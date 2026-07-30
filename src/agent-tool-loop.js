'use strict';

function abortError() {
  return Object.assign(new Error('Operação cancelada.'), { name: 'AbortError' });
}

function ensureNotAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function stripCodeFence(text) {
  const value = String(text || '').trim();
  const match = value.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : value;
}

function balancedJsonCandidates(text) {
  const value = String(text || '');
  const candidates = [];
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== '{' && value[start] !== '[') continue;
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const character = value[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') {
        quoted = true;
        continue;
      }
      if (character === '{' || character === '[') stack.push(character);
      else if (character === '}' || character === ']') {
        const opener = stack.at(-1);
        if ((opener === '{' && character !== '}') || (opener === '[' && character !== ']')) break;
        stack.pop();
        if (stack.length === 0) {
          candidates.push(value.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function parseArguments(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeToolCall(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeToolCall(item);
      if (normalized) return normalized;
    }
    return null;
  }

  if (value.tool_call) return normalizeToolCall(value.tool_call);
  if (value.function_call) return normalizeToolCall(value.function_call);
  if (Array.isArray(value.tool_calls)) return normalizeToolCall(value.tool_calls);

  if (value.function && typeof value.function === 'object') {
    const name = String(value.function.name || '').trim();
    const args = parseArguments(value.function.arguments ?? value.function.args ?? value.function.parameters);
    return name && args ? { name, arguments: args, source: 'function' } : null;
  }

  const name = String(value.name || value.tool || value.functionName || '').trim();
  const args = parseArguments(value.arguments ?? value.args ?? value.parameters ?? value.input ?? {});
  return name && args ? { name, arguments: args, source: 'json' } : null;
}

function detectToolCall(text) {
  const raw = stripCodeFence(text);
  const xmlMatches = [...raw.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)].map(match => match[1]);
  const candidates = [raw, ...xmlMatches, ...balancedJsonCandidates(raw)];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const call = normalizeToolCall(JSON.parse(candidate));
      if (call) return { ...call, raw: candidate };
    } catch {
      // Continua procurando um bloco JSON válido na resposta.
    }
  }
  return null;
}

function looksLikeToolCall(text) {
  const value = String(text || '');
  return /"(?:name|tool|functionName|function_call|tool_call)"\s*:|"tool_calls"\s*:|<tool_call>/i.test(value);
}

function resultLength(result) {
  try { return JSON.stringify(result).length; } catch { return String(result).length; }
}

function serializeResult(result) {
  try { return JSON.stringify(result); }
  catch { return JSON.stringify({ value: String(result) }); }
}

function buildToolResultPrompt(call, result) {
  return [
    '<resultado_ferramenta>',
    `Nome: ${call.name}`,
    `Argumentos: ${JSON.stringify(call.arguments)}`,
    `Resultado: ${serializeResult(result)}`,
    '</resultado_ferramenta>',
    '',
    'Continue a tarefa usando esse resultado. Chame outra ferramenta quando necessário.',
    'Não mostre ao usuário JSON de ferramenta. Conclua com uma resposta textual ou finalize as alterações com applyChanges.'
  ].join('\n');
}

async function executeAgentToolLoop({
  initialPrompt,
  invokeStep,
  handlers,
  maxSteps = 10,
  signal,
  log = () => {},
  diagnosticMode = false
}) {
  if (typeof invokeStep !== 'function') throw new TypeError('invokeStep precisa ser uma função.');
  let prompt = String(initialPrompt || '');
  const calls = [];
  const limit = Math.max(1, Math.min(30, Number(maxSteps) || 10));

  for (let step = 1; step <= limit; step += 1) {
    ensureNotAborted(signal);
    log('debug', `Etapa ${step}/${limit} iniciada.`);
    const startedAt = Date.now();
    const response = String(await invokeStep(prompt, { step, signal }) || '');
    log('debug', `Resposta da etapa ${step} recebida em ${Date.now() - startedAt} ms. Caracteres=${response.length}.`);
    if (diagnosticMode) log('trace', `Resposta bruta da etapa ${step}: ${response.slice(0, 12000)}`);

    const call = detectToolCall(response);
    if (!call) {
      if (looksLikeToolCall(response)) {
        log('warn', `Resposta parece tool call, mas não foi interpretada. Conteúdo bruto=${response.slice(0, 2000)}`);
        throw new Error('O modelo retornou uma chamada de ferramenta inválida. Consulte os logs do Agente.');
      }
      log('debug', `Nenhuma tool call detectada na etapa ${step}. Finalizando.`);
      return { text: response, steps: step, calls };
    }

    log('info', `Tool call detectada: ${call.name}.`);
    if (diagnosticMode) log('trace', `Argumentos de ${call.name}: ${JSON.stringify(call.arguments)}`);
    const handler = handlers?.[call.name];
    if (typeof handler !== 'function') {
      log('error', `Ferramenta solicitada não está disponível: ${call.name}.`);
      throw new Error(`Ferramenta solicitada pelo modelo não está disponível: ${call.name}`);
    }

    const toolStartedAt = Date.now();
    try {
      log('debug', `Executando ferramenta: ${call.name}.`);
      const result = await handler(call.arguments);
      calls.push({ name: call.name, arguments: call.arguments, result });
      log('info', `Resultado da ferramenta ${call.name} recebido em ${Date.now() - toolStartedAt} ms. Caracteres=${resultLength(result)}.`);
      if (diagnosticMode) log('trace', `Resultado de ${call.name}: ${serializeResult(result).slice(0, 12000)}`);
      log('debug', `Enviando resultado de ${call.name} de volta ao modelo.`);
      prompt = buildToolResultPrompt(call, result);
    } catch (error) {
      log('error', `Falha ao executar ferramenta ${call.name}. Argumentos=${JSON.stringify(call.arguments)}\n${error?.stack || error}`);
      throw error;
    }
  }

  throw new Error(`O agente excedeu o número máximo de etapas (${limit}).`);
}

module.exports = {
  detectToolCall,
  looksLikeToolCall,
  buildToolResultPrompt,
  executeAgentToolLoop,
  normalizeToolCall,
  balancedJsonCandidates
};
