import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import type {
  EngineDiagnostics, EngineLoadOptions, EngineRequestMethod, EngineResult, EngineErrorMessage,
  EngineChunk, EngineReady, EngineLog, ResourceSnapshot, ToolCall, ToolResult
} from '../types/contracts';
import { AgentLoop } from '../agent/AgentLoop';
import { ResourceMonitor } from '../diagnostics/ResourceMonitor';
import { chooseLoadAttempts, HardwareProfileStore } from '../diagnostics/HardwareProfile';
import type { FileLogger } from '../diagnostics/FileLogger';
import { isDeviceMemoryError } from '../llm/LlamaServerEngine';
import { LlamaServerManager, llamaServerExecutablePath } from '../llm/LlamaServerManager';

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
  private readonly intentionalStops = new WeakSet<ChildProcess>();
  private readonly handledExits = new WeakSet<ChildProcess>();
  private counter = 0;
  private busyOperation: 'load' | 'prompt' | 'agent' | 'unload' | undefined;
  private readonly monitor: ResourceMonitor;
  private readonly profiles: HardwareProfileStore;
  private state: EngineDiagnostics = {
    loaded: false, loading: false, engineState: 'notStarted', agentActive: false, modelPath: '',
    backend: 'cpu', contextSize: null, gpuLayers: 'auto', sequenceAcquisitions: 0, workerPid: null,
    lastFallback: null, lastUnloadReport: null, lastError: null
  };

  private readonly serverManager: LlamaServerManager;

  constructor(
    private readonly extensionPath: string,
    private readonly storagePath: string,
    private readonly logger: FileLogger,
    catalog: import('../models/ModelCatalog').ModelCatalog
  ) {
    this.monitor = new ResourceMonitor(extensionPath, logger);
    this.profiles = new HardwareProfileStore(storagePath);
    this.serverManager = new LlamaServerManager(extensionPath, storagePath, catalog);
  }

  async init(): Promise<void> { await this.profiles.init(); }
  get diagnostics(): EngineDiagnostics { return { ...this.state }; }
  get isLoaded(): boolean { return this.state.loaded; }
  get isBusy(): boolean { return Boolean(this.busyOperation); }

  async load(options: EngineLoadOptions, systemPrompt: string): Promise<EngineDiagnostics> {
    this.busyOperation = 'load';
    this.state = { ...this.state, loading: true, engineState: 'loading', lastError: null };
    try {
      // Garante que o binário llama-server está instalado antes de tentar carregar.
      // Se não estiver, baixa do release do GitHub automaticamente.
      if (!this.serverManager.isInstalled()) {
        this.logger.info('model', '[Load] Binário llama-server não encontrado. Iniciando download...');
        const repoUrl = 'https://github.com/rmagnocopilot/offgrid';
        await this.serverManager.ensureInstalled(repoUrl, (progress) => {
          this.logger.info('model', `[Load][Binário] ${progress.message}`);
        });
        this.logger.info('model', '[Load] Binário llama-server instalado com sucesso.');
      }

      const before = await this.refreshResources(true, true);
      this.logResources('antes de carregar', before);
      const saved = this.profiles.get(options.modelPath);
      const attempts = chooseLoadAttempts(options, before, saved);
      this.logger.info('model', `[Load] Plano: ${attempts.map(item => `${item.gpu}/${item.gpuLayers}`).join(' → ')}`);
      let lastError: unknown;

      for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index];
        if (!attempt) continue;
        try {
          const result = await this.rpc<EngineDiagnostics>('load', {
            options: { ...options, gpu: attempt.gpu, gpuLayers: attempt.gpuLayers, fallbackToCpu: false },
            systemPrompt
          }, { timeoutMs: 0 });
          this.state = {
            ...result,
            loading: false,
            engineState: 'ready',
            workerPid: this.worker?.pid ?? result.workerPid,
            lastFallback: index ? { from: attempts[0], to: attempt } : null
          };
          await this.profiles.recordSuccess(options.modelPath, attempt);
          this.state.resources = await this.refreshResources(true, false);
          this.logResources('depois de carregar', this.state.resources);
          return this.diagnostics;
        } catch (error) {
          lastError = error;
          this.logger.warn('model', `[Load] Tentativa ${attempt.gpu}/${attempt.gpuLayers} falhou.`, error);
          if (index + 1 >= attempts.length) break;
          if (attempt.gpu === 'cpu' && !isDeviceMemoryError(error)) break;
        }
      }
      throw lastError ?? new Error('Não foi possível carregar o modelo.');
    } catch (error) {
      this.state = {
        ...this.state,
        loaded: false,
        loading: false,
        engineState: 'error',
        lastError: error instanceof Error ? error.stack ?? error.message : String(error)
      };
      throw error;
    } finally {
      this.busyOperation = undefined;
    }
  }

  async prompt(text: string, options: { signal?: AbortSignal; onChunk?: (chunk: string) => void; maxTokens?: number; temperature?: number } = {}): Promise<string> {
    this.busyOperation = 'prompt';
    try {
      return await this.rpc<string>('prompt', {
        text,
        options: { maxTokens: options.maxTokens, temperature: options.temperature }
      }, { signal: options.signal, onChunk: options.onChunk });
    } finally {
      this.busyOperation = undefined;
    }
  }

  async runAgent(params: {
    initialPrompt: string;
    taskReminder?: string;
    systemPrompt: string;
    maxSteps: number;
    diagnosticMode: boolean;
    maxTokens?: number;
    signal?: AbortSignal;
    executeTool: (call: ToolCall) => Promise<ToolResult>;
  }): Promise<string> {
    this.busyOperation = 'agent';
    let started = false;
    try {
      const startStartedAt = Date.now();
      this.logger.debug(
        'agent',
        '[Engine][1/3] Enviando agentStart ao processo do motor.'
      );

      await this.rpc('agentStart', { systemPrompt: params.systemPrompt }, { signal: params.signal });
      started = true;

      this.logger.debug(
        'agent',
        `[Engine][1/3] agentStart concluído em ${Date.now() - startStartedAt} ms.`
      );

      const loop = new AgentLoop();
      const result = await loop.run({
        initialPrompt: params.initialPrompt,
        taskReminder: params.taskReminder,
        maxSteps: params.maxSteps,
        diagnosticMode: params.diagnosticMode,
        signal: params.signal,
        log: (level, message) => this.logger.log(level, 'agent', message),
        executeTool: params.executeTool,
        invokeStep: async (prompt, step) => {
          const stepStartedAt = Date.now();
          const stepMaxTokens = prompt.includes('<correcao_chamada_ferramenta>')
            ? Math.min(params.maxTokens ?? 192, 192)
            : step === 1
              ? params.maxTokens
              : Math.min(params.maxTokens ?? 256, 256);
          this.logger.info(
            'agent',
            [
              `[Engine][2/3] Enviando agentStep ${step}.`,
              `prompt=${prompt.length} caracteres`,
              `primeiraEtapa=${step === 1}`,
              `maxTokens=${stepMaxTokens ?? 'configuracao do motor'}`
            ].join(' ')
          );

          try {
            const response = await this.rpc<string>('agentStep', {
              text: prompt,
              options: {
                firstStep: step === 1,
                systemPrompt: params.systemPrompt,
                maxTokens: stepMaxTokens
              }
            }, { signal: params.signal });

            this.logger.info(
              'agent',
              `[Engine][2/3] agentStep ${step} concluído em ${Date.now() - stepStartedAt} ms; resposta=${response.length} caracteres.`
            );
            return response;
          } catch (error) {
            const elapsed = Date.now() - stepStartedAt;
            if ((error as Error)?.name === 'AbortError') {
              this.logger.info(
                'agent',
                `[Engine][2/3] agentStep ${step} cancelado após ${elapsed} ms.`
              );
            } else {
              this.logger.error(
                'agent',
                `[Engine][2/3] agentStep ${step} falhou após ${elapsed} ms.`,
                error
              );
            }
            throw error;
          }
        }
      });
      return result.text;
    } finally {
      if (started && params.signal?.aborted) {
        this.logger.warn(
          'agent',
          [
            '[Engine][3/3] Geração cancelada.',
            'O runtime não confirmou o encerramento;',
            'reiniciando o processo isolado para evitar bloqueio.'
          ].join(' ')
        );

        await this.restart();

        this.logger.info(
          'agent',
          '[Engine][3/3] Processo isolado reiniciado após cancelamento.'
        );
      } else if (started) {
        const finishStartedAt = Date.now();

        this.logger.debug(
          'agent',
          '[Engine][3/3] Enviando agentFinish ao processo do motor.'
        );

        await this.rpc('agentFinish', {}, { timeoutMs: 15_000, signal: params.signal })
          .then(() => {
            this.logger.debug(
              'agent',
              `[Engine][3/3] agentFinish concluído em ${Date.now() - finishStartedAt} ms.`
            );
          })
          .catch(error => {
            this.logger.warn(
              'agent',
              `[Engine][3/3] agentFinish falhou após ${Date.now() - finishStartedAt} ms.`,
              error
            );
          });
      }
      this.busyOperation = undefined;
    }
  }

  async unload(): Promise<void> {
    this.busyOperation = 'unload';
    this.state.engineState = 'unloading';
    try {
      const before = await this.refreshResources(true, true);
      this.logResources('antes de descarregar', before);
      const report = this.worker ? await this.rpc<any>('unload', {}, { timeoutMs: 60_000 }) : undefined;
      await this.terminate();
      this.state = {
        ...this.state,
        loaded: false,
        loading: false,
        engineState: 'unloaded',
        agentActive: false,
        modelPath: '',
        backend: 'cpu',
        contextSize: null,
        gpuLayers: 'auto',
        workerPid: null,
        lastUnloadReport: report ?? null,
        lastError: null
      };
      this.state.resources = await this.monitor.snapshot({ forceGpu: true });
      this.logResources('depois de descarregar', this.state.resources);
    } catch (error) {
      this.state.engineState = 'error';
      this.state.lastError = error instanceof Error ? error.stack ?? error.message : String(error);
      throw error;
    } finally {
      this.busyOperation = undefined;
    }
  }

  async restart(): Promise<void> {
    await this.terminate();
    this.state = {
      ...this.state,
      loaded: false,
      loading: false,
      engineState: 'notStarted',
      agentActive: false,
      modelPath: '',
      backend: 'cpu',
      contextSize: null,
      gpuLayers: 'auto',
      workerPid: null,
      lastError: null
    };
  }

  async clearHistory(): Promise<void> { if (this.worker) await this.rpc('clearHistory', {}); }
  async clearHardwareProfiles(): Promise<void> { await this.profiles.clear(); }

  async refreshResources(forceGpu = false, skipEngine = false): Promise<ResourceSnapshot> {
    if (!skipEngine && this.worker && !this.busyOperation) {
      try {
        const remote = await this.rpc<EngineDiagnostics>('diagnostics', {}, { timeoutMs: 10_000 });
        this.state = { ...this.state, ...remote, workerPid: this.worker.pid ?? remote.workerPid };
      } catch (error) {
        this.logger.debug('diagnostics', `Diagnóstico remoto indisponível: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const snapshot = await this.monitor.snapshot({
      workerPid: this.worker?.pid,
      forceGpu,
      skipGpu: this.busyOperation === 'load' && !forceGpu
    });
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
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OFFGRID_ENGINE_WORKER: '1',
        OFFGRID_SERVER_BINARY: llamaServerExecutablePath(
          require('node:path').join(this.storagePath, 'binaries')
        )
      },
      execPath: process.execPath,
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    this.worker = worker;

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Tempo esgotado ao iniciar o processo do motor.'));
      }, 20_000);
      const onReady = (message: unknown): void => {
        const value = message as EngineReady;
        if (value?.type !== 'ready') return;
        cleanup();
        this.state.workerPid = value.pid;
        resolve();
      };
      const onStartupError = (error: Error): void => { cleanup(); reject(error); };
      const onStartupExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(new Error(`Motor encerrou antes de ficar pronto: code=${code}; signal=${signal}`));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.off('message', onReady);
        worker.off('error', onStartupError);
        worker.off('exit', onStartupExit);
      };
      worker.on('message', onReady);
      worker.once('error', onStartupError);
      worker.once('exit', onStartupExit);
    });
    this.ready = ready;

    worker.stdout?.on('data', chunk => this.logger.debug('model', `[Engine stdout] ${String(chunk).trim()}`));
    worker.stderr?.on('data', chunk => this.logger.debug('model', `[Engine stderr] ${String(chunk).trim()}`));
    worker.on('message', message => this.onMessage(message));
    worker.on('exit', (code, signal) => this.onExit(worker, new Error(`Motor encerrado: code=${code}; signal=${signal}`)));
    worker.on('error', error => this.onExit(worker, error));

    try {
      await ready;
    } catch (error) {
      if (this.worker === worker) await this.terminate();
      throw error;
    }
  }

  private onMessage(message: unknown): void {
    const value = message as EngineResult | EngineErrorMessage | EngineChunk | EngineReady | EngineLog;
    if (!value || typeof value !== 'object') return;
    if (value.type === 'log') {
      this.logger.log(value.level, 'model', value.message);
      return;
    }
    if (value.type === 'ready') return;
    const requestId = (value as EngineResult | EngineErrorMessage | EngineChunk).requestId;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (value.type === 'chunk') { pending.onChunk?.(value.chunk); return; }
    this.pending.delete(requestId);
    pending.cleanup();
    if (value.type === 'result') pending.resolve(value.result);
    else if (value.type === 'error') {
      pending.reject(Object.assign(new Error(value.error.message), {
        name: value.error.name,
        stack: value.error.stack,
        details: value.error.details
      }));
    }
  }

  private onExit(worker: ChildProcess, error: Error): void {
    if (this.handledExits.has(worker)) return;
    this.handledExits.add(worker);
    const intentional = this.intentionalStops.has(worker);

    if (this.worker === worker) {
      this.worker = undefined;
      this.ready = undefined;
    }
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(intentional ? Object.assign(new Error('Motor encerrado intencionalmente.'), { name: 'AbortError' }) : error);
    }
    this.pending.clear();

    if (intentional) return;
    this.logger.error('model', 'O processo isolado do motor foi encerrado inesperadamente.', error);
    this.state = {
      ...this.state,
      loaded: false,
      loading: false,
      engineState: 'error',
      workerPid: null,
      lastError: error.stack ?? error.message
    };
  }

  private async terminate(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = undefined;
    if (!worker) return;

    this.intentionalStops.add(worker);
    const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
    try { if (worker.connected) worker.disconnect(); } catch { /* ignorar */ }
    try { worker.kill(); } catch { /* ignorar */ }
    await Promise.race([exited, delay(2_000)]);
    if (worker.exitCode === null && worker.signalCode === null) {
      try { worker.kill('SIGKILL'); } catch { /* ignorar */ }
      await Promise.race([exited, delay(1_000)]);
    }
  }

  private async rpc<T = unknown>(method: EngineRequestMethod, params: Record<string, unknown>, options: { signal?: AbortSignal; onChunk?: (chunk: string) => void; timeoutMs?: number } = {}): Promise<T> {
    await this.ensureWorker();
    const requestId = `r${Date.now()}-${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const abort = (): void => {
        this.logger.info(
          'agent',
          [
            '[Abort][2/4] Sinal recebido pelo EngineClient.',
            `requestId=${requestId}`,
            `método=${method}`,
            `worker=${Boolean(this.worker)}`,
            `conectado=${Boolean(this.worker?.connected)}`
          ].join(' ')
        );

        const pendingRequest = this.pending.get(requestId);
        if (pendingRequest) {
          this.pending.delete(requestId);
          pendingRequest.cleanup();
          pendingRequest.reject(
            Object.assign(
              new Error('Operação cancelada pelo usuário.'),
              { name: 'AbortError' }
            )
          );
          this.logger.info(
            'agent',
            `[Abort][2/4] Requisição local encerrada. requestId=${requestId}.`
          );
        }

        try {
          this.worker?.send(
            { type: 'cancel', requestId },
            error => {
              if (error) {
                this.logger.error(
                  'agent',
                  `[Abort][2/4] Falha ao enviar cancel ao worker. requestId=${requestId}.`,
                  error
                );
                return;
              }
              this.logger.info(
                'agent',
                `[Abort][2/4] Cancel enviado ao worker. requestId=${requestId}.`
              );
            }
          );
        } catch (error) {
          this.logger.error(
            'agent',
            `[Abort][2/4] Exceção ao enviar cancel ao worker. requestId=${requestId}.`,
            error
          );
        }
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      if (options.signal?.aborted) {
        reject(Object.assign(new Error('Operação cancelada.'), { name: 'AbortError' }));
        return;
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(requestId);
          abort();
          cleanup();
          reject(new Error(`Tempo esgotado no motor (${method}).`));
        }, options.timeoutMs);
      }
      this.pending.set(requestId, { resolve, reject, onChunk: options.onChunk, cleanup });
      try {
        this.worker!.send({ type: 'request', requestId, method, params }, error => {
          if (!error) return;
          this.pending.delete(requestId);
          cleanup();
          reject(error);
        });
      } catch (error) {
        this.pending.delete(requestId);
        cleanup();
        reject(error);
      }
    });
  }
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }