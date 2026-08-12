import type { ToolCall, ToolResult } from '../types/contracts';
import { detectToolCalls, looksLikeToolCall, looksLikeToolSchema, looksLikeTruncatedCreateFileCall } from './ToolCallParser';
import { compactTaskReminderForContinuation, serializeToolArgumentsForPrompt, serializeToolResultForPrompt } from './AgentToolResultBudget';

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
  /** Limite total aproximado do prompt de continuação após ferramentas. */
  continuationPromptMaxChars?: number;
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

function resultPrompt(
  executed: ExecutedTool[],
  taskReminder?: string,
  maxChars = 6_000
): string {
  const totalLimit = Math.max(900, Math.floor(maxChars));
  const reminderLimit = Math.max(220, Math.min(700, Math.floor(totalLimit * 0.28)));
  const compactReminder = taskReminder
    ? compactTaskReminderForContinuation(taskReminder, reminderLimit)
    : '';
  const fixedTail = [
    compactReminder ? `Lembre-se da tarefa original:\n${compactReminder}` : '',
    'Continue a tarefa considerando TODOS os resultados acima.',
    'Chame somente as ferramentas que ainda forem necessárias.',
    'Nunca mostre JSON de ferramenta ao usuário. Finalize em texto ou prepare uma revisão.'
  ].filter(Boolean).join('\n');

  const remaining = Math.max(420, totalLimit - fixedTail.length - 32);
  const perResult = Math.max(320, Math.floor(remaining / Math.max(1, executed.length)));
  const toolResults = executed.map(({ call, result }) => {
    const argumentLimit = Math.max(120, Math.min(360, Math.floor(perResult * 0.24)));
    const errorText = result.error
      ? compactTaskReminderForContinuation(String(result.error), Math.max(120, Math.floor(perResult * 0.22)))
      : '';
    const contentLimit = Math.max(160, perResult - argumentLimit - errorText.length - 140);
    return [
      '<resultado_ferramenta>',
      `Nome: ${call.name}`,
      `Argumentos: ${serializeToolArgumentsForPrompt(call.name, call.arguments, argumentLimit)}`,
      `Sucesso: ${result.ok}`,
      `Resultado: ${serializeToolResultForPrompt(call.name, result.content, contentLimit)}`,
      errorText ? `Erro: ${errorText}` : '',
      '</resultado_ferramenta>'
    ].filter(Boolean).join('\n');
  });

  return [
    ...toolResults,
    fixedTail
  ].filter(Boolean).join('\n\n');
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


function isExplicitUserRejection(result: ToolResult): boolean {
  const message = String(result.error ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return (message.includes('rejeitad') && message.includes('usuario'))
    || (message.includes('cancelad') && message.includes('usuario'))
    || (message.includes('rejected') && message.includes('user'))
    || (message.includes('cancelled') && message.includes('user'))
    || (message.includes('canceled') && message.includes('user'));
}

function skippedApplyChangesResult(call: ToolCall): ToolResult {
  return {
    callId: call.id,
    name: call.name,
    ok: false,
    content: null,
    error: 'apply_changes foi adiado porque a tarefa ainda não está pronta para revisão.',
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
            const truncatedCreateFile = !schema && looksLikeTruncatedCreateFileCall(response);
            options.log('warn', `${schema ? 'Schema de ferramenta' : truncatedCreateFile ? 'create_file truncado' : 'Chamada de ferramenta inválida'} recebido: ${response.slice(0, 2000)}`);
            if (truncatedCreateFile) {
              throw Object.assign(
                new Error('A chamada create_file foi truncada antes de fechar o conteúdo. O limite de saída da geração foi insuficiente para o arquivo completo.'),
                { name: 'ToolCallTruncatedError' }
              );
            }
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
        const successfulWritesBefore = successfulWrites.length;
        let recoverableWriteFailure = false;
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
              if (isExplicitUserRejection(result)) {
                options.log('warn', 'Escrita rejeitada pelo usuário; encerrando sem nova geração do modelo.');
                throw new Error(result.error ?? `A ferramenta ${call.name} foi rejeitada pelo usuário.`);
              }
              recoverableWriteFailure = true;
              options.log('warn', 'Escrita inválida; devolvendo o erro ao modelo para uma tentativa de correção.');
            }
            continue;
          }

          if (REVIEW_WRITE_TOOLS.has(call.name)) {
            successfulWrites.push(call);
          }
        }

        const wroteSuccessfullyThisTurn = successfulWrites.length > successfulWritesBefore;

        if (recoverableWriteFailure) {
          for (const finalizer of finalizers) {
            calls.push(finalizer);
            const skipped = skippedApplyChangesResult(finalizer);
            results.push(skipped);
            executed.push({ call: finalizer, result: skipped });
            options.log('warn', skipped.error ?? 'apply_changes adiado.');
          }
          prompt = resultPrompt(executed, options.taskReminder, options.continuationPromptMaxChars);
          break;
        }

        if (wroteSuccessfullyThisTurn) {
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

        prompt = resultPrompt(executed, options.taskReminder, options.continuationPromptMaxChars);
        break;
      }
    }

    throw new Error(`O agente excedeu o limite de ${limit} etapas.`);
  }
}
