'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');
const { ResourceMonitor, summarizeResources } = require('./resource-monitor');
const { chooseAttempts, HardwareProfileStore } = require('./hardware-profile');
const { isDeviceMemoryError } = require('./llama-engine');
const { executeAgentToolLoop } = require('./agent-tool-loop');

function reviveError(payload) {
  const error = new Error(payload?.message || 'Falha no processo do motor.');
  error.name = payload?.name || 'Error';
  if (payload?.stack) error.stack = payload.stack;
  if (payload?.details) error.details = payload.details;
  return error;
}

class EngineProcessClient {
  constructor({ extensionPath, storagePath, logger = () => {}, workerFactory } = {}) {
    this.extensionPath = extensionPath || path.resolve(__dirname, '..');
    this.storagePath = storagePath || path.join(this.extensionPath, '.offgrid-storage');
    this.logger = logger;
    this.workerFactory = workerFactory;
    this.worker = null;
    this.readyPromise = null;
    this.requests = new Map();
    this.counter = 0;
    this.state = {
      loaded: false,
      loading: false,
      engineState: 'notStarted',
      modelPath: '',
      backend: 'cpu',
      contextSize: null,
      gpuLayers: 'auto',
      lastFallback: null,
      lastError: null,
      lastUnloadReport: null,
      workerPid: null,
      processMemory: null,
      resourceSnapshot: null,
      attempts: [],
      selectedProfile: null
    };
    this.monitor = new ResourceMonitor({ extensionPath: this.extensionPath, logger });
    this.profiles = new HardwareProfileStore(this.storagePath, logger);
    this.initialized = this.profiles.init();
  }

  get isLoaded() { return Boolean(this.state.loaded); }
  get isLoading() { return Boolean(this.state.loading); }
  get backend() { return this.state.backend || 'cpu'; }
  get loadedModelPath() { return this.state.modelPath || ''; }
  get diagnostics() { return { ...this.state }; }

