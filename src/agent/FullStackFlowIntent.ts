import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import { interpretLayeredTask } from './LayeredTaskIntent';

export type FullStackListFramework = 'jax-rs' | 'spring';

export interface FullStackModelField {
  name: string;
  type: string;
  javaType?: string;
  optional: boolean;
}

export interface FullStackFlowAnalysis {
  priority: string[];
  operation: 'list';
  entityTerm: string;
  entityType: string;
  entityKebab: string;
  pluralRoute: string;
  angularRoot?: string;
  componentFile?: string;
  componentTemplateFile?: string;
  componentStyleFile?: string;
  frontendServiceFile?: string;
  frontendModelFile?: string;
  backendResourceFile?: string;
  backendServiceFile?: string;
  backendModelFile?: string;
  dataAccessFile?: string;
  referenceBackendModelFile?: string;
  referenceDataAccessFile?: string;
  modelFieldsSource: 'workspace' | 'request' | 'none';
  referenceComponentFile?: string;
  referenceFrontendServiceFile?: string;
  referenceResourceFile?: string;
  referenceBackendServiceFile?: string;
  javaFramework?: FullStackListFramework;
  modelFields: FullStackModelField[];
}

export interface FullStackFlowAnalysisOptions {
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

const FLOW_HINT = /\b(?:full[\s-]?stack|fluxo\s+completo|ponta\s+a\s+ponta|end[\s-]?to[\s-]?end|frontend\s+e\s+backend|front-end\s+e\s+back-end)\b/i;
const FRONTEND_HINT = /\b(?:angular|frontend|front-end|componente|component|html|css|scss|service\.ts)\b/i;
const BACKEND_HINT = /\b(?:backend|back-end|java|endpoint|resource|controller|service\s+java|servi[cç]o\s+java)\b/i;
const LIST_HINT = /(?:^|\s|@)GET(?=\s|\/|$)|\b(?:listar|listagem|consultar|buscar|carregar|list|get|find|fetch)\b/i;
const COMPONENT_BUNDLE_HINT = /\b(?:html|template)\b[\s\S]{0,100}\b(?:css|scss|estilo)\b|\b(?:html|ts|typescript)\b[\s,\/+-]*(?:e|and)?[\s,\/+-]*\b(?:css|scss)\b/i;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.angular', '.idea', '.vscode', '.vscode-test', 'node_modules', 'target', 'build', 'dist', 'out',
  'coverage', '.next', '.nuxt', '.cache', '.gradle', '.offgrid'
]);

export function isFullStackFlowIntent(request: string): boolean {
  const normalized = request.trim();
  if (!normalized) return false;
  const explicitFlow = FLOW_HINT.test(normalized);
  const layered = interpretLayeredTask(normalized);
  const multiLayer = layered.targetLayers.length >= 2
    || (layered.referenceLayers.includes('endpoint') && /\b(?:component|componente|frontend|service\.ts)\b/i.test(normalized));
  return LIST_HINT.test(normalized)
    && FRONTEND_HINT.test(normalized)
    && BACKEND_HINT.test(normalized)
    && (explicitFlow || multiLayer)
    && (COMPONENT_BUNDLE_HINT.test(normalized) || /\b(?:componente|component)\b/i.test(normalized));
}

export function fullStackFlowTaskGuidance(request: string): string | undefined {
  if (!isFullStackFlowIntent(request)) return undefined;
  return [
    'Tarefa full-stack de listagem: trate frontend e backend como um único plano coordenado.',
    'No Angular, reutilize ou crie um componente com arquivos externos TS, HTML e CSS/SCSS e um service.ts HTTP.',
    'No Java, reutilize ou crie Service e Resource/Controller GET seguindo o framework, pacotes e injeção existentes.',
    'Não invente entidade, campos, repository, rota ou persistência: só gere automaticamente quando essas dependências forem comprovadas no workspace.',
    'Não crie arquivos duplicados; prepare todas as alterações relacionadas para uma única revisão.'
  ].join(' ');
}

