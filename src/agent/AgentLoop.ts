import type { ToolCall, ToolResult } from '../types/contracts';
import { detectToolCalls, looksLikeToolCall, looksLikeToolSchema } from './ToolCallParser';

export interface AgentLoopLogger {
  (level: 'trace' | 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export interface AgentLoopOptions {
  initialPrompt: string;
  taskReminder?: string;
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

interface ExecutedTool {
  call: ToolCall;
  result: ToolResult;
}

const REVIEW_WRITE_TOOLS = new Set([
  'apply_edit',
  'create_file',
  'delete_file',
  'rename_file'
]);

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('Operação cancelada.'), { name: 'AbortError' });
  }
}

function resultPrompt(executed: ExecutedTool[], taskReminder?: string): string {
  const toolResults = executed.flatMap(({ call, result }) => [
    '<resultado_ferramenta>',
    `Nome: ${call.name}`,
    `Argumentos: ${JSON.stringify(call.arguments)}`,
    `Sucesso: ${result.ok}`,
    `Resultado: ${JSON.stringify(result.content)}`,
    result.error ? `Erro: ${result.error}` : '',
    '</resultado_ferramenta>'
  ].filter(Boolean));

  return [
    ...toolResults,
    '',
    taskReminder ? `Lembre-se da tarefa original:\n${taskReminder}` : '',
    'Continue a tarefa considerando TODOS os resultados acima.',
    'Chame somente as ferramentas que ainda forem necessárias.',
    'Nunca mostre JSON de ferramenta ao usuário. Finalize em texto ou prepare uma revisão.'
  ].filter(Boolean).join('\n');
}

function cleanTaskReminder(taskReminder?: string): string {
  return String(taskReminder ?? '')
    .replace(/<\/?tarefa_usuario>/gi, '')
    .trim();
}

