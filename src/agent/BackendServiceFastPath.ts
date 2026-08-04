import * as fsp from 'node:fs/promises';
import * as ts from 'typescript';
import { randomUUID } from 'node:crypto';
import { resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';
import type { BackendServiceAnalysis } from './BackendServiceIntent';

export interface BackendServiceFastPathResult {
  text: string;
  calls: ToolCall[];
  results: ToolResult[];
}

export interface BackendServiceFastPathOptions {
  request: string;
  workspaceRoot?: string;
  analysis?: BackendServiceAnalysis;
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
  start: number;
  end: number;
  bodyStart: number;
  bodyEnd: number;
  annotations: string;
  modifiers: string;
  returnType: string;
  name: string;
  parameters: JavaParameter[];
  body: string;
}

interface ServiceMethodPlan {
  endpointMethod: JavaMethod;
  entityParameter: JavaParameter;
  idParameter: JavaParameter;
  serviceCallMethod: string;
  serviceCallText: string;
  serviceCallArguments: string[];
  setterText?: string;
  returnPrefix: string;
}

const UPDATE_METHOD = /^(?:editar|alterar|atualizar|edit|update|modify|patch)$/i;
const SAVE_METHOD = /^(?:salvar|save|persistir|persist|gravar|store|cadastrar|create)$/i;

export async function tryPrepareBackendServiceFastPath(
  options: BackendServiceFastPathOptions
): Promise<BackendServiceFastPathResult | undefined> {
  if (options.analysis?.language === 'typescript') {
    return tryPrepareTypeScriptServiceFastPath(options);
  }
  return tryPrepareJavaServiceFastPath(options);
}

async function tryPrepareJavaServiceFastPath(
  options: BackendServiceFastPathOptions
): Promise<BackendServiceFastPathResult | undefined> {
  const root = options.workspaceRoot;
  const analysis = options.analysis;
  if (!root || !analysis?.resourceFile || !analysis.serviceFile || !analysis.serviceField || !analysis.entityType) {
    return undefined;
  }

  let resourceText: string;
  let serviceText: string;
  try {
    [resourceText, serviceText] = await Promise.all([
      fsp.readFile(resolveInsideRoot(root, analysis.resourceFile), 'utf8'),
      fsp.readFile(resolveInsideRoot(root, analysis.serviceFile), 'utf8')
    ]);
  } catch (error) {
    options.warn?.(`[BackendServiceFastPath] Não foi possível ler Resource/Service: ${messageOf(error)}`);
    return undefined;
  }

  const endpoint = selectEndpointMethod(resourceText, analysis.endpointMethod, analysis.entityType);
  if (!endpoint) return undefined;

  const plan = resolveServiceMethodPlan(endpoint, analysis.serviceField, analysis.entityType);
  if (!plan) return undefined;

  const existingServiceMethod = parseJavaMethods(serviceText).find(method =>
    method.name.toLowerCase() === endpoint.name.toLowerCase()
    && sameParameterShape(method.parameters, [plan.idParameter, plan.entityParameter])
  );

  const baseServiceMethod = parseJavaMethods(serviceText).find(method =>
    method.name.toLowerCase() === plan.serviceCallMethod.toLowerCase()
    && method.parameters.length === plan.serviceCallArguments.length
  ) ?? parseJavaMethods(serviceText).find(method =>
    SAVE_METHOD.test(method.name)
    && method.parameters.length === 1
    && simpleType(method.parameters[0]?.type ?? '') === simpleType(plan.entityParameter.type)
  );

  if (!existingServiceMethod && !baseServiceMethod) return undefined;
  if (!existingServiceMethod && !plan.setterText && baseServiceMethod?.parameters.length === 1) return undefined;

  const serviceMethodName = endpoint.name;
  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];
  let updatedService = serviceText;
  let updatedResource = resourceText;

  if (!existingServiceMethod) {
    const serviceMethod = buildServiceMethod(serviceText, serviceMethodName, plan, baseServiceMethod!);
    if (!serviceMethod) return undefined;
    updatedService = serviceMethod;
  }

  const endpointAlreadyUsesEquivalent = plan.serviceCallMethod.toLowerCase() === serviceMethodName.toLowerCase()
    && plan.serviceCallArguments.length === 2;

  if (!endpointAlreadyUsesEquivalent) {
    const resourceUpdate = buildResourceUpdate(resourceText, plan, analysis.serviceField, serviceMethodName);
    if (!resourceUpdate) return undefined;
    updatedResource = resourceUpdate;
  }

  if (updatedService === serviceText && updatedResource === resourceText) {
    return {
      calls,
      results,
      text: [
        'Nenhuma alteração foi necessária.',
        'O método de Service equivalente já existe e já é usado pelo endpoint.',
        `Arquivo: ${analysis.serviceFile}`,
        `Método existente: ${serviceMethodName}`
      ].join('\n\n')
    };
  }

  options.info?.(
    [
      '[BackendServiceFastPath] Service Java estrutural detectado; modelo não será chamado.',
      `endpoint=${analysis.resourceFile}#${endpoint.name}`,
      `service=${analysis.serviceFile}#${serviceMethodName}`,
      `entidade=${analysis.entityType}`
    ].join(' ')
  );

  if (updatedService !== serviceText) {
    const call = applyEditCall(analysis.serviceFile, serviceText, updatedService);
    const result = await options.execute(call);
    calls.push(call);
    results.push(result);
    if (!result.ok) {
      options.warn?.(`[BackendServiceFastPath] apply_edit no Service falhou: ${result.error ?? 'erro desconhecido'}`);
      return undefined;
    }
  }

  if (updatedResource !== resourceText) {
    const call = applyEditCall(analysis.resourceFile, resourceText, updatedResource);
    const result = await options.execute(call);
    calls.push(call);
    results.push(result);
    if (!result.ok) {
      options.warn?.(`[BackendServiceFastPath] apply_edit no endpoint falhou: ${result.error ?? 'erro desconhecido'}`);
      return {
        calls,
        results,
        text: [
          'O método de Service foi preparado, mas a atualização da chamada no endpoint falhou.',
          `Service: ${analysis.serviceFile}`,
          `Endpoint: ${analysis.resourceFile}`,
          `Erro: ${result.error ?? 'erro desconhecido'}`
        ].join('\n\n')
      };
    }
  }

  return {
    calls,
    results,
    text: [
      'Service equivalente preparado para revisão.',
      `Arquivo do Service: ${analysis.serviceFile}`,
      `Método adicionado: ${serviceMethodName}`,
      updatedResource !== resourceText
        ? `Endpoint atualizado: ${analysis.resourceFile}`
        : 'O endpoint já chamava o método equivalente.'
    ].join('\n\n')
  };
}

