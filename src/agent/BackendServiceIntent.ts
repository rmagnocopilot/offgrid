import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import { interpretLayeredTask, type LayeredTaskIntent } from './LayeredTaskIntent';

export type ServiceLanguage = 'java' | 'typescript';
export type ServiceFramework = 'jax-rs' | 'spring' | 'angular-http' | 'nestjs' | 'typescript';

export interface BackendServiceAnalysis {
  priority: string[];
  language?: ServiceLanguage;
  resourceFile?: string;
  serviceFile?: string;
  entityType?: string;
  serviceType?: string;
  serviceField?: string;
  endpointMethod?: string;
  endpointVerb?: 'PUT' | 'PATCH';
  framework?: ServiceFramework;
}

export interface BackendServiceAnalysisOptions {
  request: string;
  workspaceRoot?: string;
  priority?: string[];
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface JavaFile {
  filePath: string;
  fileName: string;
  content: string;
  kind: 'resource' | 'service' | 'other';
}

interface TypeScriptFile {
  filePath: string;
  fileName: string;
  content: string;
  kind: 'endpoint' | 'service' | 'other';
  framework?: 'angular-http' | 'nestjs' | 'typescript';
}

interface ResourceMethod {
  name: string;
  annotations: string;
  parameters: string;
  body: string;
  verb?: 'PUT' | 'PATCH';
}

interface JavaReference {
  resource: JavaFile;
  method: ResourceMethod;
  framework?: 'jax-rs' | 'spring';
  binding?: { type: string; field: string };
  entityType?: string;
  serviceFile?: JavaFile;
}

const IGNORED_DIRECTORIES = new Set([
  '.git', '.idea', '.vscode', 'node_modules', 'target', 'build', 'dist', 'out', 'coverage', '.gradle', '.angular', '.next', '.nuxt'
]);

const UPDATE_WORD = /\b(?:editar|alterar|atualizar|edit|update|modify|patch)\b/i;

export function isBackendServiceIntent(request: string): boolean {
  const task = interpretLayeredTask(request);
  return !task.ambiguous
    && task.targetLayer === 'service'
    && (task.action === 'create' || task.action === 'modify')
    && (task.operation === 'update' || UPDATE_WORD.test(request));
}

export function serviceTaskGuidance(request: string): string | undefined {
  if (!isBackendServiceIntent(request)) return undefined;
  const task = interpretLayeredTask(request);
  const language = task.language === 'typescript' ? ' TypeScript' : task.language === 'java' ? ' Java' : '';
  return [
    `Tarefa de Service${language}: trate o Service como alvo da alteração e endpoint/controller apenas como referência.`,
    'Não crie outro endpoint, Resource, Controller ou rota.',
    'Localize o Service correspondente à mesma entidade e operação; não escolha arquivos apenas porque estão ativos.',
    'Adicione somente o método equivalente e ajuste a chamada de referência apenas quando isso for estruturalmente necessário.',
    'Siga tipos, injeção, persistência e cliente HTTP já usados no projeto; não invente Repository, URL ou método auxiliar.'
  ].join(' ');
}

export async function analyzeBackendServiceIntent(
  options: BackendServiceAnalysisOptions
): Promise<BackendServiceAnalysis | undefined> {
  if (!isBackendServiceIntent(options.request) || !options.workspaceRoot) return undefined;

  const task = interpretLayeredTask(options.request);
  const priorityPaths = normalizePriority(options.priority ?? []);

  let javaFiles: JavaFile[] = [];
  let tsFiles: TypeScriptFile[] = [];
  try {
    [javaFiles, tsFiles] = await Promise.all([
      discoverJavaFiles(options.workspaceRoot),
      discoverTypeScriptFiles(options.workspaceRoot)
    ]);
  } catch (error) {
    options.warn?.(`[ServiceLayerPolicy] Falha ao analisar arquivos de Service: ${messageOf(error)}`);
    return { priority: priorityPaths };
  }

  const javaReference = selectJavaReference(javaFiles, task, priorityPaths);
  const language = chooseLanguage(task, priorityPaths, javaReference, tsFiles);

  if (language === 'typescript') {
    const analysis = analyzeTypeScriptService(task, priorityPaths, tsFiles, javaReference);
    if (!analysis.serviceFile) {
      options.warn?.('[ServiceLayerPolicy] Service TypeScript único não foi comprovado; usando o AgentLoop com contexto direcionado.');
    }
    options.info?.(
      [
        '[ServiceLayerPolicy] Intenção de Service TypeScript detectada.',
        `referência=${analysis.resourceFile ?? 'não definida'}`,
        `service=${analysis.serviceFile ?? 'não encontrado'}`,
        `entidade=${analysis.entityType ?? 'não definida'}`
      ].join(' ')
    );
    return analysis;
  }

  const analysis = analyzeJavaService(priorityPaths, javaReference);
  if (!analysis.resourceFile) {
    options.warn?.('[ServiceLayerPolicy] Nenhum endpoint de atualização único foi comprovado; usando o AgentLoop com contexto direcionado.');
  }
  options.info?.(
    [
      '[ServiceLayerPolicy] Intenção de Service Java detectada.',
      `referência=${analysis.resourceFile ?? 'não definida'}`,
      `service=${analysis.serviceFile ?? 'não encontrado'}`,
      `entidade=${analysis.entityType ?? 'não definida'}`
    ].join(' ')
  );
  return analysis;
}

function chooseLanguage(
  task: LayeredTaskIntent,
  priority: string[],
  javaReference: JavaReference | undefined,
  tsFiles: TypeScriptFile[]
): ServiceLanguage {
  if (task.language === 'typescript') return 'typescript';
  if (task.language === 'java') return 'java';
  if (task.explicitFiles.some(file => /\.service\.ts$/i.test(file))) return 'typescript';
  if (task.explicitFiles.some(file => /Service\.java$/i.test(file))) return 'java';
  if (priority.some(file => /\.service\.ts$/i.test(file))) return 'typescript';
  if (priority.some(file => /Service\.java$/i.test(file))) return 'java';
  if (javaReference?.serviceFile) return 'java';
  if (tsFiles.some(file => file.kind === 'service')) return 'typescript';
  return 'java';
}

function analyzeJavaService(
  priorityPaths: string[],
  reference: JavaReference | undefined
): BackendServiceAnalysis {
  if (!reference) return { priority: priorityPaths, language: 'java' };
  return {
    priority: mergePriority([
      reference.resource.filePath,
      reference.serviceFile?.filePath,
      ...priorityPaths
    ].filter((value): value is string => Boolean(value))),
    language: 'java',
    resourceFile: reference.resource.filePath,
    serviceFile: reference.serviceFile?.filePath,
    entityType: reference.entityType,
    serviceType: reference.binding?.type,
    serviceField: reference.binding?.field,
    endpointMethod: reference.method.name,
    endpointVerb: reference.method.verb,
    framework: reference.framework
  };
}

function analyzeTypeScriptService(
  task: LayeredTaskIntent,
  priorityPaths: string[],
  files: TypeScriptFile[],
  javaReference: JavaReference | undefined
): BackendServiceAnalysis {
  const services = files.filter(file => file.kind === 'service');
  const endpoints = files.filter(file => file.kind === 'endpoint');
  const explicitService = resolveExplicitServiceFile(task.explicitFiles, services);
  const priorityService = priorityPaths
    .map(filePath => services.find(service => samePath(service.filePath, filePath)))
    .find((service): service is TypeScriptFile => Boolean(service));
  const entityTerms = mergeTerms(task.entityTerms, javaReference?.entityType ? [javaReference.entityType] : []);

  const scoredServices = services
    .map(service => ({ service, score: scoreTypeScriptService(service, entityTerms) }))
    .sort((left, right) => right.score - left.score || left.service.filePath.localeCompare(right.service.filePath));
  const bestScore = scoredServices[0]?.score ?? 0;
  const best = scoredServices.filter(candidate => candidate.score === bestScore && bestScore > 0);

  let service = explicitService ?? priorityService;
  if (!service && best.length === 1) service = best[0]?.service;
  if (!service && services.length === 1) service = services[0];

  const endpoint = selectTypeScriptEndpoint(endpoints, entityTerms, task.operation);
  const entityType = javaReference?.entityType
    ?? resolveTypeScriptEntityType(service?.fileName, service?.content, entityTerms)
    ?? entityTerms[0];

  const framework = service?.framework ?? endpoint?.framework ?? 'typescript';
  const referenceFile = javaReference?.resource.filePath ?? endpoint?.filePath;
  const endpointMethod = javaReference?.method.name ?? findTypeScriptUpdateMethodName(endpoint?.content);

  return {
    priority: mergePriority([
      service?.filePath,
      referenceFile,
      ...priorityPaths
    ].filter((value): value is string => Boolean(value))),
    language: 'typescript',
    resourceFile: referenceFile,
    serviceFile: service?.filePath,
    entityType,
    serviceType: resolveTypeScriptServiceClass(service?.content),
    serviceField: undefined,
    endpointMethod,
    endpointVerb: javaReference?.method.verb ?? (task.operation === 'update' ? 'PUT' : undefined),
    framework
  };
}

function selectJavaReference(
  files: JavaFile[],
  task: LayeredTaskIntent,
  priorityPaths: string[]
): JavaReference | undefined {
  const resources = files.filter(file => file.kind === 'resource');
  const candidates = resources.flatMap(resource =>
    findResourceMethods(resource.content)
      .filter(method => method.verb && (UPDATE_WORD.test(method.name) || task.operation === 'update'))
      .map(method => ({ resource, method }))
  );

  const terms = task.entityTerms.map(normalizeWord).filter(Boolean);
  let selected = terms.length
    ? candidates.find(candidate => candidateMatchesTerms(candidate.resource, candidate.method, terms))
    : undefined;

  if (!selected && candidates.length === 1) selected = candidates[0];

  if (!selected && candidates.length > 1) {
    const explicitResource = task.explicitFiles
      .map(file => resources.find(resource => samePath(resource.filePath, file) || resource.filePath.toLowerCase().endsWith(file.replace(/\\/g, '/').toLowerCase())))
      .find((resource): resource is JavaFile => Boolean(resource));
    if (explicitResource) {
      const methods = candidates.filter(candidate => samePath(candidate.resource.filePath, explicitResource.filePath));
      if (methods.length === 1) selected = methods[0];
    }
  }

  if (!selected) return undefined;

  const framework = detectFramework(selected.resource.content);
  const entityType = resolveEntityType(selected.resource.fileName, selected.method.parameters, selected.resource.content);
  const binding = resolveServiceBinding(selected.resource.content, entityType);
  const serviceFile = binding
    ? files.find(file => file.kind === 'service' && normalizeWord(file.fileName) === normalizeWord(binding.type))
    : undefined;

  // Arquivo ativo só desempata quando já corresponde à entidade comprovada; nunca escolhe outro Resource sozinho.
  if (priorityPaths.length && candidates.length > 1 && !terms.length && !task.explicitFiles.length) return undefined;

  return {
    resource: selected.resource,
    method: selected.method,
    framework,
    binding,
    entityType,
    serviceFile
  };
}

function candidateMatchesTerms(resource: JavaFile, method: ResourceMethod, terms: string[]): boolean {
  const haystack = normalizeWord(`${resource.fileName} ${method.parameters}`);
  return terms.some(term => haystack.includes(term));
}

async function discoverJavaFiles(root: string): Promise<JavaFile[]> {
  const result: JavaFile[] = [];
  for (const filePath of listSourceFiles(root, file => /\.java$/i.test(file), /(?:^|\/)src\/main\/java\//i, 4_000)) {
    let content: string;
    try { content = await fsp.readFile(resolveInsideRoot(root, filePath), 'utf8'); } catch { continue; }
    const fileName = path.posix.basename(filePath, '.java');
    result.push({ filePath, fileName, content, kind: classifyJavaFile(fileName, content) });
  }
  return result;
}

async function discoverTypeScriptFiles(root: string): Promise<TypeScriptFile[]> {
  const result: TypeScriptFile[] = [];
  const files = listSourceFiles(
    root,
    file => /\.ts$/i.test(file) && !/\.(?:spec|test|d)\.ts$/i.test(file),
    /(?:^|\/)(?:src|app|server|client|frontend|backend)\//i,
    6_000
  );
  for (const filePath of files) {
    let content: string;
    try { content = await fsp.readFile(resolveInsideRoot(root, filePath), 'utf8'); } catch { continue; }
    const fileName = path.posix.basename(filePath);
    const kind = classifyTypeScriptFile(fileName, content);
    result.push({ filePath, fileName, content, kind, framework: detectTypeScriptFramework(content, kind) });
  }
  return result;
}

function listSourceFiles(
  root: string,
  acceptFile: (name: string) => boolean,
  acceptRelativePath: RegExp,
  maxFiles: number
): string[] {
  const stack = [root];
  const files: string[] = [];
  let visited = 0;
  while (stack.length && visited < 60_000 && files.length < maxFiles) {
    const directory = stack.pop();
    if (!directory) break;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      if (visited >= 60_000) break;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !acceptFile(entry.name)) continue;
      const relative = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/');
      if (!acceptRelativePath.test(relative)) continue;
      try { files.push(normalizeRelativePath(relative)); } catch { /* caminho inválido */ }
    }
  }
  return files;
}

