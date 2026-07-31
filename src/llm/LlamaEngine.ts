import * as fs from 'node:fs';
import type { EngineDiagnostics, EngineLoadOptions, EffectiveBackend, UnloadReport, UnloadStep } from '../types/contracts';

export type EngineLogger = (level: 'trace' | 'debug' | 'info' | 'warn' | 'error', message: string) => void;

type NodeLlamaCppRuntime = typeof import('node-llama-cpp');

/**
 * node-llama-cpp é ESM. Como o Offgrid ainda é compilado em CommonJS para o
 * Extension Host, o TypeScript não pode transformar este import() em require().
 * A Function preserva o import dinâmico nativo em tempo de execução.
 */
export async function importNodeLlamaCppRuntime(): Promise<NodeLlamaCppRuntime> {
  const nativeImport = Function('return import("node-llama-cpp")') as () => Promise<NodeLlamaCppRuntime>;
  return nativeImport();
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
}

export function isDeviceMemoryError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  return [
    'outofdevicememory','out of device memory','insufficientmemoryerror','unable to allocate vulkan',
    'failed to allocate vulkan','device memory allocation','failed to allocate buffer',
    'failed to allocate memory','not enough memory','out of memory'
  ].some(fragment => text.includes(fragment));
}

export class LlamaEngine {
  private llama: any;
  private model: any;
  private context: any;
  private sequence: any;
  private session: any;
  private options?: EngineLoadOptions;
  private systemPrompt = '';
  private generationQueue: Promise<unknown> = Promise.resolve();
  private loadQueue: Promise<unknown> = Promise.resolve();
  private loading = false;
  private agentActive = false;
  private sequenceAcquisitions = 0;
  private state: EngineDiagnostics['engineState'] = 'notStarted';
  private lastError: string | null = null;
  private lastFallback: unknown | null = null;
  private lastUnloadReport: UnloadReport | null = null;

  constructor(private readonly log: EngineLogger) {}

  get isLoaded(): boolean { return Boolean(this.model && this.context && this.sequence && this.session); }
  get diagnostics(): EngineDiagnostics {
    const backend = normalizeBackend(this.llama?.gpu);
    return {
      loaded: this.isLoaded,
      loading: this.loading,
      engineState: this.state,
      agentActive: this.agentActive,
      modelPath: this.options?.modelPath ?? '',
      backend,
      contextSize: this.options?.contextSize ?? null,
      gpuLayers: this.options?.gpuLayers ?? 'auto',
      sequenceAcquisitions: this.sequenceAcquisitions,
      workerPid: process.pid,
      lastFallback: this.lastFallback,
      lastUnloadReport: this.lastUnloadReport,
      lastError: this.lastError
    };
  }

  async load(options: EngineLoadOptions, systemPrompt: string): Promise<EngineDiagnostics> {
    const task = this.loadQueue.catch(() => undefined).then(() => this.loadInternal(options, systemPrompt));
    this.loadQueue = task;
    return task;
  }

  private async loadInternal(options: EngineLoadOptions, systemPrompt: string): Promise<EngineDiagnostics> {
    if (!fs.existsSync(options.modelPath)) throw new Error(`Modelo não encontrado: ${options.modelPath}`);
    const same = this.isLoaded && this.options && JSON.stringify(this.options) === JSON.stringify(options);
    if (same) return this.diagnostics;
    this.loading = true;
    this.state = 'loading';
    this.lastError = null;
    const started = Date.now();
    try {
      await this.disposeResources('nova carga', false);
      const runtime = await importNodeLlamaCppRuntime();
      const requested = options.gpu;
      const llamaOptions: Record<string, unknown> = { logLevel: runtime.LlamaLogLevel?.warn };
      if (requested !== 'auto') llamaOptions.gpu = requested === 'cpu' ? false : requested;
      this.log('debug', `[Load] Backend solicitado: ${requested}`);
      this.llama = await runtime.getLlama(llamaOptions);
      const modelOptions: Record<string, unknown> = { modelPath: options.modelPath };
      if (requested === 'cpu') modelOptions.gpuLayers = 0;
      else if (typeof options.gpuLayers === 'number') modelOptions.gpuLayers = options.gpuLayers;
      const loadWeightsAt = Date.now();
      this.model = await this.llama.loadModel(modelOptions);
      this.log('debug', `[Perf] loadWeights: ${Date.now() - loadWeightsAt} ms`);
      const contextAt = Date.now();
      this.context = await this.model.createContext({ contextSize: options.contextSize, sequences: 1 });
      this.log('debug', `[Perf] createContext: ${Date.now() - contextAt} ms`);
      this.sequence = this.context.getSequence();
      this.sequenceAcquisitions += 1;
      this.session = new runtime.LlamaChatSession({ contextSequence: this.sequence, systemPrompt });
      this.options = options;
      this.systemPrompt = systemPrompt;
      this.state = 'ready';
      this.log('info', `[Load] Modelo carregado. Backend efetivo: ${this.diagnostics.backend}`);
      this.log('debug', `[Perf] loadModel: ${Date.now() - started} ms`);
      return this.diagnostics;
    } catch (error) {
      this.lastError = errorText(error);
      this.state = 'error';
      this.log('error', `[Load][ERRO] ${this.lastError}`);
      await this.disposeResources('falha de carregamento', false);
      throw error;
    } finally {
      this.loading = false;
    }
  }