function selectEndpointMethod(
  resourceText: string,
  expectedName: string | undefined,
  entityType: string
): JavaMethod | undefined {
  const methods = parseJavaMethods(resourceText).filter(method => isUpdateEndpoint(method));
  return methods.find(method => expectedName && method.name.toLowerCase() === expectedName.toLowerCase())
    ?? methods.find(method => method.parameters.some(parameter => simpleType(parameter.type) === simpleType(entityType)))
    ?? (methods.length === 1 ? methods[0] : undefined);
}

function resolveServiceMethodPlan(
  endpointMethod: JavaMethod,
  serviceField: string,
  entityType: string
): ServiceMethodPlan | undefined {
  const entityParameter = endpointMethod.parameters.find(parameter => simpleType(parameter.type) === simpleType(entityType));
  const idParameter = endpointMethod.parameters.find(parameter => parameter !== entityParameter && isIdParameter(parameter));
  if (!entityParameter || !idParameter) return undefined;

  const callPattern = new RegExp(`\\b${escapeRegex(serviceField)}\\.([A-Za-z_$][\\w$]*)\\s*\\(([^)]*)\\)`);
  const callMatch = endpointMethod.body.match(callPattern);
  if (!callMatch || !callMatch[0] || !callMatch[1]) return undefined;
  const serviceCallArguments = splitArguments(callMatch[2] ?? '');
  if (!serviceCallArguments.some(argument => normalizeExpression(argument) === entityParameter.name)) return undefined;

  const callIndex = endpointMethod.body.indexOf(callMatch[0]);
  const lineStart = endpointMethod.body.lastIndexOf('\n', callIndex) + 1;
  const linePrefix = endpointMethod.body.slice(lineStart, callIndex);
  const returnPrefix = /\breturn\s+[^;]*$/s.test(linePrefix) || endpointMethod.body.slice(Math.max(0, callIndex - 40), callIndex).includes('return')
    ? 'return '
    : '';

  const setterPattern = new RegExp(
    `^[ \\t]*${escapeRegex(entityParameter.name)}\\.([A-Za-z_$][\\w$]*)\\s*\\(\\s*${escapeRegex(idParameter.name)}\\s*\\)\\s*;[ \\t]*(?:\\r?\\n)?`,
    'm'
  );
  const setterMatch = endpointMethod.body.match(setterPattern);

  return {
    endpointMethod,
    entityParameter,
    idParameter,
    serviceCallMethod: callMatch[1],
    serviceCallText: callMatch[0],
    serviceCallArguments,
    setterText: setterMatch?.[0]?.trim(),
    returnPrefix
  };
}

