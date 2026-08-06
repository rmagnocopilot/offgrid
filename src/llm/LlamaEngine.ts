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

/**
 * Cria uma LlamaChatSession forçando o QwenChatWrapper com variation "3".
 * O wrapper "auto" detectado pelo node-llama-cpp pode não identificar
 * corretamente o template do Qwen2.5-Coder, produzindo ChatML malformado
 * que trava session.prompt() indefinidamente.
 * O acesso via (runtime as any) é necessário pois os tipos do pacote não
 * expõem QwenChatWrapper no namespace principal.
 */
function createQwenSession(runtime: NodeLlamaCppRuntime, sequence: any, systemPrompt: string): any {
  const QwenChatWrapper = (runtime as any).QwenChatWrapper;
  const chatWrapper = QwenChatWrapper ? new QwenChatWrapper({ variation: '3', thoughts: 'discourage', keepOnlyLastThought: true }) : 'auto';
  return new runtime.LlamaChatSession({
    contextSequence: sequence,
    systemPrompt,
    chatWrapper
  });
}

export class LlamaEngine {
  private llama: any;
  private model: any;
  private context: any;
  private sequence: any;
  private session: any;
  private options?: EngineLoadOptions;
  private systemPrompt = '';
  private agentSystemPrompt = '';
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
      // logLevel debug + logger customizado: expõe os logs internos do llama.cpp
      // (decode, batch, kv cache) para diagnosticar travamentos na geração.
      const llamaOptions: Record<string, unknown> = {
        logLevel: runtime.LlamaLogLevel?.debug ?? runtime.LlamaLogLevel?.warn,
        logger: (level: unknown, message: string) => {
          this.log('debug', `[llama.cpp][${String(level)}] ${message}`);
        }
      };
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
      // Threads explícitas: força o uso de todos os núcleos físicos com mínimo
      // garantido, evitando que a detecção automática ou o modo de eficiência
      // do Windows limitem a inferência a poucas threads.
      const os = await import('node:os');
      const cpuCount = os.cpus().length;
      const idealThreads = Math.max(1, cpuCount - 1);
      this.log('debug', `[Load] CPUs lógicas=${cpuCount}; threads solicitadas=${idealThreads} (mínimo garantido=${Math.max(1, Math.floor(cpuCount / 2))}).`);
      this.context = await this.model.createContext({
        contextSize: options.contextSize,
        sequences: 1,
        threads: {
          ideal: idealThreads,
          minimum: Math.max(1, Math.floor(cpuCount / 2))
        }
      });
      this.log('debug', `[Perf] createContext: ${Date.now() - contextAt} ms`);
      this.sequence = this.context.getSequence();
      this.sequenceAcquisitions += 1;
      // Introspecção do modelo e contexto para diagnóstico
      try {
        this.log('debug', [
          '[Load][Introspecção]',
          `trainContextSize=${this.model?.trainContextSize ?? 'n/a'}`,
          `contextSize=${this.context?.contextSize ?? 'n/a'}`,
          `batchSize=${this.context?.batchSize ?? 'n/a'}`,
          `flashAttention=${this.context?.flashAttention ?? 'n/a'}`,
          `sequenceNextToken=${this.sequence?.nextTokenIndex ?? 'n/a'}`
        ].join(' '));
      } catch (introspectError) {
        this.log('debug', `[Load][Introspecção] Falhou: ${introspectError instanceof Error ? introspectError.message : String(introspectError)}`);
      }
      const effectiveSystemPrompt = this.withPromptMode(systemPrompt, options.promptMode);
      this.session = createQwenSession(runtime, this.sequence, effectiveSystemPrompt);
      this.options = options;
      this.systemPrompt = effectiveSystemPrompt;
      this.state = 'ready';
      this.log('debug', `[Load] LlamaChatSession criada com systemPrompt de chat. chars=${effectiveSystemPrompt.length} tokens≈${this.countTokens(effectiveSystemPrompt)}`);
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
      const maxTokens = options.maxTokens ?? this.options!.maxTokens;
      const temperature = options.temperature ?? this.options!.temperature;
      this.log('debug', [
        '[Chat][Prompt] Chamando session.prompt().',
        `chars=${text.length}`,
        `tokens≈${this.countTokens(text)}`,
        `maxTokens=${maxTokens}`,
        `temperature=${temperature}`,
        `signal=${Boolean(options.signal)}`,
        `aborted=${options.signal?.aborted ?? false}`
      ].join(' '));
      let chatFirstTokenAt: number | null = null;
      let chatTokenCount = 0;
      let chatLastKv = this.sequence?.nextTokenIndex ?? 0;
      const chatHeartbeat = setInterval(() => {
        try {
          const kvNow = this.sequence?.nextTokenIndex ?? -1;
          const delta = kvNow - chatLastKv;
          chatLastKv = kvNow;
          this.log('debug', `[Chat][Heartbeat] elapsed=${Date.now() - started} ms kvTokens=${kvNow} delta5s=${delta} tokensGerados=${chatTokenCount}`);
        } catch { /* ignorar */ }
      }, 5_000);
      try {
        const response = await this.session.prompt(text, {
          maxTokens,
          temperature,
          signal: options.signal,
          onToken: (tokens: number[]) => {
            chatTokenCount += tokens.length;
            if (chatFirstTokenAt === null) {
              chatFirstTokenAt = Date.now();
              this.log('debug', `[Chat][Prompt] Primeiro token gerado em ${chatFirstTokenAt - started} ms.`);
            }
          },
          onTextChunk: (chunk: string) => options.onChunk?.(chunk)
        });
        this.log('debug', `[Chat][Prompt] Concluído em ${Date.now() - started} ms; resposta=${response.length} chars; tokens=${chatTokenCount}.`);
        return response;
      } catch (error) {
        this.log('error', `[Chat][Prompt] Falhou após ${Date.now() - started} ms: ${errorText(error)}`);
        throw error;
      } finally {
        clearInterval(chatHeartbeat);
        this.log('debug', `[Perf] prompt: ${Date.now() - started} ms`);
      }
    });
  }

  async startAgent(systemPrompt: string): Promise<void> {
    await this.enqueue(async () => {
      this.ensureLoaded();
      const effectiveSystemPrompt = this.withPromptMode(systemPrompt, this.options?.promptMode);
      const kvTokensBefore = this.sequence?.nextTokenIndex ?? 0;
      this.log('debug', [
        '[Agent][startAgent] Iniciando.',
        `systemPromptAnterior=chat chars=${this.systemPrompt.length} tokens≈${this.countTokens(this.systemPrompt)}`,
        `systemPromptNovo=agente chars=${effectiveSystemPrompt.length} tokens≈${this.countTokens(effectiveSystemPrompt)}`,
        `sequenceAcquisitions=${this.sequenceAcquisitions}`,
        `kvCacheTokens=${kvTokensBefore}`
      ].join(' | '));

      // Limpa o KV cache da sequência antes de recriar a sessão.
      // Sem isso, ao recriar o LlamaChatSession com a mesma sequence,
      // o node-llama-cpp tenta reaproveitar tokens do cache da sessão anterior
      // (chat), montando um contexto incoerente que faz session.prompt() travar.
      if (kvTokensBefore > 0) {
        this.log('debug', `[Agent][startAgent] Limpando KV cache da sequência. tokens=${kvTokensBefore}`);
        try {
          await this.sequence.eraseContextTokenRanges([{ start: 0, end: kvTokensBefore }]);
          this.log('debug', `[Agent][startAgent] KV cache limpo. kvApos=${this.sequence.nextTokenIndex}`);
        } catch (eraseError) {
          this.log('warn', `[Agent][startAgent] Falha ao limpar KV cache: ${eraseError instanceof Error ? eraseError.message : String(eraseError)}. Continuando.`);
        }
      } else {
        this.log('debug', '[Agent][startAgent] KV cache já vazio. Nenhuma limpeza necessária.');
      }

      // Recria a sessão com o system prompt do Agente.
      // Não usamos setChatHistory pois o LlamaChatSession mantém o system prompt
      // original codificado internamente — recriar é a única forma segura.
      const runtime = await importNodeLlamaCppRuntime();
      const sessionAnterior = this.session;
      this.log('debug', `[Agent][startAgent] Descartando sessão anterior. temDispose=${typeof sessionAnterior?.dispose === 'function'} disposed=${sessionAnterior?.disposed ?? 'n/a'}`);
      // Descarta explicitamente a sessão anterior antes de criar a nova.
      // Sem isso, o LlamaChat interno da sessão antiga continua ativo na mesma
      // sequence — duas instâncias de LlamaChat na mesma sequence simultaneamente
      // causam estado inconsistente e travam session.prompt().
      try { sessionAnterior?.dispose({ disposeSequence: false }); } catch { /* ignorar */ }
      this.log('debug', `[Agent][startAgent] Sessão anterior descartada. disposed=${sessionAnterior?.disposed ?? 'n/a'}`);
      this.session = createQwenSession(runtime, this.sequence, effectiveSystemPrompt);
      this.agentActive = true;
      this.agentSystemPrompt = effectiveSystemPrompt;
      this.log('debug', [
        '[Agent][startAgent] Sessão recriada com sucesso.',
        `sessionOk=${Boolean(this.session)}`,
        `agentActive=${this.agentActive}`,
        `wrapper=${this.session?.chatWrapper?.wrapperName ?? 'desconhecido'}`,
        `kvApos=${this.sequence?.nextTokenIndex ?? 0}`,
        `tokens≈${this.countTokens(effectiveSystemPrompt)}`
      ].join(' '));
    });
  }

  async agentStep(
    text: string,
    options: {
      firstStep: boolean;
      systemPrompt: string;
      signal?: AbortSignal;
      onChunk?: (chunk: string) => void;
      maxTokens?: number;
    }
  ): Promise<string> {
    return this.enqueue(async () => {
      this.ensureLoaded();

      const prompt = text;

      const contextSize = Math.max(256, this.options!.contextSize);
      // O system prompt ativo da sessão do Agente é sempre o agentSystemPrompt
      // (gravado em startAgent), independente de ser o primeiro step ou não.
      // Usar this.systemPrompt (chat) a partir do step 2 subestimava a entrada
      // e podia permitir gerar mais tokens do que o contexto suporta.
      const activeSystemPrompt = this.agentActive ? this.agentSystemPrompt : this.systemPrompt;
      const sessionSystemTokens = this.countTokens(activeSystemPrompt);
      const promptTokens = this.countTokens(prompt);
      const chatOverheadTokens = 32;
      const safetyTokens = Math.max(48, Math.floor(contextSize * 0.04));
      const kvTokensAtStep = Math.max(0, Number(this.sequence?.nextTokenIndex ?? 0));
      // A sessão embarcada mantém os turns anteriores no KV cache. Contar apenas
      // o prompt atual superestimava a saída disponível nas etapas seguintes.
      const freshSessionInputTokens = sessionSystemTokens + promptTokens + chatOverheadTokens;
      const accumulatedInputTokens = kvTokensAtStep + promptTokens + chatOverheadTokens;
      const usedInputTokens = Math.max(freshSessionInputTokens, accumulatedInputTokens);
      const availableOutputTokens = contextSize - usedInputTokens - safetyTokens;
      const requestedMaxTokens = Math.max(
        1,
        Math.floor(options.maxTokens ?? this.options!.maxTokens)
      );

      if (availableOutputTokens < 32) {
        throw Object.assign(
          new Error(
            [
              'O prompt do Agente excede a janela de contexto do modelo.',
              `contexto=${contextSize}`,
              `entradaEstimada=${usedInputTokens}`,
              `margem=${safetyTokens}`,
              'Aumente offgrid.contextSize ou reduza o contexto enviado.'
            ].join(' ')
          ),
          {
            name: 'ContextWindowError',
            details: {
              contextSize,
              sessionSystemTokens,
              promptTokens,
              chatOverheadTokens,
              safetyTokens,
              requestedMaxTokens
            }
          }
        );
      }

      const effectiveMaxTokens = Math.max(
        32,
        Math.min(requestedMaxTokens, availableOutputTokens)
      );
      const started = Date.now();

      // Monitora o crescimento do KV cache ao longo dos steps do Agente.
      // O histórico da sessão acumula turns; em loops longos o contexto pode
      // encher e disparar context shift automático (que descarta turns antigos).
      const kvUsagePercent = Math.round((kvTokensAtStep / contextSize) * 100);
      if (kvUsagePercent >= 75) {
        this.log('warn', `[Agent][KV] Contexto em ${kvUsagePercent}% (${kvTokensAtStep}/${contextSize} tokens). Context shift automático pode descartar turns antigos.`);
      } else {
        this.log('debug', `[Agent][KV] Uso do contexto: ${kvUsagePercent}% (${kvTokensAtStep}/${contextSize} tokens).`);
      }

      this.log(
        'debug',
        [
          '[Agent][Prompt] Iniciando geração.',
          `prompt=${prompt.length} caracteres`,
          `tokensPrompt=${promptTokens}`,
          `tokensSistema=${sessionSystemTokens}`,
          `contexto=${contextSize}`,
          `disponívelSaída=${availableOutputTokens}`,
          `maxTokens=${effectiveMaxTokens}`,
          `signal=${Boolean(options.signal)}`,
          `aborted=${options.signal?.aborted ?? false}`
        ].join(' ')
      );

      // Modo diagnóstico: substitui o prompt completo por um mínimo para isolar
      // se o travamento é causado pelo tamanho da entrada ou pelo runtime.
      const diagPrompt = '[DIAG] Responda apenas: {"name":"list_files","arguments":{"path":"."}}';
      const isDiag = false; // mude para true para ativar o diagnóstico
      const effectivePrompt = isDiag ? diagPrompt : prompt;

      // Diagnóstico de system prompt: força system prompt vazio na sessão
      // para isolar se o travamento é causado pelo conteúdo/tamanho do system prompt.
      if (isDiag) {
        this.log('debug', '[Agent][DIAG] Recriando sessão com system prompt VAZIO para diagnóstico.');
        try { this.session?.dispose({ disposeSequence: false }); } catch { /* ignorar */ }
        const runtimeDiag = await importNodeLlamaCppRuntime();
        this.session = new runtimeDiag.LlamaChatSession({
          contextSequence: this.sequence,
          systemPrompt: 'Você é um assistente. Responda em JSON.',
          chatWrapper: new (runtimeDiag as any).QwenChatWrapper({ variation: '3' })
        });
        this.log('debug', `[Agent][DIAG] Sessão de diagnóstico criada. wrapper=${(this.session as any)?.chatWrapper?.wrapperName ?? 'n/a'}`);
      }

      this.log(
        'debug',
        `[Agent][Prompt] Primeiros 500 chars do prompt enviado (diag=${isDiag}): ${effectivePrompt.slice(0, 500)}`
      );

      const temperature = Math.min(this.options!.temperature, 0.2);
      this.log(
        'debug',
        [
          '[Agent][Prompt] Chamando session.prompt().',
          `maxTokens=${effectiveMaxTokens}`,
          `temperature=${temperature}`,
          `wrapper=${(this.session as any)?.chatWrapper?.wrapperName ?? 'desconhecido'}`,
          `sessionDisposed=${this.session?.disposed ?? 'n/a'}`,
          `sequenceDisposed=${this.sequence?.disposed ?? 'n/a'}`,
          `signal=${Boolean(options.signal)}`,
          `aborted=${options.signal?.aborted ?? false}`
        ].join(' ')
      );

      let firstTokenAt: number | null = null;
      let tokenCount = 0;

      // Heartbeat: monitora o progresso interno da sequência durante a geração.
      // nextTokenIndex cresce conforme o prefill avança token a token.
      // Se crescer → prefill progredindo (lento, mas vivo).
      // Se ficar parado → deadlock real no runtime.
      const heartbeatStartKv = this.sequence?.nextTokenIndex ?? 0;
      let lastHeartbeatKv = heartbeatStartKv;
      const heartbeat = setInterval(() => {
        try {
          const kvNow = this.sequence?.nextTokenIndex ?? -1;
          const delta = kvNow - lastHeartbeatKv;
          lastHeartbeatKv = kvNow;
          this.log('debug', [
            '[Agent][Heartbeat]',
            `elapsed=${Date.now() - started} ms`,
            `kvTokens=${kvNow}`,
            `delta5s=${delta}`,
            `tokensGerados=${tokenCount}`,
            `sessionDisposed=${this.session?.disposed ?? 'n/a'}`,
            `sequenceDisposed=${this.sequence?.disposed ?? 'n/a'}`
          ].join(' '));
        } catch (hbError) {
          this.log('debug', `[Agent][Heartbeat] erro ao ler estado: ${hbError instanceof Error ? hbError.message : String(hbError)}`);
        }
      }, 5_000);

      try {
        const response = await this.session.prompt(effectivePrompt, {
          maxTokens: effectiveMaxTokens,
          temperature,
          signal: options.signal,
          onToken: (tokens: number[]) => {
            tokenCount += tokens.length;
            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
              this.log('debug', `[Agent][Prompt] Primeiro token gerado em ${firstTokenAt - started} ms. tokens=${tokens.length}`);
            } else if (tokenCount % 10 === 0) {
              this.log('debug', `[Agent][Prompt] Gerando... tokens=${tokenCount} elapsed=${Date.now() - started} ms`);
            }
          },
          onTextChunk: (chunk: string) => options.onChunk?.(chunk)
        });

        this.log(
          'debug',
          [
            `[Agent][Prompt] Geração concluída em ${Date.now() - started} ms.`,
            `resposta=${response.length} chars`,
            `tokens=${tokenCount}`,
            `primeiroToken=${firstTokenAt !== null ? firstTokenAt - started : 'nunca'} ms`
          ].join(' ')
        );
        return response;
      } catch (error) {
        const elapsed = Date.now() - started;
        if (options.signal?.aborted || (error as Error)?.name === 'AbortError') {
          this.log(
            'info',
            `[Abort][4/4] Sinal recebido pelo LlamaEngine. aborted=${options.signal?.aborted ?? false} tempo=${elapsed}ms`
          );
        } else {
          this.log(
            'error',
            `[Agent][Prompt] Geração falhou após ${elapsed} ms: ${errorText(error)}`
          );
        }
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    });
  }

  private countTokens(text: string): number {
    if (!text) return 0;

    try {
      if (typeof this.model?.tokenize === 'function') {
        const tokens = this.model.tokenize(text);
        if (Array.isArray(tokens)) return tokens.length;
        if (ArrayBuffer.isView(tokens)) {
          const viewLength = (tokens as { length?: number }).length;
          return typeof viewLength === 'number' ? viewLength : tokens.byteLength;
        }
        this.log('debug', '[Tokens] tokenize() retornou tipo inesperado; usando estimativa.');
      } else {
        this.log('debug', '[Tokens] model.tokenize não disponível; usando estimativa chars/3.');
      }
    } catch (error) {
      this.log(
        'debug',
        `[Tokens] Tokenização exata falhou; usando estimativa. erro=${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Estimativa conservadora para código, caminhos e texto em português.
    return Math.ceil(text.length / 3);
  }

  async finishAgent(): Promise<void> {
    await this.enqueue(async () => {
      const kvTokensBefore = this.sequence?.nextTokenIndex ?? 0;
      this.log('debug', `[Agent][finishAgent] Iniciando restauração da sessão de chat. kvCacheTokens=${kvTokensBefore}`);
      try {
        // Limpa o KV cache antes de restaurar a sessão de chat.
        if (kvTokensBefore > 0) {
          try {
            await this.sequence.eraseContextTokenRanges([{ start: 0, end: kvTokensBefore }]);
            this.log('debug', `[Agent][finishAgent] KV cache limpo. kvApos=${this.sequence.nextTokenIndex}`);
          } catch (eraseError) {
            this.log('warn', `[Agent][finishAgent] Falha ao limpar KV cache: ${eraseError instanceof Error ? eraseError.message : String(eraseError)}. Continuando.`);
          }
        }
        const runtime = await importNodeLlamaCppRuntime();
        const sessionAgente = this.session;
        this.log('debug', `[Agent][finishAgent] Descartando sessão do Agente. disposed=${sessionAgente?.disposed ?? 'n/a'}`);
        try { sessionAgente?.dispose({ disposeSequence: false }); } catch { /* ignorar */ }
        this.session = createQwenSession(runtime, this.sequence, this.systemPrompt);
        this.log('debug', `[Agent][finishAgent] Sessão de chat restaurada. tokens≈${this.countTokens(this.systemPrompt)}`);
      } catch (error) {
        this.log('error', `[Agent][finishAgent] Falha ao restaurar sessão: ${errorText(error)}`);
        throw error;
      } finally {
        this.agentActive = false;
        this.agentSystemPrompt = '';
        this.log('debug', `[Agent][finishAgent] agentActive=${this.agentActive}`);
      }
    });
  }

  async clearHistory(): Promise<void> { await this.enqueue(() => this.clearHistoryDirect()); }

  private async clearHistoryDirect(): Promise<void> {
    if (!this.session) return;
    if (this.session.disposed) {
      this.log('debug', '[Session] Sessão já descartada; nada a limpar.');
      return;
    }
    // resetChatHistory restaura o estado inicial (incluindo o system prompt),
    // que é o comportamento correto para "limpar a conversa".
    // setChatHistory([]) removeria também o system prompt do histórico.
    if (typeof this.session.resetChatHistory === 'function') {
      this.session.resetChatHistory();
      this.log('debug', '[Session] Histórico restaurado ao estado inicial (resetChatHistory).');
      return;
    }
    if (typeof this.session.setChatHistory !== 'function') {
      throw new Error('A versão instalada do node-llama-cpp não oferece setChatHistory().');
    }
    this.session.setChatHistory([]);
    this.log('debug', '[Session] Histórico limpo (setChatHistory vazio).');
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

  private withPromptMode(systemPrompt: string, promptMode: EngineLoadOptions['promptMode']): string {
    if (promptMode !== 'no-think') return systemPrompt;
    return systemPrompt.includes('/no_think') ? systemPrompt : `${systemPrompt}

/no_think`;
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
    // A sessão é descartada sem descartar a sequence — a sequence é descartada
    // separadamente junto com o context logo abaixo.
    if (this.session && typeof this.session.dispose === 'function') {
      this.log('debug', '[Unload] Dispose session iniciado.');
      try {
        this.session.dispose({ disposeSequence: false });
        steps.push({ name: 'session', status: 'completed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ name: 'session', message, stack: error instanceof Error ? error.stack : undefined });
        steps.push({ name: 'session', status: 'error', message });
      }
    } else {
      steps.push({ name: 'session', status: 'absent' });
    }
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
    this.agentSystemPrompt = '';
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