export async function analyzeFullStackFlowIntent(
  options: FullStackFlowAnalysisOptions
): Promise<FullStackFlowAnalysis | undefined> {
  if (!isFullStackFlowIntent(options.request) || !options.workspaceRoot) return undefined;

  let files: WorkspaceFile[];
  try {
    files = await discoverWorkspaceFiles(options.workspaceRoot);
  } catch (error) {
    options.warn?.(`[FullStackFlowPolicy] Falha ao analisar o workspace: ${messageOf(error)}`);
    return undefined;
  }

  const entityTerm = extractEntityTerm(options.request);
  if (!entityTerm) {
    options.warn?.('[FullStackFlowPolicy] A entidade do fluxo não pôde ser identificada de forma segura.');
    return undefined;
  }

  const normalizedEntity = normalizeWord(singularize(entityTerm));
  const targetModel = selectTargetModel(files, normalizedEntity);
  const entityType = targetModel?.entityType ?? toPascalCase(singularize(entityTerm));
  const entityKebab = toKebabCase(entityType);
  const pluralRoute = pluralize(entityKebab);

  const angularRoot = findAngularRoot(files);
  const frontendModel = selectFrontendModel(files, normalizedEntity, entityType);
  const backendModel = selectBackendModel(files, normalizedEntity, entityType);
  const frontendService = selectExactFile(files, file => isFrontendService(file.filePath, file.content), normalizedEntity, entityType);
  const component = selectExactFile(files, file => isAngularComponent(file.filePath, file.content), normalizedEntity, entityType);
  const backendService = selectExactFile(files, file => isJavaService(file.filePath, file.content), normalizedEntity, entityType);
  const backendResource = selectExactFile(files, file => isJavaResource(file.filePath, file.content), normalizedEntity, entityType);

  const referenceComponent = selectReference(files, file => isAngularExternalComponent(file.filePath, file.content), component?.filePath);
  const referenceFrontendService = selectReference(files, file => isFrontendService(file.filePath, file.content), frontendService?.filePath);
  const referenceResource = selectReference(files, file => isJavaResource(file.filePath, file.content), backendResource?.filePath);
  const referenceBackendService = selectReference(files, file => isJavaService(file.filePath, file.content), backendService?.filePath);
  const referenceBackendModel = selectReference(files, file => isJavaModel(file.filePath, file.content), backendModel?.filePath);
  const dataAccess = selectDataAccess(files, entityType);
  const referenceDataAccess = selectReferenceDataAccess(files, dataAccess?.filePath);

  const styleExtension = detectStyleExtension(referenceComponent?.content) ?? 'css';
  const componentPaths = resolveComponentPaths(
    angularRoot,
    entityKebab,
    component?.filePath,
    referenceComponent?.filePath,
    styleExtension
  );
  const frontendServicePath = frontendService?.filePath
    ?? resolveSiblingTarget(referenceFrontendService?.filePath, `${entityKebab}.service.ts`)
    ?? (angularRoot ? `${angularRoot}/src/app/services/${entityKebab}.service.ts` : undefined);
  const frontendModelPath = frontendModel?.filePath
    ?? resolveSiblingTarget(selectReference(files, file => isFrontendModel(file.filePath, file.content))?.filePath, `${entityKebab}.model.ts`)
    ?? (angularRoot ? `${angularRoot}/src/app/models/${entityKebab}.model.ts` : undefined);
  const resourceSuffix = referenceResource ? javaResourceSuffix(referenceResource.filePath) : 'Resource';
  const backendResourcePath = backendResource?.filePath
    ?? resolveSiblingTarget(referenceResource?.filePath, `${entityType}${resourceSuffix}.java`);
  const backendServicePath = backendService?.filePath
    ?? resolveSiblingTarget(referenceBackendService?.filePath, `${entityType}Service.java`);
  const backendModelPath = backendModel?.filePath
    ?? resolveSiblingTarget(referenceBackendModel?.filePath, `${entityType}.java`);
  const dataAccessPath = dataAccess?.filePath
    ?? resolveDataAccessTarget(referenceDataAccess, entityType);
  const javaFramework = detectJavaFramework(backendResource?.content ?? referenceResource?.content ?? '');
  const workspaceFields = parseModelFields(frontendModel?.content, backendModel?.content);
  const requestFields = parseRequestModelFields(options.request);
  const modelFields = workspaceFields.length ? workspaceFields : requestFields;
  const modelFieldsSource: FullStackFlowAnalysis['modelFieldsSource'] = workspaceFields.length
    ? 'workspace'
    : requestFields.length ? 'request' : 'none';

  const priority = mergePriority([
    componentPaths.componentFile,
    frontendServicePath,
    frontendModelPath,
    backendResourcePath,
    backendServicePath,
    backendModelPath,
    dataAccessPath,
    referenceComponent?.filePath,
    referenceFrontendService?.filePath,
    referenceResource?.filePath,
    referenceBackendService?.filePath,
    ...(options.priority ?? [])
  ].filter((value): value is string => Boolean(value)));

  const analysis: FullStackFlowAnalysis = {
    priority,
    operation: 'list',
    entityTerm: singularize(entityTerm),
    entityType,
    entityKebab,
    pluralRoute,
    angularRoot,
    componentFile: componentPaths.componentFile,
    componentTemplateFile: componentPaths.templateFile,
    componentStyleFile: componentPaths.styleFile,
    frontendServiceFile: frontendServicePath,
    frontendModelFile: frontendModelPath,
    backendResourceFile: backendResourcePath,
    backendServiceFile: backendServicePath,
    backendModelFile: backendModelPath,
    dataAccessFile: dataAccessPath,
    referenceBackendModelFile: referenceBackendModel?.filePath,
    referenceDataAccessFile: referenceDataAccess?.filePath,
    modelFieldsSource,
    referenceComponentFile: referenceComponent?.filePath,
    referenceFrontendServiceFile: referenceFrontendService?.filePath,
    referenceResourceFile: referenceResource?.filePath,
    referenceBackendServiceFile: referenceBackendService?.filePath,
    javaFramework,
    modelFields
  };

  options.info?.(
    [
      '[FullStackFlowPolicy] Fluxo full-stack de listagem detectado.',
      `entidade=${analysis.entityType}`,
      `componente=${analysis.componentFile ?? 'não resolvido'}`,
      `frontendService=${analysis.frontendServiceFile ?? 'não resolvido'}`,
      `resource=${analysis.backendResourceFile ?? 'não resolvido'}`,
      `backendService=${analysis.backendServiceFile ?? 'não resolvido'}`,
      `framework=${analysis.javaFramework ?? 'não detectado'}`
    ].join(' ')
  );
  return analysis;
}

