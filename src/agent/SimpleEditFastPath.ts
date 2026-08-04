import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';
import { isFileCreationTask } from './AgentTaskPolicy';

export interface SimpleReplacement {
  oldText: string;
  newText: string;
  replaceAll: boolean;
  occurrences: number;
}

export interface SimpleEditFastPathResult {
  text: string;
  call: ToolCall;
  result: ToolResult;
}

export interface SimpleEditFastPathOptions {
  request: string;
  workspaceRoot?: string;
  priority: string[];
  execute: (call: ToolCall) => Promise<ToolResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

const ACTION_PATTERN = /\b(?:altere|alterar|troque|trocar|substitua|substituir|mude|mudar|renomeie|renomear)\b/i;
const ALL_PATTERN = /\b(?:todos|todas|cada|em\s+todo|em\s+toda|todas\s+as\s+ocorr[eê]ncias|replace\s+all)\b/i;

function stripOuterQuotes(value: string): string {
  return value
    .trim()
    .replace(/^[`'"“”‘’]+/, '')
    .replace(/[`'"“”‘’]+$/, '')
    .trim();
}

function cleanRight(value: string): string {
  return stripOuterQuotes(value)
    .replace(/\s+(?:no|na)\s+arquivo\s+[`'"“”]?[\w./\\-]+\.[A-Za-z0-9]+[`'"“”]?\s*$/i, '')
    .replace(/[.;,:!?]+$/, '')
    .trim();
}

function existingSuffix(value: string, content: string): string | undefined {
  const cleaned = stripOuterQuotes(value)
    .replace(/^(?:por\s+favor[,;:]?\s*)/i, '')
    .replace(/^(?:altere|alterar|troque|trocar|substitua|substituir|mude|mudar|renomeie|renomear)\b\s*/i, '')
    .trim();

  if (cleaned && content.includes(cleaned)) return cleaned;

  const words = cleaned.split(/\s+/).filter(Boolean);
  for (let index = 1; index < words.length; index += 1) {
    const candidate = words.slice(index).join(' ').trim();
    if (candidate && content.includes(candidate)) return candidate;
  }
  return undefined;
}

function quotedValues(request: string): string[] {
  const values: string[] = [];
  const expression = /["“'‘`](.*?)["”'’`]/g;
  for (const match of request.matchAll(expression)) {
    const value = match[1]?.trim();
    if (value) values.push(value);
  }
  return values;
}

function countOccurrences(content: string, oldText: string): number {
  if (!oldText) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= content.length - oldText.length) {
    const index = content.indexOf(oldText, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(1, oldText.length);
  }
  return count;
}

function buildReplacement(request: string, content: string, oldText: string, newText: string): SimpleReplacement | undefined {
  const oldValue = stripOuterQuotes(oldText);
  const newValue = cleanRight(newText);
  if (!oldValue || !newValue || oldValue === newValue) return undefined;
  if (oldValue.length > 240 || newValue.length > 240) return undefined;
  if (oldValue.includes('\n') || newValue.includes('\n')) return undefined;

  const occurrences = countOccurrences(content, oldValue);
  if (!occurrences) return undefined;
  const replaceAll = occurrences === 1 || ALL_PATTERN.test(request);
  if (occurrences > 1 && !replaceAll) return undefined;

  return { oldText: oldValue, newText: newValue, replaceAll, occurrences };
}

export function detectSimpleReplacement(request: string, content: string): SimpleReplacement | undefined {
  const normalizedRequest = String(request ?? '').replace(/\s+/g, ' ').trim();
  if (!normalizedRequest || !ACTION_PATTERN.test(normalizedRequest)) return undefined;

  const quoted = quotedValues(normalizedRequest);
  if (quoted.length >= 2 && /\b(?:para|por)\b/i.test(normalizedRequest)) {
    const direct = buildReplacement(normalizedRequest, content, quoted[0]!, quoted[1]!);
    if (direct) return direct;
  }

  const separators = [...normalizedRequest.matchAll(/\s+(?:para|por)\s+/gi)];
  for (let index = separators.length - 1; index >= 0; index -= 1) {
    const separator = separators[index]!;
    const start = separator.index ?? -1;
    if (start < 0) continue;
    const left = normalizedRequest.slice(0, start);
    const right = normalizedRequest.slice(start + separator[0].length);
    const oldValue = existingSuffix(left, content);
    if (!oldValue) continue;
    const replacement = buildReplacement(normalizedRequest, content, oldValue, right);
    if (replacement) return replacement;
  }

  return undefined;
}

export async function tryPrepareSimpleEditFastPath(options: SimpleEditFastPathOptions): Promise<SimpleEditFastPathResult | undefined> {
  const root = options.workspaceRoot;
  if (!root) return undefined;
  if (isFileCreationTask(options.request)) return undefined;
  if (!ACTION_PATTERN.test(String(options.request ?? ''))) return undefined;

  const prioritized = options.priority
    .map(item => item.split('#')[0])
    .find((item): item is string => Boolean(item));
  if (!prioritized) return undefined;

  let filePath: string;
  let content: string;
  try {
    filePath = normalizeRelativePath(prioritized);
    content = await fsp.readFile(resolveInsideRoot(root, filePath), 'utf8');
  } catch (error) {
    options.warn?.(`[FastPath] Não foi possível ler o arquivo prioritário: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const replacement = detectSimpleReplacement(options.request, content);
  if (!replacement) return undefined;

  const call: ToolCall = {
    id: randomUUID(),
    name: 'apply_edit',
    arguments: {
      filePath,
      oldText: replacement.oldText,
      newText: replacement.newText,
      replaceAll: replacement.replaceAll
    }
  };

  options.info?.(
    `[FastPath] Substituição simples detectada; modelo não será chamado. arquivo=${filePath} ocorrências=${replacement.occurrences}`
  );

  const result = await options.execute(call);
  if (!result.ok) {
    options.warn?.(`[FastPath] apply_edit falhou; seguindo pelo AgentLoop: ${result.error ?? 'erro desconhecido'}`);
    return undefined;
  }

  return {
    call,
    result,
    text: [
      'Alteração preparada para revisão.',
      `Arquivo: ${filePath}`,
      `Substituição: “${replacement.oldText}” → “${replacement.newText}”`
    ].join('\n\n')
  };
}
