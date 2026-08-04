import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as ts from 'typescript';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import { interpretLayeredTask } from './LayeredTaskIntent';

export interface FrontendCrudAnalysis {
  priority: string[];
  framework?: 'angular';
  componentFile?: string;
  serviceFile?: string;
  modelFile?: string;
  componentClass?: string;
  serviceClass?: string;
  entityType?: string;
  entityField?: string;
  targetTerms: string[];
}

export interface FrontendCrudAnalysisOptions {
  request: string;
  workspaceRoot?: string;
  priority?: string[];
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface TypeScriptCandidate {
  filePath: string;
  fileName: string;
  content: string;
  sourceFile: ts.SourceFile;
  kind: 'component' | 'service' | 'model' | 'other';
  className?: string;
  templateText?: string;
}

interface ComponentStructure {
  serviceType?: string;
  serviceField?: string;
  serviceModule?: string;
  entityType?: string;
  entityField?: string;
  modelModule?: string;
}

const FORM_TARGET = /\b(?:formul[aá]rio|form|tela|componente|component|frontend|front-end)\b/i;
const UPDATE_BEHAVIOR = /(?:^|\s|@)(?:PUT|PATCH)(?=\s|\/|$)|\b(?:editar|edite|alterar|altere|atualizar|atualize|update|edit|patch)\b/i;
const CREATE_BEHAVIOR = /(?:^|\s|@)POST(?=\s|\/|$)|\b(?:cadastrar|cadastro|salvar|registrar|incluir|criar|create|save|register)\b/i;
const ID_CONDITION = /\b(?:quando|se|caso)\b[^.!?;]{0,90}\bid\b|\bcom\s+id\b|\bsem\s+id\b/i;
const ENDPOINT_REFERENCE = /\b(?:endpoint|rota|api|PUT|PATCH|POST)\b/i;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.angular', '.idea', '.vscode', '.vscode-test', 'node_modules', 'target', 'build', 'dist', 'out',
  'coverage', '.next', '.nuxt', '.cache'
]);

export function isFrontendCrudIntent(request: string): boolean {
  const task = interpretLayeredTask(request);
  if (task.ambiguous || task.targetLayer !== 'component') return false;
  return FORM_TARGET.test(request)
    && UPDATE_BEHAVIOR.test(request)
    && CREATE_BEHAVIOR.test(request)
    && ID_CONDITION.test(request)
    && ENDPOINT_REFERENCE.test(request);
}

export function frontendCrudTaskGuidance(request: string): string | undefined {
  if (!isFrontendCrudIntent(request)) return undefined;
  return [
    'Tarefa composta de formulário frontend: o alvo é o componente/formulário existente e o service.ts usado por ele.',
    'Endpoint, PUT e POST descrevem o comportamento HTTP esperado; não altere Resource, Controller ou backend.',
    'Localize o formulário real pela estrutura do código, não apenas pelo arquivo ativo.',
    'Reutilize o componente existente: use atualização quando a entidade tiver id e criação quando não tiver.',
    'Não crie um componente novo se o projeto já possui formulário de cadastro/edição.'
  ].join(' ');
}

