import type { ToolCall, ToolResult } from '../types/contracts';
import { detectToolCall, looksLikeToolCall, looksLikeToolSchema } from './ToolCallParser';

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

function recoveryPrompt(schema: boolean): string {
  return [
    '<correcao_chamada_ferramenta>',
    schema
      ? 'A resposta anterior copiou o schema de uma ferramenta e não executou nenhuma ação.'
      : 'A resposta anterior parecia uma chamada de ferramenta, mas estava em formato inválido.',
    'Continue a mesma tarefa e responda SOMENTE com uma chamada válida neste formato:',
    '{"name":"nome_da_ferramenta","arguments":{"argumento":"valor"}}',
    'Não use bloco Markdown. Não retorne o schema. Não explique a chamada.',
    '</correcao_chamada_ferramenta>'
  ].join('\n');
}

export class AgentLoop {
  async run(options: AgentLoopOptions): Promise<AgentLoopResult> {
    const limit = Math.max(1, Math.min(30, Math.floor(options.maxSteps || 10)));
    const calls: ToolCall[] = [];
    const results: ToolResult[] = [];
    let prompt = options.initialPrompt;
    let invalidRecoveryUsed = false;

    for (let step = 1; step <= limit; step += 1) {
      while (true) {
        ensureNotAborted(options.signal);
        options.log('debug', `Etapa ${step}/${limit} iniciada${invalidRecoveryUsed ? ' (recuperação)' : ''}.`);
        const startedAt = Date.now();
        const response = String(await options.invokeStep(prompt, step) ?? '');
        options.log('debug', `Resposta recebida em ${Date.now() - startedAt} ms; caracteres=${response.length}.`);
        if (options.diagnosticMode) options.log('trace', `Resposta bruta: ${response.slice(0, 12000)}`);

        const call = detectToolCall(response);
        if (!call) {
          if (looksLikeToolCall(response)) {
            const schema = looksLikeToolSchema(response);
            options.log('warn', `${schema ? 'Schema de ferramenta' : 'Chamada de ferramenta inválida'} recebido: ${response.slice(0, 2000)}`);
            if (!invalidRecoveryUsed) {
              invalidRecoveryUsed = true;
              prompt = recoveryPrompt(schema);
              continue;
            }
            throw new Error(schema
              ? 'O modelo retornou o schema da ferramenta em vez de executá-la, mesmo após uma tentativa de correção. Consulte os logs do Agente.'
              : 'O modelo retornou uma chamada de ferramenta inválida, mesmo após uma tentativa de correção. Consulte os logs do Agente.');
          }
          return { text: response, steps: step, calls, results };
        }

        invalidRecoveryUsed = false;
        calls.push(call);
        options.log('info', `Executando ferramenta ${call.name}.`);
        const result = await options.executeTool(call);
        results.push(result);
        if (!result.ok) options.log('error', `Ferramenta ${call.name} falhou: ${result.error ?? 'erro desconhecido'}`);
        prompt = resultPrompt(call, result);
        break;
      }
    }

    throw new Error(`O agente excedeu o limite de ${limit} etapas.`);
  }
}
