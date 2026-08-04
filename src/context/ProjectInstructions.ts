import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

const INSTRUCTION_FILE = 'AGENTS.md';
const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_CHARS_PER_FILE = 12_000;
const DEFAULT_MAX_TOTAL_CHARS = 32_000;
const SUPPORTED_CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.java', '.js', '.jsx', '.kt', '.kts',
  '.mjs', '.cjs', '.php', '.py', '.rs', '.ts', '.tsx'
]);

export interface ProjectInstructionFile {
  filePath: string;
  scope: string;
  content: string;
  truncated: boolean;
}

export interface ProjectInstructions {
  files: ProjectInstructionFile[];
  text: string;
}

export interface OffgridProjectRules {
  maxCyclomaticComplexity?: number;
  extractStringAfterOccurrences?: number;
  maxMethodLines?: number;
  allowPlaceholders?: boolean;
}

export interface ProjectRuleViolation {
  rule: keyof OffgridProjectRules;
  message: string;
  line?: number;
}

export async function loadProjectInstructions(params: {
  workspaceRoot?: string;
  targetFiles?: string[];
  maxFiles?: number;
  maxCharsPerFile?: number;
  maxTotalChars?: number;
}): Promise<ProjectInstructions> {
  const root = params.workspaceRoot ? path.resolve(params.workspaceRoot) : undefined;
  if (!root) return { files: [], text: '' };

  const maxFiles = clamp(params.maxFiles ?? DEFAULT_MAX_FILES, 1, 32);
  const maxCharsPerFile = clamp(params.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE, 256, 64_000);
  const maxTotalChars = clamp(params.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS, 256, 128_000);
  const directories = instructionDirectories(root, params.targetFiles ?? []);
  const files: ProjectInstructionFile[] = [];
  let remaining = maxTotalChars;

  for (const directory of directories) {
    if (files.length >= maxFiles || remaining <= 0) break;
    const absolute = path.join(directory, INSTRUCTION_FILE);
    let content: string;
    try {
      const stat = await fsp.stat(absolute);
      if (!stat.isFile()) continue;
      content = stripBom(await fsp.readFile(absolute, 'utf8'));
    } catch {
      continue;
    }

    const allowed = Math.min(maxCharsPerFile, remaining);
    const truncated = content.length > allowed;
    const marker = '\n\n<!-- conteúdo truncado pelo Offgrid -->';
    const selected = truncated
      ? `${content.slice(0, Math.max(0, allowed - marker.length))}${marker}`
      : content;
    const relativeDirectory = normalizeRelative(path.relative(root, directory)) || '.';
    files.push({
      filePath: relativeDirectory === '.' ? INSTRUCTION_FILE : `${relativeDirectory}/${INSTRUCTION_FILE}`,
      scope: relativeDirectory,
      content: selected,
      truncated
    });
    remaining -= selected.length;
  }

  return { files, text: formatProjectInstructions(files) };
}

export function parseOffgridRules(files: ProjectInstructionFile[]): OffgridProjectRules {
  const rules: OffgridProjectRules = {};
  for (const file of files) {
    for (const block of offgridBlocks(file.content)) {
      for (const rawLine of block.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+#.*$/, '').trim();
        if (!line) continue;
        const match = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.+)$/);
        if (!match) continue;
        const key = match[1] as keyof OffgridProjectRules;
        const value = match[2]?.trim() ?? '';
        switch (key) {
          case 'maxCyclomaticComplexity':
          case 'extractStringAfterOccurrences':
          case 'maxMethodLines': {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0) rules[key] = parsed;
            break;
          }
          case 'allowPlaceholders':
            if (/^(true|false)$/i.test(value)) rules.allowPlaceholders = value.toLowerCase() === 'true';
            break;
        }
      }
    }
  }
  return rules;
}

