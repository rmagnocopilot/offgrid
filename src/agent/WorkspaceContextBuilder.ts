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
  request?: string;
  maxFiles?: number;
  maxCharsPerFile?: number;
  maxTotalChars?: number;
  includeTestRelated?: boolean;
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
  const resolvedReferences = new Map<string, string | undefined>();
  const files: AgentContextFile[] = [];
  let totalChars = 0;

  const enqueue = (value: string | undefined, reason: string, depth: number): void => {
    if (!value) return;
    const withoutSelection = value.split('#')[0];
    if (!withoutSelection) return;
    let requested: string;
    try { requested = normalizeRelativePath(withoutSelection); } catch { return; }
    const referenceKey = requested.toLowerCase();
    let relative = resolvedReferences.get(referenceKey);
    if (!resolvedReferences.has(referenceKey)) {
      relative = resolveContextReference(root, requested);
      resolvedReferences.set(referenceKey, relative);
    }
    if (!relative) return;
    const key = relative.toLowerCase();
    if (queuedKeys.has(key)) return;
    if (!TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())) return;
    queuedKeys.add(key);
    queued.push({ filePath: relative, reason, depth });
  };

  // O primeiro arquivo prioritário é normalmente a classe ativa/alvo. Em
  // tarefas Java, referências citadas explicitamente pelo usuário (por exemplo
  // AcompanhamentoObrasHistoricoDTOTest) entram logo depois, antes de arquivos
  // secundários inferidos pelo ContextManager. Assim um limite de 2 arquivos
  // ainda preserva exatamente origem + exemplo.
  if (params.priority[0]) {
    enqueue(params.priority[0], 'arquivo citado ou ativo prioritário', 0);
  }

  const namedJavaReferences = resolveNamedJavaReferences(root, params.request, params.priority);
  for (const namedJavaFile of namedJavaReferences) {
    enqueue(namedJavaFile, 'classe Java citada explicitamente no pedido', 0);
  }

  for (const item of params.priority.slice(1)) {
    enqueue(item, 'arquivo priorizado pelo contexto', 0);
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
    const selected = truncated
      ? compactContextContent(content, allowed, candidate.filePath)
      : content;
    files.push({ filePath: candidate.filePath, reason: candidate.reason, content: selected, truncated });
    totalChars += selected.length;

    if (params.includeTestRelated && candidate.depth === 0) {
      for (const related of discoverTestCreationFiles(root, candidate.filePath, content)) {
        enqueue(related.filePath, related.reason, 1);
      }
    }

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



function compactContextContent(content: string, allowed: number, filePath: string): string {
  const marker = '\n/* ... contexto intermediário omitido pelo Offgrid ... */\n';
  if (allowed <= marker.length + 64) return content.slice(0, Math.max(0, allowed));

  // Em código Java, apenas o início elimina frequentemente equals/hashCode,
  // getters ou os últimos @Test. Preservar início + fim mantém imports/campos
  // e também a parte final da implementação sem aumentar o orçamento.
  if (/\.java$/i.test(filePath) && content.length > allowed) {
    const payload = allowed - marker.length;
    const head = Math.max(64, Math.floor(payload * 0.68));
    const tail = Math.max(0, payload - head);
    return `${content.slice(0, head)}${marker}${tail ? content.slice(-tail) : ''}`.slice(0, allowed);
  }

  const truncationMarker = '\n/* contexto truncado pelo Offgrid */';
  return `${content.slice(0, Math.max(0, allowed - truncationMarker.length))}${truncationMarker}`;
}

function resolveNamedJavaReferences(root: string, request: string | undefined, priority: string[]): string[] {
  const names: string[] = [];
  const seenNames = new Set<string>();
  for (const match of String(request ?? '').matchAll(/\b([A-Z][A-Za-z0-9_$]{2,})\b/g)) {
    const name = match[1];
    if (!name || seenNames.has(name.toLowerCase())) continue;
    if (/^(?:JSON|HTTP|HTTPS|REST|CRUD|DTO|VO|API|SQL|XML|HTML|CSS|JUNIT)$/i.test(name)) continue;
    seenNames.add(name.toLowerCase());
    names.push(name);
    if (names.length >= 12) break;
  }
  if (!names.length) return [];

  const moduleRoots = [...new Set(priority.map(modulePrefixRaw).filter(Boolean))];
  const packageHints = extractJavaPackageHints(request);
  const matches = new Map<string, string[]>();
  const addMatch = (name: string, relative: string): void => {
    const normalized = relative.replace(/\\/g, '/');
    const list = matches.get(name) ?? [];
    if (!list.some(item => item.toLowerCase() === normalized.toLowerCase())) list.push(normalized);
    matches.set(name, list);
  };

  // Caminho direto primeiro. Pedidos corporativos costumam informar o pacote
  // de destino, por exemplo "br.gov.caixa.siavo.tests.dto". Resolver esse
  // caminho evita percorrer dezenas de milhares de arquivos antes de achar o
  // teste-exemplo citado pelo usuário.
  for (const moduleRoot of moduleRoots) {
    for (const packageName of packageHints) {
      const packagePath = packageName.replace(/\./g, '/');
      for (const name of names) {
        for (const sourceRoot of ['src/test/java', 'src/main/java']) {
          const candidate = path.posix.join(moduleRoot, sourceRoot, packagePath, `${name}.java`);
          if (contextFileExists(root, candidate)) addMatch(name, candidate);
        }
      }
    }
  }

  const unresolved = new Set(names.filter(name => !(matches.get(name)?.length)));
  if (unresolved.size) {
    const targetFiles = new Map([...unresolved].map(name => [`${name.toLowerCase()}.java`, name]));
    const searchRoots: string[] = [];
    for (const moduleRoot of moduleRoots) {
      searchRoots.push(
        path.posix.join(moduleRoot, 'src/test/java'),
        path.posix.join(moduleRoot, 'src/main/java')
      );
    }
    if (!searchRoots.length) searchRoots.push('.');

    // Busca primeiro dentro do(s) módulo(s) do arquivo ativo/citado. O limite é
    // deliberadamente maior que o antigo 20k porque workspaces Maven grandes
    // ultrapassavam esse valor e a referência explícita nunca chegava ao prompt.
    for (const relativeRoot of searchRoots) {
      scanExactJavaNames(root, relativeRoot, targetFiles, addMatch, 100_000);
      for (const name of [...unresolved]) {
        if (matches.get(name)?.length) unresolved.delete(name);
      }
      if (!unresolved.size) break;
    }
  }

  const priorityModules = new Set(moduleRoots.map(value => value.toLowerCase()));
  const resolved: string[] = [];
  for (const name of names) {
    const candidates = matches.get(name) ?? [];
    if (candidates.length === 1) {
      resolved.push(candidates[0]!);
      continue;
    }
    const sameModule = candidates.filter(candidate => priorityModules.has(modulePrefix(candidate)));
    if (sameModule.length === 1) resolved.push(sameModule[0]!);
  }
  return resolved;
}

function extractJavaPackageHints(request: string | undefined): string[] {
  const text = String(request ?? '');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\b([a-z_$][\w$]*(?:\.[a-z_$][\w$]*){2,})\b/gi)) {
    const value = match[1];
    if (!value || /\.(?:java|ts|tsx|js|json|xml|yml|yaml)$/i.test(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= 6) break;
  }
  return result;
}

