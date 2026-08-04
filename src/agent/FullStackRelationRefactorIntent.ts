import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';

export interface RelationRefactorField {
  name: string;
  javaType: string;
  typeScriptType: string;
  kind: 'relation' | 'scalar';
  relatedJavaModelFile?: string;
  relatedTypeScriptModelFile?: string;
  relatedFields: string[];
}

export interface FullStackRelationRefactorAnalysis {
  priority: string[];
  entityType?: string;
  entityTerm?: string;
  backendModelFile?: string;
  frontendModelFile?: string;
  componentTemplateFile?: string;
  desiredFields: RelationRefactorField[];
  errors: string[];
}

export interface FullStackRelationRefactorAnalysisOptions {
  request: string;
  workspaceRoot?: string;
  priority?: string[];
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface WorkspaceFile {
  filePath: string;
  content: string;
}

interface ParsedField {
  name: string;
  type: string;
}

const REFACTOR_HINT = /\b(?:refator(?:e|ar|ação)|reestrutur(?:e|ar|ação)|reorganize|normalize|substitua)\b/i;
const RELATION_HINT = /\b(?:entidade|model(?:o)?|interface)\b[\s\S]{0,160}\b(?:tenha|possua|contenha|use)\b|\b(?:campos?\s+duplicados?|relacionamentos?|objetos?\s+relacionados?)\b/i;
const FLOW_CONTEXT_HINT = /\b(?:fluxo|frontend|backend|typescript|listagem|componente|endpoint|service)\b/i;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.angular', '.idea', '.vscode', '.vscode-test', 'node_modules', 'target', 'build', 'dist', 'out',
  'coverage', '.next', '.nuxt', '.cache', '.gradle', '.offgrid'
]);

export function isFullStackRelationRefactorIntent(request: string): boolean {
  const normalized = request.trim();
  return Boolean(normalized)
    && REFACTOR_HINT.test(normalized)
    && RELATION_HINT.test(normalized)
    && FLOW_CONTEXT_HINT.test(normalized);
}

