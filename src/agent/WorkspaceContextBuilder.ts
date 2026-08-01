import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';

const TEXT_EXTENSIONS = new Set([
  '.js','.cjs','.mjs','.jsx','.ts','.tsx','.json','.jsonc','.css','.scss','.html','.md','.py','.java',
  '.kt','.kts','.gradle','.properties','.cs','.go','.rs','.php','.vue','.svelte','.yml','.yaml','.xml',
  '.jsp','.sql','.sh','.ps1'
]);

export interface AgentContextFile {
  filePath: string;
  reason: string;
  content: string;
  truncated: boolean;
}

export interface AgentWorkspaceContext {
  files: AgentContextFile[];
  text: string;
}

export async function buildAgentWorkspaceContext(params: {
  workspaceRoot?: string;
  priority: string[];
  maxFiles?: number;
  maxCharsPerFile?: number;
  maxTotalChars?: number;
}): Promise<AgentWorkspaceContext> {
  const root = params.workspaceRoot;
  if (!root) return { files: [], text: '' };

  const requestedTotal = params.maxTotalChars ?? 56_000;
  if (requestedTotal <= 0) return { files: [], text: '' };

  const maxFiles = clamp(params.maxFiles ?? 10, 1, 20);
  const maxCharsPerFile = clamp(params.maxCharsPerFile ?? 12_000, 128, 30_000);
  const maxTotalChars = clamp(requestedTotal, 128, 120_000);
  const queued: Array<{ filePath: string; reason: string; depth: number }> = [];
  const queuedKeys = new Set<string>();
  const files: AgentContextFile[] = [];
  let totalChars = 0;

  const enqueue = (value: string | undefined, reason: string, depth: number): void => {
    if (!value) return;
    const withoutSelection = value.split('#')[0];
    if (!withoutSelection) return;
    let relative: string;
    try { relative = normalizeRelativePath(withoutSelection); } catch { return; }
    const key = relative.toLowerCase();
    if (queuedKeys.has(key)) return;
    const absolute = resolveInsideRoot(root, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return;
    if (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) return;
    queuedKeys.add(key);
    queued.push({ filePath: relative, reason, depth });
  };

  for (const [index, item] of params.priority.entries()) {
    enqueue(item, index === 0 ? 'arquivo citado ou ativo prioritário' : 'arquivo priorizado pelo contexto', 0);
  }

  while (queued.length && files.length < maxFiles && totalChars < maxTotalChars) {
    const candidate = queued.shift();
    if (!candidate) break;
    const absolute = resolveInsideRoot(root, candidate.filePath);
    let content: string;
    try { content = await fsp.readFile(absolute, 'utf8'); } catch { continue; }

    const allowed = Math.min(maxCharsPerFile, maxTotalChars - totalChars);
    if (allowed <= 0) break;
    const truncated = content.length > allowed;
    const truncationMarker = '\n/* contexto truncado pelo Offgrid */';
    const selected = truncated
      ? `${content.slice(0, Math.max(0, allowed - truncationMarker.length))}${truncationMarker}`
      : content;
    files.push({ filePath: candidate.filePath, reason: candidate.reason, content: selected, truncated });
    totalChars += selected.length;

    // O modelo usa read_file para buscar arquivos adicionais quando a tarefa exigir.
  }

  if (!files.length) return { files, text: '' };

  const compact = maxTotalChars < 2_000;
  const text = compact
    ? [
        '<contexto_workspace>',
        ...files.map(file => [
          `<arquivo caminho="${escapeAttribute(file.filePath)}"${file.truncated ? ' truncado="true"' : ''}>`,
          file.content,
          '</arquivo>'
        ].join('\n')),
        '</contexto_workspace>'
      ].join('\n')
    : [
        '<contexto_workspace_analisado>',
        'Os arquivos abaixo foram carregados automaticamente como contexto inicial. Analise as relações entre eles e use ferramentas para buscar outros arquivos quando necessário.',
        ...files.map(file => [
          `<arquivo caminho="${escapeAttribute(file.filePath)}" motivo="${escapeAttribute(file.reason)}"${file.truncated ? ' truncado="true"' : ''}>`,
          file.content,
          '</arquivo>'
        ].join('\n')),
        '</contexto_workspace_analisado>'
      ].join('\n\n');

  return { files, text };
}

function discoverRelatedFiles(root: string, relative: string, content: string): Array<{ filePath: string; reason: string }> {
  const results: Array<{ filePath: string; reason: string }> = [];
  const seen = new Set<string>();
  const add = (candidate: string, reason: string): void => {
    const normalized = candidate.replace(/\\/g, '/');
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ filePath: normalized, reason });
  };

  const directory = path.posix.dirname(relative.replace(/\\/g, '/'));
  const fileName = path.posix.basename(relative);
  const angularStem = angularComponentStem(fileName);
  if (angularStem) {
    const absoluteDirectory = resolveInsideRoot(root, directory === '.' ? '' : directory);
    try {
      for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith(`${angularStem}.component.`)) {
          add(path.posix.join(directory === '.' ? '' : directory, entry.name), 'arquivo do mesmo componente Angular');
        }
      }
    } catch { /* diretório opcional */ }
  }

  for (const match of content.matchAll(/\b(?:templateUrl|styleUrl)\s*:\s*['"]([^'"]+)['"]/g)) {
    if (match[1]) add(resolveRelativeImport(relative, match[1]), 'arquivo declarado nos metadados do componente');
  }
  for (const match of content.matchAll(/\bstyleUrls\s*:\s*\[([\s\S]*?)\]/g)) {
    const list = match[1] ?? '';
    for (const item of list.matchAll(/['"]([^'"]+)['"]/g)) {
      if (item[1]) add(resolveRelativeImport(relative, item[1]), 'arquivo de estilo declarado no componente');
    }
  }

  for (const match of content.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1] ?? match[2];
    if (!specifier?.startsWith('.')) continue;
    const resolved = resolveImportFile(root, relative, specifier);
    if (resolved) add(resolved, /service/i.test(resolved) ? 'service importado pelo componente' : 'dependência relativa importada');
  }

  return results;
}

function angularComponentStem(fileName: string): string | undefined {
  const match = fileName.match(/^(.*)\.component\.(?:html|ts|tsx|css|scss|sass|less|spec\.ts)$/i);
  return match?.[1];
}

function resolveRelativeImport(fromFile: string, specifier: string): string {
  const base = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  return path.posix.normalize(path.posix.join(base, specifier.replace(/\\/g, '/')));
}

function resolveImportFile(root: string, fromFile: string, specifier: string): string | undefined {
  const base = resolveRelativeImport(fromFile, specifier);
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.json`,
    path.posix.join(base, 'index.ts'), path.posix.join(base, 'index.tsx'), path.posix.join(base, 'index.js')
  ];
  for (const candidate of candidates) {
    try {
      const normalized = normalizeRelativePath(candidate);
      const absolute = resolveInsideRoot(root, normalized);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return normalized;
    } catch { /* candidato inválido */ }
  }
  return undefined;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}