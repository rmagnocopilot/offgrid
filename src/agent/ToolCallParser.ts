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
  gitDiff: 'git_diff'
};

function canonicalToolName(name: string): string { return TOOL_ALIASES[name] ?? name; }

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

function normalize(value: unknown, raw?: string): ToolCall | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const call = normalize(item, raw);
      if (call) return call;
    }
    return null;
  }
  const object = value as Record<string, unknown>;
  if (object.tool_call) return normalize(object.tool_call, raw);
  if (object.function_call) return normalize(object.function_call, raw);
  if (object.tool_calls) return normalize(object.tool_calls, raw);
  if (object.function && typeof object.function === 'object') {
    const fn = object.function as Record<string, unknown>;
    const name = String(fn.name ?? '').trim();
    const args = parseArguments(fn.arguments ?? fn.args ?? fn.parameters);
    return name && args ? { id: String(object.id ?? randomUUID()), name: canonicalToolName(name), arguments: args, raw } : null;
  }
  const name = String(object.name ?? object.tool ?? object.functionName ?? '').trim();
  const args = parseArguments(object.arguments ?? object.args ?? object.parameters ?? object.input ?? {});
  return name && args ? { id: String(object.id ?? randomUUID()), name: canonicalToolName(name), arguments: args, raw } : null;
}

function balancedCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (!first || !'{['.includes(first)) continue;
    const stack: string[] = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (!character) break;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') { quoted = true; continue; }
      if ('{['.includes(character)) stack.push(character);
      else if ('}]'.includes(character)) {
        const opener = stack.at(-1);
        if ((opener === '{' && character !== '}') || (opener === '[' && character !== ']')) break;
        stack.pop();
        if (!stack.length) { candidates.push(text.slice(start, index + 1)); break; }
      }
    }
  }
  return candidates;
}

function parseXml(text: string): ToolCall | null {
  const call = text.match(/<tool_call(?:\s+name=["']([^"']+)["'])?>([\s\S]*?)<\/tool_call>/i);
  if (!call) return null;
  const body = call[2]?.trim();
  if (!body) return null;
  if (call[1]) {
    const args = parseArguments(body) ?? {};
    return { id: randomUUID(), name: call[1], arguments: args, raw: call[0] };
  }
  try { return normalize(JSON.parse(body), call[0]); } catch { return null; }
}

function parseFunctionTag(text: string): ToolCall | null {
  const match = text.match(/<function[=:][\"']?([A-Za-z_][\w.-]*)[\"']?>([\s\S]*?)<\/function>/i);
  if (!match?.[1]) return null;
  const args = parseArguments(match[2]?.trim() ?? '') ?? {};
  return { id: randomUUID(), name: canonicalToolName(match[1]), arguments: args, raw: match[0] };
}

export function detectToolCall(text: string): ToolCall | null {
  const raw = stripFence(text);
  const xml = parseXml(raw) ?? parseFunctionTag(raw);
  if (xml) return xml;
  const candidates = [raw, ...balancedCandidates(raw)];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const call = normalize(JSON.parse(candidate), candidate);
      if (call) return call;
    } catch { /* continue */ }
  }
  return null;
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