export function validateProjectContent(
  filePath: string,
  content: string,
  rules: OffgridProjectRules
): ProjectRuleViolation[] {
  if (!SUPPORTED_CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return [];
  const violations: ProjectRuleViolation[] = [];
  const methods = extractMethodBlocks(content);

  if (rules.maxCyclomaticComplexity) {
    for (const method of methods) {
      const complexity = cyclomaticComplexity(method.content);
      if (complexity > rules.maxCyclomaticComplexity) {
        violations.push({
          rule: 'maxCyclomaticComplexity',
          line: method.line,
          message: `${method.name} possui complexidade ciclomática aproximada ${complexity}; limite ${rules.maxCyclomaticComplexity}.`
        });
      }
    }
  }

  if (rules.maxMethodLines) {
    for (const method of methods) {
      const lines = method.content.split(/\r?\n/).length;
      if (lines > rules.maxMethodLines) {
        violations.push({
          rule: 'maxMethodLines',
          line: method.line,
          message: `${method.name} possui ${lines} linhas; limite ${rules.maxMethodLines}.`
        });
      }
    }
  }

  if (rules.extractStringAfterOccurrences) {
    for (const repeated of repeatedStrings(
      validationTextFragments(content),
      rules.extractStringAfterOccurrences
    )) {
      violations.push({
        rule: 'extractStringAfterOccurrences',
        line: repeated.line,
        message: `A string ${JSON.stringify(repeated.value)} aparece ${repeated.count} vezes; extraia para uma constante após ${rules.extractStringAfterOccurrences} ocorrências.`
      });
    }
  }

  if (rules.allowPlaceholders === false) {
    const placeholder = findPlaceholder(content);
    if (placeholder) {
      violations.push({
        rule: 'allowPlaceholders',
        line: placeholder.line,
        message: `Placeholder não permitido: ${placeholder.text}.`
      });
    }
  }

  return violations;
}

export async function validateContentAgainstProjectInstructions(params: {
  workspaceRoot?: string;
  filePath: string;
  content: string;
}): Promise<{ instructions: ProjectInstructions; rules: OffgridProjectRules; violations: ProjectRuleViolation[] }> {
  const instructions = await loadProjectInstructions({
    workspaceRoot: params.workspaceRoot,
    targetFiles: [params.filePath]
  });
  const rules = parseOffgridRules(instructions.files);
  return {
    instructions,
    rules,
    violations: validateProjectContent(params.filePath, params.content, rules)
  };
}

function instructionDirectories(root: string, targetFiles: string[]): string[] {
  const directories: string[] = [];
  const seen = new Set<string>();
  const add = (directory: string): void => {
    const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
    if (seen.has(key)) return;
    seen.add(key);
    directories.push(directory);
  };
  add(root);

  for (const targetFile of targetFiles) {
    const directory = safeTargetDirectory(root, targetFile);
    if (!directory) continue;
    const chain: string[] = [];
    let current = directory;
    while (isInside(root, current) && current !== root) {
      chain.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    chain.reverse().forEach(add);
  }
  return directories;
}

function safeTargetDirectory(root: string, targetFile: string): string | undefined {
  const withoutSelection = String(targetFile ?? '').split('#')[0]?.trim() ?? '';
  if (!withoutSelection || path.isAbsolute(withoutSelection)) return undefined;
  const normalized = withoutSelection.replace(/[\\/]+/g, path.sep).replace(/^\.[\\/]/, '');
  const absolute = path.resolve(root, normalized);
  if (!isInside(root, absolute)) return undefined;
  return path.dirname(absolute);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function formatProjectInstructions(files: ProjectInstructionFile[]): string {
  if (!files.length) return '';
  return [
    '<instrucoes_projeto prioridade="obrigatoria">',
    'As regras abaixo são obrigatórias para esta tarefa. Preserve-as durante análise, geração, edição e revisão.',
    'Quando houver conflito, o AGENTS.md do escopo mais próximo do arquivo alterado prevalece sobre os anteriores.',
    ...files.map(file => [
      `<arquivo caminho="${escapeAttribute(file.filePath)}" escopo="${escapeAttribute(file.scope)}"${file.truncated ? ' truncado="true"' : ''}>`,
      file.content,
      '</arquivo>'
    ].join('\n')),
    '</instrucoes_projeto>'
  ].join('\n\n');
}

function offgridBlocks(content: string): string[] {
  return [...content.matchAll(/```offgrid\s*\r?\n([\s\S]*?)```/gi)].map(match => match[1] ?? '');
}

interface MethodBlock { name: string; line: number; content: string }

function extractMethodBlocks(content: string): MethodBlock[] {
  const sanitized = maskCommentsAndStrings(content);
  const blocks: MethodBlock[] = [];
  const patterns: RegExp[] = [
    /^[ \t]*(?:(?:public|protected|private|static|async|final|synchronized|native|override|export|default|get|set)\s+)*(?:(?:[A-Za-z_$][\w$<>,.?\[\]]*(?:\s*\[\])?)\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?::\s*[^={]+)?\s*\{/gm,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{/g
  ];
  for (const pattern of patterns) {
    for (const match of sanitized.matchAll(pattern)) {
      const name = match[1] ?? 'método';
      if (CONTROL_KEYWORDS.has(name)) continue;
      const openBrace = match.index! + match[0].lastIndexOf('{');
      const closeBrace = matchingBrace(sanitized, openBrace);
      if (closeBrace <= openBrace) continue;
      blocks.push({
        name,
        line: lineAt(content, match.index!),
        content: content.slice(match.index!, closeBrace + 1)
      });
    }
  }
  return removeNestedBlocks(blocks);
}

const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'else', 'do', 'try', 'new']);

function removeNestedBlocks(blocks: MethodBlock[]): MethodBlock[] {
  const unique = new Map<string, MethodBlock>();
  for (const block of blocks) unique.set(`${block.line}:${block.name}`, block);
  return [...unique.values()];
}

function cyclomaticComplexity(content: string): number {
  const sanitized = maskCommentsAndStrings(content);
  const decisions = sanitized.match(/\b(?:if|for|while|case|catch)\b|&&|\|\||\?(?![?.])/g)?.length ?? 0;
  return 1 + decisions;
}

function repeatedStrings(contents: readonly string[], allowedOccurrences: number): Array<{ value: string; count: number; line: number }> {
  const counts = new Map<string, { count: number; line: number }>();
  const regex = /(['"])(?:(?!\1|\\).|\\.)*\1|`(?:[^`\\$]|\\.|\$(?!\{))*`/gs;

  for (const content of contents) {
    for (const match of content.matchAll(regex)) {
      const literal = match[0];
      const value = literal.slice(1, -1);
      const prefix = content.slice(Math.max(0, match.index! - 32), match.index!);
      if (/\b(?:from|import|require)\s*\(?\s*$/i.test(prefix)) continue;
      if (
        value.trim().length < 4
        || /^\.\.?\//.test(value)
        || /^[A-Za-z0-9_./-]+\.(?:ts|js|json|css|html|java)$/.test(value)
      ) {
        continue;
      }

      const current = counts.get(value);
      if (current) current.count += 1;
      else counts.set(value, { count: 1, line: lineAt(content, match.index!) });
    }
  }

  return [...counts.entries()]
    .filter(([, data]) => data.count > allowedOccurrences)
    .map(([value, data]) => ({ value, count: data.count, line: data.line }));
}

/**
 * Alguns modelos pequenos serializam uma representação intermediária em JSON
 * dentro de content. As regras do AGENTS.md também precisam inspecionar os
 * textos internos desse envelope, sem aceitar o JSON como código-fonte.
 */
function validationTextFragments(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    return [content];
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const fragments: string[] = [];
    collectJsonTextFragments(parsed, fragments, new Set<string>());
    return fragments.length ? fragments : [content];
  } catch {
    return [content];
  }
}

function collectJsonTextFragments(
  value: unknown,
  fragments: string[],
  seen: Set<string>
): void {
  if (typeof value === 'string') {
    if (value && !seen.has(value)) {
      seen.add(value);
      fragments.push(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectJsonTextFragments(item, fragments, seen));
    return;
  }

  if (!value || typeof value !== 'object') return;
  Object.values(value).forEach(item =>
    collectJsonTextFragments(item, fragments, seen)
  );
}

function findPlaceholder(content: string): { line: number; text: string } | undefined {
  const sanitized = maskStrings(content);
  const match = /\b(?:TODO|FIXME|HACK)\b|throw\s+new\s+Error\s*\(\s*['"](?:not implemented|não implementado|implementar)[^'"]*['"]\s*\)/i.exec(sanitized);
  return match ? { line: lineAt(content, match.index), text: match[0].slice(0, 120) } : undefined;
}

function maskCommentsAndStrings(content: string): string {
  return maskStrings(content)
    .replace(/\/\*[\s\S]*?\*\//g, match => preserveLines(match))
    .replace(/\/\/[^\r\n]*/g, match => ' '.repeat(match.length));
}

function maskStrings(content: string): string {
  return content.replace(/(['"])(?:(?!\1|\\).|\\.)*\1|`(?:[^`\\]|\\.)*`/gs, match => preserveLines(match));
}

function preserveLines(value: string): string {
  return value.replace(/[^\r\n]/g, ' ');
}

function matchingBrace(content: string, openBrace: number): number {
  let depth = 0;
  for (let index = openBrace; index < content.length; index += 1) {
    if (content[index] === '{') depth += 1;
    else if (content[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function lineAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, '/');
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
