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
    this.engineState = 'notStarted';
    this.agentActive = false;
    this.lastUnloadReport = null;
  }

  get isLoaded() {
    return Boolean(this.model && this.context && this.contextSequence && this.session);
  }

  get isLoading() { return this.loading; }
  get backend() { return this.llama?.gpu || false; }
  get loadedModelPath() { return this.options?.modelPath || ''; }

  get diagnostics() {
    return {
      loaded: this.isLoaded,
      loading: this.loading,
      engineState: this.engineState,
      agentActive: this.agentActive,
      modelPath: this.loadedModelPath,
      backend: this.backend || 'cpu',
      contextSize: this.options?.contextSize || null,
      gpuLayers: this.options?.gpuLayers ?? 'auto',
      sequenceAcquisitions: this.sequenceAcquisitions,
      lastFallback: this.lastFallback,
      lastUnloadReport: this.lastUnloadReport,
      lastError: this.lastError
    };
  }

  async load(options, systemPrompt) {
    const task = this.loadQueue.catch(() => undefined).then(() => this.#loadInternal(options, systemPrompt));
    this.loadQueue = task;
    return task;
  }

  async #loadInternal(options, systemPrompt) {
    if (!fs.existsSync(options.modelPath)) throw new Error(`Modelo não encontrado: ${options.modelPath}`);

    const normalized = { ...options, gpuLayers: normalizeGpuLayers(options.gpuLayers) };
    const sameModel = this.options
      && this.options.modelPath === normalized.modelPath
      && this.options.contextSize === normalized.contextSize
      && this.options.gpu === normalized.gpu
      && this.options.gpuLayers === normalized.gpuLayers;
    if (sameModel && this.isLoaded) {
      this.logger(`[Load] Modelo já carregado: ${normalized.modelPath}`);
      return this.diagnostics;
    }

    this.loading = true;
    this.engineState = 'loading';
    this.lastError = null;
    this.lastFallback = null;
    this.logger(`[Load] Iniciando carregamento: ${normalized.modelPath}`);
    const startedAt = Date.now();
    try {
      const requestedBackend = normalized.gpu || 'auto';
      try {
        await this.#loadAttempt(normalized, systemPrompt, requestedBackend);
      } catch (error) {
        const canFallback = normalized.fallbackToCpu !== false && requestedBackend !== 'cpu' && isDeviceMemoryError(error);
        if (!canFallback) throw error;
        this.lastFallback = { from: requestedBackend, to: 'cpu', reason: error instanceof Error ? error.message : String(error) };
        this.logger(`[Load] Memória insuficiente no backend ${requestedBackend}. Tentando fallback automático para CPU.`);
        await this.#loadAttempt({ ...normalized, gpu: 'cpu', gpuLayers: 0 }, systemPrompt, 'cpu');
      }
      this.engineState = 'ready';
      this.logger(`[Perf] loadModel: ${Date.now() - startedAt} ms`);
      this.logger(`[Load] Modelo carregado. Backend efetivo: ${this.backend || 'cpu'}`);
      return this.diagnostics;
    } catch (error) {
      this.lastError = errorText(error);
      this.engineState = 'error';
      this.logger(`[Load][ERRO] ${this.lastError}`);
      await this.#disposeResources({ reason: 'falha de carregamento', strict: false });
      throw error;
    } finally {
      this.loading = false;
    }
  }

  async #loadAttempt(options, systemPrompt, backendMode) {
    await this.#disposeResources({ reason: 'nova tentativa de carregamento', strict: false });
    const moduleStartedAt = Date.now();
    const { getLlama, LlamaChatSession, LlamaLogLevel } = await this.moduleLoader();
    this.logger(`[Perf] loadLlamaModule: ${Date.now() - moduleStartedAt} ms`);
    const commonOptions = { logLevel: LlamaLogLevel?.warn };

    if (backendMode === 'auto') {
      this.logger('[Load] Backend: detecção automática');
      this.llama = await getLlama(commonOptions);
    } else {
      const gpu = backendMode === 'cpu' ? false : backendMode;
      this.logger(`[Load] Backend solicitado: ${backendMode}`);
      this.llama = await getLlama({ ...commonOptions, gpu });
    }

    const modelLoadOptions = { modelPath: options.modelPath };
    if (backendMode === 'cpu') modelLoadOptions.gpuLayers = 0;
    else if (typeof options.gpuLayers === 'number') modelLoadOptions.gpuLayers = options.gpuLayers;

    this.logger(`[Load] Carregando pesos GGUF${modelLoadOptions.gpuLayers !== undefined ? `; gpuLayers=${modelLoadOptions.gpuLayers}` : ''}`);
    const modelStartedAt = Date.now();
    this.model = await this.llama.loadModel(modelLoadOptions);
    this.logger(`[Perf] loadWeights: ${Date.now() - modelStartedAt} ms`);

    this.logger(`[Load] Criando contexto de ${options.contextSize} tokens`);
    const contextStartedAt = Date.now();
    this.context = await this.model.createContext({ contextSize: options.contextSize, sequences: 1 });
    this.logger(`[Perf] createContext: ${Date.now() - contextStartedAt} ms`);
    this.contextSequence = this.context.getSequence();
    this.sequenceAcquisitions += 1;
    this.session = new LlamaChatSession({ contextSequence: this.contextSequence, systemPrompt });
    this.options = { ...options, gpu: backendMode };
    this.systemPrompt = systemPrompt;
  }

  async prompt(text, { signal, onChunk, maxTokens, temperature } = {}) {
    return this.#enqueueGeneration(async () => {
      if (!this.session || !this.options) throw new Error('Nenhum modelo carregado.');
      const startedAt = Date.now();
      try {
        return await this.session.prompt(text, {
          maxTokens: maxTokens || this.options.maxTokens,
          temperature: temperature ?? this.options.temperature,
          signal,
          onTextChunk: chunk => onChunk?.(chunk)
        });
      } finally {
        this.logger(`[Perf] prompt: ${Date.now() - startedAt} ms`);
      }
    });
  }

  async startAgent() {
    return this.#enqueueGeneration(async () => {
      if (!this.session || !this.options) throw new Error('Nenhum modelo carregado.');
      await this.clearHistory();
      this.agentActive = true;
      this.logger('[Agent] Sessão do agente iniciada usando a sequência existente.');
      return true;
    });
  }

  async runAgentStep(text, { functions, agentSystemPrompt, firstStep = false, signal, onChunk, maxTokens } = {}) {
    return this.#enqueueGeneration(async () => {
      if (!this.session || !this.options) throw new Error('Nenhum modelo carregado.');
      const prompt = firstStep
        ? ['<instrucoes_modo_agente>', agentSystemPrompt || '', '</instrucoes_modo_agente>', '', text].join('\n')
        : text;
      const startedAt = Date.now();
      try {
        return await this.session.prompt(prompt, {
          functions,
          maxTokens: maxTokens || Math.max(this.options.maxTokens, 4096),
          temperature: Math.min(this.options.temperature, 0.2),
          signal,
          onTextChunk: chunk => onChunk?.(chunk)
        });
      } finally {
        this.logger(`[Perf] agent.promptStep: ${Date.now() - startedAt} ms`);
      }
    });
  }

  async finishAgent() {
    return this.#enqueueGeneration(async () => {
      try { await this.clearHistory(); }
      finally {
        this.agentActive = false;
        this.logger('[Agent] Sessão do agente finalizada e histórico limpo.');
      }
      return true;
    });
  }

  async runAgent(text, options = {}) {
    await this.startAgent();
    try {
      return await this.runAgentStep(text, { ...options, firstStep: true });
    } finally {
      await this.finishAgent();
    }
  }

  async clearHistory() {
    if (!this.session || !this.options) return;
    if (typeof this.session.setChatHistory === 'function') {
      await this.session.setChatHistory([]);
      this.logger('[Session] Histórico limpo sem adquirir nova sequência.');
      return;
    }
    throw new Error('A versão instalada do node-llama-cpp não oferece setChatHistory().');
  }

  async unload() {
    await this.loadQueue.catch(() => undefined);
    await this.generationQueue.catch(() => undefined);
    this.engineState = 'unloading';
    this.logger('[Unload] Solicitação recebida para descarregar modelo.');
    const report = await this.#disposeResources({ reason: 'descarregamento solicitado', strict: true });
    this.engineState = 'unloaded';
    this.lastUnloadReport = report;
    this.logger('[Unload] Modelo descarregado com sucesso.');
    return { ...report, diagnostics: this.diagnostics };
  }

  async #enqueueGeneration(operation) {
    const task = this.generationQueue.catch(() => undefined).then(operation);
    this.generationQueue = task;
    return task;
  }

  async #disposeResources({ reason = 'limpeza', strict = false } = {}) {
    const startedAt = Date.now();
    const errors = [];
    const steps = [];
    const dispose = async (name, value) => {
      if (!value) {
        steps.push({ name, status: 'ausente' });
        this.logger(`[Unload] ${name}: ausente.`);
        return;
      }
      this.logger(`[Unload] Dispose ${name} iniciado.`);
      try {
        if (typeof value.dispose === 'function') await value.dispose();
        steps.push({ name, status: 'concluído' });
        this.logger(`[Unload] Dispose ${name} concluído.`);
      } catch (error) {
        errors.push({ name, message: error?.message || String(error), stack: error?.stack || '' });
        steps.push({ name, status: 'erro' });
        this.logger(`[Unload][ERRO] Falha ao descartar ${name}: ${error?.stack || error}`);
      }
    };

    await dispose('session', this.session);
    await dispose('context', this.context);
    await dispose('model', this.model);
    await dispose('llama/runtime', this.llama);
    this.session = null;
    this.contextSequence = null;
    this.context = null;
    this.model = null;
    this.llama = null;
    this.options = null;
    this.systemPrompt = '';
    this.agentActive = false;
    this.logger('[Unload] Estado interno limpo.');
    const report = { reason, durationMs: Date.now() - startedAt, steps, errors };
    this.logger(`[Perf] unloadModel: ${report.durationMs} ms`);
    if (strict && errors.length) {
      const error = new Error(`Falha ao descarregar completamente o modelo: ${errors.map(item => item.name).join(', ')}.`);
      error.details = report;
      this.lastError = errorText(error);
      this.engineState = 'error';
      throw error;
    }
    return report;
  }

  async dispose() {
    try { await this.unload(); }
    catch { await this.#disposeResources({ reason: 'encerramento forçado', strict: false }); }
  }
}

function normalizeGpuLayers(value) {
  if (value === undefined || value === null || value === '' || value === 'auto') return 'auto';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 'auto';
  return Math.floor(numeric);
}

module.exports = { LlamaEngine, isDeviceMemoryError, normalizeGpuLayers };
