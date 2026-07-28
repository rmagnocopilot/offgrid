'use strict';

const fs = require('node:fs');

let llamaModulePromise;
function loadLlamaModule() {
  if (!llamaModulePromise) llamaModulePromise = import('node-llama-cpp');
  return llamaModulePromise;
}

class LlamaEngine {
  constructor(logger = () => {}) {
    this.logger = logger;
    this.llama = null;
    this.model = null;
    this.context = null;
    this.session = null;
    this.options = null;
    this.systemPrompt = '';
    this.loadQueue = Promise.resolve();
    this.loading = false;
  }

  get isLoaded() {
    return Boolean(this.model && this.context && this.session);
  }

  get isLoading() {
    return this.loading;
  }

  get backend() {
    return this.llama?.gpu || false;
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

    const sameModel = this.options
      && this.options.modelPath === options.modelPath
      && this.options.contextSize === options.contextSize
      && this.options.gpu === options.gpu;
    if (sameModel && this.isLoaded) {
      this.logger(`Modelo já carregado: ${options.modelPath}`);
      return;
    }

    this.loading = true;
    this.logger(`Iniciando carregamento: ${options.modelPath}`);
    try {
      await this.#disposeResources();
      const { getLlama, LlamaChatSession, LlamaLogLevel } = await loadLlamaModule();
      const commonOptions = { logLevel: LlamaLogLevel.warn };

      if (options.gpu === 'auto') {
        try {
          this.logger('Backend: detecção automática');
          this.llama = await getLlama(commonOptions);
        } catch (autoError) {
          this.logger(`Backend automático falhou: ${this.#errorText(autoError)}`);
          this.logger('Tentando novamente em CPU');
          this.llama = await getLlama({ ...commonOptions, gpu: false });
        }
      } else {
        const gpu = options.gpu === 'cpu' ? false : options.gpu;
        this.logger(`Backend solicitado: ${options.gpu}`);
        this.llama = await getLlama({ ...commonOptions, gpu });
      }

      this.logger('Carregando pesos GGUF');
      this.model = await this.llama.loadModel({ modelPath: options.modelPath });
      this.logger(`Criando contexto de ${options.contextSize} tokens`);
      this.context = await this.model.createContext({ contextSize: options.contextSize });
      this.session = new LlamaChatSession({
        contextSequence: this.context.getSequence(),
        systemPrompt
      });
      this.options = { ...options };
      this.systemPrompt = systemPrompt;
      this.logger(`Modelo carregado. Backend efetivo: ${this.backend || 'cpu'}`);
    } catch (error) {
      this.logger(`Falha no carregamento: ${this.#errorText(error)}`);
      await this.#disposeResources();
      throw error;
    } finally {
      this.loading = false;
    }
  }

  async prompt(text, { signal, onChunk } = {}) {
    if (!this.session || !this.options) throw new Error('Nenhum modelo carregado.');
    return this.session.prompt(text, {
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      signal,
      onTextChunk: chunk => onChunk?.(chunk)
    });
  }

  async runAgent(text, { functions, agentSystemPrompt, signal, onChunk, maxTokens } = {}) {
    if (!this.context || !this.options) throw new Error('Nenhum modelo carregado.');

    await this.clearHistory(agentSystemPrompt);
    try {
      return await this.session.prompt(text, {
        functions,
        maxTokens: maxTokens || Math.max(this.options.maxTokens, 4096),
        temperature: Math.min(this.options.temperature, 0.2),
        signal,
        onTextChunk: chunk => onChunk?.(chunk)
      });
    } finally {
      await this.clearHistory(this.systemPrompt);
    }
  }

  async clearHistory(systemPrompt = this.systemPrompt) {
    if (!this.context || !this.options) return;
    try { await this.session?.dispose?.(); } catch { /* best effort */ }
    const { LlamaChatSession } = await loadLlamaModule();
    this.session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      systemPrompt
    });
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
    this.context = null;
    this.model = null;
    this.llama = null;
    this.options = null;
    this.systemPrompt = '';
  }

  async dispose() {
    await this.loadQueue.catch(() => undefined);
    await this.#disposeResources();
  }

  #errorText(error) {
    return error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
  }
}

module.exports = { LlamaEngine };
