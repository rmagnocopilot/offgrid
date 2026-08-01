import type { EngineRequest, WorkerOutboundMessage } from '../types/contracts';
import { LlamaServerEngine } from '../llm/LlamaServerEngine';

const controllers = new Map<string, AbortController>();
const send = (message: WorkerOutboundMessage): void => { if (process.send) process.send(message); };

// O caminho do binário é passado via variável de ambiente pelo EngineClient
// para que o worker não precise conhecer o storagePath da extensão.
const serverBinaryPath = process.env['OFFGRID_SERVER_BINARY'] ?? '';
const engine = new LlamaServerEngine(
  (level, message) => send({ type: 'log', level, category: 'model', message }),
  serverBinaryPath
);

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

// Heartbeat do event loop do worker: se estas mensagens pararem de aparecer
// durante um travamento, o event loop do processo isolado está bloqueado
// (deadlock nativo); se continuarem, o travamento está só na promise da geração.
let workerHeartbeatCount = 0;
setInterval(() => {
  workerHeartbeatCount += 1;
  // Loga a cada 15s (3 ciclos de 5s) para não poluir
  if (workerHeartbeatCount % 3 === 0) {
    const memory = process.memoryUsage();
    send({
      type: 'log', level: 'debug', category: 'model',
      message: `[Worker][EventLoop] vivo. rss=${Math.round(memory.rss / 1024 / 1024)} MB heap=${Math.round(memory.heapUsed / 1024 / 1024)} MB`
    });
  }
}, 5_000).unref();

process.on('message', async (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const value = message as Record<string, unknown>;
  if (value.type === 'cancel' && typeof value.requestId === 'string') {
    const controller = controllers.get(value.requestId);

    send({
      type: 'log',
      level: 'info',
      category: 'model',
      message: [
        '[Abort][3/4] Cancel recebido pelo EngineWorker.',
        `requestId=${value.requestId}`,
        `controller=${Boolean(controller)}`
      ].join(' ')
    });

    if (controller) {
      controller.abort();

      send({
        type: 'log',
        level: 'info',
        category: 'model',
        message: [
          '[Abort][3/4] AbortController do worker sinalizado.',
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
  send({ type: 'log', level: 'debug', category: 'model', message: `[Worker][RPC] Recebido: ${request.method} requestId=${request.requestId}` });
  const handleStartedAt = Date.now();
  try {
    const result = await handle(request, controller.signal);
    send({ type: 'log', level: 'debug', category: 'model', message: `[Worker][RPC] Concluído: ${request.method} requestId=${request.requestId} em ${Date.now() - handleStartedAt} ms` });
    send({ type: 'result', requestId: request.requestId, result });
  } catch (error) {
    send({ type: 'log', level: 'debug', category: 'model', message: `[Worker][RPC] Falhou: ${request.method} requestId=${request.requestId} em ${Date.now() - handleStartedAt} ms: ${error instanceof Error ? error.message : String(error)}` });
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
    case 'load': return engine.load(params.options, params.systemPrompt ?? '');
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