function modulePrefixRaw(filePath: string): string {
  const normalized = String(filePath ?? '').split('#')[0]?.replace(/\\/g, '/') ?? '';
  const marker = normalized.toLowerCase().indexOf('/src/');
  return marker >= 0 ? normalized.slice(0, marker) : '';
}

function contextFileExists(root: string, relative: string): boolean {
  try {
    const safe = normalizeRelativePath(relative);
    const absolute = resolveInsideRoot(root, safe);
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  } catch {
    return false;
  }
}

function scanExactJavaNames(
  root: string,
  relativeRoot: string,
  targets: Map<string, string>,
  add: (name: string, relative: string) => void,
  limit: number
): void {
  let start: string;
  try {
    start = resolveInsideRoot(root, normalizeRelativePath(relativeRoot));
  } catch {
    return;
  }
  if (!fs.existsSync(start)) return;

  const ignored = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.vscode-test', 'target']);
  const queue = [start];
  let visited = 0;
  while (queue.length && visited < limit) {
    const directory = queue.shift();
    if (!directory) break;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      if (visited >= limit) break;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) queue.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const name = targets.get(entry.name.toLowerCase());
      if (!name) continue;
      add(name, path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/'));
    }
  }
}

function modulePrefix(filePath: string): string {
  const normalized = String(filePath ?? '').split('#')[0]?.replace(/\\/g, '/') ?? '';
  const marker = normalized.toLowerCase().indexOf('/src/');
  return marker >= 0 ? normalized.slice(0, marker).toLowerCase() : '';
}

function resolveContextReference(root: string, requested: string): string | undefined {
  try {
    const absolute = resolveInsideRoot(root, requested);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return requested;
  } catch { /* tenta resolver referência abreviada */ }

  const normalizedRequested = requested.replace(/\\/g, '/');
  const requestedLower = normalizedRequested.toLowerCase();
  const requestedBase = path.posix.basename(normalizedRequested).toLowerCase();
  if (!requestedBase) return undefined;

  const ignored = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.vscode-test']);
  const stack = [root];
  const matches: string[] = [];
  let visited = 0;

  while (stack.length && visited < 20_000 && matches.length < 20) {
    const directory = stack.pop();
    if (!directory) break;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }

    for (const entry of entries) {
      visited += 1;
      if (visited >= 20_000) break;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || entry.name.toLowerCase() !== requestedBase) continue;
      const relative = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/');
      const lower = relative.toLowerCase();
      if (!requestedLower.includes('/') || lower.endsWith(requestedLower)) matches.push(relative);
    }
  }

  return matches.sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
}


