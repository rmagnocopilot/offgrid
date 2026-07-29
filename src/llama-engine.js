'use strict';

const fs = require('node:fs');

let llamaModulePromise;
function loadLlamaModule() {
  if (!llamaModulePromise) llamaModulePromise = import('node-llama-cpp');
  return llamaModulePromise;
}

function errorText(error) {
  return error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
}

function isDeviceMemoryError(error) {
  const text = errorText(error).toLowerCase();
  return [
    'outofdevicememory',
    'out of device memory',
    'insufficientmemoryerror',
    'unable to allocate vulkan',
    'failed to allocate vulkan',
    'device memory allocation',
    'failed to allocate buffer',
    'failed to allocate memory',
    'not enough memory',
    'out of memory'
  ].some(fragment => text.includes(fragment));
}

class LlamaEngine {
  constructor(logger = () => {}, moduleLoader = loadLlamaModule) {
    this.logger = logger;
    this.moduleLoader = moduleLoader;
    this.llama = null;
    this.model = null;
    this.context = null;
    this.contextSequence = null;
    this.session = null;
    this.options = null;
    this.systemPrompt = '';
    this.loadQueue = Promise.resolve();
    this.generationQueue = Promise.resolve();
    this.loading = false;
    this.sequenceAcquisitions = 0;
    this.lastError = null;
    this.lastFallback = null;
  }

  get isLoaded() {
    return Boolean(this.model && this.context && this.contextSequence && this.session);
  }

  get isLoading() {
    return this.loading;
  }

  get backend() {
    return this.llama?.gpu || false;
  }

  get loadedModelPath() {
    return this.options?.modelPath || '';
  }

  get diagnostics() {
    return {
      loaded: this.isLoaded,
      loading: this.loading,
      modelPath: this.loadedModelPath,
      backend: this.backend || 'cpu',
      contextSize: this.options?.contextSize || null,
      gpuLayers: this.options?.gpuLayers ?? 'auto',
      sequenceAcquisitions: this.sequenceAcquisitions,
      lastFallback: this.lastFallback,
      lastError: this.lastError
    };
  }

  async load(options, systemPrompt) {
    const task = this.loadQueue
      .catch(() => undefined)
      .then(() => this.#loadInternal(options, systemPrompt));
    this.loadQueue = task;
    return task;
  }

  async #loadInternal(options, systemPrompt) {
    if (!fs.existsSync(options.modelPath)) {
      throw new Error(`Modelo não encontrado: ${options.modelPath}`);
    }

    const normalized = {
      ...options,
      gpuLayers: normalizeGpuLayers(options.gpuLayers)
    };
    const sameModel = this.options
      && this.options.modelPath === normalized.modelPath
      && this.options.contextSize === normalized.contextSize
      && this.options.gpu === normalized.gpu
      && this.options.gpuLayers === normalized.gpuLayers;
    if (sameModel && this.isLoaded) {
      this.logger(`Modelo já carregado: ${normalized.modelPath}`);
      return this.diagnostics;
    }

    this.loading = true;
    this.lastError = null;
    this.lastFallback = null;
    this.logger(`Iniciando carregamento: ${normalized.modelPath}`);
    try {
      const requestedBackend = normalized.gpu || 'auto';
      try {
        await this.#loadAttempt(normalized, systemPrompt, requestedBackend);
      } catch (error) {
        const canFallback = normalized.fallbackToCpu !== false
          && requestedBackend !== 'cpu'
          && isDeviceMemoryError(error);
        if (!canFallback) throw error;

        this.lastFallback = {
          from: requestedBackend,
          to: 'cpu',
          reason: error instanceof Error ? error.message : String(error)
        };
        this.logger(`Memória insuficiente no backend ${requestedBackend}. Tentando fallback automático para CPU.`);
        await this.#loadAttempt({ ...normalized, gpu: 'cpu', gpuLayers: 0 }, systemPrompt, 'cpu');
      }
      this.logger(`Modelo carregado. Backend efetivo: ${this.backend || 'cpu'}`);
      return this.diagnostics;
    } catch (error) {
      this.lastError = errorText(error);
      this.logger(`Falha no carregamento: ${this.lastError}`);
      await this.#disposeResources();
      throw error;
    } finally {
      this.loading = false;
    }
  }

  async #loadAttempt(options, systemPrompt, backendMode) {
    await this.#disposeResources();
    const { getLlama, LlamaChatSession, LlamaLogLevel } = await this.moduleLoader();
    const commonOptions = { logLevel: LlamaLogLevel?.warn };

