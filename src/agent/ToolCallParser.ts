import { randomUUID } from 'node:crypto';
import type { ToolCall } from '../types/contracts';

const TOOL_ALIASES: Record<string, string> = {
  listWorkspaceFiles: 'list_files',
  readWorkspaceFile: 'read_file',
  searchWorkspace: 'search_codebase',
  searchCodebase: 'search_codebase',
  prepareFileChange: 'create_file',
  applyChanges: 'apply_changes',
  getActiveFile: 'get_active_file',
  getSelection: 'get_selection',
  getDiagnostics: 'get_diagnostics',
  findSymbol: 'find_symbol',
  findDefinition: 'find_definition',
  findReferences: 'find_references',
  gitStatus: 'git_status',
  gitDiff: 'git_diff',
  renameSymbol: 'apply_edit',
  rename_symbol: 'apply_edit'
};

function stripFence(text: string): string {
  const value = String(text ?? '').trim();
  const match = value.match(/^```(?:json|javascript|js|xml)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ? match[1].trim() : value;
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function definedEntries(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function unwrapSerializedJavaString(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  let current = value;

  for (let depth = 0; depth < 2; depth += 1) {
    const trimmed = current.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return current;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return current;
      const object = parsed as Record<string, unknown>;
      if (object['@class'] !== 'java.lang.String' || typeof object.content !== 'string') return current;
      current = object.content;
    } catch {
      return current;
    }
  }

  return current;
}

function canonicalize(name: string, args: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } {
  const canonicalName = TOOL_ALIASES[name] ?? name;

  if (name === 'rename_symbol' || name === 'renameSymbol') {
    return {
      name: 'apply_edit',
      arguments: definedEntries({
        filePath: args.filePath ?? args.path,
        oldText: args.oldText ?? args.oldName ?? args.from,
        newText: args.newText ?? args.newName ?? args.to,
        replaceAll: args.replaceAll ?? true
      })
    };
  }

  if (canonicalName === 'find_symbol') {
    return {
      name: canonicalName,
      arguments: definedEntries({ query: args.query ?? args.name ?? args.symbol })
    };
  }

  if (canonicalName === 'get_active_file' || canonicalName === 'get_selection' || canonicalName === 'git_status') {
    return { name: canonicalName, arguments: {} };
  }

  if (canonicalName === 'create_file') {
    return {
      name: canonicalName,
      arguments: {
        ...args,
        content: unwrapSerializedJavaString(args.content)
      }
    };
  }

  return { name: canonicalName, arguments: args };
}

function createCall(name: string, args: Record<string, unknown>, id?: unknown, raw?: string): ToolCall {
  const canonical = canonicalize(name, args);
  return {
    id: String(id ?? randomUUID()),
    name: canonical.name,
    arguments: canonical.arguments,
    raw
  };
}

function normalizeAll(value: unknown, raw?: string): ToolCall[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(item => normalizeAll(item, raw));

  const object = value as Record<string, unknown>;
  if (object.tool_call) return normalizeAll(object.tool_call, raw);
  if (object.function_call) return normalizeAll(object.function_call, raw);
  if (object.tool_calls) return normalizeAll(object.tool_calls, raw);

  if (object.function && typeof object.function === 'object') {
    const fn = object.function as Record<string, unknown>;
    const name = String(fn.name ?? '').trim();
    const args = parseArguments(fn.arguments ?? fn.args ?? fn.parameters);
    return name && args ? [createCall(name, args, object.id, raw)] : [];
  }

  const name = String(object.name ?? object.tool ?? object.functionName ?? '').trim();
  const args = parseArguments(object.arguments ?? object.args ?? object.parameters ?? object.input ?? {});
  return name && args ? [createCall(name, args, object.id, raw)] : [];
}

function balancedCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  const stack: string[] = [];
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!character) continue;

    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }

    if (character === '"') {
      if (stack.length) quoted = true;
      continue;
    }

    if (character === '{' || character === '[') {
      if (!stack.length) start = index;
      stack.push(character);
      continue;
    }

    if (character !== '}' && character !== ']') continue;
    const opener = stack.at(-1);
    const validPair = (opener === '{' && character === '}') || (opener === '[' && character === ']');
    if (!validPair) {
      stack.length = 0;
      start = -1;
      continue;
    }

    stack.pop();
    if (!stack.length && start >= 0) {
      candidates.push(text.slice(start, index + 1));
      start = -1;
    }
  }

  return candidates;
}

function parseXmlCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const expression = /<tool_call(?:\s+name=["']([^"']+)["'])?>([\s\S]*?)<\/tool_call>/gi;
  for (const match of text.matchAll(expression)) {
    const body = match[2]?.trim();
    if (!body) continue;
    if (match[1]) {
      const args = parseArguments(body) ?? {};
      calls.push(createCall(match[1], args, undefined, match[0]));
      continue;
    }
    try { calls.push(...normalizeAll(JSON.parse(body), match[0])); } catch { /* continue */ }
  }
  return calls;
}

function parseFunctionTags(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const expression = /<function[=:]["']?([A-Za-z_][\w.-]*)["']?>([\s\S]*?)<\/function>/gi;
  for (const match of text.matchAll(expression)) {
    if (!match[1]) continue;
    const args = parseArguments(match[2]?.trim() ?? '') ?? {};
    calls.push(createCall(match[1], args, undefined, match[0]));
  }
  return calls;
}


interface LooseStringValue {
  value: string;
  end: number;
}

function decodeLooseEscapes(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\' || index + 1 >= value.length) {
      output += character;
      continue;
    }

    const next = value[index + 1];
    index += 1;
    switch (next) {
      case 'n': output += '\n'; break;
      case 'r': output += '\r'; break;
      case 't': output += '\t'; break;
      case 'b': output += '\b'; break;
      case 'f': output += '\f'; break;
      case '"': output += '"'; break;
      case "'": output += "'"; break;
      case '`': output += '`'; break;
      case '\\': output += '\\'; break;
      default: output += `\\${next ?? ''}`; break;
    }
  }
  return output;
}

function isLooseClosingBoundary(text: string, offset: number): boolean {
  return /^\s*(?:,\s*"[A-Za-z_][\w.-]*"\s*:|[}\]])/.test(text.slice(offset))
    || /^\s*$/.test(text.slice(offset));
}

function readLooseString(text: string, start: number, allowApplyChangesBoundary = false): LooseStringValue | undefined {
  let offset = start;
  while (/\s/.test(text[offset] ?? '')) offset += 1;
  const quote = text[offset];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;

  let escaped = false;
  for (let index = offset + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character !== quote) continue;

    if (quote === '`' || isLooseClosingBoundary(text, index + 1)) {
      return {
        value: decodeLooseEscapes(text.slice(offset + 1, index)),
        end: index + 1
      };
    }
  }

  if (allowApplyChangesBoundary) {
    const remainder = text.slice(offset + 1);
    const marker = remainder.search(/\r?\n\s*apply_changes\s*\(/i);
    if (marker >= 0) {
      return {
        value: decodeLooseEscapes(remainder.slice(0, marker).replace(/\s+$/, '')),
        end: offset + 1 + marker
      };
    }
  }
  return undefined;
}

