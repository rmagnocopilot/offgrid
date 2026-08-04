import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import { interpretLayeredTask } from './LayeredTaskIntent';

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ExistingBackendEndpoint {
  filePath: string;
  methodName: string;
  verb: HttpVerb;
  framework: 'jax-rs' | 'spring';
}

export interface BackendEndpointAnalysis {
  targetTerms: string[];
  requestedVerb?: HttpVerb;
  priority: string[];
  resourceFile?: string;
  framework?: 'jax-rs' | 'spring';
  existingEndpoint?: ExistingBackendEndpoint;
}

export interface BackendEndpointAnalysisOptions {
  request: string;
  workspaceRoot?: string;
  priority?: string[];
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface JavaCandidate {
  filePath: string;
  fileName: string;
  content: string;
  kind: 'resource' | 'service' | 'model' | 'application' | 'other';
  framework?: 'jax-rs' | 'spring';
  score: number;
}

interface AnnotatedMethod {
  methodName: string;
  parameters: string;
  annotations: string;
  bodyPreview: string;
  verb?: HttpVerb;
  framework?: 'jax-rs' | 'spring';
}

const ENDPOINT_INTENT = /\b(?:endpoint|end-point|rota|route|api\s+rest|recurso\s+rest|resource|controller|controlador|@(?:GET|POST|PUT|PATCH|DELETE)|(?:GET|POST|PUT|PATCH|DELETE)\s+\/)/i;
const JAVA_BACKEND_HINT = /\b(?:java|jakarta|jax-?rs|spring|spring\s*boot|backend|back-end)\b/i;
const ACTION_VERBS = /\b(?:cadastrar|registrar|criar|salvar|incluir|adicionar|listar|consultar|buscar|obter|carregar|atualizar|alterar|editar|excluir|remover|deletar|apagar|create|save|register|add|list|get|find|fetch|update|edit|delete|remove)\b/i;

const IGNORED_DIRECTORIES = new Set([
  '.git', '.idea', '.vscode', 'node_modules', 'target', 'build', 'dist', 'out', 'coverage', '.gradle'
]);

const STOP_WORDS = new Set([
  'a', 'ao', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'existente', 'java',
  'no', 'na', 'nos', 'nas', 'novo', 'nova', 'o', 'os', 'para', 'pelo', 'pela', 'projeto', 'seguindo',
  'um', 'uma', 'backend', 'back-end', 'endpoint', 'rota', 'api', 'rest', 'resource', 'controller',
  'controlador', 'metodo', 'método', 'http', 'jax-rs', 'jakarta', 'spring', 'crie', 'criar', 'cadastre'
]);

export function isBackendEndpointIntent(request: string): boolean {
  const normalized = normalizeText(request);
  if (!normalized) return false;
  const task = interpretLayeredTask(request);
  if (task.ambiguous) return false;
  if (task.targetLayer !== 'unknown') return task.targetLayer === 'endpoint';
  return ENDPOINT_INTENT.test(normalized)
    || (JAVA_BACKEND_HINT.test(normalized) && ACTION_VERBS.test(normalized) && /\b(?:rest|http)\b/i.test(normalized));
}

export function requestedHttpVerb(request: string): HttpVerb | undefined {
  const normalized = normalizeText(request);
  const explicit = normalized.match(/(?:^|\s|@)(GET|POST|PUT|PATCH|DELETE)(?=\s|\/|$)/i)?.[1]?.toUpperCase();
  if (explicit === 'GET' || explicit === 'POST' || explicit === 'PUT' || explicit === 'PATCH' || explicit === 'DELETE') {
    return explicit;
  }
  if (/\b(?:cadastrar|registrar|criar|salvar|incluir|adicionar|create|save|register|add)\b/i.test(normalized)) return 'POST';
  if (/\b(?:listar|consultar|buscar|obter|carregar|list|get|find|fetch)\b/i.test(normalized)) return 'GET';
  if (/\b(?:atualizar|alterar|editar|update|edit)\b/i.test(normalized)) return 'PUT';
  if (/\b(?:excluir|remover|deletar|apagar|delete|remove)\b/i.test(normalized)) return 'DELETE';
  return undefined;
}

export function endpointTaskGuidance(request: string): string | undefined {
  if (!isBackendEndpointIntent(request)) return undefined;
  return [
    'Tarefa de endpoint Java: procure primeiro em **/src/main/java/** por classes Resource, Controller ou equivalentes.',
    'Endpoint é um método exposto por anotação HTTP/rota; alterar apenas Service ou Repository não cria endpoint.',
    'Detecte o framework já usado (JAX-RS/Jakarta ou Spring), siga o padrão existente e não crie rota duplicada.',
    'Se um endpoint equivalente já existir, informe isso sem modificar arquivos.'
  ].join(' ');
}

export async function analyzeBackendEndpointIntent(
  options: BackendEndpointAnalysisOptions
): Promise<BackendEndpointAnalysis | undefined> {
  if (!isBackendEndpointIntent(options.request) || !options.workspaceRoot) return undefined;

  const targetTerms = extractTargetTerms(options.request);
  const requestedVerb = requestedHttpVerb(options.request);
  let candidates: JavaCandidate[];
  try {
    candidates = await discoverJavaCandidates(options.workspaceRoot, targetTerms);
  } catch (error) {
    options.warn?.(`[BackendEndpointPolicy] Falha ao analisar backend Java: ${error instanceof Error ? error.message : String(error)}`);
    return {
      targetTerms,
      requestedVerb,
      priority: options.priority ?? []
    };
  }

  const discoveredPriority = candidates
    .filter(candidate => candidate.kind !== 'other')
    .slice(0, 10)
    .map(candidate => candidate.filePath);
  const priority = mergePriority(discoveredPriority, options.priority ?? []);
  const primaryResource = candidates.find(candidate => candidate.kind === 'resource');
  const existingEndpoint = requestedVerb
    ? detectExistingEndpoint(candidates, targetTerms, requestedVerb)
    : undefined;

  options.info?.(
    [
      '[BackendEndpointPolicy] Intenção de endpoint Java detectada.',
      `verbo=${requestedVerb ?? 'não definido'}`,
      `alvo=${targetTerms.join(',') || 'não definido'}`,
      `arquivos=${discoveredPriority.slice(0, 6).join(',') || 'nenhum'}`
    ].join(' ')
  );

  if (existingEndpoint) {
    options.info?.(
      `[BackendEndpointPolicy] Endpoint equivalente já existe; modelo não será chamado. arquivo=${existingEndpoint.filePath} método=${existingEndpoint.methodName} verbo=${existingEndpoint.verb}`
    );
  }

  return {
    targetTerms,
    requestedVerb,
    priority,
    resourceFile: primaryResource?.filePath,
    framework: primaryResource?.framework,
    existingEndpoint
  };
}

export function existingEndpointResponse(endpoint: ExistingBackendEndpoint): string {
  return [
    'Nenhuma alteração foi necessária.',
    'Um endpoint equivalente já existe no backend.',
    `Arquivo: ${endpoint.filePath}`,
    `Operação HTTP: ${endpoint.verb}`,
    `Método existente: ${endpoint.methodName}`
  ].join('\n\n');
}

function extractTargetTerms(request: string): string[] {
  const normalized = normalizeText(request);
  const direct = normalized.match(
    /\b(?:cadastrar|registrar|criar|salvar|incluir|adicionar|listar|consultar|buscar|obter|carregar|atualizar|alterar|editar|excluir|remover|deletar|apagar|create|save|register|add|list|get|find|fetch|update|edit|delete|remove)\s+(?:um|uma|o|a|os|as|novo|nova|novos|novas)?\s*([\p{L}_$][\p{L}\p{N}_$-]*)/iu
  )?.[1];

  const terms: string[] = [];
  const add = (value: string | undefined): void => {
    if (!value) return;
    const normalizedValue = singularize(normalizeIdentifier(value));
    if (!normalizedValue || normalizedValue.length < 3 || STOP_WORDS.has(normalizedValue)) return;
    if (!terms.includes(normalizedValue)) terms.push(normalizedValue);
  };
  add(direct);

  for (const token of normalized.match(/[\p{L}_$][\p{L}\p{N}_$-]*/gu) ?? []) {
    const normalizedToken = singularize(normalizeIdentifier(token));
    if (STOP_WORDS.has(normalizedToken) || normalizedToken.length < 4) continue;
    if (/^(?:cadastrar|registrar|criar|salvar|incluir|adicionar|listar|consultar|buscar|obter|carregar|atualizar|alterar|editar|excluir|remover|deletar|apagar|create|save|register|list|find|fetch|update|edit|delete|remove)$/.test(normalizedToken)) continue;
    if (/[A-Z]/.test(token.charAt(0)) || token === direct) add(token);
  }

  return terms.slice(0, 3);
}

async function discoverJavaCandidates(root: string, targetTerms: string[]): Promise<JavaCandidate[]> {
  const files = listJavaSourceFiles(root);
  const candidates: JavaCandidate[] = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = await fsp.readFile(resolveInsideRoot(root, filePath), 'utf8');
    } catch {
      continue;
    }
    const fileName = path.posix.basename(filePath, '.java');
    const framework = detectFramework(content);
    const kind = classifyJavaFile(fileName, content);
    const score = scoreCandidate(filePath, fileName, content, kind, targetTerms);
    candidates.push({ filePath, fileName, content, kind, framework, score });
  }

  return candidates.sort((left, right) => right.score - left.score || left.filePath.length - right.filePath.length || left.filePath.localeCompare(right.filePath));
}