function buildServiceMethod(
  serviceText: string,
  methodName: string,
  plan: ServiceMethodPlan,
  baseMethod: JavaMethod
): string | undefined {
  const closingBrace = findPrimaryClassClosingBrace(serviceText);
  if (closingBrace < 0) return undefined;
  const lineEnding = serviceText.includes('\r\n') ? '\r\n' : '\n';
  const indent = detectMemberIndent(serviceText) || '    ';
  const bodyIndent = `${indent}    `;
  const returnType = baseMethod.returnType;
  const entityName = plan.entityParameter.name;
  const idName = plan.idParameter.name;

  let bodyLines: string[];
  if (baseMethod.parameters.length >= 2) {
    const argumentsText = baseMethod.parameters.map(parameter =>
      simpleType(parameter.type) === simpleType(plan.entityParameter.type) ? entityName : idName
    ).join(', ');
    bodyLines = normalizeType(returnType) === 'void'
      ? [`${baseMethod.name}(${argumentsText});`]
      : [`return ${baseMethod.name}(${argumentsText});`];
  } else {
    if (!plan.setterText) return undefined;
    const setterStatement = plan.setterText.replace(/^[ \t]+/, '');
    bodyLines = [
      setterStatement,
      normalizeType(returnType) === 'void'
        ? `${baseMethod.name}(${entityName});`
        : `return ${baseMethod.name}(${entityName});`
    ];
  }

  const method = [
    `${indent}public ${returnType} ${methodName}(${plan.idParameter.type} ${idName}, ${plan.entityParameter.type} ${entityName}) {`,
    ...bodyLines.map(line => `${bodyIndent}${line}`),
    `${indent}}`
  ].join(lineEnding);

  const before = serviceText.slice(0, closingBrace).replace(/[ \t]+$/gm, '').replace(/\s*$/, '');
  const after = serviceText.slice(closingBrace);
  return `${before}${lineEnding}${lineEnding}${method}${lineEnding}${after}`;
}

function buildResourceUpdate(
  resourceText: string,
  plan: ServiceMethodPlan,
  serviceField: string,
  serviceMethodName: string
): string | undefined {
  let newBody = plan.endpointMethod.body;
  if (plan.setterText) {
    const setterPattern = new RegExp(
      `^[ \\t]*${escapeRegex(plan.entityParameter.name)}\\.[A-Za-z_$][\\w$]*\\s*\\(\\s*${escapeRegex(plan.idParameter.name)}\\s*\\)\\s*;[ \\t]*(?:\\r?\\n)?`,
      'm'
    );
    newBody = newBody.replace(setterPattern, '');
  }

  const replacement = `${serviceField}.${serviceMethodName}(${plan.idParameter.name}, ${plan.entityParameter.name})`;
  newBody = newBody.replace(plan.serviceCallText, replacement);
  if (newBody === plan.endpointMethod.body) return undefined;

  return resourceText.slice(0, plan.endpointMethod.bodyStart + 1)
    + newBody
    + resourceText.slice(plan.endpointMethod.bodyEnd);
}

