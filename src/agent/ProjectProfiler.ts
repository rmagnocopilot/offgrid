import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';

export type ProjectLanguage = 'java' | 'typescript' | 'javascript' | 'python' | 'csharp' | 'go' | 'rust' | 'unknown';
export type ProjectBuildSystem = 'maven' | 'gradle' | 'npm' | 'pnpm' | 'yarn' | 'dotnet' | 'go' | 'cargo' | 'unknown';

export interface AdaptiveProjectProfile {
  workspaceRoot: string;
  moduleRoot: string;
  language: ProjectLanguage;
  buildSystem: ProjectBuildSystem;
  sourceRoot?: string;
  testRoot?: string;
  testFramework?: string;
  packageName?: string;
  referenceStyle?: {
    lineEnding: 'lf' | 'crlf';
    indent: string;
  };
  manifests: string[];
}

const IGNORED = new Set([
  '.git', '.svn', '.hg', '.idea', '.vscode-test', 'node_modules', 'out', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.gradle', 'target', 'bin', 'obj', '.venv', 'venv'
]);
const cache = new Map<string, { fingerprint: string; profile: AdaptiveProjectProfile }>();

export async function profileProject(params: {
  workspaceRoot: string;
  sourcePath?: string;
  referencePath?: string;
  sourceText?: string;
  referenceText?: string;
}): Promise<AdaptiveProjectProfile> {
  const root = params.workspaceRoot;
  const sourcePath = params.sourcePath ? normalizeRelativePath(params.sourcePath) : undefined;
  const referencePath = params.referencePath ? normalizeRelativePath(params.referencePath) : undefined;
  const moduleRoot = inferModuleRoot(root, sourcePath ?? referencePath);
  const fingerprint = await profileFingerprint(root, moduleRoot);
  const sourceScope = sourcePath ? path.posix.dirname(sourcePath).toLowerCase() : '';
  const referenceScope = referencePath ? path.posix.dirname(referencePath).toLowerCase() : '';
  const key = `${root.toLowerCase()}::${moduleRoot.toLowerCase()}::${sourceScope}::${referenceScope}`;
  const cached = cache.get(key);
  if (cached?.fingerprint === fingerprint) {
    return enrichProfile(cached.profile, params.sourceText, params.referenceText);
  }

  const manifests = detectManifests(root, moduleRoot);
  const language = inferLanguage(sourcePath, referencePath, manifests);
  const buildSystem = inferBuildSystem(manifests);
  const { sourceRoot, testRoot } = inferRoots(sourcePath, referencePath, language, moduleRoot);
  const manifestTexts = await Promise.all(manifests.map(async manifest => ({
    manifest,
    text: await readOptional(resolveInsideRoot(root, manifest)) ?? ''
  })));
  const testFramework = inferTestFramework(language, manifestTexts);
  const packageName = params.sourceText ? inferPackageName(language, params.sourceText) : undefined;

  const profile: AdaptiveProjectProfile = {
    workspaceRoot: root,
    moduleRoot,
    language,
    buildSystem,
    sourceRoot,
    testRoot,
    testFramework,
    packageName,
    manifests
  };
  cache.set(key, { fingerprint, profile });
  return enrichProfile(profile, params.sourceText, params.referenceText);
}

export async function findWorkspaceReference(
  workspaceRoot: string,
  request: string,
  priority: readonly string[] = [],
  preferredExtension?: string,
  moduleRootHint = ''
): Promise<string | undefined> {
  const candidates = extractReferenceCandidates(request, preferredExtension);

  for (const value of priority) {
    const raw = String(value ?? '').split('#')[0];
    if (!raw) continue;
    try {
      const relative = normalizeRelativePath(raw);
      if (moduleRootHint && !isInsideModule(relative, moduleRootHint)) continue;
      if (!fileExists(resolveInsideRoot(workspaceRoot, relative))) continue;
      const base = path.posix.basename(relative).toLowerCase();
      const stem = base.replace(/\.[^.]+$/, '');
      if (candidates.some(candidate => candidate.base === base || candidate.stem === stem)) return relative;
    } catch {
      // Continua para busca no workspace.
    }
  }

  for (const candidate of candidates) {
    const found = await findFileByCandidate(
      workspaceRoot,
      candidate.base,
      candidate.stem,
      preferredExtension,
      moduleRootHint,
      'reference'
    );
    if (found) return found;
  }
  return undefined;
}