export async function analyzeFullStackRelationRefactorIntent(
  options: FullStackRelationRefactorAnalysisOptions
): Promise<FullStackRelationRefactorAnalysis | undefined> {
  if (!isFullStackRelationRefactorIntent(options.request) || !options.workspaceRoot) return undefined;

  const errors: string[] = [];
  const entityTerm = extractEntityTerm(options.request);
  const entityType = entityTerm ? toPascalCase(singularize(entityTerm)) : undefined;
  if (!entityType) errors.push('A entidade que deve ser refatorada não foi identificada.');

  let files: WorkspaceFile[] = [];
  try {
    files = await discoverWorkspaceFiles(options.workspaceRoot);
  } catch (error) {
    errors.push(`Falha ao analisar o workspace: ${messageOf(error)}`);
  }

  const backendModel = entityType ? selectExactModel(files, entityType, 'java') : undefined;
  const frontendModel = entityType ? selectExactModel(files, entityType, 'typescript') : undefined;
  const componentTemplate = entityType ? selectComponentTemplate(files, entityType) : undefined;

  if (entityType && !backendModel) errors.push(`O modelo Java ${entityType} não foi encontrado.`);
  if (entityType && !frontendModel) errors.push(`O model TypeScript ${entityType} não foi encontrado.`);
  if (entityType && !componentTemplate) errors.push(`A listagem HTML existente de ${entityType} não foi encontrada.`);

  const desiredTerms = entityType ? extractDesiredFieldTerms(options.request, entityType) : [];
  if (!desiredTerms.length) errors.push('Os campos ou relacionamentos desejados não foram identificados.');

  const currentJavaFields = backendModel ? parseJavaFields(backendModel.content) : [];
  const currentTypeScriptFields = frontendModel ? parseTypeScriptFields(frontendModel.content) : [];
  const desiredFields: RelationRefactorField[] = [];

  for (const desiredTerm of desiredTerms) {
    const explicit = desiredTerm.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$<>.?]*)$/);
    const rawName = explicit?.[1] ?? desiredTerm;
    const explicitType = explicit?.[2];
    const relationType = explicitType && /^[A-Z]/.test(explicitType)
      ? explicitType
      : /^[A-Z]/.test(rawName) ? rawName : undefined;

    if (relationType) {
      const relatedJava = selectExactModel(files, relationType, 'java');
      const relatedTs = selectExactModel(files, relationType, 'typescript');
      if (!relatedJava || !relatedTs) {
        errors.push(`O relacionamento ${relationType} não pôde ser comprovado nos modelos Java e TypeScript.`);
        continue;
      }
      const relatedFields = unique([
        ...parseJavaFields(relatedJava.content).map(field => field.name),
        ...parseTypeScriptFields(relatedTs.content).map(field => field.name)
      ]);
      desiredFields.push({
        name: lowerCamel(relationType),
        javaType: relationType,
        typeScriptType: relationType,
        kind: 'relation',
        relatedJavaModelFile: relatedJava.filePath,
        relatedTypeScriptModelFile: relatedTs.filePath,
        relatedFields
      });
      continue;
    }

    const fieldName = rawName;
    const javaField = currentJavaFields.find(field => sameIdentifier(field.name, fieldName));
    const tsField = currentTypeScriptFields.find(field => sameIdentifier(field.name, fieldName));
    const javaType = explicitType ?? javaField?.type;
    const typeScriptType = tsField?.type ?? (javaType ? javaTypeToTypeScript(javaType) : undefined);
    if (!javaType || !typeScriptType) {
      errors.push(`O tipo do campo ${fieldName} não pôde ser comprovado.`);
      continue;
    }
    desiredFields.push({
      name: fieldName,
      javaType,
      typeScriptType,
      kind: 'scalar',
      relatedFields: []
    });
  }

  if (desiredFields.length && !desiredFields.some(field => field.kind === 'relation')) {
    errors.push('Nenhum relacionamento por objeto foi identificado no pedido.');
  }

  const priority = mergePriority([
    backendModel?.filePath,
    frontendModel?.filePath,
    componentTemplate?.filePath,
    ...desiredFields.flatMap(field => [field.relatedJavaModelFile, field.relatedTypeScriptModelFile]),
    ...(options.priority ?? [])
  ].filter((value): value is string => Boolean(value)));

  const analysis: FullStackRelationRefactorAnalysis = {
    priority,
    entityType,
    entityTerm,
    backendModelFile: backendModel?.filePath,
    frontendModelFile: frontendModel?.filePath,
    componentTemplateFile: componentTemplate?.filePath,
    desiredFields,
    errors: unique(errors)
  };

  options.info?.([
    '[FullStackRelationRefactorPolicy] Refatoração de relacionamento detectada.',
    `entidade=${entityType ?? 'não resolvida'}`,
    `campos=${desiredFields.map(field => `${field.name}:${field.javaType}`).join(',') || 'nenhum'}`,
    `erros=${analysis.errors.length}`
  ].join(' '));

  return analysis;
}

function extractEntityTerm(request: string): string | undefined {
  const candidates = [
    request.match(/\bentidade\s+([\p{L}_$][\p{L}\p{N}_$-]*)/iu)?.[1],
    request.match(/\bfluxo\s+(?:de|do|da)\s+([\p{L}_$][\p{L}\p{N}_$-]*)/iu)?.[1],
    request.match(/\bmodel(?:o)?\s+(?:de|do|da)?\s*([\p{L}_$][\p{L}\p{N}_$-]*)/iu)?.[1]
  ];
  return candidates.find(candidate => candidate && !isStopWord(candidate));
}

function extractDesiredFieldTerms(request: string, entityType: string): string[] {
  const escaped = escapeRegex(entityType);
  const match = request.match(new RegExp(`\\bentidade\\s+${escaped}\\s+(?:tenha|possua|contenha|use)\\s+([\\s\\S]+?)(?:[.;]|\\b(?:remova|atualize|mantenha|sem\\s+criar)\\b|$)`, 'iu'));
  if (!match?.[1]) return [];
  return match[1]
    .split(/\s*,\s*|\s+(?:e|and)\s+/i)
    .map(value => value.trim().replace(/^(?:um|uma|o|a)\s+/i, ''))
    .filter(value => /^[A-Za-z_$][\w$]*(?:\s*:\s*[A-Za-z_$][\w$<>.?]*)?$/.test(value));
}

async function discoverWorkspaceFiles(root: string): Promise<WorkspaceFile[]> {
  const stack = [root];
  const result: WorkspaceFile[] = [];
  let visited = 0;
  while (stack.length && visited < 60_000 && result.length < 10_000) {
    const directory = stack.pop();
    if (!directory) break;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !/\.(?:ts|java|html)$/i.test(entry.name)) continue;
      const relative = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/');
      if (!/(?:^|\/)src\//i.test(relative)) continue;
      let filePath: string;
      try { filePath = normalizeRelativePath(relative); } catch { continue; }
      try {
        const content = await fsp.readFile(resolveInsideRoot(root, filePath), 'utf8');
        result.push({ filePath, content });
      } catch { /* arquivo transitório */ }
    }
  }
  return result;
}

