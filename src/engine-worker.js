'use strict';

const { LlamaEngine } = require('./llama-engine');

const pendingTools = new Map();
const requestAbortControllers = new Map();

const logger = message => {
  if (process.send) process.send({ type: 'log', message: String(message) });
};

const engine = new LlamaEngine(logger);

function serializeError(error) {
  return {
    name: error?.name || 'Error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack || '' : '',
    details: error?.details || null
  };
}

function reply(requestId, result) {
  process.send?.({ type: 'result', requestId, result });
}

function reject(requestId, error) {
  process.send?.({ type: 'error', requestId, error: serializeError(error) });
}

async function buildFunctions(requestId, definitions = {}) {
  const { defineChatSessionFunction } = await import('node-llama-cpp');
  return Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, defineChatSessionFunction({
    description: definition.description,
    params: definition.params,
    handler: args => new Promise((resolve, rejectTool) => {
      const callId = `${requestId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      pendingTools.set(callId, { resolve, reject: rejectTool, requestId, name });
      logger(`[Agent] Tool call nativa detectada: ${name}.`);
      process.send?.({ type: 'toolCall', requestId, callId, name, args });
    })
  })]));
}

function cleanupPendingTools(requestId, error = null) {
  for (const [callId, pending] of pendingTools.entries()) {
    if (pending.requestId !== requestId) continue;
    pendingTools.delete(callId);
    if (error) pending.reject(error);
  }
}

async function handleRequest(message) {
  const { requestId, method, params = {} } = message;
  const controller = new AbortController();
  requestAbortControllers.set(requestId, controller);
  try {
    if (method === 'load') {
      reply(requestId, await engine.load(params.options, params.systemPrompt));
    } else if (method === 'prompt') {
      const result = await engine.prompt(params.text, {
        ...params.options,
        signal: controller.signal,
        onChunk: chunk => process.send?.({ type: 'chunk', requestId, chunk })
      });
      reply(requestId, result);
    } else if (method === 'agentStart') {
      reply(requestId, await engine.startAgent());
    } else if (method === 'agentStep') {
      const functions = await buildFunctions(requestId, params.functionDefinitions);
      const result = await engine.runAgentStep(params.text, {
        ...params.options,
        functions,
        signal: controller.signal,
        onChunk: chunk => process.send?.({ type: 'chunk', requestId, chunk })
      });
      reply(requestId, result);
    } else if (method === 'agentFinish') {
      reply(requestId, await engine.finishAgent());
    } else if (method === 'runAgent') {
      const functions = await buildFunctions(requestId, params.functionDefinitions);
      const result = await engine.runAgent(params.text, {
        ...params.options,
        functions,
        signal: controller.signal,
        onChunk: chunk => process.send?.({ type: 'chunk', requestId, chunk })
      });
      reply(requestId, result);
    } else if (method === 'clearHistory') {
      await engine.clearHistory();
      reply(requestId, true);
    } else if (method === 'unload') {
      const report = await engine.unload();
      const memory = process.memoryUsage();
      reply(requestId, {
        ...report,
        processMemory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers
        }
      });
    } else if (method === 'diagnostics') {
      const memory = process.memoryUsage();
      reply(requestId, {
        ...engine.diagnostics,
        processMemory: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          heapTotalBytes: memory.heapTotal,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers
        },
        pid: process.pid
      });
    } else if (method === 'dispose') {
      await engine.dispose();
      reply(requestId, true);
      setTimeout(() => process.exit(0), 25).unref();
    } else {
      throw new Error(`Método desconhecido do motor: ${method}`);
    }
  } catch (error) {
    reject(requestId, error);
  } finally {
    requestAbortControllers.delete(requestId);
    cleanupPendingTools(requestId, Object.assign(new Error('A chamada da ferramenta foi encerrada junto com a etapa do agente.'), { name: 'AbortError' }));
  }
}

process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'request') {
    handleRequest(message).catch(error => reject(message.requestId, error));
  } else if (message.type === 'cancel') {
    requestAbortControllers.get(message.requestId)?.abort();
    cleanupPendingTools(message.requestId, Object.assign(new Error('Operação cancelada.'), { name: 'AbortError' }));
  } else if (message.type === 'toolResult') {
    const pending = pendingTools.get(message.callId);
    if (!pending) return;
    pendingTools.delete(message.callId);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message || String(message.error)), { stack: message.error.stack || '' }));
    else pending.resolve(message.result);
  }
});

process.on('disconnect', async () => {
  try { await engine.dispose(); } catch { /* best effort */ }
  process.exit(0);
});

process.on('uncaughtException', error => {
  logger(`ERRO NÃO TRATADO NO MOTOR: ${error?.stack || error}`);
  process.exitCode = 1;
});

process.send?.({ type: 'ready', pid: process.pid });
