import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';
import type { BackendEndpointAnalysis, HttpVerb } from './BackendEndpointIntent';

export interface BackendEndpointFastPathResult {
  text: string;
  call: ToolCall;
  result: ToolResult;
}

export interface BackendEndpointFastPathOptions {
  request: string;
  workspaceRoot?: string;
  analysis?: BackendEndpointAnalysis;
  execute: (call: ToolCall) => Promise<ToolResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface JavaParameter {
  annotations: string;
  type: string;
  name: string;
}

interface JavaMethod {
  name: string;
  returnType: string;
  parameters: JavaParameter[];
}

interface ServiceCallPlan {
  methodName: string;
  returnType: string;
  usesIdParameter: boolean;
  idType?: string;
}

interface EndpointPlan {
  filePath: string;
  framework: 'jax-rs' | 'spring';
  verb: 'PUT' | 'PATCH';
  methodName: string;
  entityType: string;
  entityParameter: string;
  idType: string;
  serviceField: string;
  serviceMethod: string;
  serviceReturnsVoid: boolean;
  setIdMethod?: string;
  route: string;
}

const RESOURCE_SUFFIX = /(?:Resource|Controller|Endpoint|Rest|Api)$/i;
const UPDATE_VERBS = new Set<HttpVerb>(['PUT', 'PATCH']);
const UPDATE_METHOD_NAMES = /^(?:atualizar|alterar|editar|update|edit|modify|patch)$/i;
const SAVE_METHOD_NAMES = /^(?:salvar|save|persistir|persist|gravar|store|cadastrar|create)$/i;

export async function tryPrepareBackendEndpointFastPath(
  options: BackendEndpointFastPathOptions
): Promise<BackendEndpointFastPathResult | undefined> {
  const root = options.workspaceRoot;
  const analysis = options.analysis;
  if (!root || !analysis?.requestedVerb || !UPDATE_VERBS.has(analysis.requestedVerb)) return undefined;
  if (analysis.existingEndpoint) return undefined;

  const verb = analysis.requestedVerb as 'PUT' | 'PATCH';
  const resourcePath = resolveResourcePath(analysis);
  if (!resourcePath) return undefined;

  let resourceText: string;
  try {
    resourceText = await fsp.readFile(resolveInsideRoot(root, resourcePath), 'utf8');
  } catch (error) {
    options.warn?.(`[BackendEndpointFastPath] Não foi possível ler o Resource/Controller: ${messageOf(error)}`);
    return undefined;
  }

  const framework = detectFramework(resourceText);
  if (!framework) return undefined;

  const entityType = resolveEntityType(resourcePath, resourceText, analysis.targetTerms);
  if (!entityType) return undefined;

  const serviceBinding = resolveServiceBinding(resourceText, entityType);
  if (!serviceBinding) return undefined;

  const servicePath = resolveRelatedPath(analysis.priority, serviceBinding.type);
  const modelPath = resolveRelatedPath(analysis.priority, entityType);
  if (!servicePath || !modelPath) return undefined;

  let serviceText: string;
  let modelText: string;
  try {
    [serviceText, modelText] = await Promise.all([
      fsp.readFile(resolveInsideRoot(root, servicePath), 'utf8'),
      fsp.readFile(resolveInsideRoot(root, modelPath), 'utf8')
    ]);
  } catch (error) {
    options.warn?.(`[BackendEndpointFastPath] Não foi possível ler Service/Model: ${messageOf(error)}`);
    return undefined;
  }

  const servicePlan = resolveServiceCallPlan(serviceText, entityType);
  if (!servicePlan) return undefined;

  const idSetter = resolveIdSetter(modelText);
  if (!servicePlan.usesIdParameter && !idSetter) return undefined;

  const idType = servicePlan.idType ?? idSetter?.idType;
  if (!idType) return undefined;

  const methodName = uniqueMethodName(
    requestedMethodName(options.request),
    parseJavaMethods(resourceText).map(method => method.name)
  );
  const entityParameter = lowerFirst(entityType);
  const route = discoverIdRoute(resourceText, framework) ?? '/{id}';

  const plan: EndpointPlan = {
    filePath: resourcePath,
    framework,
    verb,
    methodName,
    entityType,
    entityParameter,
    idType,
    serviceField: serviceBinding.field,
    serviceMethod: servicePlan.methodName,
    serviceReturnsVoid: normalizeType(servicePlan.returnType) === 'void',
    setIdMethod: servicePlan.usesIdParameter ? undefined : idSetter?.methodName,
    route
  };

  const updated = buildEndpointEdit(resourceText, plan);
  if (!updated || updated === resourceText) return undefined;

  const call: ToolCall = {
    id: randomUUID(),
    name: 'apply_edit',
    arguments: {
      filePath: resourcePath,
      oldText: resourceText,
      newText: updated,
      replaceAll: false
    }
  };

  options.info?.(
    [
      '[BackendEndpointFastPath] Endpoint Java estrutural detectado; modelo não será chamado.',
      `arquivo=${resourcePath}`,
      `framework=${framework}`,
      `verbo=${verb}`,
      `método=${methodName}`,
      `service=${serviceBinding.field}.${servicePlan.methodName}`
    ].join(' ')
  );

  const result = await options.execute(call);
  if (!result.ok) {
    options.warn?.(`[BackendEndpointFastPath] apply_edit falhou; usando o AgentLoop: ${result.error ?? 'erro desconhecido'}`);
    return undefined;
  }

  return {
    call,
    result,
    text: [
      'Endpoint preparado para revisão.',
      `Arquivo: ${resourcePath}`,
      `Operação HTTP: ${verb}`,
      `Método adicionado: ${methodName}`
    ].join('\n\n')
  };
}

function resolveResourcePath(analysis: BackendEndpointAnalysis): string | undefined {
  const explicit = analysis.resourceFile;
  if (explicit) {
    try { return normalizeRelativePath(explicit); } catch { return undefined; }
  }

  const resource = analysis.priority.find(candidate => {
    const base = path.posix.basename(candidate.replace(/\\/g, '/'), '.java');
    return /(?:^|\/)src\/main\/java\//i.test(candidate)
      && candidate.toLowerCase().endsWith('.java')
      && RESOURCE_SUFFIX.test(base);
  });
  if (!resource) return undefined;
  try { return normalizeRelativePath(resource); } catch { return undefined; }
}

function resolveRelatedPath(priority: string[], typeName: string, suffix = ''): string | undefined {
  const expected = `${typeName}${suffix}`.toLowerCase();
  const match = priority.find(candidate => {
    const normalized = candidate.replace(/\\/g, '/');
    return /(?:^|\/)src\/main\/java\//i.test(normalized)
      && path.posix.basename(normalized, '.java').toLowerCase() === expected;
  });
  if (!match) return undefined;
  try { return normalizeRelativePath(match); } catch { return undefined; }
}

function detectFramework(content: string): 'jax-rs' | 'spring' | undefined {
  if (/\b(?:jakarta|javax)\.ws\.rs\.|@(Path|GET|POST|PUT|PATCH|DELETE)\b/.test(content)) return 'jax-rs';
  if (/\borg\.springframework\.web\.bind\.annotation\.|@(RestController|RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/.test(content)) return 'spring';
  return undefined;
}

function resolveEntityType(filePath: string, content: string, targetTerms: string[]): string | undefined {
  const imports = [...content.matchAll(/^\s*import\s+([\w.]+)\s*;/gm)]
    .map(match => match[1]?.split('.').at(-1))
    .filter((value): value is string => Boolean(value));
  const resourceBase = path.posix.basename(filePath, '.java').replace(RESOURCE_SUFFIX, '');
  const normalizedTargets = targetTerms.map(normalizeWord);

  const direct = imports.find(imported => normalizedTargets.includes(normalizeWord(imported)));
  if (direct) return direct;

  const fromResource = imports.find(imported => normalizeWord(imported) === normalizeWord(resourceBase));
  if (fromResource) return fromResource;

  const methodTypes = parseJavaMethods(content)
    .flatMap(method => method.parameters.map(parameter => simpleType(parameter.type)))
    .filter(type => type && !isInfrastructureType(type));
  const targetMethodType = methodTypes.find(type => normalizedTargets.includes(normalizeWord(type)));
  if (targetMethodType) return targetMethodType;
  return methodTypes.find(type => normalizeWord(type) === normalizeWord(resourceBase));
}

function resolveServiceBinding(
  resourceText: string,
  entityType: string
): { type: string; field: string } | undefined {
  const fields = [...resourceText.matchAll(
    /(?:^|\n)[ \t]*(?:(?:@[\w.]+(?:\([^\r\n]*\))?)[ \t]*\r?\n[ \t]*)*(?:private|protected|public)[ \t]+(?:final[ \t]+)?([A-Za-z_$][\w$]*Service)[ \t]+([A-Za-z_$][\w$]*)[ \t]*;/g
  )].map(match => ({ type: match[1]!, field: match[2]! }));

  return fields.find(field => normalizeWord(field.type) === normalizeWord(`${entityType}Service`))
    ?? fields.find(field => normalizeWord(field.type).includes(normalizeWord(entityType)))
    ?? (fields.length === 1 ? fields[0] : undefined);
}

function resolveServiceCallPlan(serviceText: string, entityType: string): ServiceCallPlan | undefined {
  const methods = parseJavaMethods(serviceText)
    .filter(method => method.parameters.some(parameter => simpleType(parameter.type) === entityType))
    .map(method => {
      const entityParameter = method.parameters.find(parameter => simpleType(parameter.type) === entityType);
      const other = method.parameters.find(parameter => parameter !== entityParameter);
      const nameScore = UPDATE_METHOD_NAMES.test(method.name) ? 300 : SAVE_METHOD_NAMES.test(method.name) ? 220 : 0;
      const shapeScore = other ? 80 : 40;
      const returnScore = normalizeType(method.returnType) === normalizeType(entityType) ? 30 : normalizeType(method.returnType) === 'void' ? 0 : 10;
      return { method, other, score: nameScore + shapeScore + returnScore };
    })
    .filter(candidate => candidate.score >= 220)
    .sort((left, right) => right.score - left.score);

  const selected = methods[0];
  if (!selected) return undefined;
  return {
    methodName: selected.method.name,
    returnType: selected.method.returnType,
    usesIdParameter: Boolean(selected.other),
    idType: selected.other?.type
  };
}

function resolveIdSetter(modelText: string): { methodName: string; idType: string } | undefined {
  const setter = parseJavaMethods(modelText).find(method =>
    /^setId$/i.test(method.name)
    && method.parameters.length === 1
    && normalizeType(method.returnType) === 'void'
  );
  if (setter) return { methodName: setter.name, idType: setter.parameters[0]!.type };

  const field = modelText.match(/\b(?:private|protected|public)\s+([A-Za-z_$][\w$<>?,.\[\]]*)\s+id\s*;/i);
  return field ? undefined : undefined;
}

function requestedMethodName(request: string): string {
  const normalized = normalizeWord(request);
  if (/\beditar\b/.test(normalized)) return 'editar';
  if (/\balterar\b/.test(normalized)) return 'alterar';
  if (/\batualizar\b/.test(normalized)) return 'atualizar';
  if (/\bedit\b/.test(normalized)) return 'edit';
  if (/\bupdate\b/.test(normalized)) return 'update';
  return 'atualizar';
}

function uniqueMethodName(base: string, existing: string[]): string {
  const occupied = new Set(existing.map(name => name.toLowerCase()));
  if (!occupied.has(base.toLowerCase())) return base;
  const withId = `${base}PorId`;
  if (!occupied.has(withId.toLowerCase())) return withId;
  let index = 2;
  while (occupied.has(`${withId}${index}`.toLowerCase())) index += 1;
  return `${withId}${index}`;
}

function discoverIdRoute(content: string, framework: 'jax-rs' | 'spring'): string | undefined {
  if (framework === 'jax-rs') {
    return content.match(/@Path\(\s*"([^"]*\{id\}[^"]*)"\s*\)/i)?.[1];
  }
  return content.match(/@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?"([^"]*\{id\}[^"]*)"/i)?.[2];
}

function buildEndpointEdit(sourceText: string, plan: EndpointPlan): string | undefined {
  const lineEnding = sourceText.includes('\r\n') ? '\r\n' : '\n';
  const imports = requiredImports(sourceText, plan);
  let withImports = ensureImports(sourceText, imports, lineEnding);

  const classClosingBrace = findPrimaryClassClosingBrace(withImports);
  if (classClosingBrace < 0) return undefined;

  const indent = detectMemberIndent(withImports) || '    ';
  const bodyIndent = `${indent}    `;
  const callArguments = plan.setIdMethod
    ? plan.entityParameter
    : `id, ${plan.entityParameter}`;
  const serviceCall = `${plan.serviceField}.${plan.serviceMethod}(${callArguments})`;

  const body: string[] = [];
  if (plan.setIdMethod) {
    body.push(`${bodyIndent}${plan.entityParameter}.${plan.setIdMethod}(id);`);
  }

  if (plan.framework === 'jax-rs') {
    if (plan.serviceReturnsVoid) {
      body.push(`${bodyIndent}${serviceCall};`);
      body.push(`${bodyIndent}return Response.noContent().build();`);
    } else {
      body.push(`${bodyIndent}return Response.ok(${serviceCall}).build();`);
    }
  } else if (plan.serviceReturnsVoid) {
    body.push(`${bodyIndent}${serviceCall};`);
    body.push(`${bodyIndent}return ResponseEntity.noContent().build();`);
  } else {
    body.push(`${bodyIndent}return ResponseEntity.ok(${serviceCall});`);
  }

  const annotations = plan.framework === 'jax-rs'
    ? [
        `${indent}@${plan.verb}`,
        `${indent}@Path("${plan.route}")`
      ]
    : [
        `${indent}@${plan.verb === 'PATCH' ? 'PatchMapping' : 'PutMapping'}("${plan.route}")`
      ];

  const signature = plan.framework === 'jax-rs'
    ? `${indent}public Response ${plan.methodName}(@PathParam("id") ${plan.idType} id, ${plan.entityType} ${plan.entityParameter}) {`
    : `${indent}public ResponseEntity<${plan.serviceReturnsVoid ? 'Void' : plan.entityType}> ${plan.methodName}(@PathVariable ${plan.idType} id, @RequestBody ${plan.entityType} ${plan.entityParameter}) {`;

  const methodText = [...annotations, signature, ...body, `${indent}}`].join(lineEnding);
  const before = withImports.slice(0, classClosingBrace);
  const after = withImports.slice(classClosingBrace);
  const separator = before.endsWith(lineEnding) ? lineEnding : `${lineEnding}${lineEnding}`;
  withImports = `${before}${separator}${methodText}${lineEnding}${after}`;
  return withImports;
}

function requiredImports(sourceText: string, plan: EndpointPlan): string[] {
  if (plan.framework === 'jax-rs') {
    const namespace = /import\s+javax\.ws\.rs\./.test(sourceText) ? 'javax' : 'jakarta';
    return [
      `${namespace}.ws.rs.${plan.verb}`,
      `${namespace}.ws.rs.Path`,
      `${namespace}.ws.rs.PathParam`,
      `${namespace}.ws.rs.core.Response`
    ];
  }
  return [
    `org.springframework.web.bind.annotation.${plan.verb === 'PATCH' ? 'PatchMapping' : 'PutMapping'}`,
    'org.springframework.web.bind.annotation.PathVariable',
    'org.springframework.web.bind.annotation.RequestBody',
    'org.springframework.http.ResponseEntity'
  ];
}

function ensureImports(sourceText: string, imports: string[], lineEnding: string): string {
  const missing = imports.filter(importName => !hasImport(sourceText, importName));
  if (!missing.length) return sourceText;

  const importMatches = [...sourceText.matchAll(/^\s*import\s+[\w.*]+\s*;\s*$/gm)];
  const block = missing.map(importName => `import ${importName};`).join(lineEnding);
  if (importMatches.length) {
    const last = importMatches.at(-1)!;
    const insertAt = last.index! + last[0].length;
    return `${sourceText.slice(0, insertAt)}${lineEnding}${block}${sourceText.slice(insertAt)}`;
  }

  const packageMatch = sourceText.match(/^\s*package\s+[\w.]+\s*;\s*$/m);
  if (!packageMatch || packageMatch.index === undefined) return sourceText;
  const insertAt = packageMatch.index + packageMatch[0].length;
  return `${sourceText.slice(0, insertAt)}${lineEnding}${lineEnding}${block}${sourceText.slice(insertAt)}`;
}

function hasImport(sourceText: string, importName: string): boolean {
  if (new RegExp(`^\\s*import\\s+${escapeRegExp(importName)}\\s*;`, 'm').test(sourceText)) return true;
  const packageName = importName.slice(0, importName.lastIndexOf('.'));
  return new RegExp(`^\\s*import\\s+${escapeRegExp(packageName)}\\.\\*\\s*;`, 'm').test(sourceText);
}

function findPrimaryClassClosingBrace(sourceText: string): number {
  const classMatch = /\b(?:public\s+)?(?:abstract\s+|final\s+)?class\s+[A-Za-z_$][\w$]*[^\{]*\{/.exec(sourceText);
  if (!classMatch || classMatch.index === undefined) return -1;
  const opening = sourceText.indexOf('{', classMatch.index);
  if (opening < 0) return -1;

  let depth = 0;
  let state: 'code' | 'line-comment' | 'block-comment' | 'string' | 'char' = 'code';
  let escaped = false;
  for (let index = opening; index < sourceText.length; index += 1) {
    const current = sourceText[index]!;
    const next = sourceText[index + 1];

    if (state === 'line-comment') {
      if (current === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (current === '*' && next === '/') { state = 'code'; index += 1; }
      continue;
    }
    if (state === 'string' || state === 'char') {
      if (escaped) { escaped = false; continue; }
      if (current === '\\') { escaped = true; continue; }
      if ((state === 'string' && current === '"') || (state === 'char' && current === "'")) state = 'code';
      continue;
    }
    if (current === '/' && next === '/') { state = 'line-comment'; index += 1; continue; }
    if (current === '/' && next === '*') { state = 'block-comment'; index += 1; continue; }
    if (current === '"') { state = 'string'; continue; }
    if (current === "'") { state = 'char'; continue; }
    if (current === '{') depth += 1;
    else if (current === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function detectMemberIndent(sourceText: string): string | undefined {
  return sourceText.match(/^([ \t]+)@(GET|POST|PUT|PATCH|DELETE|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/m)?.[1]
    ?? sourceText.match(/^([ \t]+)(?:public|private|protected)\s+[^\r\n;{]+[;{]/m)?.[1];
}

function parseJavaMethods(sourceText: string): JavaMethod[] {
  const methods: JavaMethod[] = [];
  const pattern = /(?:^|\n)[ \t]*(?:@[\w.]+(?:\([^\r\n]*\))?[ \t]*\r?\n[ \t]*)*(?:public|protected|private)[ \t]+(?:static[ \t]+)?(?:final[ \t]+)?([A-Za-z_$][\w$<>?,.\[\] ]*)[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(([^)]*)\)[ \t]*(?:throws[^{]+)?\{/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(sourceText)) !== null) {
    methods.push({
      returnType: match[1]!.trim(),
      name: match[2]!,
      parameters: parseParameters(match[3] ?? '')
    });
  }
  return methods;
}

function parseParameters(value: string): JavaParameter[] {
  return splitTopLevel(value).map(raw => {
    const annotations = [...raw.matchAll(/@[\w.]+(?:\([^)]*\))?/g)].map(match => match[0]).join(' ');
    const withoutAnnotations = raw.replace(/@[\w.]+(?:\([^)]*\))?/g, ' ').replace(/\bfinal\b/g, ' ').trim();
    const match = withoutAnnotations.match(/^(.+?)\s+([A-Za-z_$][\w$]*)$/);
    if (!match) return undefined;
    return { annotations, type: match[1]!.trim(), name: match[2]! };
  }).filter((value): value is JavaParameter => Boolean(value));
}

function splitTopLevel(value: string): string[] {
  const result: string[] = [];
  let start = 0;
  let angle = 0;
  let paren = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '<') angle += 1;
    else if (char === '>') angle = Math.max(0, angle - 1);
    else if (char === '(') paren += 1;
    else if (char === ')') paren = Math.max(0, paren - 1);
    else if (char === ',' && angle === 0 && paren === 0) {
      result.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function simpleType(value: string): string {
  return value.replace(/<.*>/g, '').replace(/\[\]$/g, '').trim().split('.').at(-1) ?? value;
}

function isInfrastructureType(type: string): boolean {
  return /^(?:String|Long|Integer|Boolean|Double|Float|Response|ResponseEntity|HttpServletRequest|UriInfo)$/i.test(type)
    || /Service$/i.test(type);
}

function normalizeType(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function normalizeWord(value: string): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_$]+/g, ' ')
    .toLowerCase()
    .trim();
}

function lowerFirst(value: string): string {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : 'entidade';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