function listJavaSourceFiles(root: string): string[] {
  const stack = [root];
  const files: string[] = [];
  let visited = 0;

  while (stack.length && visited < 40_000 && files.length < 4_000) {
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
      if (visited >= 40_000) break;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.java')) continue;
      const relative = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/');
      if (!/(?:^|\/)src\/main\/java\//i.test(relative)) continue;
      try {
        files.push(normalizeRelativePath(relative));
      } catch { /* caminho inválido */ }
    }
  }

  return files;
}

function classifyJavaFile(fileName: string, content: string): JavaCandidate['kind'] {
  if (/(?:Resource|Controller|Endpoint|Rest|Api)$/i.test(fileName) || /@(Path|RestController|Controller)\b/.test(content)) return 'resource';
  if (/Service$/i.test(fileName) || /@(Service|Stateless)\b/.test(content)) return 'service';
  if (/(?:Application|Configuration|Config)$/i.test(fileName) || /@(ApplicationPath|SpringBootApplication)\b/.test(content)) return 'application';
  if (/(?:Entity|Model|Dto|DTO)$/i.test(fileName) || /@(Entity|Embeddable)\b/.test(content) || /\b(?:class|record)\s+\w+/.test(content)) return 'model';
  return 'other';
}

function detectFramework(content: string): JavaCandidate['framework'] {
  if (/\bjakarta\.ws\.rs\.|\bjavax\.ws\.rs\.|@(Path|GET|POST|PUT|PATCH|DELETE)\b/.test(content)) return 'jax-rs';
  if (/\borg\.springframework\.web\.bind\.annotation\.|@(RestController|RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/.test(content)) return 'spring';
  return undefined;
}

function scoreCandidate(
  filePath: string,
  fileName: string,
  content: string,
  kind: JavaCandidate['kind'],
  targetTerms: string[]
): number {
  const searchableName = normalizeIdentifier(fileName);
  const searchablePath = normalizeIdentifier(filePath);
  const searchableContent = normalizeIdentifier(content.slice(0, 8_000));
  const targetMatches = targetTerms.reduce((score, term) => {
    if (searchableName.includes(term)) return score + 520;
    if (searchablePath.includes(term)) return score + 280;
    if (searchableContent.includes(term)) return score + 100;
    return score;
  }, 0);

  const kindScore = kind === 'resource' ? 650
    : kind === 'service' ? 430
      : kind === 'model' ? 300
        : kind === 'application' ? 120
          : 0;
  const sourceScore = /(?:^|\/)src\/main\/java\//i.test(filePath) ? 50 : 0;
  return targetMatches + kindScore + sourceScore;
}

function detectExistingEndpoint(
  candidates: JavaCandidate[],
  targetTerms: string[],
  requestedVerb: HttpVerb
): ExistingBackendEndpoint | undefined {
  const resources = candidates.filter(candidate => candidate.kind === 'resource');

  for (const candidate of resources) {
    const methods = findAnnotatedMethods(candidate.content);
    for (const method of methods) {
      if (method.verb !== requestedVerb || !method.framework) continue;
      if (!endpointMatchesTarget(candidate, method, targetTerms)) continue;
      return {
        filePath: candidate.filePath,
        methodName: method.methodName,
        verb: requestedVerb,
        framework: method.framework
      };
    }
  }

  return undefined;
}

function findAnnotatedMethods(content: string): AnnotatedMethod[] {
  const methods: AnnotatedMethod[] = [];
  const pattern = /((?:^[ \t]*@[\w.]+(?:\([^\r\n]*\))?[ \t]*\r?\n)+)[ \t]*(?:public|protected|private)?[ \t]*(?:static[ \t]+)?(?:final[ \t]+)?[\w<>?,.\[\] \t]+?[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(([^)]*)\)[ \t]*(?:throws[^{]+)?\{/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const annotations = match[1] ?? '';
    const methodName = match[2] ?? '';
    const parameters = match[3] ?? '';
    const bodyPreview = content.slice(pattern.lastIndex, Math.min(content.length, pattern.lastIndex + 800));
    const endpoint = endpointAnnotation(annotations);
    methods.push({
      methodName,
      parameters,
      annotations,
      bodyPreview,
      verb: endpoint?.verb,
      framework: endpoint?.framework
    });
  }

  return methods;
}

function endpointAnnotation(annotations: string): { verb: HttpVerb; framework: 'jax-rs' | 'spring' } | undefined {
  const jax = annotations.match(/@(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toUpperCase();
  if (jax === 'GET' || jax === 'POST' || jax === 'PUT' || jax === 'PATCH' || jax === 'DELETE') {
    return { verb: jax, framework: 'jax-rs' };
  }

  const spring = annotations.match(/@(Get|Post|Put|Patch|Delete)Mapping\b/i)?.[1]?.toUpperCase();
  if (spring === 'GET' || spring === 'POST' || spring === 'PUT' || spring === 'PATCH' || spring === 'DELETE') {
    return { verb: spring, framework: 'spring' };
  }

  const requestMethod = annotations.match(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toUpperCase();
  if (requestMethod === 'GET' || requestMethod === 'POST' || requestMethod === 'PUT' || requestMethod === 'PATCH' || requestMethod === 'DELETE') {
    return { verb: requestMethod, framework: 'spring' };
  }
  return undefined;
}

function endpointMatchesTarget(candidate: JavaCandidate, method: AnnotatedMethod, targetTerms: string[]): boolean {
  if (!targetTerms.length) return false;
  const searchable = normalizeIdentifier([
    candidate.fileName,
    candidate.filePath,
    method.methodName,
    method.parameters,
    method.annotations,
    method.bodyPreview
  ].join(' '));
  return targetTerms.some(term => searchable.includes(term));
}

function mergePriority(discovered: string[], original: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of [...discovered, ...original]) {
    const withoutSelection = value.split('#')[0]?.replace(/\\/g, '/');
    if (!withoutSelection) continue;
    const key = withoutSelection.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(withoutSelection);
  }
  return result;
}

function singularize(value: string): string {
  if (value.length > 5 && value.endsWith('oes')) return `${value.slice(0, -3)}ao`;
  if (value.length > 4 && value.endsWith('ães')) return `${value.slice(0, -3)}ao`;
  if (value.length > 4 && value.endsWith('es')) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith('s')) return value.slice(0, -1);
  return value;
}

function normalizeIdentifier(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_$-]+/g, ' ')
    .toLowerCase();
}

function normalizeText(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