function discoverTestCreationFiles(root: string, relative: string, content: string): Array<{ filePath: string; reason: string }> {
  const results: Array<{ filePath: string; reason: string }> = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined, reason: string): void => {
    if (!candidate) return;
    const normalized = candidate.replace(/\\/g, '/');
    const key = normalized.toLowerCase();
    if (seen.has(key) || key === relative.replace(/\\/g, '/').toLowerCase()) return;
    seen.add(key);
    results.push({ filePath: normalized, reason });
  };

  if (/\.java$/i.test(relative)) {
    for (const match of content.matchAll(/\bimport\s+(?!static\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*;/g)) {
      const qualifiedName = match[1];
      if (!qualifiedName || qualifiedName.startsWith('java.') || qualifiedName.startsWith('javax.') || qualifiedName.startsWith('jakarta.')) continue;
      add(resolveJavaImportFile(root, relative, qualifiedName), 'classe Java usada pelo arquivo de origem');
    }
    add(findNearestPomFile(root, relative), 'dependências Maven do módulo');
    add(findNearestTestFile(root, relative), 'padrão de teste Java existente no módulo');
    return results;
  }

  for (const match of content.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const specifier = match[1] ?? match[2];
    if (!specifier?.startsWith('.')) continue;
    const resolved = resolveImportFile(root, relative, specifier);
    if (resolved) add(resolved, /service/i.test(resolved) ? 'service usado pelo componente' : 'modelo ou dependência usada pelo componente');
  }

  add(findNearestTestFile(root, relative), 'padrão de teste existente no projeto');
  return results;
}

function findNearestTestFile(root: string, relative: string): string | undefined {
  const ignored = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.vscode-test', 'target']);
  const normalizedSource = relative.replace(/\\/g, '/');
  const sourceParts = path.posix.dirname(normalizedSource).split('/');
  const javaSource = /\.java$/i.test(normalizedSource);
  const sourceModule = normalizedSource.split('/src/')[0] ?? '';
  const candidates: Array<{ filePath: string; score: number }> = [];
  const stack = [root];
  let visited = 0;

  while (stack.length && visited < 20_000 && candidates.length < 50) {
    const directory = stack.pop();
    if (!directory) break;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      if (visited >= 20_000) break;
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (javaSource ? !/(?:Test|Tests)\.java$/i.test(entry.name) : !/\.(?:spec|test)\.(?:ts|tsx|js|jsx)$/i.test(entry.name)) continue;

      const filePath = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/');
      if (javaSource && sourceModule && !filePath.startsWith(`${sourceModule}/`)) continue;
      const parts = path.posix.dirname(filePath).split('/');
      let common = 0;
      while (common < sourceParts.length && common < parts.length && sourceParts[common] === parts[common]) common += 1;
      candidates.push({ filePath, score: common * 1000 - filePath.length });
    }
  }

  return candidates.sort((left, right) => right.score - left.score)[0]?.filePath;
}

function findNearestPomFile(root: string, relative: string): string | undefined {
  const normalized = relative.replace(/\\/g, '/');
  const sourceMarker = normalized.indexOf('/src/');
  const modulePrefix = sourceMarker >= 0 ? normalized.slice(0, sourceMarker) : path.posix.dirname(normalized);
  const candidates = [
    path.posix.join(modulePrefix, 'pom.xml'),
    'pom.xml'
  ];
  for (const candidate of candidates) {
    try {
      const safe = normalizeRelativePath(candidate);
      const absolute = resolveInsideRoot(root, safe);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return safe;
    } catch { /* próximo candidato */ }
  }
  return undefined;
}

function resolveJavaImportFile(root: string, fromFile: string, qualifiedName: string): string | undefined {
  const normalized = fromFile.replace(/\\/g, '/');
  const marker = normalized.toLowerCase().indexOf('/src/main/java/');
  if (marker < 0) return undefined;
  const modulePrefix = normalized.slice(0, marker);
  const candidate = path.posix.join(modulePrefix, 'src/main/java', `${qualifiedName.replace(/\./g, '/')}.java`);
  try {
    const safe = normalizeRelativePath(candidate);
    const absolute = resolveInsideRoot(root, safe);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return safe;
  } catch { /* import externo ou inválido */ }
  return undefined;
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