export async function analyzeFrontendCrudIntent(
  options: FrontendCrudAnalysisOptions
): Promise<FrontendCrudAnalysis | undefined> {
  if (!isFrontendCrudIntent(options.request) || !options.workspaceRoot) return undefined;

  const task = interpretLayeredTask(options.request);
  const targetTerms = task.entityTerms.map(normalizeWord).filter(Boolean);
  let candidates: TypeScriptCandidate[];
  try {
    candidates = await discoverTypeScriptCandidates(options.workspaceRoot);
  } catch (error) {
    options.warn?.(`[FrontendCrudPolicy] Falha ao analisar o frontend: ${messageOf(error)}`);
    return { priority: normalizePriority(options.priority ?? []), targetTerms };
  }

  const components = candidates.filter(candidate => candidate.kind === 'component');
  const services = candidates.filter(candidate => candidate.kind === 'service');
  const models = candidates.filter(candidate => candidate.kind === 'model');
  const initialPriority = normalizePriority(options.priority ?? []);

  const rankedComponents = components
    .map(component => ({
      component,
      structure: inspectComponent(component, targetTerms),
      score: scoreComponent(component, targetTerms, initialPriority)
    }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.component.filePath.localeCompare(right.component.filePath));

  const bestScore = rankedComponents[0]?.score ?? 0;
  const bestComponents = rankedComponents.filter(candidate => candidate.score === bestScore);
  const selected = bestComponents.length === 1 ? bestComponents[0] : undefined;
  if (!selected) {
    options.warn?.('[FrontendCrudPolicy] O formulário alvo não pôde ser comprovado de forma única; usando o AgentLoop com contexto direcionado.');
    return {
      priority: mergePriority([
        ...rankedComponents.slice(0, 4).map(candidate => candidate.component.filePath),
        ...initialPriority
      ]),
      targetTerms
    };
  }

  const service = resolveServiceCandidate(selected.component, selected.structure, services, targetTerms);
  const model = resolveModelCandidate(selected.component, selected.structure, models, targetTerms);
  const entityType = selected.structure.entityType
    ?? inferEntityTypeFromService(service, targetTerms)
    ?? inferEntityTypeFromModel(model, targetTerms);
  const entityField = selected.structure.entityField;

  const analysis: FrontendCrudAnalysis = {
    priority: mergePriority([
      selected.component.filePath,
      service?.filePath,
      model?.filePath,
      ...initialPriority
    ].filter((value): value is string => Boolean(value))),
    framework: 'angular',
    componentFile: selected.component.filePath,
    serviceFile: service?.filePath,
    modelFile: model?.filePath,
    componentClass: selected.component.className,
    serviceClass: service?.className ?? selected.structure.serviceType,
    entityType,
    entityField,
    targetTerms
  };

  options.info?.(
    [
      '[FrontendCrudPolicy] Fluxo de formulário frontend detectado.',
      `componente=${analysis.componentFile}`,
      `service=${analysis.serviceFile ?? 'não encontrado'}`,
      `modelo=${analysis.modelFile ?? 'não encontrado'}`,
      `entidade=${analysis.entityType ?? (targetTerms.join(',') || 'não definida')}`
    ].join(' ')
  );
  return analysis;
}

async function discoverTypeScriptCandidates(root: string): Promise<TypeScriptCandidate[]> {
  const files = listTypeScriptSourceFiles(root);
  const result: TypeScriptCandidate[] = [];
  for (const filePath of files) {
    let content: string;
    try {
      content = await fsp.readFile(resolveInsideRoot(root, filePath), 'utf8');
    } catch {
      continue;
    }
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const classDeclaration = sourceFile.statements.find(ts.isClassDeclaration);
    const className = classDeclaration?.name?.text;
    const fileName = path.posix.basename(filePath);
    const kind = classifyFile(fileName, content, sourceFile);
    if (kind === 'other') continue;
    const templateText = kind === 'component' ? await readComponentTemplate(root, filePath, content) : undefined;
    result.push({ filePath, fileName, content, sourceFile, kind, className, templateText });
  }
  return result;
}

function listTypeScriptSourceFiles(root: string): string[] {
  const stack = [root];
  const files: string[] = [];
  let visited = 0;
  while (stack.length && visited < 50_000 && files.length < 5_000) {
    const directory = stack.pop();
    if (!directory) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.ts')) continue;
      if (/\.(?:spec|test)\.ts$|\.d\.ts$/i.test(entry.name)) continue;
      const relative = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/');
      if (!/(?:^|\/)src\//i.test(relative)) continue;
      try { files.push(normalizeRelativePath(relative)); } catch { /* caminho inválido */ }
    }
  }
  return files;
}

function classifyFile(
  fileName: string,
  content: string,
  sourceFile: ts.SourceFile
): TypeScriptCandidate['kind'] {
  if (/\.component\.ts$/i.test(fileName) || /@Component\s*\(/.test(content)) return 'component';
  if (/\.service\.ts$/i.test(fileName) || (/@Injectable\s*\(/.test(content) && /\bHttpClient\b/.test(content))) return 'service';
  if (/\.model\.ts$/i.test(fileName)) return 'model';
  const exportedType = sourceFile.statements.some(statement =>
    (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
    && hasExportModifier(statement)
  );
  return exportedType ? 'model' : 'other';
}

async function readComponentTemplate(root: string, filePath: string, content: string): Promise<string | undefined> {
  const inline = content.match(/\btemplate\s*:\s*`([\s\S]*?)`/m)?.[1]
    ?? content.match(/\btemplate\s*:\s*(['"])([\s\S]*?)\1/m)?.[2];
  if (inline) return inline;
  const templateUrl = content.match(/\btemplateUrl\s*:\s*['"]([^'"]+)['"]/m)?.[1];
  if (!templateUrl) return undefined;
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), templateUrl));
  try { return await fsp.readFile(resolveInsideRoot(root, relative), 'utf8'); } catch { return undefined; }
}

function scoreComponent(candidate: TypeScriptCandidate, terms: string[], priority: string[]): number {
  if (!terms.length) return 0;
  const normalizedPath = normalizeWord(candidate.filePath);
  const normalizedClass = normalizeWord(candidate.className ?? '');
  const source = normalizeWord(candidate.content);
  const template = normalizeWord(candidate.templateText ?? '');
  let score = 0;
  for (const term of terms) {
    if (normalizedPath.includes(term)) score += 160;
    if (normalizedClass.includes(term)) score += 130;
    if (new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(source)) score += 50;
  }
  if (/\b(?:ngmodel|formgroup|formcontrol|submit)\b/i.test(template)) score += 140;
  if (/\b(?:dialog|modal|salvar|save|cadastrar|register)\b/i.test(candidate.content + candidate.templateText)) score += 70;
  if (/\b(?:edit|editar|alterar|update)\w*\s*\(/i.test(candidate.content)) score += 50;
  if (/\b(?:save|salvar|cadastrar|register)\w*\s*\(/i.test(candidate.content)) score += 50;
  if (hasExactEntityProperty(candidate, terms)) score += 180;
  if (priority.some(item => samePath(item, candidate.filePath))) score += 8;
  return score;
}

function hasExactEntityProperty(candidate: TypeScriptCandidate, terms: string[]): boolean {
  const classDeclaration = candidate.sourceFile.statements.find(ts.isClassDeclaration);
  if (!classDeclaration) return false;
  return classDeclaration.members.some(member => {
    if (!ts.isPropertyDeclaration(member) || !member.type || ts.isArrayTypeNode(member.type)) return false;
    const typeText = normalizeWord(member.type.getText(candidate.sourceFile));
    return terms.some(term => typeText === term);
  });
}

function inspectComponent(candidate: TypeScriptCandidate, terms: string[]): ComponentStructure {
  const imports = importMap(candidate.sourceFile);
  const classDeclaration = candidate.sourceFile.statements.find(ts.isClassDeclaration);
  const structure: ComponentStructure = {};
  if (!classDeclaration) return structure;

  const constructor = classDeclaration.members.find(ts.isConstructorDeclaration);
  for (const parameter of constructor?.parameters ?? []) {
    const type = parameter.type?.getText(candidate.sourceFile);
    const name = parameter.name.getText(candidate.sourceFile);
    if (!type || !/Service$/.test(type)) continue;
    structure.serviceType = type;
    structure.serviceField = name;
    structure.serviceModule = imports.get(type);
    break;
  }

  const properties = classDeclaration.members.filter(ts.isPropertyDeclaration);
  const exact = properties.find(property => {
    if (!property.type || ts.isArrayTypeNode(property.type)) return false;
    const typeText = normalizeWord(property.type.getText(candidate.sourceFile));
    return terms.some(term => typeText === term);
  });
  if (exact?.type) {
    structure.entityType = exact.type.getText(candidate.sourceFile);
    structure.entityField = exact.name.getText(candidate.sourceFile);
    structure.modelModule = imports.get(structure.entityType);
  }
  return structure;
}

function resolveServiceCandidate(
  component: TypeScriptCandidate,
  structure: ComponentStructure,
  services: TypeScriptCandidate[],
  terms: string[]
): TypeScriptCandidate | undefined {
  const importedPath = structure.serviceModule
    ? resolveModulePath(component.filePath, structure.serviceModule)
    : undefined;
  if (importedPath) {
    const exact = services.find(service => samePath(service.filePath, importedPath));
    if (exact) return exact;
  }
  if (structure.serviceType) {
    const exactClass = services.filter(service => service.className === structure.serviceType);
    if (exactClass.length === 1) return exactClass[0];
  }
  return uniqueBest(services, service => scoreRelatedFile(service, terms));
}

function resolveModelCandidate(
  component: TypeScriptCandidate,
  structure: ComponentStructure,
  models: TypeScriptCandidate[],
  terms: string[]
): TypeScriptCandidate | undefined {
  const importedPath = structure.modelModule
    ? resolveModulePath(component.filePath, structure.modelModule)
    : undefined;
  if (importedPath) {
    const exact = models.find(model => samePath(model.filePath, importedPath));
    if (exact) return exact;
  }
  return uniqueBest(models, model => scoreRelatedFile(model, terms));
}

function scoreRelatedFile(candidate: TypeScriptCandidate, terms: string[]): number {
  const value = normalizeWord(`${candidate.filePath} ${candidate.className ?? ''}`);
  return terms.reduce((score, term) => score + (value.includes(term) ? 100 : 0), 0);
}

function uniqueBest(
  candidates: TypeScriptCandidate[],
  score: (candidate: TypeScriptCandidate) => number
): TypeScriptCandidate | undefined {
  const ranked = candidates
    .map(candidate => ({ candidate, score: score(candidate) }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.filePath.localeCompare(right.candidate.filePath));
  const best = ranked[0]?.score ?? 0;
  const tied = ranked.filter(candidate => candidate.score === best);
  return tied.length === 1 ? tied[0]?.candidate : undefined;
}

function inferEntityTypeFromService(candidate: TypeScriptCandidate | undefined, terms: string[]): string | undefined {
  if (!candidate) return undefined;
  const imports = importMap(candidate.sourceFile);
  return [...imports.keys()].find(name => terms.some(term => normalizeWord(name) === term));
}

function inferEntityTypeFromModel(candidate: TypeScriptCandidate | undefined, terms: string[]): string | undefined {
  if (!candidate) return undefined;
  const names = candidate.sourceFile.statements.flatMap(statement => {
    if (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      return statement.name ? [statement.name.text] : [];
    }
    return [];
  });
  return names.find(name => terms.some(term => normalizeWord(name) === term)) ?? names[0];
}

function importMap(sourceFile: ts.SourceFile): Map<string, string> {
  const result = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const modulePath = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) result.set(clause.name.text, modulePath);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) result.set(element.name.text, modulePath);
    }
  }
  return result;
}

function resolveModulePath(fromFile: string, modulePath: string): string | undefined {
  if (!modulePath.startsWith('.')) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), modulePath));
  try { return normalizeRelativePath(base.endsWith('.ts') ? base : `${base}.ts`); } catch { return undefined; }
}

function hasExportModifier(node: ts.Node & { modifiers?: ts.NodeArray<ts.ModifierLike> }): boolean {
  return node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function normalizePriority(values: string[]): string[] {
  return mergePriority(values.map(value => value.split('#')[0]).filter((value): value is string => Boolean(value)));
}

function mergePriority(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    try {
      const normalized = normalizeRelativePath(value);
      if (!result.some(existing => samePath(existing, normalized))) result.push(normalized);
    } catch { /* ignora referências inválidas */ }
  }
  return result;
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();
}

function normalizeWord(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_$]+/g, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