  async load(options, systemPrompt) {
    await this.initialized;
    this.state.loading = true;
    this.state.engineState = 'loading';
    this.state.lastError = null;
    const resources = await this.refreshDiagnostics(true);
    this.#logMemory('antes de carregar', resources);
    const saved = this.profiles.get(options.modelPath, resources);
    const attempts = chooseAttempts(options, resources, saved);
    this.state.attempts = attempts;
    this.logger(`[Load] Plano: ${attempts.map(item => `${item.gpu}/${item.gpuLayers} (${item.reason})`).join(' → ')}`);

    let lastError;
    const startedAt = Date.now();
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      const currentOptions = { ...options, gpu: attempt.gpu, gpuLayers: attempt.gpuLayers, fallbackToCpu: false };
      try {
        this.logger(`[Load] Tentativa ${index + 1}/${attempts.length}: gpu=${attempt.gpu}; gpuLayers=${attempt.gpuLayers}`);
        const result = await this.#rpc('load', { options: currentOptions, systemPrompt });
        this.state = {
          ...this.state,
          ...result,
          loaded: true,
          loading: false,
          engineState: 'ready',
          modelPath: result.modelPath || options.modelPath,
          backend: result.backend || attempt.gpu,
          gpuLayers: result.gpuLayers ?? attempt.gpuLayers,
          selectedProfile: attempt,
          lastFallback: index > 0 ? { from: attempts[0], to: attempt, reason: lastError?.message || 'tentativa anterior falhou' } : null,
          lastError: null
        };
        await this.profiles.recordSuccess(options.modelPath, resources, attempt, result);
        const after = await this.refreshDiagnostics(true);
        this.#logMemory('depois de carregar', after);
        this.logger(`[Perf] loadModel total: ${Date.now() - startedAt} ms`);
        return this.diagnostics;
      } catch (error) {
        lastError = error;
        this.logger(`[Load][ERRO] Tentativa falhou: ${error?.stack || error}`);
        await this.profiles.recordFailure(options.modelPath, resources, attempt, error);
        const hasNext = index + 1 < attempts.length;
        if (hasNext) this.logger(`[Load] Tentando próximo perfil: ${attempts[index + 1].gpu}/${attempts[index + 1].gpuLayers}.`);
        if (!hasNext || (!isDeviceMemoryError(error) && attempt.gpu === 'cpu')) break;
      }
    }
    this.state.loading = false;
    this.state.loaded = false;
    this.state.engineState = 'error';
    this.state.lastError = lastError?.stack || lastError?.message || String(lastError);
    const afterError = await this.refreshDiagnostics(true).catch(() => this.state.resourceSnapshot);
    this.#logMemory('após erro de carregamento', afterError);
    this.logger(`[Perf] loadModel com falha: ${Date.now() - startedAt} ms`);
    throw lastError || new Error('Não foi possível carregar o modelo.');
  }

  async prompt(text, { signal, onChunk, ...options } = {}) {
    return this.#rpc('prompt', { text, options }, { signal, onChunk });
  }

  async runAgent(text, { functions = {}, signal, onChunk, maxAgentSteps = 10, diagnosticMode = false, ...options } = {}) {
    const functionDefinitions = {};
    const handlers = {};
    for (const [name, definition] of Object.entries(functions)) {
      if (!definition || typeof definition.handler !== 'function') continue;
      functionDefinitions[name] = { description: definition.description, params: definition.params };
      handlers[name] = definition.handler;
    }

    this.logger(`[Agent] Funções disponíveis: ${Object.keys(handlers).join(', ') || 'nenhuma'}.`);
    await this.refreshDiagnostics(true).then(snapshot => this.#logMemory('antes do agente', snapshot)).catch(() => undefined);
    await this.#rpc('agentStart', {}, { signal });
    try {
      const result = await executeAgentToolLoop({
        initialPrompt: text,
        handlers,
        maxSteps: maxAgentSteps,
        signal,
        diagnosticMode,
        log: (level, message) => this.logger(`[Agent][${level.toUpperCase()}] ${message}`),
        invokeStep: async (stepPrompt, { step }) => {
          const chunks = [];
          const response = await this.#rpc('agentStep', {
            text: stepPrompt,
            functionDefinitions,
            options: { ...options, firstStep: step === 1 }
          }, {
            signal,
            toolHandlers: handlers,
            onChunk: chunk => chunks.push(String(chunk))
          });
          // Não mostra chunks imediatamente: um JSON de ferramenta textual não deve aparecer no chat.
          return response || chunks.join('');
        }
      });
      if (result.text) onChunk?.(result.text);
      return result.text;
    } finally {
      await this.#rpc('agentFinish', {}, { timeoutMs: 10000 }).catch(error => this.logger(`[Agent][WARN] Falha ao finalizar sessão: ${error?.message || error}`));
      await this.refreshDiagnostics(true).then(snapshot => this.#logMemory('depois do agente', snapshot)).catch(() => undefined);
    }
  }

  async clearHistory() {
    if (!this.worker) return;
    await this.#rpc('clearHistory', {});
  }

  async unload() {
    this.logger('[Unload] Solicitação recebida para descarregar modelo.');
    this.logger(`[Unload] Modelo atual: ${this.state.modelPath || 'nenhum'}`);
    this.logger(`[Unload] Backend atual: ${this.state.backend || 'cpu'}`);
    const before = await this.refreshDiagnostics(true).catch(() => this.state.resourceSnapshot);
    this.#logMemory('antes de descarregar', before);
    this.state.engineState = 'unloading';
    this.state.loading = false;
    try {
      let result = { steps: [], errors: [] };
      if (this.worker) result = await this.#rpc('unload', {}, { timeoutMs: 30000 });
      this.state.loaded = false;
      this.state.modelPath = '';
      this.state.backend = 'cpu';
      this.state.gpuLayers = 'auto';
      this.state.engineState = 'unloaded';
      this.state.lastUnloadReport = result;
      this.state.lastError = null;
      this.state.processMemory = result?.processMemory || this.state.processMemory;
      const after = await this.refreshDiagnostics(true);
      this.#logMemory('depois de descarregar', after);
      this.logger('[Unload] Modelo descarregado com sucesso.');
      return { ...result, before, after };
    } catch (error) {
      this.state.engineState = 'error';
      this.state.lastError = error?.stack || error?.message || String(error);
      this.logger(`[Unload][ERRO] ${this.state.lastError}`);
      throw error;
    }
  }

  async restart() {
    const wasLoaded = this.state.loaded;
    this.state.engineState = 'unloading';
    await this.#terminateWorker();
    this.state.loaded = false;
    this.state.loading = false;
    this.state.modelPath = '';
    this.state.backend = 'cpu';
    this.state.processMemory = null;
    this.state.workerPid = null;
    this.state.engineState = 'notStarted';
    this.logger(`[Engine] Processo reiniciado${wasLoaded ? '; o modelo precisa ser recarregado' : ''}.`);
  }

  async refreshDiagnostics(forceGpuRefresh = false) {
    let processMemory = this.state.processMemory;
    if (this.worker) {
      try {
        const remote = await this.#rpc('diagnostics', {}, { timeoutMs: 5000 });
        processMemory = remote.processMemory || processMemory;
        this.state = { ...this.state, ...remote, processMemory, workerPid: remote.pid || this.worker.pid };
      } catch (error) {
        this.logger(`[Diagnostics][WARN] Diagnóstico do motor indisponível: ${error?.message || error}`);
      }
    }
    const resourceSnapshot = await this.monitor.snapshot({
      workerMemory: processMemory ? { pid: this.worker?.pid || this.state.workerPid || null, ...processMemory } : null,
      forceGpuRefresh
    });
    this.state.resourceSnapshot = resourceSnapshot;
    return resourceSnapshot;
  }

  async dispose() {
    try {
      if (this.worker) await this.#rpc('dispose', {}, { timeoutMs: 5000 });
    } catch (error) {
      this.logger(`[Engine][WARN] Falha no dispose remoto: ${error?.message || error}`);
    }
    await this.#terminateWorker();
  }

  async #ensureWorker() {
    if (this.worker?.connected) return this.readyPromise;
    const workerPath = path.join(__dirname, 'engine-worker.js');
    const worker = this.workerFactory
      ? this.workerFactory(workerPath)
      : fork(workerPath, [], {
          cwd: this.extensionPath,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OFFGRID_ENGINE_WORKER: '1' },
          execPath: process.execPath,
          execArgv: [],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          windowsHide: true
        });
    this.worker = worker;
    this.state.workerPid = worker.pid || null;
    this.state.engineState = 'loading';
    worker.stdout?.on('data', chunk => this.logger(`[Engine stdout] ${String(chunk).trim()}`));
    worker.stderr?.on('data', chunk => this.logger(`[Engine stderr] ${String(chunk).trim()}`));
    this.readyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tempo esgotado ao iniciar o processo do motor.')), 15000);
      const onReady = message => {
        if (message?.type !== 'ready') return;
        clearTimeout(timer);
        worker.off('message', onReady);
        this.state.workerPid = message.pid || worker.pid || null;
        this.state.engineState = this.state.loaded ? 'ready' : 'unloaded';
        this.logger(`[Engine] Processo iniciado. PID=${this.state.workerPid}.`);
        resolve();
      };
      worker.on('message', onReady);
    });
    worker.on('message', message => this.#onMessage(message));
    worker.on('exit', (code, signal) => this.#onExit(code, signal));
    worker.on('error', error => this.#onExit(null, null, error));
    await this.readyPromise;
  }

  #onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'log') {
      this.logger(`[Engine] ${message.message}`);
      return;
    }
    const pending = this.requests.get(message.requestId);
    if (message.type === 'toolCall') {
      const handler = pending?.toolHandlers?.[message.name];
      this.logger(`[Agent] Tool call nativa recebida: ${message.name}.`);
      if (!handler) {
        this.logger(`[Agent][ERRO] Ferramenta não disponível: ${message.name}.`);
        this.worker?.send({ type: 'toolResult', callId: message.callId, error: { message: `Ferramenta não disponível: ${message.name}` } });
        return;
      }
      const startedAt = Date.now();
      Promise.resolve().then(() => handler(message.args)).then(
        result => {
          this.logger(`[Agent] Ferramenta ${message.name} concluída em ${Date.now() - startedAt} ms.`);
          this.worker?.send({ type: 'toolResult', callId: message.callId, result });
        },
        error => {
          this.logger(`[Agent][ERRO] Ferramenta ${message.name}: ${error?.stack || error}`);
          this.worker?.send({ type: 'toolResult', callId: message.callId, error: { message: error?.message || String(error), stack: error?.stack || '' } });
        }
      );
      return;
    }
    if (!pending) return;
    if (message.type === 'chunk') {
      pending.onChunk?.(message.chunk);
      return;
    }
    if (message.type === 'result') {
      this.requests.delete(message.requestId);
      pending.cleanup?.();
      pending.resolve(message.result);
    } else if (message.type === 'error') {
      this.requests.delete(message.requestId);
      pending.cleanup?.();
      pending.reject(reviveError(message.error));
    }
  }

  #onExit(code, signal, error = null) {
    if (!this.worker) return;
    const reason = error || new Error(`Processo do motor encerrado${code !== null ? ` com código ${code}` : ''}${signal ? ` (${signal})` : ''}.`);
    for (const pending of this.requests.values()) {
      pending.cleanup?.();
      pending.reject(reason);
    }
    this.requests.clear();
    this.worker = null;
    this.readyPromise = null;
    this.state.loaded = false;
    this.state.loading = false;
    this.state.engineState = 'error';
    this.state.modelPath = '';
    this.state.processMemory = null;
    this.state.workerPid = null;
    this.state.lastError = reason.stack || reason.message;
    this.logger(`[Engine][ERRO] ${reason.message}`);
  }

  async #terminateWorker() {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.readyPromise = null;
    try { worker.disconnect?.(); } catch { /* ignore */ }
    try { worker.kill?.(); } catch { /* ignore */ }
  }

  async #rpc(method, params, { signal, onChunk, toolHandlers, timeoutMs = 0 } = {}) {
    await this.#ensureWorker();
    const requestId = `r${Date.now()}-${++this.counter}`;
    return new Promise((resolve, reject) => {
      let timer = null;
      const abort = () => this.worker?.send({ type: 'cancel', requestId });
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
      };
      if (signal?.aborted) return reject(Object.assign(new Error('Operação cancelada.'), { name: 'AbortError' }));
      signal?.addEventListener?.('abort', abort, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.requests.delete(requestId);
          abort();
          cleanup();
          reject(new Error(`Tempo esgotado no motor (${method}).`));
        }, timeoutMs);
      }
      this.requests.set(requestId, { resolve, reject, onChunk, toolHandlers, cleanup });
      this.worker.send({ type: 'request', requestId, method, params }, error => {
        if (!error) return;
        this.requests.delete(requestId);
        cleanup();
        reject(error);
      });
    });
  }

  #logMemory(label, snapshot) {
    const summary = summarizeResources(snapshot);
    this.logger(`[Memory] ${label}: RAM=${summary.ram}; Motor=${summary.engine}; GPU=${summary.gpu}; backend=${this.state.backend}; PID=${this.state.workerPid || '—'}`);
  }
}

module.exports = { EngineProcessClient, reviveError };
