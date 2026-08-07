/**
 * LlamaServerEngine
 *
 * Substitui o binding node-llama-cpp por uma comunicação HTTP com o
 * llama-server (binário oficial do llama.cpp). O processo llama-server
 * é iniciado como filho e encerrado junto com o worker.
 *
 * Vantagens sobre o binding:
 * - Sem travamento de session.prompt() — geração é uma requisição HTTP
 *   cancelável via AbortSignal
 * - Sem problemas de ESM/CJS — sem import de módulo nativo
 * - Cancelamento imediato via abort do fetch()
 * - Streaming via SSE idêntico ao comportamento anterior
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  EngineDiagnostics,
  EngineLoadOptions,
  EffectiveBackend,
  UnloadReport,
  UnloadStep
} from '../types/contracts';

export type EngineLogger = (
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error',
  message: string
) => void;

export function isDeviceMemoryError(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.message}\n${error.stack ?? ''}`
    : String(error);
  return [
    'outofdevicememory', 'out of device memory', 'insufficientmemoryerror',
    'unable to allocate vulkan', 'failed to allocate vulkan',
    'device memory allocation', 'failed to allocate buffer',
    'failed to allocate memory', 'not enough memory', 'out of memory'
  ].some(fragment => text.toLowerCase().includes(fragment));
}

// Histórico no formato OpenAI
interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

// Resposta de streaming SSE do llama-server
interface SseDelta { content?: string }
interface SseChoice { delta: SseDelta; finish_reason: string | null }
interface SseChunk { choices: SseChoice[] }

const HEALTH_TIMEOUT_MS = 60_000; // aguardar até 60s para o servidor ficar pronto
const HEALTH_POLL_MS = 300;

export class LlamaServerEngine {
  private serverProcess?: ChildProcess;
  private serverReady = false;
  private serverPort = 0;
  private effectiveBackend: EffectiveBackend = 'cpu';
  private options?: EngineLoadOptions;
  private serverBinaryPath = '';
  private chatSystemPrompt = '';   // system prompt de chat
  private agentSystemPrompt = '';  // system prompt do agente (enquanto ativo)
  private agentActive = false;
  private chatHistory: ChatMessage[] = [];
  private agentHistory: ChatMessage[] = [];
  private loading = false;
  private state: EngineDiagnostics['engineState'] = 'notStarted';
  private lastError: string | null = null;
  private lastUnloadReport: UnloadReport | null = null;
  private generationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly log: EngineLogger,
    serverBinaryPath: string
  ) {
    this.serverBinaryPath = serverBinaryPath;
  }

  // ─── Diagnósticos ────────────────────────────────────────────────────────

  get isLoaded(): boolean {
    return this.serverReady && Boolean(this.serverProcess) && Boolean(this.options);
  }

  get diagnostics(): EngineDiagnostics {
    return {
      loaded: this.isLoaded,
      loading: this.loading,
      engineState: this.state,
      agentActive: this.agentActive,
      modelPath: this.options?.modelPath ?? '',
      backend: this.effectiveBackend,
      contextSize: this.options?.contextSize ?? null,
      gpuLayers: this.options?.gpuLayers ?? 'auto',
      sequenceAcquisitions: 0,
      workerPid: this.serverProcess?.pid ?? null,
      lastFallback: null,
      lastUnloadReport: this.lastUnloadReport,
      lastError: this.lastError
    };
  }

  // ─── Carga ───────────────────────────────────────────────────────────────

  async load(options: EngineLoadOptions, systemPrompt: string): Promise<EngineDiagnostics> {
    const task = this.generationQueue
      .catch(() => undefined)
      .then(() => this.loadInternal(options, systemPrompt));
    this.generationQueue = task;
    return task;
  }

  private async loadInternal(
    options: EngineLoadOptions,
    systemPrompt: string
  ): Promise<EngineDiagnostics> {
    if (!fs.existsSync(options.modelPath)) {
      throw new Error(`Modelo não encontrado: ${options.modelPath}`);
    }
    if (!fs.existsSync(this.serverBinaryPath)) {
      throw new Error(
        `llama-server não encontrado: ${this.serverBinaryPath}. ` +
        'Instale o servidor na pasta de extensão ou configure o caminho.'
      );
    }

    // Se já está carregado com as mesmas opções, não recarrega
    const same = this.isLoaded
      && this.options
      && JSON.stringify(this.options) === JSON.stringify(options);
    if (same) return this.diagnostics;

    this.loading = true;
    this.state = 'loading';
    this.lastError = null;

    const started = Date.now();

    try {
      // Encerra servidor anterior se existir
      await this.stopServer('nova carga');

      this.chatSystemPrompt = this.withPromptMode(systemPrompt, options.promptMode);
      this.chatHistory = [];
      this.agentActive = false;
      this.agentSystemPrompt = '';
      this.agentHistory = [];

      // Cada janela do VS Code recebe uma porta própria. A porta fixa anterior
      // podia conectar ao servidor de outra janela e usar o modelo errado.
      this.serverPort = await findAvailablePort();
      this.effectiveBackend = requestedEffectiveBackend(options);
      this.options = options;

      // Monta argumentos do llama-server
      const args = this.buildServerArgs(options);
      this.log('debug', `[Load] Iniciando llama-server. porta=${this.serverPort} args=${args.join(' ')}`);

      this.serverProcess = spawn(this.serverBinaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.serverProcess.on('error', (error: Error) => {
        this.lastError = error.stack ?? error.message;
        this.log('warn', `[llama-server][processo] ${error.message}`);
        if (this.serverReady) {
          this.serverReady = false;
          this.state = 'error';
        }
      });

      // Captura logs do servidor
      this.serverProcess.stdout?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.captureEffectiveBackend(line);
          this.log('debug', `[llama-server][stdout] ${line}`);
        }
      });
      this.serverProcess.stderr?.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.captureEffectiveBackend(line);
          // llama-server escreve tudo no stderr — filtra para warn só erros reais
          const level = line.toLowerCase().includes('error') ? 'warn' : 'debug';
          this.log(level, `[llama-server][stderr] ${line}`);
        }
      });
      let stderrBuffer = '';
      this.serverProcess.stderr?.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
      });

      this.serverProcess.on('exit', (code, signal) => {
        this.log('debug', `[llama-server] Processo encerrado. code=${code} signal=${signal}`);
        if (code !== 0 && code !== null && !this.serverReady) {
          // Log das últimas linhas do stderr para diagnóstico
          const lastLines = stderrBuffer.split('\n').filter(Boolean).slice(-10).join('\n');
          if (lastLines) this.log('warn', `[llama-server][stderr-final] ${lastLines}`);
        }
        if (this.serverReady) {
          this.serverReady = false;
          this.state = 'error';
          this.lastError = `llama-server encerrou inesperadamente: code=${code} signal=${signal}`;
        }
      });

      // Aguarda o servidor aceitar conexões
      await this.waitForServer();

      this.state = 'ready';
      this.log('info', `[Load] llama-server pronto em ${Date.now() - started} ms. Backend: ${this.effectiveBackend}`);
      return this.diagnostics;
    } catch (error) {
      this.lastError = error instanceof Error ? error.stack ?? error.message : String(error);
      this.state = 'error';
      this.log('error', `[Load][ERRO] ${this.lastError}`);
      await this.stopServer('falha de carregamento');
      throw error;
    } finally {
      this.loading = false;
    }
  }

  private buildServerArgs(options: EngineLoadOptions): string[] {
    const args = [
      '--model', options.modelPath,
      '--port', String(this.serverPort),
      '--host', '127.0.0.1',
      '--ctx-size', String(options.contextSize),
      '--n-predict', String(options.maxTokens),
      '--threads', String(Math.max(1, require('os').cpus().length - 1)),
      '--parallel', '1',
      '--no-mmap',       // evita mmap para não competir com RAM do sistema
      
    ];

    // GPU
    if (options.gpu === 'cpu' || options.gpuLayers === 0) {
      args.push('--n-gpu-layers', '0');
    } else if (typeof options.gpuLayers === 'number') {
      args.push('--n-gpu-layers', String(options.gpuLayers));
    }
    // gpu=auto → não passa --n-gpu-layers, o servidor detecta automaticamente

    return args;
  }

  private async waitForServer(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    const process = this.serverProcess;
    if (!process) throw new Error('Processo llama-server não foi iniciado.');
    let startupError: Error | undefined;
    const onStartupError = (error: Error): void => { startupError = error; };
    process.once('error', onStartupError);
    this.log('debug', `[Load] Aguardando llama-server na porta ${this.serverPort}...`);

    try {
      while (Date.now() < deadline) {
        if (startupError) throw startupError;
        try {
          const ok = await this.checkHealth();
          if (ok) {
            this.serverReady = true;
            this.log('debug', `[Load] llama-server respondeu /health.`);
            return;
          }
        } catch {
          // ainda não está pronto
        }

        // Verifica se o processo morreu enquanto aguardávamos
        if (process.exitCode !== null && process.exitCode !== undefined) {
          throw new Error(
            `llama-server encerrou antes de ficar pronto: code=${process.exitCode}`
          );
        }

        await delay(HEALTH_POLL_MS);
      }

      throw new Error(
        `Tempo esgotado aguardando llama-server (${HEALTH_TIMEOUT_MS / 1000}s). ` +
        'Verifique se o binário é compatível com este sistema.'
      );
    } finally {
      process.off('error', onStartupError);
    }
  }

  private checkHealth(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${this.serverPort}/health`,
        { timeout: 2000 },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            try {
              const json = JSON.parse(body) as { status?: string };
              resolve(json.status === 'ok' || res.statusCode === 200);
            } catch {
              resolve(res.statusCode === 200);
            }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  // ─── Chat (modo Chat) ────────────────────────────────────────────────────

  async prompt(
    text: string,
    options: {
      signal?: AbortSignal;
      onChunk?: (chunk: string) => void;
      maxTokens?: number;
      temperature?: number;
    } = {}
  ): Promise<string> {
    return this.enqueue(async () => {
      this.ensureLoaded();
      const started = Date.now();

      // Adiciona a mensagem do usuário ao histórico
      this.chatHistory.push({ role: 'user', content: text });

      const messages: ChatMessage[] = [
        { role: 'system', content: this.chatSystemPrompt },
        ...this.chatHistory
      ];

      this.log('debug', [
        '[Chat][Prompt] Enviando para llama-server.',
        `chars=${text.length}`,
        `maxTokens=${options.maxTokens ?? this.options!.maxTokens}`,
        `temperature=${options.temperature ?? this.options!.temperature}`
      ].join(' '));

      try {
        const response = await this.callChatCompletions(messages, {
          maxTokens: options.maxTokens ?? this.options!.maxTokens,
          temperature: options.temperature ?? this.options!.temperature,
          signal: options.signal,
          onChunk: options.onChunk
        });

        // Adiciona resposta ao histórico
        this.chatHistory.push({ role: 'assistant', content: response });
        this.log('debug', `[Chat][Prompt] Concluído em ${Date.now() - started} ms; resposta=${response.length} chars.`);
        return response;
      } catch (error) {
        // Remove a mensagem do usuário do histórico em caso de erro
        this.chatHistory.pop();
        throw error;
      }
    });
  }

  // ─── Agente ──────────────────────────────────────────────────────────────

  async startAgent(systemPrompt: string): Promise<void> {
    await this.enqueue(async () => {
      this.ensureLoaded();
      this.agentSystemPrompt = this.withPromptMode(systemPrompt, this.options?.promptMode);
      this.agentActive = true;
      this.chatHistory = []; // histórico de chat não é misturado ao agente
      this.agentHistory = [];
      this.log('debug', [
        '[Agent][startAgent] Sessão do agente iniciada.',
        `systemPromptChars=${systemPrompt.length}`,
        `systemPromptAnterior=chat`
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
      const started = Date.now();

      const activeSystemPrompt = this.agentActive
        ? this.agentSystemPrompt
        : this.chatSystemPrompt;

      // Mantém os turns do agente também no motor HTTP. O motor embarcado já
      // preserva esse histórico dentro da LlamaChatSession; sem esta lista, o
      // llama-server perdia resultados de ferramentas e respostas inválidas nas
      // etapas seguintes, produzindo comportamento diferente entre os motores.
      this.agentHistory.push({ role: 'user', content: text });
      const messages: ChatMessage[] = [
        { role: 'system', content: activeSystemPrompt },
        ...this.agentHistory
      ];

      const contextSize = Math.max(256, this.options!.contextSize);
      const estimatedInputTokens = messages.reduce(
        (total, message) => total + Math.ceil(message.content.length / 3) + 8,
        16
      );
      const safetyTokens = Math.max(48, Math.floor(contextSize * 0.04));
      const availableOutputTokens = contextSize - estimatedInputTokens - safetyTokens;
      const requestedMaxTokens = Math.max(
        1,
        Math.floor(options.maxTokens ?? this.options!.maxTokens)
      );

      if (availableOutputTokens < 32) {
        this.agentHistory.pop();
        throw Object.assign(
          new Error(
            [
              'O histórico do Agente excede a janela de contexto do modelo.',
              `contexto=${contextSize}`,
              `entradaEstimada=${estimatedInputTokens}`,
              `margem=${safetyTokens}`,
              'Aumente offgrid.contextSize ou reduza o contexto enviado.'
            ].join(' ')
          ),
          {
            name: 'ContextWindowError',
            details: { contextSize, estimatedInputTokens, safetyTokens, requestedMaxTokens }
          }
        );
      }

      const maxTokens = Math.max(32, Math.min(requestedMaxTokens, availableOutputTokens));

      this.log('debug', [
        '[Agent][Prompt] Enviando para llama-server.',
        `step=firstStep=${options.firstStep}`,
        `chars=${text.length}`,
        `tokensEntradaEstimados=${estimatedInputTokens}`,
        `maxTokens=${maxTokens}`,
        `historyTurns=${this.agentHistory.length}`,
        `signal=${Boolean(options.signal)}`,
        `aborted=${options.signal?.aborted ?? false}`
      ].join(' '));

      try {
        const response = await this.callChatCompletions(messages, {
          maxTokens,
          temperature: Math.min(this.options!.temperature, 0.2),
          signal: options.signal,
          onChunk: options.onChunk
        });

        this.agentHistory.push({ role: 'assistant', content: response });
        this.log('debug', `[Agent][Prompt] Concluído em ${Date.now() - started} ms; resposta=${response.length} chars.`);
        return response;
      } catch (error) {
        // Remove a mensagem deste step; os turns anteriores continuam íntegros.
        this.agentHistory.pop();
        const elapsed = Date.now() - started;
        if (options.signal?.aborted || (error as Error)?.name === 'AbortError') {
          this.log('trace', `[Abort] Sinal recebido pelo LlamaServerEngine. tempo=${elapsed}ms`);
        } else {
          this.log('error', `[Agent][Prompt] Falhou após ${elapsed} ms: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    });
  }

  async finishAgent(): Promise<void> {
    await this.enqueue(async () => {
      this.agentActive = false;
      this.agentSystemPrompt = '';
      this.agentHistory = [];
      this.chatHistory = [];
      this.log('debug', '[Agent][finishAgent] Sessão do agente encerrada; histórico limpo.');
    });
  }

  async clearHistory(): Promise<void> {
    await this.enqueue(() => {
      this.chatHistory = [];
      this.agentHistory = [];
      this.log('debug', '[Session] Histórico limpo.');
      return Promise.resolve();
    });
  }

  // ─── Chamada HTTP ao llama-server ────────────────────────────────────────

  private async callChatCompletions(
    messages: ChatMessage[],
    options: {
      maxTokens: number;
      temperature: number;
      signal?: AbortSignal;
      onChunk?: (chunk: string) => void;
    }
  ): Promise<string> {
    const body = JSON.stringify({
      messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: true,
      cache_prompt: true  // reutiliza KV cache entre chamadas com prefixo comum
    });

    const response = await fetch(
      `http://127.0.0.1:${this.serverPort}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: options.signal
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`llama-server respondeu HTTP ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('llama-server não retornou body na resposta.');
    }

    // Lê o stream SSE
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // última linha pode estar incompleta

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') break;

          try {
            const chunk = JSON.parse(data) as SseChunk;
            const content = chunk.choices?.[0]?.delta?.content;
            if (content) {
              fullResponse += content;
              options.onChunk?.(content);
            }
          } catch {
            // linha SSE malformada — ignora
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return fullResponse;
  }

  // ─── Descarregamento ─────────────────────────────────────────────────────

  async unload(): Promise<UnloadReport> {
    await this.generationQueue.catch(() => undefined);
    this.state = 'unloading';
    const report = await this.stopServer('descarregamento solicitado');
    this.state = 'unloaded';
    this.lastUnloadReport = report;
    return report;
  }

  async dispose(): Promise<void> {
    try { await this.unload(); } catch {
      await this.stopServer('encerramento forçado');
    }
  }

  private async stopServer(reason: string): Promise<UnloadReport> {
    const started = Date.now();
    const steps: UnloadStep[] = [];
    const errors: UnloadReport['errors'] = [];

    if (this.serverProcess) {
      this.log('debug', `[Unload] Encerrando llama-server. motivo=${reason}`);
      try {
        const proc = this.serverProcess;
        const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()));
        proc.kill('SIGTERM');
        await Promise.race([exited, delay(3_000)]);
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill('SIGKILL');
          await Promise.race([exited, delay(1_000)]);
        }
        steps.push({ name: 'session', status: 'completed' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ name: 'session', message });
        steps.push({ name: 'session', status: 'error', message });
      }
    } else {
      steps.push({ name: 'session', status: 'absent' });
    }

    this.serverProcess = undefined;
    this.serverReady = false;
    this.serverPort = 0;
    this.effectiveBackend = 'cpu';
    this.options = undefined;
    this.chatSystemPrompt = '';
    this.agentSystemPrompt = '';
    this.agentActive = false;
    this.agentHistory = [];
    this.chatHistory = [];

    const report: UnloadReport = {
      reason,
      durationMs: Date.now() - started,
      steps,
      errors
    };
    this.log('debug', `[Perf] stopServer: ${report.durationMs} ms`);
    return report;
  }

  // ─── Utilitários ─────────────────────────────────────────────────────────

  private captureEffectiveBackend(line: string): void {
    if (this.options?.gpu === 'cpu' || this.options?.gpuLayers === 0) return;
    const normalized = line.toLowerCase();
    if (normalized.includes('cuda')) this.effectiveBackend = 'cuda';
    else if (normalized.includes('vulkan')) this.effectiveBackend = 'vulkan';
    else if (normalized.includes('metal')) this.effectiveBackend = 'metal';
  }

  private withPromptMode(systemPrompt: string, promptMode: EngineLoadOptions['promptMode']): string {
    if (promptMode !== 'no-think') return systemPrompt;
    return systemPrompt.includes('/no_think') ? systemPrompt : `${systemPrompt}\n\n/no_think`;
  }

  private ensureLoaded(): void {
    if (!this.isLoaded) throw new Error('Nenhum modelo carregado.');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.generationQueue.catch(() => undefined).then(operation);
    this.generationQueue = task;
    return task;
  }
}

function requestedEffectiveBackend(options: EngineLoadOptions): EffectiveBackend {
  if (options.gpu === 'cpu' || options.gpuLayers === 0) return 'cpu';
  return options.gpu === 'auto' ? 'cpu' : options.gpu;
}

function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => {
        if (error) reject(error);
        else if (!port) reject(new Error('Não foi possível reservar uma porta local para o llama-server.'));
        else resolve(port);
      });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}