import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import type {
  EngineDiagnostics, EngineLoadOptions, EngineRequestMethod, EngineResult, EngineErrorMessage,
  EngineChunk, EngineReady, EngineLog, ResourceSnapshot, ToolCall, ToolResult
} from '../types/contracts';
import { AgentLoop } from '../agent/AgentLoop';
import { ResourceMonitor } from '../diagnostics/ResourceMonitor';
import { chooseLoadAttempts, HardwareProfileStore, type LoadAttempt } from '../diagnostics/HardwareProfile';
import type { FileLogger } from '../diagnostics/FileLogger';
import { isDeviceMemoryError } from '../llm/LlamaEngine';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: unknown) => void;
  onChunk?: (chunk: string) => void;
  cleanup: () => void;
}

export class EngineClient {
  private worker?: ChildProcess;
  private ready?: Promise<void>;
  private readonly pending = new Map<string, PendingRequest>();
  private counter = 0;
  private busyOperation: 'load' | 'prompt' | 'agent' | 'unload' | undefined;
  private readonly monitor: ResourceMonitor;
  private readonly profiles: HardwareProfileStore;
  private state: EngineDiagnostics = {
    loaded: false, loading: false, engineState: 'notStarted', agentActive: false, modelPath: '',
    backend: 'cpu', contextSize: null, gpuLayers: 'auto', sequenceAcquisitions: 0, workerPid: null,
    lastFallback: null, lastUnloadReport: null, lastError: null
  };

  constructor(
    private readonly extensionPath: string,
    private readonly storagePath: string,
    private readonly logger: FileLogger
  ) {
    this.monitor = new ResourceMonitor(extensionPath, logger);
    this.profiles = new HardwareProfileStore(storagePath);
  }

  async init(): Promise<void> { await this.profiles.init(); }
  get diagnostics(): EngineDiagnostics { return { ...this.state }; }
  get isLoaded(): boolean { return this.state.loaded; }
  get isBusy(): boolean { return Boolean(this.busyOperation); }