function reviewText(finalizer: ToolCall | undefined, writes: ToolCall[], taskReminder?: string): string {
  const summary = typeof finalizer?.arguments.summary === 'string'
    ? finalizer.arguments.summary.trim()
    : '';
  const task = cleanTaskReminder(taskReminder);
  const files = [...new Set(writes
    .map(call => call.arguments.filePath)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];

  return [
    'Alteração preparada para revisão.',
    summary || task || undefined,
    files.length ? `Arquivo${files.length > 1 ? 's' : ''}: ${files.join(', ')}` : undefined
  ].filter(Boolean).join('\n\n');
}

function recoveryPrompt(schema: boolean, taskReminder?: string): string {
  const task = cleanTaskReminder(taskReminder);
  return [
    '<correcao_chamada_ferramenta>',
    schema
      ? 'A resposta anterior copiou o schema de uma ferramenta e não executou nenhuma ação.'
      : 'A resposta anterior parecia uma chamada de ferramenta, mas estava em formato inválido.',
    task ? `<tarefa_original>\n${task}\n</tarefa_original>` : '',
    'Continue a mesma tarefa e refaça a chamada COMPLETA.',
    'Responda SOMENTE com uma chamada válida neste formato:',
    '{"name":"nome_da_ferramenta","arguments":{"argumento":"valor"}}',
    'Não use bloco Markdown. Não retorne o schema. Não explique a chamada.',
    '</correcao_chamada_ferramenta>'
  ].join('\n');
}

function skippedApplyChangesResult(call: ToolCall): ToolResult {
  return {
    callId: call.id,
    name: call.name,
    ok: false,
    content: null,
    error: 'apply_changes foi adiado porque nenhuma alteração foi preparada com sucesso.',
    durationMs: 0
  };
}

export class AgentLoop {
  async run(options: AgentLoopOptions): Promise<AgentLoopResult> {
    const limit = Math.max(1, Math.min(30, Math.floor(options.maxSteps || 10)));
    const calls: ToolCall[] = [];
    const results: ToolResult[] = [];
    const successfulWrites: ToolCall[] = [];
    let prompt = options.initialPrompt;
    let invalidRecoveryUsed = false;

    for (let step = 1; step <= limit; step += 1) {
      while (true) {
        ensureNotAborted(options.signal);
        options.log('debug', `Etapa ${step}/${limit} iniciada${invalidRecoveryUsed ? ' (recuperação)' : ''}.`);
        const startedAt = Date.now();
        const response = String(await options.invokeStep(prompt, step) ?? '');
        options.log('debug', `Resposta recebida em ${Date.now() - startedAt} ms; caracteres=${response.length}.`);
        if (options.diagnosticMode) {
          options.log('debug', `Resposta bruta: ${response.slice(0, 12000)}`);
        }

        const detected = detectToolCalls(response);
        if (!detected.length) {
          if (looksLikeToolCall(response)) {
            const schema = looksLikeToolSchema(response);
            options.log('warn', `${schema ? 'Schema de ferramenta' : 'Chamada de ferramenta inválida'} recebido: ${response.slice(0, 2000)}`);
            if (!invalidRecoveryUsed) {
              invalidRecoveryUsed = true;
              prompt = recoveryPrompt(schema, options.taskReminder);
              continue;
            }
            throw new Error(schema
              ? 'O modelo retornou o schema da ferramenta em vez de executá-la, mesmo após uma tentativa de correção. Consulte os logs do Agente.'
              : 'O modelo retornou uma chamada de ferramenta inválida, mesmo após uma tentativa de correção. Consulte os logs do Agente.');
          }
          return { text: response, steps: step, calls, results };
        }

        invalidRecoveryUsed = false;
        const executed: ExecutedTool[] = [];
        const finalizers = detected.filter(call => call.name === 'apply_changes');
        const regularCalls = detected.filter(call => call.name !== 'apply_changes');

        for (let index = 0; index < regularCalls.length; index += 1) {
          ensureNotAborted(options.signal);
          const call = regularCalls[index]!;
          calls.push(call);
          options.log('info', `Executando ferramenta ${call.name} (${index + 1}/${regularCalls.length + finalizers.length}).`);
          const result = await options.executeTool(call);
          results.push(result);
          executed.push({ call, result });

          if (!result.ok) {
            options.log('error', `Ferramenta ${call.name} falhou: ${result.error ?? 'erro desconhecido'}`);
            if (REVIEW_WRITE_TOOLS.has(call.name)) {
              options.log('warn', 'Escrita rejeitada; encerrando sem nova geracao do modelo.');
              throw new Error(result.error ?? `A ferramenta ${call.name} rejeitou a alteracao proposta.`);
            }
            continue;
          }

          if (REVIEW_WRITE_TOOLS.has(call.name)) {
            successfulWrites.push(call);
          }
        }

        if (successfulWrites.length) {
          const finalizer = finalizers.at(-1);
          if (finalizer) {
            calls.push(finalizer);
            options.log('info', `Executando ferramenta ${finalizer.name} (${regularCalls.length + 1}/${regularCalls.length + finalizers.length}).`);
            const result = await options.executeTool(finalizer);
            results.push(result);
            executed.push({ call: finalizer, result });
            if (!result.ok) {
              options.log('warn', `apply_changes falhou após uma escrita válida; a revisão pendente será preservada: ${result.error ?? 'erro desconhecido'}`);
            }
          } else {
            options.log('debug', 'Escrita preparada com sucesso; encerrando sem nova geração do modelo.');
          }

          return {
            text: reviewText(finalizer, successfulWrites, options.taskReminder),
            steps: step,
            calls,
            results
          };
        }

        for (const finalizer of finalizers) {
          calls.push(finalizer);
          const skipped = skippedApplyChangesResult(finalizer);
          results.push(skipped);
          executed.push({ call: finalizer, result: skipped });
          options.log('warn', skipped.error ?? 'apply_changes adiado.');
        }

        prompt = resultPrompt(executed, options.taskReminder);
        break;
      }
    }

    throw new Error(`O agente excedeu o limite de ${limit} etapas.`);
  }
}