function parseJavaMethods(content: string): JavaMethod[] {
  const methods: JavaMethod[] = [];
  const pattern = /^(\s*)((?:(?:public|protected|private|static|final|synchronized|abstract|native|default)\s+)+)([A-Za-z_$][\w$<>?,.\[\] ]*?)\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(content)) !== null) {
    const openParen = pattern.lastIndex - 1;
    const closeParen = findMatchingParenthesis(content, openParen);
    if (closeParen < 0) continue;
    const braceIndex = content.indexOf('{', closeParen + 1);
    const semicolonIndex = content.indexOf(';', closeParen + 1);
    if (braceIndex < 0 || (semicolonIndex >= 0 && semicolonIndex < braceIndex)) continue;
    const between = content.slice(closeParen + 1, braceIndex);
    if (!/^\s*(?:throws\s+[^\{]+)?\s*$/.test(between)) continue;
    const bodyEnd = findMatchingBrace(content, braceIndex);
    if (bodyEnd < 0) continue;
    const start = match.index;
    const end = bodyEnd + 1;
    methods.push({
      start,
      end,
      bodyStart: braceIndex,
      bodyEnd,
      annotations: annotationsBefore(content, start),
      modifiers: (match[2] ?? '').trim(),
      returnType: (match[3] ?? '').trim(),
      name: match[4] ?? '',
      parameters: parseParameters(content.slice(openParen + 1, closeParen)),
      body: content.slice(braceIndex + 1, bodyEnd)
    });
    pattern.lastIndex = end;
  }
  return methods;
}

function annotationsBefore(content: string, signatureStart: number): string {
  const lines: string[] = [];
  let cursor = content.lastIndexOf('\n', Math.max(0, signatureStart - 1));
  while (cursor >= 0) {
    const previousEnd = cursor;
    const previousStart = content.lastIndexOf('\n', Math.max(0, previousEnd - 1)) + 1;
    const line = content.slice(previousStart, previousEnd).trim();
    if (!line) {
      if (lines.length) break;
      cursor = previousStart - 1;
      continue;
    }
    if (!line.startsWith('@')) break;
    lines.unshift(line);
    cursor = previousStart - 1;
  }
  return lines.join('\n');
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

function parseParameters(value: string): JavaParameter[] {
  return splitArguments(value).map(raw => {
    const annotations = [...raw.matchAll(/@[A-Za-z_$][\w$.]*(?:\([^)]*\))?/g)].map(match => match[0]).join(' ');
    const cleaned = raw.replace(/@[A-Za-z_$][\w$.]*(?:\([^)]*\))?\s*/g, '').replace(/\bfinal\s+/g, '').trim();
    const match = cleaned.match(/^(.+?)\s+([A-Za-z_$][\w$]*)$/);
    return {
      annotations,
      type: match?.[1]?.trim() ?? '',
      name: match?.[2] ?? ''
    };
  }).filter(parameter => Boolean(parameter.type && parameter.name));
}