function classifyJavaFile(fileName: string, content: string): JavaFile['kind'] {
  if (/(?:Resource|Controller|Endpoint|Rest|Api)$/i.test(fileName) || /@(Path|RestController|Controller)\b/.test(content)) return 'resource';
  if (/Service$/i.test(fileName) || /@(Service|Stateless)\b/.test(content)) return 'service';
  return 'other';
}

function classifyTypeScriptFile(fileName: string, content: string): TypeScriptFile['kind'] {
  if (/\.service\.ts$/i.test(fileName) || /@Injectable\b/.test(content) || /\bclass\s+\w+Service\b/.test(content)) return 'service';
  if (/\.(?:controller|resource|routes?)\.ts$/i.test(fileName)
    || /@Controller\b/.test(content)
    || /\b(?:router|app)\.(?:put|patch|post|get|delete)\s*\(/.test(content)) return 'endpoint';
  return 'other';
}

function detectTypeScriptFramework(content: string, kind: TypeScriptFile['kind']): 'angular-http' | 'nestjs' | 'typescript' {
  if (/from\s+['"]@angular\/common\/http['"]|\bHttpClient\b/.test(content)) return 'angular-http';
  if (/from\s+['"]@nestjs\//.test(content) || /@(Controller|Injectable)\b/.test(content) && kind === 'endpoint') return 'nestjs';
  return 'typescript';
}

function findResourceMethods(content: string): ResourceMethod[] {
  const methods: ResourceMethod[] = [];
  const pattern = /((?:@[A-Za-z_$][\w$.]*(?:\([^)]*\))?\s*)+)(?:public|protected|private)\s+[A-Za-z_$][\w$<>?,.\[\] ]*\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const methodName = match[2];
    if (!methodName) continue;
    const openParen = pattern.lastIndex - 1;
    const closeParen = findMatchingParenthesis(content, openParen);
    if (closeParen < 0) continue;
    const bodyStart = content.indexOf('{', closeParen + 1);
    const semicolon = content.indexOf(';', closeParen + 1);
    if (bodyStart < 0 || (semicolon >= 0 && semicolon < bodyStart)) continue;
    const bodyEnd = findMatchingBrace(content, bodyStart);
    if (bodyEnd < 0) continue;
    const annotations = match[1] ?? '';
    methods.push({
      name: methodName,
      parameters: content.slice(openParen + 1, closeParen),
      annotations,
      body: content.slice(bodyStart + 1, bodyEnd),
      verb: updateVerb(annotations)
    });
    pattern.lastIndex = bodyEnd + 1;
  }
  return methods;
}

function updateVerb(annotations: string): 'PUT' | 'PATCH' | undefined {
  if (/\@PUT\b/i.test(annotations) || /\@PutMapping\b/i.test(annotations) || /RequestMethod\.PUT\b/i.test(annotations)) return 'PUT';
  if (/\@PATCH\b/i.test(annotations) || /\@PatchMapping\b/i.test(annotations) || /RequestMethod\.PATCH\b/i.test(annotations)) return 'PATCH';
  return undefined;
}

function detectFramework(content: string): 'jax-rs' | 'spring' | undefined {
  if (/\b(?:jakarta|javax)\.ws\.rs\.|@(Path|GET|POST|PUT|PATCH|DELETE)\b/.test(content)) return 'jax-rs';
  if (/\borg\.springframework\.web\.bind\.annotation\.|@(RestController|RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/.test(content)) return 'spring';
  return undefined;
}

function resolveServiceBinding(content: string, entityType?: string): { type: string; field: string } | undefined {
  const fields = [...content.matchAll(
    /(?:^|\n)[ \t]*(?:(?:@[\w.]+(?:\([^\r\n]*\))?)[ \t]*\r?\n[ \t]*)*(?:private|protected|public)[ \t]+(?:final[ \t]+)?([A-Za-z_$][\w$]*Service)[ \t]+([A-Za-z_$][\w$]*)[ \t]*;/g
  )].map(match => ({ type: match[1]!, field: match[2]! }));
  if (entityType) {
    const exact = fields.find(field => normalizeWord(field.type) === normalizeWord(`${entityType}Service`));
    if (exact) return exact;
    const related = fields.filter(field => normalizeWord(field.type).includes(normalizeWord(entityType)));
    if (related.length === 1) return related[0];
  }
  return fields.length === 1 ? fields[0] : undefined;
}

function resolveEntityType(fileName: string, parameters: string, content: string): string | undefined {
  const resourceBase = fileName.replace(/(?:Resource|Controller|Endpoint|Rest|Api)$/i, '');
  const parameterTypes = splitTopLevel(parameters)
    .map(parameter => parameter.replace(/@[A-Za-z_$][\w$.]*(?:\([^)]*\))?\s*/g, '').trim())
    .map(parameter => parameter.match(/([A-Za-z_$][\w$<>?,.\[\]]*)\s+[A-Za-z_$][\w$]*$/)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(type => type.replace(/<.*>/g, '').split('.').at(-1) ?? type)
    .filter(type => !/^(?:Long|Integer|String|UUID|long|int)$/i.test(type));
  const fromParameter = parameterTypes.find(type => normalizeWord(type) === normalizeWord(resourceBase));
  if (fromParameter) return fromParameter;
  if (parameterTypes.length === 1) return parameterTypes[0];
  return [...content.matchAll(/^\s*import\s+([\w.]+)\s*;/gm)]
    .map(match => match[1]?.split('.').at(-1))
    .find(value => value && normalizeWord(value) === normalizeWord(resourceBase));
}

function resolveExplicitServiceFile(explicitFiles: string[], services: TypeScriptFile[]): TypeScriptFile | undefined {
  for (const file of explicitFiles.filter(value => /\.service\.ts$/i.test(value))) {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    const matches = services.filter(service => service.filePath.toLowerCase().endsWith(normalized)
      || service.fileName.toLowerCase() === path.posix.basename(normalized));
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function scoreTypeScriptService(file: TypeScriptFile, terms: string[]): number {
  if (!terms.length) return 0;
  const fileBase = file.fileName.replace(/\.service\.ts$/i, '');
  const className = resolveTypeScriptServiceClass(file.content) ?? '';
  const haystack = normalizeWord(`${fileBase} ${className}`);
  return Math.max(...terms.map(term => haystack.includes(normalizeWord(term)) ? 100 : 0));
}

function selectTypeScriptEndpoint(
  endpoints: TypeScriptFile[],
  terms: string[],
  operation: LayeredTaskIntent['operation']
): TypeScriptFile | undefined {
  const updateEndpoints = endpoints.filter(file => operation !== 'update' || hasTypeScriptUpdateEndpoint(file.content));
  const matching = terms.length
    ? updateEndpoints.filter(file => terms.some(term => normalizeWord(`${file.fileName} ${file.content.slice(0, 2_000)}`).includes(normalizeWord(term))))
    : [];
  if (matching.length === 1) return matching[0];
  return updateEndpoints.length === 1 ? updateEndpoints[0] : undefined;
}

function hasTypeScriptUpdateEndpoint(content: string): boolean {
  return /@(Put|Patch)\b/.test(content) || /\b(?:router|app)\.(?:put|patch)\s*\(/.test(content);
}

function findTypeScriptUpdateMethodName(content?: string): string | undefined {
  if (!content) return undefined;
  return content.match(/@(Put|Patch)\b[^\n]*\n\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/)?.[2]
    ?? content.match(/\b(?:router|app)\.(?:put|patch)\s*\([^,]+,\s*(?:async\s*)?\([^)]*\)\s*=>/)?.[0];
}

function resolveTypeScriptEntityType(fileName?: string, content?: string, terms: string[] = []): string | undefined {
  if (!content) return terms[0] ? pascalCase(terms[0]) : undefined;
  const classBase = fileName?.replace(/\.service\.ts$/i, '');
  const imports = [...content.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]*(?:model|models|entity|entities|dto)[^'"]*['"]/g)]
    .flatMap(match => (match[1] ?? '').split(',').map(value => value.trim().split(/\s+as\s+/i).at(-1) ?? '').filter(Boolean));
  const exact = imports.find(value => terms.some(term => normalizeWord(value) === normalizeWord(term)))
    ?? imports.find(value => classBase && normalizeWord(value) === normalizeWord(classBase));
  if (exact) return exact;
  if (imports.length === 1) return imports[0];
  return terms[0] ? pascalCase(terms[0]) : classBase ? pascalCase(classBase) : undefined;
}

function resolveTypeScriptServiceClass(content?: string): string | undefined {
  return content?.match(/\bexport\s+class\s+([A-Za-z_$][\w$]*Service)\b/)?.[1]
    ?? content?.match(/\bclass\s+([A-Za-z_$][\w$]*Service)\b/)?.[1];
}

function findMatchingParenthesis(content: string, openIndex: number): number {
  if (openIndex < 0 || content[openIndex] !== '(') return -1;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  let quote: 'single' | 'double' | 'template' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (lineComment) { if (char === '\n') lineComment = false; continue; }
    if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"') || (quote === 'template' && char === '`')) quote = undefined;
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'") { quote = 'single'; continue; }
    if (char === '"') { quote = 'double'; continue; }
    if (char === '`') { quote = 'template'; continue; }
    if (char === '{') depth += 1;
    if (char === '}') { depth -= 1; if (depth === 0) return index; }
  }
  return -1;
}

function splitTopLevel(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let angle = 0;
  let paren = 0;
  for (const char of value) {
    if (char === '<') angle += 1;
    if (char === '>') angle = Math.max(0, angle - 1);
    if (char === '(') paren += 1;
    if (char === ')') paren = Math.max(0, paren - 1);
    if (char === ',' && angle === 0 && paren === 0) { result.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function normalizePriority(priority: string[]): string[] {
  const result: string[] = [];
  for (const value of priority) {
    const filePath = value.split('#')[0]?.replace(/\\/g, '/');
    if (!filePath) continue;
    try { result.push(normalizeRelativePath(filePath)); } catch { /* ignore */ }
  }
  return result;
}

function mergePriority(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function mergeTerms(left: string[], right: string[]): string[] {
  const result: string[] = [];
  for (const value of [...left, ...right]) {
    const normalized = normalizeWord(value);
    if (!normalized || result.some(existing => normalizeWord(existing) === normalized)) continue;
    result.push(value);
  }
  return result;
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();
}

function normalizeWord(value: string): string {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_$]+/g, '').toLowerCase();
}

function pascalCase(value: string): string {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
