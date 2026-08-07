import type { EngineRequest, WorkerOutboundMessage } from '../types/contracts';
import { LlamaServerEngine } from '../llm/LlamaServerEngine';
import { LlamaEngine } from '../llm/LlamaEngine';

const controllers = new Map<string, AbortController>();
const send = (message: WorkerOutboundMessage): void => { if (process.send) process.send(message); };

// O caminho do binário é passado via variável de ambiente pelo EngineClient
// para que o worker não precise conhecer o storagePath da extensão.
const serverBinaryPath = process.env['OFFGRID_SERVER_BINARY'] ?? '';
const engineLogger = (
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
  message: string
): void => send({ type: 'log', level, category: 'model', message });

let usingServerEngine = true;
let engine: LlamaServerEngine | LlamaEngine = new LlamaServerEngine(
  engineLogger,
  serverBinaryPath
);

function isServerExecutionBlocked(error: unknown): boolean {
  const text = error instanceof Error
    ? [error.message, error.stack ?? ''].join('\n')
    : String(error);

  return /spawn(?:\s+\S+)?|\b(?:UNKNOWN|ENOENT|EACCES|EPERM|EISDIR)\b|llama-server.*(?:não encontrado|not found|indisponível)|group policy|política de grupo|programa.*bloqueado|blocked.*policy|not a valid Win32 application|não é um aplicativo Win32 válido/i.test(text);
}

async function loadEngine(options: any, systemPrompt: string): Promise<unknown> {
  try {
    return await engine.load(options, systemPrompt);
  } catch (error) {
    if (!usingServerEngine || !isServerExecutionBlocked(error)) throw error;

    engineLogger(
      'warn',
      '[Load] llama-server indisponível ou bloqueado. Ativando motor embarcado node-llama-cpp.'
    );

    await engine.dispose().catch(() => undefined);
    usingServerEngine = false;
    engine = new LlamaEngine(engineLogger);

    return engine.load(options, systemPrompt);
  }
}

// Eleva a prioridade do processo para ABOVE_NORMAL no Windows.
// Processos filhos forked do VS Code podem ser colocados em Efficiency Mode
// (EcoQoS) pelo Windows 11, limitando clock e núcleos — o que reduz a
// inferência a poucos tokens por segundo. Elevar a prioridade tira o
// processo desse modo.
import * as os from 'node:os';
try {
  os.setPriority(process.pid, -10); // -10 → ABOVE_NORMAL_PRIORITY_CLASS no Windows
  send({ type: 'log', level: 'debug', category: 'model', message: `[Worker] Prioridade elevada para ABOVE_NORMAL. pid=${process.pid}` });
} catch (priorityError) {
  send({ type: 'log', level: 'warn', category: 'model', message: `[Worker] Falha ao elevar prioridade: ${priorityError instanceof Error ? priorityError.message : String(priorityError)}` });
}

send({ type: 'ready', pid: process.pid });

// Heartbeat reservado ao nível trace. É útil para diagnosticar deadlock, mas
// não deve aparecer na saída normal do usuário.
setInterval(() => {
  const memory = process.memoryUsage();
  send({
    type: 'log', level: 'trace', category: 'model',
    message: `[Worker][EventLoop] vivo. rss=${Math.round(memory.rss / 1024 / 1024)} MB heap=${Math.round(memory.heapUsed / 1024 / 1024)} MB`
  });
}, 60_000).unref();

process.on('message', async (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const value = message as Record<string, unknown>;
  if (value.type === 'cancel' && typeof value.requestId === 'string') {
    const controller = controllers.get(value.requestId);

    send({
      type: 'log',
      level: 'trace',
      category: 'model',
      message: [
        '[Abort] Cancel recebido pelo EngineWorker.',
        `requestId=${value.requestId}`,
        `controller=${Boolean(controller)}`
      ].join(' ')
    });

    if (controller) {
      controller.abort();

      send({
        type: 'log',
        level: 'trace',
        category: 'model',
        message: [
          '[Abort] AbortController do worker sinalizado.',
          `requestId=${value.requestId}`,
          `aborted=${controller.signal.aborted}`
        ].join(' ')
      });
    }

    return;
  }
  if (value.type !== 'request') return;
  const request = value as unknown as EngineRequest;
  const controller = new AbortController();
  controllers.set(request.requestId, controller);
  send({ type: 'log', level: 'trace', category: 'model', message: `[Worker][RPC] Recebido: ${request.method} requestId=${request.requestId}` });
  const handleStartedAt = Date.now();
  try {
    const result = await handle(request, controller.signal);
    send({ type: 'log', level: 'trace', category: 'model', message: `[Worker][RPC] Concluído: ${request.method} requestId=${request.requestId} em ${Date.now() - handleStartedAt} ms` });
    send({ type: 'result', requestId: request.requestId, result });
  } catch (error) {
    send({ type: 'log', level: 'trace', category: 'model', message: `[Worker][RPC] Falhou: ${request.method} requestId=${request.requestId} em ${Date.now() - handleStartedAt} ms: ${error instanceof Error ? error.message : String(error)}` });
    send({
      type: 'error', requestId: request.requestId,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        details: (error as { details?: unknown })?.details
      }
    });
  } finally { controllers.delete(request.requestId); }
});

async function handle(request: EngineRequest, signal: AbortSignal): Promise<unknown> {
  const params = request.params as Record<string, any>;
  switch (request.method) {
    case 'load': return loadEngine(params.options, params.systemPrompt ?? '');
    case 'prompt': return engine.prompt(params.text, {
      ...params.options, signal,
      onChunk: (chunk: string) => send({ type: 'chunk', requestId: request.requestId, chunk })
    });
    case 'agentStart': return engine.startAgent(String(params.systemPrompt ?? ''));
    case 'agentStep': return engine.agentStep(params.text, {
      firstStep: Boolean(params.options?.firstStep),
      systemPrompt: String(params.options?.systemPrompt ?? ''),
      maxTokens: params.options?.maxTokens,
      signal,
      onChunk: (chunk: string) => send({ type: 'chunk', requestId: request.requestId, chunk })
    });
    case 'agentFinish': return engine.finishAgent();
    case 'clearHistory': return engine.clearHistory();
    case 'diagnostics': return engine.diagnostics;
    case 'unload': return engine.unload();
    case 'dispose': return engine.dispose();
    default: throw new Error(`Método de motor desconhecido: ${request.method}`);
  }
}

process.on('disconnect', () => engine.dispose().finally(() => process.exit(0)));
process.on('SIGTERM', () => engine.dispose().finally(() => process.exit(0)));