function splitArguments(value: string): string[] {
  const result: string[] = [];
  let current = '';
  let angle = 0;
  let paren = 0;
  let bracket = 0;
  let quote: string | undefined;
  let escaped = false;

  for (const char of value) {
    if (quote) {
      current += char;
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === '<') angle += 1;
    if (char === '>') angle = Math.max(0, angle - 1);
    if (char === '(') paren += 1;
    if (char === ')') paren = Math.max(0, paren - 1);
    if (char === '[') bracket += 1;
    if (char === ']') bracket = Math.max(0, bracket - 1);
    if (char === ',' && angle === 0 && paren === 0 && bracket === 0) {
      if (current.trim()) result.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function isUpdateEndpoint(method: JavaMethod): boolean {
  return /@(?:PUT|PATCH|PutMapping|PatchMapping)\b/i.test(method.annotations)
    || /RequestMethod\.(?:PUT|PATCH)\b/i.test(method.annotations);
}

function isIdParameter(parameter: JavaParameter): boolean {
  return /(?:PathParam|PathVariable)\b/i.test(parameter.annotations)
    || /^(?:id|codigo|code|key)$/i.test(parameter.name);
}

function sameParameterShape(left: JavaParameter[], right: JavaParameter[]): boolean {
  return left.length === right.length
    && left.every((parameter, index) => simpleType(parameter.type) === simpleType(right[index]?.type ?? ''));
}

function simpleType(type: string): string {
  return type.replace(/<.*>/g, '').replace(/\[\]$/g, '').split('.').at(-1)?.trim() ?? type.trim();
}

function normalizeType(type: string): string {
  return type.replace(/\s+/g, '').toLowerCase();
}

function normalizeExpression(value: string): string {
  return value.replace(/\s+/g, '');
}

function detectMemberIndent(content: string): string | undefined {
  return content.match(/^([ \t]+)(?:public|protected|private|@)[^\n]*$/m)?.[1];
}

function findPrimaryClassClosingBrace(content: string): number {
  const classMatch = /\b(?:class|record|interface|enum)\s+[A-Za-z_$][\w$]*[^\{]*\{/.exec(content);
  if (!classMatch) return -1;
  const openIndex = classMatch.index + classMatch[0].lastIndexOf('{');
  return findMatchingBrace(content, openIndex);
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if ((quote === 'single' && char === "'") || (quote === 'double' && char === '"')) quote = undefined;
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (char === "'") { quote = 'single'; continue; }
    if (char === '"') { quote = 'double'; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function applyEditCall(filePath: string, oldText: string, newText: string): ToolCall {
  return {
    id: randomUUID(),
    name: 'apply_edit',
    arguments: { filePath, oldText, newText, replaceAll: false }
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TypeScriptServicePlan {
  classNode: ts.ClassDeclaration;
  methodName: string;
  entityType: string;
  entityParameter: string;
  idType: string;
  idParameter: string;
  httpField: string;
  httpMethod: 'put' | 'patch';
  urlExpression: string;
  returnType: string;
}

async function tryPrepareTypeScriptServiceFastPath(
  options: BackendServiceFastPathOptions
): Promise<BackendServiceFastPathResult | undefined> {
  const root = options.workspaceRoot;
  const analysis = options.analysis;
  if (!root || !analysis?.serviceFile || !analysis.entityType || analysis.framework !== 'angular-http') return undefined;

  let serviceText: string;
  let referenceText: string | undefined;
  try {
    serviceText = await fsp.readFile(resolveInsideRoot(root, analysis.serviceFile), 'utf8');
    if (analysis.resourceFile) {
      try { referenceText = await fsp.readFile(resolveInsideRoot(root, analysis.resourceFile), 'utf8'); } catch { /* referência opcional */ }
    }
  } catch (error) {
    options.warn?.(`[BackendServiceFastPath] Não foi possível ler o Service TypeScript: ${messageOf(error)}`);
    return undefined;
  }

  const source = ts.createSourceFile(analysis.serviceFile, serviceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const plan = resolveAngularServicePlan(source, serviceText, referenceText, options.request, analysis);
  if (!plan) return undefined;

  const existing = plan.classNode.members
    .filter(ts.isMethodDeclaration)
    .find(method => methodNameOf(method) === plan.methodName
      && method.parameters.length === 2
      && method.parameters.some(parameter => parameter.name.getText(source) === plan.idParameter));

  if (existing) {
    return {
      calls: [],
      results: [],
      text: [
        'Nenhuma alteração foi necessária.',
        'O método equivalente já existe no Service TypeScript.',
        `Arquivo: ${analysis.serviceFile}`,
        `Método existente: ${plan.methodName}`
      ].join('\n\n')
    };
  }

  const updated = insertTypeScriptServiceMethod(serviceText, source, plan);
  if (!updated || updated === serviceText) return undefined;

  options.info?.(
    [
      '[BackendServiceFastPath] Service TypeScript estrutural detectado; modelo não será chamado.',
      `service=${analysis.serviceFile}#${plan.methodName}`,
      `entidade=${plan.entityType}`,
      `clienteHttp=${plan.httpField}.${plan.httpMethod}`
    ].join(' ')
  );

  const call = applyEditCall(analysis.serviceFile, serviceText, updated);
  const result = await options.execute(call);
  if (!result.ok) {
    options.warn?.(`[BackendServiceFastPath] apply_edit no Service TypeScript falhou: ${result.error ?? 'erro desconhecido'}`);
    return undefined;
  }

  return {
    calls: [call],
    results: [result],
    text: [
      'Service TypeScript equivalente preparado para revisão.',
      `Arquivo do Service: ${analysis.serviceFile}`,
      `Método adicionado: ${plan.methodName}`,
      'O endpoint foi usado apenas como referência e não foi alterado.'
    ].join('\n\n')
  };
}

function resolveAngularServicePlan(
  source: ts.SourceFile,
  serviceText: string,
  referenceText: string | undefined,
  request: string,
  analysis: BackendServiceAnalysis
): TypeScriptServicePlan | undefined {
  const classNode = source.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && Boolean(statement.name)
  );
  if (!classNode?.name) return undefined;

  const httpField = resolveHttpClientField(classNode, source);
  if (!httpField) return undefined;

  const requestedEntityType = analysis.entityType;
  if (!requestedEntityType) return undefined;
  const entityType = resolveTypeScriptEntityName(source, classNode, requestedEntityType);
  if (!entityType) return undefined;

  const methods = classNode.members.filter(ts.isMethodDeclaration);
  const baseMethod = methods.find(method => {
    if (method.parameters.length !== 1) return false;
    const parameterType = method.parameters[0]?.type?.getText(source);
    if (simpleTsType(parameterType ?? '') !== simpleTsType(entityType)) return false;
    return methodContainsHttpCall(method, source, httpField, ['post', 'put', 'patch']);
  });
  if (!baseMethod?.type) return undefined;

  const idEvidence = resolveTypeScriptIdEvidence(methods, source, httpField);
  if (!idEvidence) return undefined;

  const urlExpression = idEvidence.urlExpression
    ?? resolveReferenceUrlExpression(classNode, source, referenceText, idEvidence.parameterName);
  if (!urlExpression) return undefined;

  const methodName = requestedTypeScriptServiceMethodName(request, analysis.endpointMethod);
  const entityParameter = lowerCamel(entityType);
  const httpMethod: 'put' | 'patch' = analysis.endpointVerb === 'PATCH' || /\bpatch\b/i.test(request) ? 'patch' : 'put';

  return {
    classNode,
    methodName,
    entityType,
    entityParameter,
    idType: idEvidence.parameterType,
    idParameter: idEvidence.parameterName,
    httpField,
    httpMethod,
    urlExpression,
    returnType: baseMethod.type.getText(source)
  };
}

function resolveHttpClientField(classNode: ts.ClassDeclaration, source: ts.SourceFile): string | undefined {
  for (const member of classNode.members) {
    if (ts.isConstructorDeclaration(member)) {
      const parameter = member.parameters.find(candidate => simpleTsType(candidate.type?.getText(source) ?? '') === 'HttpClient');
      if (parameter && ts.isIdentifier(parameter.name)) return parameter.name.text;
    }
    if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
      if (simpleTsType(member.type?.getText(source) ?? '') === 'HttpClient') return member.name.text;
      if (member.initializer && ts.isCallExpression(member.initializer)
        && member.initializer.expression.getText(source) === 'inject'
        && member.initializer.arguments[0]?.getText(source) === 'HttpClient') return member.name.text;
    }
  }
  return undefined;
}

function resolveTypeScriptEntityName(
  source: ts.SourceFile,
  classNode: ts.ClassDeclaration,
  requested: string
): string | undefined {
  const requestedSimple = simpleTsType(requested);
  const imported = source.statements
    .filter(ts.isImportDeclaration)
    .flatMap(statement => {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map(element => element.name.text)
        : [];
    });
  const exact = imported.find(name => simpleTsType(name).toLowerCase() === requestedSimple.toLowerCase());
  if (exact) return exact;
  const classBase = classNode.name?.text.replace(/Service$/i, '');
  const fromClass = imported.find(name => classBase && name.toLowerCase() === classBase.toLowerCase());
  if (fromClass) return fromClass;
  if (requestedSimple && /^[A-Za-z_$][\w$]*$/.test(requestedSimple)) return requestedSimple;
  return classBase || undefined;
}

function resolveTypeScriptIdEvidence(
  methods: ts.MethodDeclaration[],
  source: ts.SourceFile,
  httpField: string
): { parameterName: string; parameterType: string; urlExpression?: string } | undefined {
  for (const method of methods) {
    if (method.parameters.length !== 1) continue;
    const parameter = method.parameters[0];
    if (!parameter || !ts.isIdentifier(parameter.name) || !parameter.type) continue;
    const parameterName = parameter.name.text;
    const parameterType = parameter.type.getText(source);
    if (!/^(?:id|codigo|code|key)$/i.test(parameterName)) continue;
    const call = findHttpCall(method, source, httpField, ['delete', 'get', 'put', 'patch']);
    const firstArgument = call?.arguments[0];
    const urlExpression = firstArgument && containsIdentifier(firstArgument, parameterName)
      ? firstArgument.getText(source)
      : undefined;
    return { parameterName, parameterType, urlExpression };
  }
  return undefined;
}

function resolveReferenceUrlExpression(
  classNode: ts.ClassDeclaration,
  source: ts.SourceFile,
  referenceText: string | undefined,
  idParameter: string
): string | undefined {
  if (!referenceText) return undefined;
  const route = extractUpdateRoute(referenceText);
  if (!route || !/\{(?:id|codigo|code|key)\}/i.test(route)) return undefined;
  const urlField = classNode.members.find((member): member is ts.PropertyDeclaration =>
    ts.isPropertyDeclaration(member)
      && ts.isIdentifier(member.name)
      && Boolean(member.initializer)
      && /(?:url|endpoint|api)/i.test(member.name.text)
  );
  if (!urlField || !ts.isIdentifier(urlField.name)) return undefined;
  const suffix = route
    .replace(/^\/+/, '')
    .replace(/\{(?:id|codigo|code|key)\}/gi, `\${${idParameter}}`);
  return suffix ? `\`\${this.${urlField.name.text}}/${suffix}\`` : undefined;
}

function extractUpdateRoute(content: string): string | undefined {
  const java = content.match(/@(?:PUT|PATCH)\b[\s\S]{0,120}?@Path\(\s*"([^"]+)"\s*\)/i)?.[1]
    ?? content.match(/@Path\(\s*"([^"]+)"\s*\)[\s\S]{0,120}?@(?:PUT|PATCH)\b/i)?.[1];
  if (java) return java;
  return content.match(/@(Put|Patch)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/i)?.[2]
    ?? content.match(/@(Put|Patch)\(\s*["']([^"']+)["']/i)?.[2];
}

function methodContainsHttpCall(
  method: ts.MethodDeclaration,
  source: ts.SourceFile,
  httpField: string,
  names: string[]
): boolean {
  return Boolean(findHttpCall(method, source, httpField, names));
}

function findHttpCall(
  method: ts.MethodDeclaration,
  source: ts.SourceFile,
  httpField: string,
  names: string[]
): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const expression = node.expression.expression.getText(source);
      const name = node.expression.name.text;
      if (expression === `this.${httpField}` && names.includes(name)) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  if (method.body) visit(method.body);
  return found;
}

function containsIdentifier(node: ts.Node, identifier: string): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(candidate) && candidate.text === identifier) { found = true; return; }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function requestedTypeScriptServiceMethodName(request: string, endpointMethod?: string): string {
  if (/\beditar\b/i.test(request)) return 'editar';
  if (/\balterar\b/i.test(request)) return 'alterar';
  if (/\batualizar\b/i.test(request)) return 'atualizar';
  if (/\bupdate\b/i.test(request)) return 'update';
  if (/\bedit\b/i.test(request)) return 'edit';
  if (endpointMethod && /^[A-Za-z_$][\w$]*$/.test(endpointMethod)) return endpointMethod;
  return 'atualizar';
}

function insertTypeScriptServiceMethod(
  serviceText: string,
  source: ts.SourceFile,
  plan: TypeScriptServicePlan
): string | undefined {
  const closingBrace = plan.classNode.end - 1;
  if (closingBrace < 0 || serviceText[closingBrace] !== '}') return undefined;
  const lineEnding = serviceText.includes('\r\n') ? '\r\n' : '\n';
  const indent = detectTypeScriptMemberIndent(plan.classNode, source, serviceText) ?? '  ';
  const bodyIndent = `${indent}  `;
  const method = [
    `${indent}${plan.methodName}(${plan.idParameter}: ${plan.idType}, ${plan.entityParameter}: ${plan.entityType}): ${plan.returnType} {`,
    `${bodyIndent}return this.${plan.httpField}.${plan.httpMethod}<${plan.entityType}>(${plan.urlExpression}, ${plan.entityParameter});`,
    `${indent}}`
  ].join(lineEnding);
  const before = serviceText.slice(0, closingBrace).replace(/[ \t]+$/gm, '').replace(/\s*$/, '');
  const after = serviceText.slice(closingBrace);
  return `${before}${lineEnding}${lineEnding}${method}${lineEnding}${after}`;
}

function detectTypeScriptMemberIndent(
  classNode: ts.ClassDeclaration,
  source: ts.SourceFile,
  text: string
): string | undefined {
  const member = classNode.members[0];
  if (!member) return undefined;
  const start = member.getStart(source);
  const lineStart = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  return text.slice(lineStart, start).match(/^[ \t]+/)?.[0];
}

function methodNameOf(method: ts.MethodDeclaration): string | undefined {
  return ts.isIdentifier(method.name) || ts.isStringLiteral(method.name) ? method.name.text : undefined;
}

function simpleTsType(type: string): string {
  return type.replace(/<.*>/g, '').replace(/\[\]$/g, '').split('.').at(-1)?.trim() ?? type.trim();
}

function lowerCamel(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}