    if (backendMode === 'auto') {
      this.logger('Backend: detecção automática');
      this.llama = await getLlama(commonOptions);
    } else {
      const gpu = backendMode === 'cpu' ? false : backendMode;
      this.logger(`Backend solicitado: ${backendMode}`);
      this.llama = await getLlama({ ...commonOptions, gpu });
    }

    const modelLoadOptions = { modelPath: options.modelPath };
    if (backendMode === 'cpu') {
      modelLoadOptions.gpuLayers = 0;
    } else if (typeof options.gpuLayers === 'number') {
      modelLoadOptions.gpuLayers = options.gpuLayers;
    }

    this.logger(`Carregando pesos GGUF${modelLoadOptions.gpuLayers !== undefined ? `; gpuLayers=${modelLoadOptions.gpuLayers}` : ''}`);
    this.model = await this.llama.loadModel(modelLoadOptions);
    this.logger(`Criando contexto de ${options.contextSize} tokens`);
    this.context = await this.model.createContext({
      contextSize: options.contextSize,
      sequences: 1
    });
    this.contextSequence = this.context.getSequence();
    this.sequenceAcquisitions += 1;
    this.session = new LlamaChatSession({
      contextSequence: this.contextSequence,
      systemPrompt
    });
    this.options = { ...options, gpu: backendMode };
    this.systemPrompt = systemPrompt;
  }

  async prompt(text, { signal, onChunk, maxTokens, temperature } = {}) {
    return this.#enqueueGeneration(async () => {
      if (!this.session || !this.options) throw new Error('Nenhum modelo carregado.');
      return this.session.prompt(text, {
        maxTokens: maxTokens || this.options.maxTokens,
        temperature: temperature ?? this.options.temperature,
        signal,
        onTextChunk: chunk => onChunk?.(chunk)
      });
    });
  }

  async runAgent(text, { functions, agentSystemPrompt, signal, onChunk, maxTokens } = {}) {
    return this.#enqueueGeneration(async () => {
      if (!this.session || !this.options) throw new Error('Nenhum modelo carregado.');
      await this.clearHistory();
      const agentPrompt = [
        '<instrucoes_modo_agente>',
        agentSystemPrompt || '',
        '</instrucoes_modo_agente>',
        '',
        text
      ].join('\n');
      try {
        return await this.session.prompt(agentPrompt, {
          functions,
          maxTokens: maxTokens || Math.max(this.options.maxTokens, 4096),
          temperature: Math.min(this.options.temperature, 0.2),
          signal,
          onTextChunk: chunk => onChunk?.(chunk)
        });
      } finally {
        await this.clearHistory();
      }
    });
  }

  async clearHistory() {
    if (!this.session || !this.options) return;
    // Reutiliza a mesma LlamaContextSequence. Criar uma nova sequência a cada
    // limpeza esgota o único slot do contexto e causa "No sequences left".
    if (typeof this.session.setChatHistory === 'function') {
      await this.session.setChatHistory([]);
      this.logger('Histórico da sessão limpo sem adquirir nova sequência.');
      return;
    }
    throw new Error('A versão instalada do node-llama-cpp não oferece setChatHistory().');
  }

  async unload() {
    await this.loadQueue.catch(() => undefined);
    await this.generationQueue.catch(() => undefined);
    await this.#disposeResources();
    this.logger('Modelo liberado da memória.');
  }

  async #enqueueGeneration(operation) {
    const task = this.generationQueue
      .catch(() => undefined)
      .then(operation);
    this.generationQueue = task;
    return task;
  }

  async #disposeResources() {
    const safeDispose = async value => {
      try { await value?.dispose?.(); } catch { /* best effort */ }
    };
    await safeDispose(this.session);
    await safeDispose(this.context);
    await safeDispose(this.model);
    await safeDispose(this.llama);
    this.session = null;
    this.contextSequence = null;
    this.context = null;
    this.model = null;
    this.llama = null;
    this.options = null;
    this.systemPrompt = '';
  }

  async dispose() {
    await this.unload();
  }
}

function normalizeGpuLayers(value) {
  if (value === undefined || value === null || value === '' || value === 'auto') return 'auto';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 'auto';
  return Math.floor(numeric);
}

module.exports = { LlamaEngine, isDeviceMemoryError, normalizeGpuLayers };
