'use strict';

const fs = require('node:fs');

let llamaModulePromise;
function loadLlamaModule() {
  if (!llamaModulePromise) llamaModulePromise = import('node-llama-cpp');
  return llamaModulePromise;
}

class LlamaEngine {
  constructor() {
    this.llama = null;
    this.model = null;
    this.context = null;
    this.session = null;
    this.options = null;
  }

  get isLoaded() {
    return Boolean(this.model && this.context && this.session);
  }

  get backend() {
    return this.llama?.gpu || false;
  }

  async load(options, systemPrompt) {
    if (!fs.existsSync(options.modelPath)) {
      throw new Error(`Modelo não encontrado: ${options.modelPath}`);
    }

    const sameModel = this.options
      && this.options.modelPath === options.modelPath
      && this.options.contextSize === options.contextSize
      && this.options.gpu === options.gpu;
    if (sameModel && this.isLoaded) return;

    await this.dispose();
    const { getLlama, LlamaChatSession, LlamaLogLevel } = await loadLlamaModule();
    const gpu = options.gpu === 'cpu' ? false : options.gpu;

    this.llama = await getLlama({ gpu, logLevel: LlamaLogLevel.warn });
    this.model = await this.llama.loadModel({ modelPath: options.modelPath });
    this.context = await this.model.createContext({ contextSize: options.contextSize });
    this.session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      systemPrompt
    });
    this.options = options;
  }

  async prompt(text, { signal, onChunk } = {}) {
    if (!this.session || !this.options) {
      throw new Error('Nenhum modelo carregado.');
    }

    return this.session.prompt(text, {
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
      signal,
      onTextChunk: chunk => onChunk?.(chunk)
    });
  }

  async clearHistory(systemPrompt) {
    if (!this.context || !this.options) return;
    try { await this.session?.dispose?.(); } catch { /* best effort */ }
    const { LlamaChatSession } = await loadLlamaModule();
    this.session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      systemPrompt
    });
  }

  async dispose() {
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
  }
}

module.exports = { LlamaEngine };