function selectExactModel(files: WorkspaceFile[], entityType: string, language: 'java' | 'typescript'): WorkspaceFile | undefined {
  const candidates = files.filter(file => {
    if (language === 'java' && !file.filePath.toLowerCase().endsWith('.java')) return false;
    if (language === 'typescript' && !/\.model\.ts$/i.test(file.filePath)) return false;
    return declaredType(file.content, file.filePath) === entityType;
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function selectComponentTemplate(files: WorkspaceFile[], entityType: string): WorkspaceFile | undefined {
  const kebab = toKebabCase(entityType);
  const candidates = files.filter(file => /\.component\.html$/i.test(file.filePath))
    .map(file => ({
      file,
      score: (file.filePath.toLowerCase().includes(`/${kebab}/`) ? 300 : 0)
        + (path.posix.basename(file.filePath).toLowerCase().startsWith(`${kebab}-`) ? 250 : 0)
        + (new RegExp(`\\b${escapeRegex(lowerCamel(entityType))}s?\\b`, 'i').test(file.content) ? 80 : 0)
    }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.file.filePath.localeCompare(right.file.filePath));
  const best = candidates[0];
  if (!best || candidates.filter(candidate => candidate.score === best.score).length !== 1) return undefined;
  return best.file;
}

function parseJavaFields(content: string): ParsedField[] {
  return [...content.matchAll(/\bprivate\s+(?:final\s+)?([A-Za-z_$][\w$<>?, .]*)\s+([A-Za-z_$][\w$]*)\s*;/g)]
    .map(match => ({ type: match[1]!.trim(), name: match[2]! }));
}

function parseTypeScriptFields(content: string): ParsedField[] {
  const body = content.match(/(?:interface|class)\s+\w+(?:\s+extends\s+[^\{]+)?\s*\{([\s\S]*?)\}/m)?.[1];
  if (!body) return [];
  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(?:\?)?\s*:\s*([^;\r\n]+)[;]?/gm)]
    .map(match => ({ name: match[1]!, type: match[2]!.trim() }));
}

function declaredType(content: string, filePath: string): string | undefined {
  if (filePath.toLowerCase().endsWith('.java')) return content.match(/\b(?:public\s+)?(?:class|record|interface)\s+([A-Za-z_$][\w$]*)/)?.[1];
  return content.match(/\b(?:export\s+)?(?:interface|class|type)\s+([A-Za-z_$][\w$]*)/)?.[1];
}

function javaTypeToTypeScript(type: string): string | undefined {
  const simple = type.replace(/^java\.[\w.]+\./, '').replace(/\s+/g, '');
  if (/^(?:String|Character|char|UUID|LocalDate|LocalDateTime|OffsetDateTime|Instant|Date)$/.test(simple)) return 'string';
  if (/^(?:Long|Integer|Short|Byte|Double|Float|BigDecimal|BigInteger|long|int|short|byte|double|float)$/.test(simple)) return 'number';
  if (/^(?:Boolean|boolean)$/.test(simple)) return 'boolean';
  if (/^[A-Z][A-Za-z0-9_$]*$/.test(simple)) return simple;
  return undefined;
}

function mergePriority(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    try {
      const clean = value.split('#')[0];
      if (!clean) continue;
      const normalized = normalizeRelativePath(clean);
      if (!result.some(existing => samePath(existing, normalized))) result.push(normalized);
    } catch { /* referência inválida */ }
  }
  return result;
}

function singularize(value: string): string {
  const word = value.trim();
  if (/ões$/i.test(word)) return `${word.slice(0, -3)}ão`;
  if (/ies$/i.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:sses|shes|ches|xes|zes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/(?:ss|us)$/i.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

function toPascalCase(value: string): string {
  return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('');
}

function toKebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function lowerCamel(value: string): string {
  return `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

function sameIdentifier(left: string, right: string): boolean {
  return normalizeWord(left) === normalizeWord(right);
}

function normalizeWord(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_$]+/g, '');
}

function isStopWord(value: string): boolean {
  return /^(?:atual|atuais|existente|existentes|endpoint|service|java|typescript|model|modelo|listagem|componente)$/i.test(value);
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