export async function findWorkspaceSource(
  workspaceRoot: string,
  request: string,
  priority: readonly string[] = [],
  preferredExtension?: string
): Promise<string | undefined> {
  const candidates = extractSourceCandidates(request, preferredExtension);
  if (!candidates.length) return undefined;

  for (const value of priority) {
    const raw = String(value ?? '').split('#')[0];
    if (!raw) continue;
    try {
      const relative = normalizeRelativePath(raw);
      if (isTestArtifact(relative) || !fileExists(resolveInsideRoot(workspaceRoot, relative))) continue;
      const base = path.posix.basename(relative).toLowerCase();
      const stem = base.replace(/\.[^.]+$/, '');
      if (candidates.some(candidate => candidate.base === base || candidate.stem === stem)) return relative;
    } catch {
      // Continua para busca no workspace.
    }
  }

  for (const candidate of candidates) {
    const found = await findFileByCandidate(
      workspaceRoot,
      candidate.base,
      candidate.stem,
      preferredExtension,
      '',
      'source'
    );
    if (found) return found;
  }
  return undefined;
}

export function workspaceModuleRoot(workspaceRoot: string, filePath?: string): string {
  return inferModuleRoot(workspaceRoot, filePath);
}

export function compactSourceForPattern(filePath: string, content: string, maxChars: number): string {
  const extension = path.extname(filePath).toLowerCase();
  if (content.length <= maxChars) return content;

  if (extension === '.java' && /(?:Test|Tests)\.java$/i.test(path.posix.basename(filePath))) return compactJavaTestReference(content, maxChars);
  if (extension === '.java') return compactJava(content, maxChars);
  if (['.ts', '.tsx', '.js', '.jsx'].includes(extension)) return compactTsLike(content, maxChars);
  return headTail(content, maxChars);
}

export function formatProjectProfile(profile: AdaptiveProjectProfile): string {
  return [
    `linguagem=${profile.language}`,
    `build=${profile.buildSystem}`,
    `modulo=${profile.moduleRoot || '.'}`,
    profile.sourceRoot ? `sourceRoot=${profile.sourceRoot}` : undefined,
    profile.testRoot ? `testRoot=${profile.testRoot}` : undefined,
    profile.testFramework ? `testFramework=${profile.testFramework}` : undefined,
    profile.packageName ? `package=${profile.packageName}` : undefined,
    profile.referenceStyle ? `estilo=${profile.referenceStyle.lineEnding},indent=${JSON.stringify(profile.referenceStyle.indent)}` : undefined
  ].filter(Boolean).join('; ');
}

function enrichProfile(
  profile: AdaptiveProjectProfile,
  sourceText?: string,
  referenceText?: string
): AdaptiveProjectProfile {
  return {
    ...profile,
    packageName: sourceText ? inferPackageName(profile.language, sourceText) ?? profile.packageName : profile.packageName,
    referenceStyle: referenceText ? inferStyle(referenceText) : profile.referenceStyle
  };
}

function inferModuleRoot(root: string, filePath?: string): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/');
  const markers = ['/src/main/', '/src/test/', '/src/', '/app/', '/lib/'];
  for (const marker of markers) {
    const index = normalized.toLowerCase().indexOf(marker);
    if (index > 0) return normalized.slice(0, index);
    if (index === 0) return '';
  }
  const first = normalized.split('/')[0] ?? '';
  return fileExists(path.join(root, first, 'pom.xml')) || fileExists(path.join(root, first, 'package.json'))
    ? first
    : '';
}

