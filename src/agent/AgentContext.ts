import * as path from 'node:path';

const EXTENSIONS = [
  'js','cjs','mjs','jsx','ts','tsx','json','jsonc','css','scss','html','md','py','java','kt','kts',
  'gradle','properties','cs','go','rs','php','vue','svelte','yml','yaml','xml','jsp','sql','sh','ps1'
].join('|');
const FILE_PATTERN = new RegExp(`(?:[A-Za-z]:)?[\\w@./\\\\-]+\\.(?:${EXTENSIONS})(?![A-Za-z0-9_])`, 'gi');
const SHORTHAND_PATTERN = new RegExp(`^\\s*\\/\\s*(${EXTENSIONS})\\b`, 'i');

export function extractExplicitFileReferences(text: string): string[] {
  const references: string[] = [];
  const seen = new Set<string>();
  for (const match of String(text ?? '').matchAll(FILE_PATTERN)) {
    const raw = match[0].replace(/[),;:'"`]+$/g, '');
    const normalized = raw.replace(/\\/g, '/');
    add(normalized);
    const tailStart = (match.index ?? 0) + match[0].length;
    const shorthand = text.slice(tailStart, tailStart + 40).match(SHORTHAND_PATTERN);
    const extension = shorthand?.[1];
    if (extension) add(normalized.replace(/\.[^./]+$/, `.${extension.toLowerCase()}`));
  }
  return references.slice(0, 20);

  function add(reference: string): void {
    const key = reference.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  }
}

export function basenameReference(reference: string): string {
  return path.posix.basename(String(reference ?? '').replace(/\\/g, '/'));
}

export function buildContextPriority(params: {
  prompt: string;
  selectionFile?: string;
  pinnedFile?: string;
  relatedFiles?: string[];
}): string[] {
  const ordered = [
    ...extractExplicitFileReferences(params.prompt),
    params.selectionFile,
    params.pinnedFile,
    ...(params.relatedFiles ?? [])
  ].filter((value): value is string => Boolean(value));
  const seen = new Set<string>();
  return ordered.filter(value => {
    const key = value.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