async function discoverWorkspaceFiles(root: string): Promise<WorkspaceFile[]> {
  const stack = [root];
  const result: WorkspaceFile[] = [];
  let visited = 0;
  while (stack.length && visited < 60_000 && result.length < 8_000) {
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
      if (!entry.isFile() || !/\.(?:ts|java|json)$/i.test(entry.name)) continue;
      const relative = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/');
      if (!/(?:^|\/)src\//i.test(relative) && entry.name !== 'package.json' && entry.name !== 'angular.json') continue;
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

function extractEntityTerm(request: string): string | undefined {
  const candidates = [
    request.match(/\bentidade\s+([\p{L}_$][\p{L}\p{N}_$-]*)/iu)?.[1],
    request.match(/\b(?:listar|listagem\s+de|consultar|buscar|carregar|list|fetch)\s+(?:(?:o|a|os|as|um|uma|de)\s+)?([\p{L}_$][\p{L}\p{N}_$-]*)/iu)?.[1],
    request.match(/\b(?:fluxo|componente|component)\s+(?:completo\s+)?(?:de|do|da|para)?\s*([\p{L}_$][\p{L}\p{N}_$-]*)/iu)?.[1],
    interpretLayeredTask(request).entityTerms[0]
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = normalizeWord(candidate);
    if (!normalized || /^(?:fluxo|completo|componente|component|endpoint|service|java|angular|html|css|scss|frontend|backend|atual|atuais|existente|existentes|using|com|with)$/.test(normalized)) continue;
    return candidate;
  }
  return undefined;
}

function selectTargetModel(files: WorkspaceFile[], normalizedEntity: string): { entityType: string } | undefined {
  const models = files.flatMap(file => {
    if (!isFrontendModel(file.filePath, file.content) && !isJavaModel(file.filePath, file.content)) return [];
    const entityType = declaredType(file.content, file.filePath);
    return entityType ? [{ entityType, score: scoreEntityFile(file, normalizedEntity, entityType) }] : [];
  }).filter(candidate => candidate.score > 0).sort((left, right) => right.score - left.score);
  const best = models[0];
  if (!best || models.filter(candidate => candidate.score === best.score).length !== 1) return undefined;
  return { entityType: best.entityType };
}

function selectFrontendModel(files: WorkspaceFile[], normalizedEntity: string, entityType: string): WorkspaceFile | undefined {
  return uniqueBest(files.filter(file => isFrontendModel(file.filePath, file.content)), file => scoreEntityFile(file, normalizedEntity, entityType));
}

function selectBackendModel(files: WorkspaceFile[], normalizedEntity: string, entityType: string): WorkspaceFile | undefined {
  return uniqueBest(files.filter(file => isJavaModel(file.filePath, file.content)), file => scoreEntityFile(file, normalizedEntity, entityType));
}

function selectExactFile(
  files: WorkspaceFile[],
  predicate: (file: WorkspaceFile) => boolean,
  normalizedEntity: string,
  entityType: string
): WorkspaceFile | undefined {
  return uniqueBest(files.filter(predicate), file => scoreEntityFile(file, normalizedEntity, entityType));
}

function selectReference(
  files: WorkspaceFile[],
  predicate: (file: WorkspaceFile) => boolean,
  excluded?: string
): WorkspaceFile | undefined {
  const candidates = files.filter(file => predicate(file) && (!excluded || !samePath(file.filePath, excluded)));
  return candidates.sort((left, right) => left.filePath.length - right.filePath.length || left.filePath.localeCompare(right.filePath))[0];
}

function selectDataAccess(files: WorkspaceFile[], entityType: string): WorkspaceFile | undefined {
  const candidates = files.filter(file => {
    if (!file.filePath.toLowerCase().endsWith('.java')) return false;
    if (!/(?:Repository|Dao|Database|Store)\.java$/i.test(file.filePath) && !/@Repository\b/.test(file.content)) return false;
    return new RegExp(`\\b${escapeRegex(entityType)}\\b`).test(file.content)
      && (new RegExp(`(?:List|Collection|Iterable)<\\s*${escapeRegex(entityType)}\\s*>`).test(file.content)
        || new RegExp(`JpaRepository<\\s*${escapeRegex(entityType)}\\s*,`).test(file.content));
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

function findAngularRoot(files: WorkspaceFile[]): string | undefined {
  const packageFile = files.find(file => path.posix.basename(file.filePath) === 'package.json' && /"@angular\/core"\s*:/.test(file.content));
  return packageFile ? path.posix.dirname(packageFile.filePath) : undefined;
}

function resolveComponentPaths(
  angularRoot: string | undefined,
  entityKebab: string,
  existingComponent: string | undefined,
  referenceComponent: string | undefined,
  styleExtension: string
): { componentFile?: string; templateFile?: string; styleFile?: string } {
  if (existingComponent) {
    const contentBase = existingComponent.replace(/\.component\.ts$/i, '.component');
    return {
      componentFile: existingComponent,
      templateFile: `${contentBase}.html`,
      styleFile: `${contentBase}.${styleExtension}`
    };
  }
  const componentBase = referenceComponent
    ? componentCollectionDirectory(referenceComponent)
    : angularRoot ? `${angularRoot}/src/app/components` : undefined;
  if (!componentBase) return {};
  const directory = `${componentBase}/${entityKebab}`;
  const base = `${directory}/${entityKebab}-list.component`;
  return { componentFile: `${base}.ts`, templateFile: `${base}.html`, styleFile: `${base}.${styleExtension}` };
}

function componentCollectionDirectory(reference: string): string {
  const normalized = reference.replace(/\\/g, '/');
  const marker = normalized.toLowerCase().lastIndexOf('/components/');
  if (marker >= 0) return normalized.slice(0, marker + '/components'.length);
  return path.posix.dirname(path.posix.dirname(normalized));
}

function resolveSiblingTarget(reference: string | undefined, fileName: string): string | undefined {
  if (!reference) return undefined;
  try { return normalizeRelativePath(path.posix.join(path.posix.dirname(reference), fileName)); } catch { return undefined; }
}

function parseModelFields(frontendModel: string | undefined, backendModel: string | undefined): FullStackModelField[] {
  const tsFields = frontendModel ? parseTypeScriptFields(frontendModel) : [];
  if (tsFields.length) return tsFields;
  return backendModel ? parseJavaFields(backendModel) : [];
}

function parseRequestModelFields(request: string): FullStackModelField[] {
  const section = request.match(/\b(?:campos|fields)(?:\s+(?:da|do|de|for)\s+[\p{L}\p{N}_$-]+)?\s*:\s*([\s\S]+)/iu)?.[1];
  if (!section) return [];

  // Aceita tanto listas em linhas separadas quanto campos colados em uma única linha:
  // "Campos de Pedido: - customerId: Long - createdAt: LocalDate".
  // Apenas marcadores seguidos de um identificador e dois-pontos viram quebras de linha,
  // evitando tratar hífens comuns do texto como separadores de campos.
  const normalizedSection = section
    .replace(/\r\n/g, '\n')
    .replace(/(?:\n|[ \t]+)(?=[-*•]\s*[A-Za-z_$][\w$]*\??\s*:)/g, '\n')
    .trim();
  const fields = [...normalizedSection.matchAll(/^\s*[-*•]\s*([A-Za-z_$][\w$]*)(\?)?\s*:\s*([A-Za-z_$][\w$<>,.? ]*)\s*$/gm)];
  const result: FullStackModelField[] = [];
  const names = new Set<string>();
  for (const match of fields) {
    const name = match[1]!;
    if (names.has(name)) continue;
    const javaType = normalizeRequestedJavaType(match[3]!.trim());
    if (!javaType) continue;
    const type = javaTypeToTypeScript(javaType);
    if (!type) continue;
    names.add(name);
    result.push({ name, optional: Boolean(match[2]), type, javaType });
  }
  return result.slice(0, 16);
}

function normalizeRequestedJavaType(type: string): string | undefined {
  const compact = type.replace(/\s+/g, '');
  const allowed = /^(?:String|Character|char|UUID|LocalDate|LocalDateTime|OffsetDateTime|Instant|Date|Long|Integer|Short|Byte|Double|Float|BigDecimal|BigInteger|long|int|short|byte|double|float|Boolean|boolean)$/;
  return allowed.test(compact) ? compact : undefined;
}

function parseTypeScriptFields(content: string): FullStackModelField[] {
  const body = content.match(/(?:interface|class)\s+\w+(?:\s+extends\s+[^\{]+)?\s*\{([\s\S]*?)\}/m)?.[1];
  if (!body) return [];
  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?\s*:\s*([^;\r\n]+)[;]?/gm)]
    .map(match => ({ name: match[1]!, optional: Boolean(match[2]), type: match[3]!.trim() }))
    .filter(field => !/[\[\]\{\}<>]/.test(field.type) || /^(?:string|number|boolean)(?:\s*\|\s*(?:null|undefined))*$/i.test(field.type))
    .slice(0, 8);
}

function parseJavaFields(content: string): FullStackModelField[] {
  const fields = [...content.matchAll(/(?:^|[;{}])\s*private\s+(?:final\s+)?([A-Za-z_$][\w$<>?, .]*)\s+([A-Za-z_$][\w$]*)\s*;/gm)];
  return fields
    .map(match => ({ name: match[2]!, optional: match[2] === 'id', type: javaTypeToTypeScript(match[1]!.trim()), javaType: match[1]!.trim() }))
    .filter(field => Boolean(field.type))
    .slice(0, 8);
}

function javaTypeToTypeScript(type: string): string {
  const simple = type.replace(/^java\.[\w.]+\./, '').replace(/\s+/g, '');
  if (/^(?:String|Character|char|UUID|LocalDate|LocalDateTime|OffsetDateTime|Instant|Date)$/.test(simple)) return 'string';
  if (/^(?:Long|Integer|Short|Byte|Double|Float|BigDecimal|BigInteger|long|int|short|byte|double|float)$/.test(simple)) return 'number';
  if (/^(?:Boolean|boolean)$/.test(simple)) return 'boolean';
  return '';
}

function scoreEntityFile(file: WorkspaceFile, normalizedEntity: string, entityType: string): number {
  const base = path.posix.basename(file.filePath).replace(/\.(?:component|service|model)?\.(?:ts|java)$/i, '').replace(/(?:Resource|Controller|Service|Repository)$/i, '');
  const declared = declaredType(file.content, file.filePath);
  let score = 0;
  if (normalizeWord(base).includes(normalizedEntity)) score += 220;
  if (declared && normalizeWord(declared) === normalizeWord(entityType)) score += 300;
  if (new RegExp(`\\b${escapeRegex(entityType)}\\b`).test(file.content)) score += 50;
  return score;
}

function uniqueBest(files: WorkspaceFile[], score: (file: WorkspaceFile) => number): WorkspaceFile | undefined {
  const ranked = files.map(file => ({ file, score: score(file) })).filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.file.filePath.localeCompare(right.file.filePath));
  const best = ranked[0];
  if (!best || ranked.filter(item => item.score === best.score).length !== 1) return undefined;
  return best.file;
}

function declaredType(content: string, filePath: string): string | undefined {
  if (filePath.toLowerCase().endsWith('.java')) return content.match(/\b(?:public\s+)?(?:class|record|interface)\s+([A-Za-z_$][\w$]*)/)?.[1];
  return content.match(/\b(?:export\s+)?(?:interface|class|type)\s+([A-Za-z_$][\w$]*)/)?.[1];
}

function isAngularComponent(filePath: string, content: string): boolean {
  return /\.component\.ts$/i.test(filePath) || /@Component\s*\(/.test(content);
}

function isAngularExternalComponent(filePath: string, content: string): boolean {
  return isAngularComponent(filePath, content) && /\btemplateUrl\s*:/.test(content);
}

function isFrontendService(filePath: string, content: string): boolean {
  return /\.service\.ts$/i.test(filePath) && /\bHttpClient\b/.test(content);
}

function isFrontendModel(filePath: string, content: string): boolean {
  return /\.model\.ts$/i.test(filePath) || (/\.ts$/i.test(filePath) && /\bexport\s+(?:interface|class|type)\b/.test(content) && !/@Component|@Injectable/.test(content));
}

function isJavaResource(filePath: string, content: string): boolean {
  return /(?:Resource|Controller|Endpoint|Rest|Api)\.java$/i.test(filePath) || /@(Path|RestController|Controller)\b/.test(content);
}

function isJavaService(filePath: string, content: string): boolean {
  return /Service\.java$/i.test(filePath) || /@(Service|Stateless|ApplicationScoped)\b/.test(content);
}

function isJavaDataAccess(filePath: string, content: string): boolean {
  return /(?:Repository|Dao|Database|Store)\.java$/i.test(filePath)
    || /@Repository\b/.test(content)
    || /(?:JpaRepository|CrudRepository)\s*</.test(content);
}

function isJavaModel(filePath: string, content: string): boolean {
  return /\.java$/i.test(filePath) && !isJavaResource(filePath, content) && !isJavaService(filePath, content)
    && !isJavaDataAccess(filePath, content)
    && /\b(?:class|record)\s+[A-Za-z_$][\w$]*/.test(content);
}

function selectReferenceDataAccess(files: WorkspaceFile[], excluded?: string): WorkspaceFile | undefined {
  const candidates = files.filter(file => isJavaDataAccess(file.filePath, file.content) && (!excluded || !samePath(file.filePath, excluded)));
  return candidates.sort((left, right) => dataAccessReferenceScore(right) - dataAccessReferenceScore(left)
    || left.filePath.length - right.filePath.length
    || left.filePath.localeCompare(right.filePath))[0];
}

function dataAccessReferenceScore(file: WorkspaceFile): number {
  const base = path.posix.basename(file.filePath);
  if (/(?:Database|Store)\.java$/i.test(base) && /\bList\s*</.test(file.content)) return 300;
  if (/(?:Repository)\.java$/i.test(base) || /(?:JpaRepository|CrudRepository)\s*</.test(file.content)) return 220;
  if (/(?:Dao)\.java$/i.test(base)) return 180;
  return 0;
}

function resolveDataAccessTarget(reference: WorkspaceFile | undefined, entityType: string): string | undefined {
  if (!reference) return undefined;
  const base = path.posix.basename(reference.filePath, '.java');
  if (/(?:Database|Store)$/i.test(base) && /\bList\s*</.test(reference.content)) return reference.filePath;
  const suffix = base.match(/(Repository|Dao)$/i)?.[1];
  return suffix ? resolveSiblingTarget(reference.filePath, `${entityType}${suffix}.java`) : undefined;
}

function detectJavaFramework(content: string): FullStackListFramework | undefined {
  if (/\b(?:jakarta|javax)\.ws\.rs\.|@(Path|GET|POST|PUT|PATCH|DELETE)\b/.test(content)) return 'jax-rs';
  if (/\borg\.springframework\.web\.bind\.annotation\.|@(RestController|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping)\b/.test(content)) return 'spring';
  return undefined;
}

function detectStyleExtension(componentContent: string | undefined): string | undefined {
  return componentContent?.match(/\bstyleUrls?\s*:\s*\[[^\]]*['"][^'"]+\.(css|scss|sass|less)['"]/m)?.[1]
    ?? componentContent?.match(/\bstyleUrl\s*:\s*['"][^'"]+\.(css|scss|sass|less)['"]/m)?.[1];
}

function javaResourceSuffix(filePath: string): string {
  const base = path.posix.basename(filePath, '.java');
  return base.match(/(Resource|Controller|Endpoint|Rest|Api)$/i)?.[1] ?? 'Resource';
}

function mergePriority(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const clean = value.split('#')[0];
    if (!clean) continue;
    try {
      const normalized = normalizeRelativePath(clean);
      if (!result.some(existing => samePath(existing, normalized))) result.push(normalized);
    } catch { /* ignora referência inválida */ }
  }
  return result;
}

function singularize(value: string): string {
  const word = value.trim();
  if (/ies$/i.test(word) && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(?:sses|shes|ches|xes|zes)$/i.test(word)) return word.slice(0, -2);
  if (/s$/i.test(word) && !/(?:ss|us)$/i.test(word) && word.length > 3) return word.slice(0, -1);
  return word;
}

function pluralize(value: string): string {
  if (/y$/i.test(value) && !/[aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
  return `${value}s`;
}

function toPascalCase(value: string): string {
  return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('');
}

function toKebabCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function normalizeWord(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_$]+/g, '');
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
