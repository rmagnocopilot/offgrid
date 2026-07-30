import type { ToolCall, ToolResult } from '../types/contracts';
import { detectToolCall, looksLikeToolCall } from './ToolCallParser';

export interface AgentLoopLogger {
  (level: 'trace' | 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export interface AgentLoopOptions {
  initialPrompt: string;
  maxSteps: number;
  signal?: AbortSignal;
  diagnosticMode: boolean;
  invokeStep: (prompt: string, step: number) => Promise<string>;
  executeTool: (call: ToolCall) => Promise<ToolResult>;
  log: AgentLoopLogger;
}

export interface AgentLoopResult {
  text: string;
  steps: number;
  calls: ToolCall[];
  results: ToolResult[];
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('Operação cancelada.'), { name: 'AbortError' });
}

function resultPrompt(call: ToolCall, result: ToolResult): string {
  return [
    '<resultado_ferramenta>',
    `Nome: ${call.name}`,
    `Argumentos: ${JSON.stringify(call.arguments)}`,
    `Sucesso: ${result.ok}`,
    `Resultado: ${JSON.stringify(result.content)}`,
    result.error ? `Erro: ${result.error}` : '',
    '</resultado_ferramenta>',
    '',
    'Continue a tarefa. Chame outra ferramenta quando necessário.',
    'Nunca mostre JSON de ferramenta ao usuário. Finalize em texto ou prepare uma revisão.'
  ].filter(Boolean).join('\n');
}

export class AgentLoop {
  async run(options: AgentLoopOptions): Promise<AgentLoopResult> {
    const limit = Math.max(1, Math.min(30, Math.floor(options.maxSteps || 10)));
    const calls: ToolCall[] = [];
    const results: ToolResult[] = [];
    let prompt = options.initialPrompt;

    for (let step = 1; step <= limit; step += 1) {
      ensureNotAborted(options.signal);
      options.log('debug', `Etapa ${step}/${limit} iniciada.`);
      const startedAt = Date.now();
      const response = String(await options.invokeStep(prompt, step) ?? '');
      options.log('debug', `Resposta recebida em ${Date.now() - startedAt} ms; caracteres=${response.length}.`);
      if (options.diagnosticMode) options.log('trace', `Resposta bruta: ${response.slice(0, 12000)}`);

      const call = detectToolCall(response);
      if (!call) {
        if (looksLikeToolCall(response)) {
          options.log('warn', `Resposta parece ferramenta, mas é inválida: ${response.slice(0, 2000)}`);
          throw new Error('O modelo retornou uma chamada de ferramenta inválida. Consulte os logs do Agente.');
        }
        return { text: response, steps: step, calls, results };
      }

      calls.push(call);
      options.log('info', `Executando ferramenta ${call.name}.`);
      const result = await options.executeTool(call);
      results.push(result);
      if (!result.ok) options.log('error', `Ferramenta ${call.name} falhou: ${result.error ?? 'erro desconhecido'}`);
      prompt = resultPrompt(call, result);
    }

    throw new Error(`O agente excedeu o limite de ${limit} etapas.`);
  }
}
