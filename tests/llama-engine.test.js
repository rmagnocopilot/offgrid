'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { LlamaEngine, isDeviceMemoryError } = require('../src/llama-engine');

async function temporaryModel() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-engine-'));
  const modelPath = path.join(dir, 'model.gguf');
  await fsp.writeFile(modelPath, 'fake');
  return { dir, modelPath };
}

function successfulModule(counters = {}) {
  counters.getSequence = 0;
  counters.setHistory = 0;
  counters.prompt = 0;
  class FakeSession {
    constructor({ contextSequence }) { this.sequence = contextSequence; }
    async setChatHistory(history) { counters.setHistory += 1; this.history = history; }
    async prompt(text) { counters.prompt += 1; return `ok:${text.slice(-10)}`; }
    async dispose() {}
  }
  const context = {
    getSequence() { counters.getSequence += 1; return { id: counters.getSequence }; },
    async dispose() {}
  };
  const model = {
    async createContext() { return context; },
    async dispose() {}
  };
  const llama = {
    gpu: 'vulkan',
    async loadModel() { return model; },
    async dispose() {}
  };
  return async () => ({
    getLlama: async () => llama,
    LlamaChatSession: FakeSession,
    LlamaLogLevel: { warn: 'warn' }
  });
}

test('modo Agente reutiliza a mesma sequência e não produz No sequences left', async () => {
  const { dir, modelPath } = await temporaryModel();
  const counters = {};
  const engine = new LlamaEngine(() => {}, successfulModule(counters));
  try {
    await engine.load({ modelPath, gpu: 'auto', gpuLayers: 'auto', fallbackToCpu: true, contextSize: 4096, maxTokens: 128, temperature: 0.2 }, 'sistema');
    await engine.runAgent('primeira tarefa', { functions: {}, agentSystemPrompt: 'agente' });
    await engine.prompt('chat');
    await engine.runAgent('segunda tarefa', { functions: {}, agentSystemPrompt: 'agente' });
    assert.equal(counters.getSequence, 1);
    assert.ok(counters.setHistory >= 4);
    assert.equal(engine.diagnostics.sequenceAcquisitions, 1);
  } finally {
    await engine.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('fallback automático repete o carregamento em CPU após falta de VRAM', async () => {
  const { dir, modelPath } = await temporaryModel();
  let calls = 0;
  class FakeSession {
    async setChatHistory() {}
    async prompt() { return 'ok'; }
    async dispose() {}
  }
  const moduleLoader = async () => ({
    LlamaLogLevel: { warn: 'warn' },
    LlamaChatSession: FakeSession,
    getLlama: async options => {
      calls += 1;
      if (options?.gpu === false) {
        return {
          gpu: false,
          async loadModel() {
            return {
              async createContext() { return { getSequence: () => ({}), async dispose() {} }; },
              async dispose() {}
            };
          },
          async dispose() {}
        };
      }
      return {
        gpu: 'vulkan',
        async loadModel() { throw new Error('ErrorOutOfDeviceMemory: unable to allocate Vulkan1 buffer'); },
        async dispose() {}
      };
    }
  });
  const engine = new LlamaEngine(() => {}, moduleLoader);
  try {
    await engine.load({ modelPath, gpu: 'auto', gpuLayers: 'auto', fallbackToCpu: true, contextSize: 4096, maxTokens: 128, temperature: 0.2 }, 'sistema');
    assert.equal(calls, 2);
    assert.equal(engine.backend, false);
    assert.equal(engine.diagnostics.lastFallback.to, 'cpu');
  } finally {
    await engine.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('reconhece mensagens comuns de falta de memória de GPU', () => {
  assert.equal(isDeviceMemoryError(new Error('failed to allocate Vulkan1 buffer')), true);
  assert.equal(isDeviceMemoryError(new Error('arquivo não encontrado')), false);
});

test('descarregamento libera sessão, contexto, modelo e runtime com relatório', async () => {
  const { dir, modelPath } = await temporaryModel();
  const disposed = [];
  const logs = [];
  class FakeSession {
    async setChatHistory() {}
    async prompt() { return 'ok'; }
    async dispose() { disposed.push('session'); }
  }
  const context = {
    getSequence() { return {}; },
    async dispose() { disposed.push('context'); }
  };
  const model = {
    async createContext() { return context; },
    async dispose() { disposed.push('model'); }
  };
  const llama = {
    gpu: 'vulkan',
    async loadModel() { return model; },
    async dispose() { disposed.push('llama/runtime'); }
  };
  const engine = new LlamaEngine(message => logs.push(String(message)), async () => ({
    getLlama: async () => llama,
    LlamaChatSession: FakeSession,
    LlamaLogLevel: { warn: 'warn' }
  }));
  try {
    await engine.load({ modelPath, gpu: 'auto', gpuLayers: 'auto', fallbackToCpu: true, contextSize: 4096, maxTokens: 128, temperature: 0.2 }, 'sistema');
    const report = await engine.unload();
    assert.deepEqual(disposed, ['session', 'context', 'model', 'llama/runtime']);
    assert.equal(engine.isLoaded, false);
    assert.equal(engine.diagnostics.engineState, 'unloaded');
    assert.equal(report.errors.length, 0);
    assert.match(logs.join('\n'), /Estado interno limpo/);
    assert.match(logs.join('\n'), /Modelo descarregado com sucesso/);
  } finally {
    await engine.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