function looseProperty(text: string, property: string, from: number, allowApplyChangesBoundary = false): LooseStringValue | undefined {
  const expression = new RegExp(`"${property}"\\s*:\\s*`, 'g');
  expression.lastIndex = from;
  const match = expression.exec(text);
  if (!match) return undefined;
  return readLooseString(text, expression.lastIndex, allowApplyChangesBoundary);
}

function parseRelaxedCreateFileCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const expression = /"name"\s*:\s*"create_file"/g;
  for (const match of text.matchAll(expression)) {
    const from = (match.index ?? 0) + match[0].length;
    const filePath = looseProperty(text, 'filePath', from);
    if (!filePath) continue;
    const content = looseProperty(text, 'content', filePath.end, true);
    if (!content) continue;
    const reason = looseProperty(text, 'reason', content.end);
    const argumentsValue: Record<string, unknown> = {
      filePath: filePath.value,
      content: content.value
    };
    if (reason?.value) argumentsValue.reason = reason.value;
    calls.push(createCall('create_file', argumentsValue, undefined, text.slice(match.index ?? 0, reason?.end ?? content.end)));
  }
  return calls;
}

function parsePlainApplyChangesCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const expression = /\bapply_changes\s*\(\s*/gi;
  for (const match of text.matchAll(expression)) {
    const summary = readLooseString(text, (match.index ?? 0) + match[0].length);
    if (!summary) continue;
    calls.push(createCall('apply_changes', { summary: summary.value }, undefined, text.slice(match.index ?? 0, summary.end)));
  }
  return calls;
}

function deduplicateCalls(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  const unique: ToolCall[] = [];
  for (const call of calls) {
    const key = `${call.name}\u0000${JSON.stringify(call.arguments)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(call);
  }
  return unique;
}

export function detectToolCalls(text: string): ToolCall[] {
  const raw = stripFence(text);
  const calls: ToolCall[] = [
    ...parseXmlCalls(raw),
    ...parseFunctionTags(raw)
  ];

  try { calls.push(...normalizeAll(JSON.parse(raw), raw)); } catch { /* continue */ }

  for (const candidate of balancedCandidates(raw)) {
    try { calls.push(...normalizeAll(JSON.parse(candidate), candidate)); } catch { /* continue */ }
  }

  calls.push(...parseRelaxedCreateFileCalls(raw));
  calls.push(...parsePlainApplyChangesCalls(raw));
  return deduplicateCalls(calls);
}

export function detectToolCall(text: string): ToolCall | null {
  return detectToolCalls(text)[0] ?? null;
}

export function looksLikeToolSchema(text: string): boolean {
  const raw = stripFence(text);
  const candidates = [raw, ...balancedCandidates(raw)];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (isToolSchema(JSON.parse(candidate))) return true;
    } catch { /* continue */ }
  }
  return false;
}

export function looksLikeToolCall(text: string): boolean {
  return /"(?:name|tool|functionName|function_call|tool_call)"\s*:|"tool_calls"\s*:|<tool_call/i.test(text)
    || looksLikeToolSchema(text);
}

function isToolSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (object.type !== 'object') return false;
  if (!object.properties || typeof object.properties !== 'object' || Array.isArray(object.properties)) return false;
  return Array.isArray(object.required) || Object.prototype.hasOwnProperty.call(object, 'additionalProperties');
}