function detectManifests(root: string, moduleRoot: string): string[] {
  const locations = ['', moduleRoot].filter((value, index, values) => values.indexOf(value) === index);
  const names = ['pom.xml', 'build.gradle', 'build.gradle.kts', 'package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'Cargo.toml', 'go.mod'];
  const result: string[] = [];
  for (const location of locations) {
    for (const name of names) {
      const relative = location ? path.posix.join(location, name) : name;
      if (fileExists(resolveInsideRoot(root, relative))) result.push(relative);
    }
  }
  return result;
}

async function profileFingerprint(root: string, moduleRoot: string): Promise<string> {
  const manifests = detectManifests(root, moduleRoot);
  const pieces: string[] = [];
  for (const manifest of manifests) {
    try {
      const stat = await fsp.stat(resolveInsideRoot(root, manifest));
      pieces.push(`${manifest}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
    } catch {
      pieces.push(`${manifest}:missing`);
    }
  }
  return pieces.join('|');
}

function inferLanguage(sourcePath: string | undefined, referencePath: string | undefined, manifests: string[]): ProjectLanguage {
  const extension = path.extname(sourcePath ?? referencePath ?? '').toLowerCase();
  if (extension === '.java') return 'java';
  if (['.ts', '.tsx'].includes(extension)) return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'javascript';
  if (extension === '.py') return 'python';
  if (extension === '.cs') return 'csharp';
  if (extension === '.go') return 'go';
  if (extension === '.rs') return 'rust';
  if (manifests.some(value => /pom\.xml$|build\.gradle(?:\.kts)?$/i.test(value))) return 'java';
  if (manifests.some(value => /package\.json$/i.test(value))) return 'typescript';
  return 'unknown';
}

function inferBuildSystem(manifests: string[]): ProjectBuildSystem {
  if (manifests.some(value => /pom\.xml$/i.test(value))) return 'maven';
  if (manifests.some(value => /build\.gradle(?:\.kts)?$/i.test(value))) return 'gradle';
  if (manifests.some(value => /pnpm-lock\.yaml$/i.test(value))) return 'pnpm';
  if (manifests.some(value => /yarn\.lock$/i.test(value))) return 'yarn';
  if (manifests.some(value => /package\.json$/i.test(value))) return 'npm';
  if (manifests.some(value => /Cargo\.toml$/i.test(value))) return 'cargo';
  if (manifests.some(value => /go\.mod$/i.test(value))) return 'go';
  return 'unknown';
}

function inferRoots(
  sourcePath: string | undefined,
  referencePath: string | undefined,
  language: ProjectLanguage,
  moduleRoot: string
): { sourceRoot?: string; testRoot?: string } {
  if (language === 'java') {
    return {
      sourceRoot: joinModule(moduleRoot, 'src/main/java'),
      testRoot: joinModule(moduleRoot, 'src/test/java')
    };
  }
  if (referencePath) {
    const refDir = path.posix.dirname(referencePath);
    if (/\.(?:spec|test)\.[jt]sx?$/i.test(referencePath)) return { sourceRoot: sourcePath ? path.posix.dirname(sourcePath) : undefined, testRoot: refDir };
  }
  return {
    sourceRoot: sourcePath ? path.posix.dirname(sourcePath) : undefined,
    testRoot: referencePath ? path.posix.dirname(referencePath) : undefined
  };
}

function inferTestFramework(
  language: ProjectLanguage,
  manifests: Array<{ manifest: string; text: string }>
): string | undefined {
  const joined = manifests.map(item => item.text).join('\n');
  if (language === 'java') {
    if (/org\.junit\.jupiter|junit-jupiter/i.test(joined)) return /mockito/i.test(joined) ? 'JUnit 5 + Mockito' : 'JUnit 5';
    if (/<groupId>\s*junit\s*<\/groupId>|junit:junit/i.test(joined)) return /mockito/i.test(joined) ? 'JUnit 4 + Mockito' : 'JUnit 4';
    if (/testng/i.test(joined)) return 'TestNG';
  }
  if (/vitest/i.test(joined)) return 'Vitest';
  if (/jest/i.test(joined)) return 'Jest';
  if (/jasmine|@angular\/core\/testing/i.test(joined)) return 'Jasmine';
  return undefined;
}

function inferPackageName(language: ProjectLanguage, source: string): string | undefined {
  if (language === 'java') return source.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1];
  return undefined;
}

function inferStyle(reference: string): { lineEnding: 'lf' | 'crlf'; indent: string } {
  const lineEnding = reference.includes('\r\n') ? 'crlf' : 'lf';
  const indents = reference.match(/^( +|\t+)(?=\S)/gm) ?? [];
  const indent = indents
    .map(value => value.replace(/\r?\n/g, ''))
    .sort((left, right) => left.length - right.length)[0] ?? '    ';
  return { lineEnding, indent };
}

function extractReferenceCandidates(request: string, preferredExtension?: string): Array<{ base: string; stem: string }> {
  const result = new Map<string, { base: string; stem: string }>();
  const explicit = request.match(/[A-Za-z0-9_$@.-]+\.(?:java|ts|tsx|js|jsx|py|cs|go|rs|xml|json|ya?ml)/gi) ?? [];
  for (const value of explicit) addCandidate(result, value);

  const names = request.match(/\b[A-Z][A-Za-z0-9_$]*(?:Test|Tests|Spec|DTO|Dto|Service|Controller|Resource|Repository|Component|Entity|Model|VO)?\b/g) ?? [];
  for (const name of names) {
    if (!/(?:Test|Tests|Spec)$/i.test(name)) continue;
    const ext = preferredExtension || '.java';
    addCandidate(result, `${name}${ext.startsWith('.') ? ext : `.${ext}`}`);
  }
  return [...result.values()];
}

function extractSourceCandidates(request: string, preferredExtension?: string): Array<{ base: string; stem: string }> {
  const result = new Map<string, { base: string; stem: string }>();
  const explicit = request.match(/[A-Za-z0-9_$@.-]+\.(?:java|ts|tsx|js|jsx|py|cs|go|rs|xml|json|ya?ml)/gi) ?? [];
  for (const value of explicit) {
    if (!/(?:Test|Tests|Spec)\.[^.]+$/i.test(value)) addCandidate(result, value);
  }

  const named = request.match(/\b[A-Z][A-Za-z0-9_$]*(?:DTO|Dto|Service|Controller|Resource|Repository|Component|Entity|Model|VO)\b/g) ?? [];
  const parenthesized = [...request.matchAll(/[(`'"]([A-Z][A-Za-z0-9_$]{2,})[)`'"]/g)]
    .map(match => match[1])
    .filter((value): value is string => Boolean(value));
  const ext = preferredExtension || '.java';
  for (const name of [...named, ...parenthesized]) {
    if (/(?:Test|Tests|Spec)$/i.test(name)) continue;
    addCandidate(result, `${name}${ext.startsWith('.') ? ext : `.${ext}`}`);
  }
  return [...result.values()];
}

function addCandidate(target: Map<string, { base: string; stem: string }>, value: string): void {
  const base = path.posix.basename(value.replace(/\\/g, '/')).toLowerCase();
  const stem = base.replace(/\.[^.]+$/, '');
  target.set(base, { base, stem });
}

async function findFileByCandidate(
  root: string,
  base: string,
  stem: string,
  preferredExtension?: string,
  moduleRootHint = '',
  kind: 'source' | 'reference' = 'reference'
): Promise<string | undefined> {
  const scope = moduleRootHint ? resolveInsideRoot(root, moduleRootHint) : root;
  const stack = [scope];
  const matches: string[] = [];
  let visited = 0;
  while (stack.length && visited < 100_000 && matches.length < 50) {
    const directory = stack.pop();
    if (!directory) break;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      if (visited > 100_000) break;
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name)) stack.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      const sameStem = lower.replace(/\.[^.]+$/, '') === stem;
      const extOk = !preferredExtension || path.extname(lower) === preferredExtension.toLowerCase();
      if (lower !== base && !(sameStem && extOk)) continue;
      matches.push(path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/'));
    }
  }
  return matches.sort((left, right) => scorePath(left, kind) - scorePath(right, kind) || left.length - right.length || left.localeCompare(right))[0];
}

function scorePath(value: string, kind: 'source' | 'reference'): number {
  const lower = value.toLowerCase();
  if (kind === 'source') {
    if (lower.includes('/src/main/')) return 0;
    if (lower.includes('/src/')) return 1;
    if (isTestArtifact(lower)) return 9;
    return 3;
  }
  if (lower.includes('/src/test/')) return 0;
  if (lower.includes('/test/')) return 1;
  return 2;
}

function isInsideModule(filePath: string, moduleRoot: string): boolean {
  if (!moduleRoot) return true;
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  const module = moduleRoot.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return normalized === module || normalized.startsWith(`${module}/`);
}

function isTestArtifact(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return /(?:^|\/)src\/test\/|(?:Test|Tests)\.java$|\.(?:spec|test)\.[jt]sx?$/i.test(normalized);
}

function compactJavaTestReference(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headerEnd = content.search(/\b(?:public\s+)?class\s+[A-Za-z_$][\w$]*Test\b/);
  const header = headerEnd >= 0 ? content.slice(0, Math.min(content.length, headerEnd + 220)) : content.slice(0, 900);
  const blocks: string[] = [];
  const annotation = /@Test\b/g;
  let match: RegExpExecArray | null;
  while ((match = annotation.exec(content)) !== null && blocks.length < 12) {
    const open = content.indexOf('{', match.index);
    if (open < 0) break;
    const close = findMatchingBrace(content, open);
    if (close < 0) break;
    blocks.push(content.slice(match.index, close + 1).trim());
    annotation.lastIndex = close + 1;
  }
  const selected = blocks.length <= 4
    ? blocks
    : [blocks[0]!, blocks[1]!, blocks.at(-2)!, blocks.at(-1)!];
  const compact = [header.trimEnd(), ...selected].join('\n\n');
  return compact.length <= maxChars ? compact : headTail(compact, maxChars);
}

function findMatchingBrace(content: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < content.length; index += 1) {
    const ch = content[index];
    const next = content[index + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

function compactJava(content: string, maxChars: number): string {
  const packageLine = content.match(/^\s*package\s+[^;]+;/m)?.[0]?.trim();
  const imports = [...content.matchAll(/^\s*import\s+[^;]+;/gm)].map(match => match[0].trim());
  const classLine = content.match(/^\s*(?:public\s+)?(?:abstract\s+|final\s+)?(?:class|interface|record|enum)\s+[^\{]+\{/m)?.[0]?.trim();
  const fields = [...content.matchAll(/^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?[^;=\n]+(?:=[^;]+)?;/gm)]
    .map(match => match[0].trim())
    .slice(0, 40);
  const methods = [...content.matchAll(/^\s*(?:public|protected)\s+(?:static\s+)?(?:final\s+)?[^\n{;]+\([^;\n]*\)\s*(?:throws\s+[^\{]+)?\{/gm)]
    .map(match => match[0].trim().replace(/\s*\{$/, ';'))
    .slice(0, 80);
  const compact = [packageLine, ...imports, '', classLine, ...fields, '', ...methods].filter(value => value !== undefined).join('\n');
  return compact.length <= maxChars ? compact : headTail(compact, maxChars);
}

function compactTsLike(content: string, maxChars: number): string {
  const imports = [...content.matchAll(/^\s*import\s+[^;]+;?/gm)].map(match => match[0].trim()).slice(0, 30);
  const declarations = [...content.matchAll(/^\s*(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum|function|const)\s+[^\n{=]+/gm)]
    .map(match => match[0].trim())
    .slice(0, 50);
  const methods = [...content.matchAll(/^\s*(?:public|protected|private)?\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^\n)]*\)\s*(?::\s*[^\n{]+)?\s*\{/gm)]
    .map(match => match[0].trim().replace(/\s*\{$/, ';'))
    .slice(0, 80);
  const compact = [...imports, '', ...declarations, ...methods].join('\n');
  return compact.length <= maxChars ? compact : headTail(compact, maxChars);
}

function headTail(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = '\n/* ... trecho omitido pelo Adaptive Fast Path ... */\n';
  const available = Math.max(128, maxChars - marker.length);
  const head = Math.ceil(available * 0.65);
  const tail = available - head;
  return `${content.slice(0, head)}${marker}${content.slice(-tail)}`;
}

function joinModule(moduleRoot: string, relative: string): string {
  return moduleRoot ? path.posix.join(moduleRoot, relative) : relative;
}

function fileExists(filePath: string): boolean {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try { return await fsp.readFile(filePath, 'utf8'); } catch { return undefined; }
}
