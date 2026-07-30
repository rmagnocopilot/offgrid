import type { EngineRequest, WorkerOutboundMessage } from '../types/contracts';
import { LlamaEngine } from '../llm/LlamaEngine';

const controllers = new Map<string, AbortController>();
const send = (message: WorkerOutboundMessage): void => { if (process.send) process.send(message); };
const engine = new LlamaEngine((level, message) => send({ type: 'log', level, category: 'model', message }));

send({ type: 'ready', pid: process.pid });

process.on('message', async (message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const value = message as Record<string, unknown>;
  if (value.type === 'cancel' && typeof value.requestId === 'string') {
    controllers.get(value.requestId)?.abort();
    return;
  }
  if (value.type !== 'request') return;
  const request = value as unknown as EngineRequest;
  const controller = new AbortController();
  controllers.set(request.requestId, controller);
  try {
    const result = await handle(request, controller.signal);
    send({ type: 'result', requestId: request.requestId, result });
  } catch (error) {
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
    case 'agentStart': return engine.startAgent();
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