  async prompt(text: string, options: { signal?: AbortSignal; onChunk?: (chunk: string) => void; maxTokens?: number; temperature?: number } = {}): Promise<string> {
    return this.enqueue(async () => {
      this.ensureLoaded();
      const started = Date.now();
      try {
        return await this.session.prompt(text, {
          maxTokens: options.maxTokens ?? this.options!.maxTokens,
          temperature: options.temperature ?? this.options!.temperature,
          signal: options.signal,
          onTextChunk: (chunk: string) => options.onChunk?.(chunk)
        });
      } finally {
        this.log('debug', `[Perf] prompt: ${Date.now() - started} ms`);
      }
    });
  }

  async startAgent(): Promise<void> {
    await this.enqueue(async () => {
      this.ensureLoaded();
      await this.clearHistoryDirect();
      this.agentActive = true;
      this.log('debug', '[Agent] Sessão iniciada usando a sequência existente.');
    });
  }

  async agentStep(text: string, options: { firstStep: boolean; systemPrompt: string; signal?: AbortSignal; onChunk?: (chunk: string) => void; maxTokens?: number }): Promise<string> {
    return this.enqueue(async () => {
      this.ensureLoaded();
      const prompt = options.firstStep
        ? `<instrucoes_modo_agente>\n${options.systemPrompt}\n</instrucoes_modo_agente>\n\n${text}`
        : text;
      return await this.session.prompt(prompt, {
        maxTokens: options.maxTokens ?? Math.max(this.options!.maxTokens, 2048),
        temperature: Math.min(this.options!.temperature, 0.2),
        signal: options.signal,
        onTextChunk: (chunk: string) => options.onChunk?.(chunk)
      });
    });
  }

  async finishAgent(): Promise<void> {
    await this.enqueue(async () => {
      try { if (this.session) await this.clearHistoryDirect(); }
      finally { this.agentActive = false; }
    });
  }

  async clearHistory(): Promise<void> { await this.enqueue(() => this.clearHistoryDirect()); }

  private async clearHistoryDirect(): Promise<void> {
    if (!this.session) return;
    if (typeof this.session.setChatHistory !== 'function') {
      throw new Error('A versão instalada do node-llama-cpp não oferece setChatHistory().');
    }
    await this.session.setChatHistory([]);
    this.log('debug', '[Session] Histórico limpo sem adquirir nova sequência.');
  }

  async unload(): Promise<UnloadReport> {
    await this.loadQueue.catch(() => undefined);
    await this.generationQueue.catch(() => undefined);
    this.state = 'unloading';
    const report = await this.disposeResources('descarregamento solicitado', true);
    this.state = 'unloaded';
    this.lastUnloadReport = report;
    return report;
  }

  async dispose(): Promise<void> {
    try { await this.unload(); }
    catch { await this.disposeResources('encerramento forçado', false); }
  }

  private ensureLoaded(): void {
    if (!this.session || !this.options) throw new Error('Nenhum modelo carregado.');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.generationQueue.catch(() => undefined).then(operation);
    this.generationQueue = task;
    return task;
  }

  private async disposeResources(reason: string, strict: boolean): Promise<UnloadReport> {
    const started = Date.now();
    const steps: UnloadStep[] = [];
    const errors: UnloadReport['errors'] = [];
    const dispose = async (name: UnloadStep['name'], value: any): Promise<void> => {
      if (!value) { steps.push({ name, status: 'absent' }); return; }
      this.log('debug', `[Unload] Dispose ${name} iniciado.`);
      try {
        if (typeof value.dispose === 'function') await value.dispose();
        steps.push({ name, status: 'completed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ name, message, stack: error instanceof Error ? error.stack : undefined });
        steps.push({ name, status: 'error', message });
      }
    };
    await dispose('session', this.session);
    await dispose('context', this.context);
    await dispose('model', this.model);
    await dispose('llama/runtime', this.llama);
    this.session = undefined;
    this.sequence = undefined;
    this.context = undefined;
    this.model = undefined;
    this.llama = undefined;
    this.options = undefined;
    this.systemPrompt = '';
    this.agentActive = false;
    const report: UnloadReport = { reason, durationMs: Date.now() - started, steps, errors };
    this.log('debug', `[Perf] unloadModel: ${report.durationMs} ms`);
    if (strict && errors.length) throw Object.assign(new Error(`Falha ao descarregar: ${errors.map(item => item.name).join(', ')}`), { details: report });
    return report;
  }
}

function normalizeBackend(value: unknown): EffectiveBackend {
  if (value === false || value === undefined || value === null) return 'cpu';
  const normalized = String(value).toLowerCase();
  return normalized === 'cuda' || normalized === 'vulkan' || normalized === 'metal' ? normalized : 'cpu';
}