  async load(options: EngineLoadOptions, systemPrompt: string): Promise<EngineDiagnostics> {
    this.busyOperation = 'load';
    this.state = { ...this.state, loading: true, engineState: 'loading', lastError: null };
    const before = await this.refreshResources(true, true);
    this.logResources('antes de carregar', before);
    const saved = this.profiles.get(options.modelPath);
    const attempts = chooseLoadAttempts(options, before, saved);
    this.logger.info('model', `[Load] Plano: ${attempts.map(item => `${item.gpu}/${item.gpuLayers}`).join(' → ')}`);
    let lastError: unknown;
    try {
      for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index];
        if (!attempt) continue;
        try {
          const result = await this.rpc<EngineDiagnostics>('load', {
            options: { ...options, gpu: attempt.gpu, gpuLayers: attempt.gpuLayers, fallbackToCpu: false },
            systemPrompt
          }, { timeoutMs: 0 });
          this.state = { ...result, loading: false, engineState: 'ready', workerPid: this.worker?.pid ?? result.workerPid, lastFallback: index ? { from: attempts[0], to: attempt } : null };
          await this.profiles.recordSuccess(options.modelPath, attempt);
          this.state.resources = await this.refreshResources(true, false);
          this.logResources('depois de carregar', this.state.resources);
          return this.diagnostics;
        } catch (error) {
          lastError = error;
          this.logger.warn('model', `[Load] Tentativa ${attempt.gpu}/${attempt.gpuLayers} falhou.`, error);
          const hasNext = index + 1 < attempts.length;
          if (!hasNext || (!isDeviceMemoryError(error) && attempt.gpu === 'cpu')) break;
        }
      }
      throw lastError ?? new Error('Não foi possível carregar o modelo.');
    } catch (error) {
      this.state = { ...this.state, loaded: false, loading: false, engineState: 'error', lastError: error instanceof Error ? error.stack ?? error.message : String(error) };
      throw error;
    } finally { this.busyOperation = undefined; }
  }

  async prompt(text: string, options: { signal?: AbortSignal; onChunk?: (chunk: string) => void; maxTokens?: number; temperature?: number } = {}): Promise<string> {
    this.busyOperation = 'prompt';
    try { return await this.rpc<string>('prompt', { text, options: { maxTokens: options.maxTokens, temperature: options.temperature } }, { signal: options.signal, onChunk: options.onChunk }); }
    finally { this.busyOperation = undefined; }
  }

  async runAgent(params: {
    initialPrompt: string;
    systemPrompt: string;
    maxSteps: number;
    diagnosticMode: boolean;
    signal?: AbortSignal;
    executeTool: (call: ToolCall) => Promise<ToolResult>;
  }): Promise<string> {
    this.busyOperation = 'agent';
    await this.rpc('agentStart', {}, { signal: params.signal });
    try {
      const loop = new AgentLoop();
      const result = await loop.run({
        initialPrompt: params.initialPrompt,
        maxSteps: params.maxSteps,
        diagnosticMode: params.diagnosticMode,
        signal: params.signal,
        log: (level, message) => this.logger.log(level, 'agent', message),
        executeTool: params.executeTool,
        invokeStep: (prompt, step) => this.rpc<string>('agentStep', {
          text: prompt,
          options: { firstStep: step === 1, systemPrompt: params.systemPrompt }
        }, { signal: params.signal })
      });
      return result.text;
    } finally {
      await this.rpc('agentFinish', {}, { timeoutMs: 15_000 }).catch(error => this.logger.warn('agent', 'Falha ao finalizar Agente.', error));
      this.busyOperation = undefined;
    }
  }

  async unload(): Promise<void> {
    this.busyOperation = 'unload';
    this.state.engineState = 'unloading';
    const before = await this.refreshResources(true, true);
    this.logResources('antes de descarregar', before);
    try {
      const report = this.worker ? await this.rpc<any>('unload', {}, { timeoutMs: 60_000 }) : undefined;
      await this.terminate();
      await new Promise(resolve => setTimeout(resolve, 300));
      this.state = { ...this.state, loaded: false, loading: false, engineState: 'unloaded', modelPath: '', backend: 'cpu', gpuLayers: 'auto', workerPid: null, lastUnloadReport: report ?? null, lastError: null };
      this.state.resources = await this.monitor.snapshot({ forceGpu: true });
      this.logResources('depois de descarregar', this.state.resources);
    } catch (error) {
      this.state.engineState = 'error';
      this.state.lastError = error instanceof Error ? error.stack ?? error.message : String(error);
      throw error;
    } finally { this.busyOperation = undefined; }
  }

  async restart(): Promise<void> {
    await this.terminate();
    this.state = { ...this.state, loaded: false, loading: false, engineState: 'notStarted', modelPath: '', backend: 'cpu', workerPid: null };
  }

  async clearHistory(): Promise<void> { if (this.worker) await this.rpc('clearHistory', {}); }
  async clearHardwareProfiles(): Promise<void> { await this.profiles.clear(); }

  async refreshResources(forceGpu = false, skipEngine = false): Promise<ResourceSnapshot> {
    if (!skipEngine && this.worker && !this.busyOperation) {
      try {
        const remote = await this.rpc<EngineDiagnostics>('diagnostics', {}, { timeoutMs: 10_000 });
        this.state = { ...this.state, ...remote, workerPid: this.worker.pid ?? remote.workerPid };
      } catch (error) { this.logger.debug('diagnostics', `Diagnóstico remoto indisponível: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const snapshot = await this.monitor.snapshot({ workerPid: this.worker?.pid, forceGpu, skipGpu: this.busyOperation === 'load' && !forceGpu });
    this.state.resources = snapshot;
    return snapshot;
  }

  async dispose(): Promise<void> {
    if (this.worker) await this.rpc('dispose', {}, { timeoutMs: 5000 }).catch(() => undefined);
    await this.terminate();
  }


  private logResources(stage: string, snapshot: ResourceSnapshot): void {
    const gigabytes = (value: number): string => `${(value / 1024 ** 3).toFixed(2)} GB`;
    const gpu = snapshot.gpus[0];
    this.logger.debug('diagnostics', [
      `[Memory] ${stage}: RAM=${gigabytes(snapshot.systemRam.freeBytes)} livres / ${gigabytes(snapshot.systemRam.totalBytes)}`,
      `Motor=${snapshot.engineRam ? gigabytes(snapshot.engineRam.workingSetBytes) : 'não iniciado'}`,
      `GPU=${gpu ? `${gpu.name}: ${gigabytes(gpu.freeBytes)} livres / ${gigabytes(gpu.totalBytes)}` : 'indisponível'}`,
      `backend=${this.state.backend}`,
      `PID=${snapshot.engineRam?.pid ?? '—'}`
    ].join('; '));
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker?.connected && this.ready) return this.ready;
    const workerPath = path.join(__dirname, 'EngineWorker.js');
    const worker = fork(workerPath, [], {
      cwd: this.extensionPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OFFGRID_ENGINE_WORKER: '1' },
      execPath: process.execPath,
      execArgv: [], stdio: ['ignore','pipe','pipe','ipc']
    });
    this.worker = worker;
    worker.stdout?.on('data', chunk => this.logger.debug('model', `[Engine stdout] ${String(chunk).trim()}`));
    worker.stderr?.on('data', chunk => this.logger.debug('model', `[Engine stderr] ${String(chunk).trim()}`));
    worker.on('message', message => this.onMessage(message));
    worker.on('exit', (code, signal) => this.onExit(new Error(`Motor encerrado: code=${code}; signal=${signal}`)));
    worker.on('error', error => this.onExit(error));
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Tempo esgotado ao iniciar o processo do motor.')), 20_000);
      const listener = (message: unknown): void => {
        const value = message as EngineReady;
        if (value?.type !== 'ready') return;
        clearTimeout(timer); worker.off('message', listener); this.state.workerPid = value.pid; resolve();
      };
      worker.on('message', listener);
    });
    return this.ready;
  }

  private onMessage(message: unknown): void {
    const value = message as EngineResult | EngineErrorMessage | EngineChunk | EngineReady | EngineLog;
    if (!value || typeof value !== 'object') return;
    if (value.type === 'log') { this.logger.log(value.level, value.category as any, value.message); return; }
    if (value.type === 'ready') return;
    const pending = this.pending.get((value as any).requestId);
    if (!pending) return;
    if (value.type === 'chunk') { pending.onChunk?.(value.chunk); return; }
    this.pending.delete((value as any).requestId); pending.cleanup();
    if (value.type === 'result') pending.resolve(value.result);
    else if (value.type === 'error') pending.reject(Object.assign(new Error(value.error.message), { name: value.error.name, stack: value.error.stack, details: value.error.details }));
  }

  private onExit(error: Error): void {
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
    this.pending.clear(); this.worker = undefined; this.ready = undefined;
    this.state = { ...this.state, loaded: false, loading: false, engineState: 'error', workerPid: null, lastError: error.stack ?? error.message };
  }

  private async terminate(): Promise<void> {
    const worker = this.worker; this.worker = undefined; this.ready = undefined;
    if (!worker) return;
    try { worker.disconnect(); } catch { /* ignore */ }
    try { worker.kill(); } catch { /* ignore */ }
  }

  private async rpc<T = unknown>(method: EngineRequestMethod, params: Record<string, unknown>, options: { signal?: AbortSignal; onChunk?: (chunk: string) => void; timeoutMs?: number } = {}): Promise<T> {
    await this.ensureWorker();
    const requestId = `r${Date.now()}-${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const abort = (): void => { this.worker?.send({ type: 'cancel', requestId }); };
      const cleanup = (): void => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
      if (options.signal?.aborted) return reject(Object.assign(new Error('Operação cancelada.'), { name: 'AbortError' }));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs && options.timeoutMs > 0) timer = setTimeout(() => { this.pending.delete(requestId); abort(); cleanup(); reject(new Error(`Tempo esgotado no motor (${method}).`)); }, options.timeoutMs);
      this.pending.set(requestId, { resolve, reject, onChunk: options.onChunk, cleanup });
      this.worker!.send({ type: 'request', requestId, method, params }, error => {
        if (!error) return;
        this.pending.delete(requestId); cleanup(); reject(error);
      });
    });
  }
}
