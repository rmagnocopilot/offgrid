import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as ts from 'typescript';
import { resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';
import type { FrontendCrudAnalysis } from './FrontendCrudIntent';

export interface FrontendCrudFastPathResult {
  text: string;
  calls: ToolCall[];
  results: ToolResult[];
}

export interface FrontendCrudFastPathOptions {
  request: string;
  workspaceRoot?: string;
  analysis?: FrontendCrudAnalysis;
  execute: (call: ToolCall) => Promise<ToolResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface HttpMethodMatch {
  declaration: ts.MethodDeclaration;
  call: ts.CallExpression;
  verb: 'post' | 'put' | 'patch' | 'delete';
  httpField: string;
  entityParameter?: ts.ParameterDeclaration;
  idParameter?: ts.ParameterDeclaration;
}

interface ServicePlan {
  sourceFile: ts.SourceFile;
  classDeclaration: ts.ClassDeclaration;
  createMethod: HttpMethodMatch;
  updateMethod?: HttpMethodMatch;
  updateMethodName: string;
  entityType: string;
  entityParameterName: string;
  idType: string;
  idParameterName: string;
  updateUrlExpression: string;
}

interface ComponentPlan {
  sourceFile: ts.SourceFile;
  classDeclaration: ts.ClassDeclaration;
  method: ts.MethodDeclaration;
  createCall: ts.CallExpression;
  serviceField: string;
  entityField: string;
}

const UPDATE_WORD = /\b(?:editar|edite|alterar|altere|atualizar|atualize|update|edit|patch)\b/i;

export async function tryPrepareFrontendCrudFastPath(
  options: FrontendCrudFastPathOptions
): Promise<FrontendCrudFastPathResult | undefined> {
  const root = options.workspaceRoot;
  const analysis = options.analysis;
  if (!root || analysis?.framework !== 'angular' || !analysis.componentFile || !analysis.serviceFile || !analysis.entityType) {
    return undefined;
  }

  let componentText: string;
  let serviceText: string;
  let modelText: string | undefined;
  try {
    [componentText, serviceText, modelText] = await Promise.all([
      fsp.readFile(resolveInsideRoot(root, analysis.componentFile), 'utf8'),
      fsp.readFile(resolveInsideRoot(root, analysis.serviceFile), 'utf8'),
      analysis.modelFile
        ? fsp.readFile(resolveInsideRoot(root, analysis.modelFile), 'utf8').catch(() => undefined)
        : Promise.resolve(undefined)
    ]);
  } catch (error) {
    options.warn?.(`[FrontendCrudFastPath] Não foi possível ler componente/service: ${messageOf(error)}`);
    return undefined;
  }

  const servicePlan = buildServicePlan(
    serviceText,
    analysis.serviceFile,
    modelText,
    analysis.entityType,
    requestedUpdateMethodName(options.request)
  );
  if (!servicePlan) {
    options.warn?.('[FrontendCrudFastPath] O padrão HttpClient do service.ts não pôde ser comprovado; usando o AgentLoop.');
    return undefined;
  }

  const componentPlan = buildComponentPlan(
    componentText,
    analysis.componentFile,
    analysis.serviceClass,
    analysis.entityType,
    analysis.entityField,
    servicePlan.createMethod.declaration.name.getText(servicePlan.sourceFile),
    servicePlan.updateMethodName
  );
  if (!componentPlan) {
    options.warn?.('[FrontendCrudFastPath] O fluxo de salvamento do formulário não pôde ser comprovado; usando o AgentLoop.');
    return undefined;
  }

  const updatedService = servicePlan.updateMethod
    ? serviceText
    : insertUpdateMethod(serviceText, servicePlan);
  if (!updatedService) return undefined;

  const componentAlreadyBranches = methodUsesUpdate(
    componentPlan.method,
    componentPlan.sourceFile,
    componentPlan.serviceField,
    servicePlan.updateMethodName
  );
  const updatedComponent = componentAlreadyBranches
    ? componentText
    : replaceCreateCallWithConditional(componentText, componentPlan, servicePlan.updateMethodName);
  if (!updatedComponent) return undefined;

  if (updatedService === serviceText && updatedComponent === componentText) {
    return {
      calls: [],
      results: [],
      text: [
        'Nenhuma alteração foi necessária.',
        'O formulário já usa atualização com id e cadastro sem id.',
        `Componente: ${analysis.componentFile}`,
        `Service: ${analysis.serviceFile}`
      ].join('\n\n')
    };
  }

  options.info?.(
    [
      '[FrontendCrudFastPath] Fluxo Angular de cadastro/edição detectado; modelo não será chamado.',
      `componente=${analysis.componentFile}`,
      `service=${analysis.serviceFile}`,
      `entidade=${analysis.entityType}`,
      `criação=${servicePlan.createMethod.declaration.name.getText(servicePlan.sourceFile)}`,
      `atualização=${servicePlan.updateMethodName}`
    ].join(' ')
  );

  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];

  if (updatedService !== serviceText) {
    const call = applyEditCall(analysis.serviceFile, serviceText, updatedService);
    const result = await options.execute(call);
    calls.push(call);
    results.push(result);
    if (!result.ok) {
      options.warn?.(`[FrontendCrudFastPath] apply_edit no service.ts falhou: ${result.error ?? 'erro desconhecido'}`);
      return undefined;
    }
  }

  if (updatedComponent !== componentText) {
    const call = applyEditCall(analysis.componentFile, componentText, updatedComponent);
    const result = await options.execute(call);
    calls.push(call);
    results.push(result);
    if (!result.ok) {
      options.warn?.(`[FrontendCrudFastPath] apply_edit no componente falhou: ${result.error ?? 'erro desconhecido'}`);
      return {
        calls,
        results,
        text: [
          'O método PUT do service.ts foi preparado, mas a alteração do formulário falhou.',
          `Service: ${analysis.serviceFile}`,
          `Componente: ${analysis.componentFile}`,
          `Erro: ${result.error ?? 'erro desconhecido'}`
        ].join('\n\n')
      };
    }
  }

  return {
    calls,
    results,
    text: [
      'Fluxo de cadastro e edição preparado para revisão.',
      `Componente: ${analysis.componentFile}`,
      `Service: ${analysis.serviceFile}`,
      `Comportamento: ${servicePlan.updateMethodName} com PUT quando houver id; ${servicePlan.createMethod.declaration.name.getText(servicePlan.sourceFile)} com POST quando não houver id.`
    ].join('\n\n')
  };
}

function buildServicePlan(
  sourceText: string,
  filePath: string,
  modelText: string | undefined,
  expectedEntityType: string,
  requestedName: string
): ServicePlan | undefined {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classDeclaration = sourceFile.statements.find(ts.isClassDeclaration);
  if (!classDeclaration) return undefined;

  const matches = classDeclaration.members
    .filter(ts.isMethodDeclaration)
    .flatMap(method => findHttpMethodMatches(method, sourceFile, expectedEntityType));
  const createMethods = matches.filter(match => match.verb === 'post' && match.entityParameter);
  if (createMethods.length !== 1) return undefined;
  const createMethod = createMethods[0]!;

  const updateMethods = matches.filter(match => (match.verb === 'put' || match.verb === 'patch') && match.entityParameter && match.idParameter);
  const updateMethod = updateMethods.length === 1
    ? updateMethods[0]
    : updateMethods.find(match => normalizeWord(match.declaration.name.getText(sourceFile)) === normalizeWord(requestedName));
  if (updateMethods.length > 1 && !updateMethod) return undefined;

  const entityParameter = createMethod.entityParameter!;
  const entityType = entityParameter.type?.getText(sourceFile);
  const entityParameterName = entityParameter.name.getText(sourceFile);
  if (!entityType || normalizeWord(entityType) !== normalizeWord(expectedEntityType)) return undefined;

  const idProof = updateMethod?.idParameter
    ? {
        type: updateMethod.idParameter.type?.getText(sourceFile),
        name: updateMethod.idParameter.name.getText(sourceFile),
        url: updateMethod.call.arguments[0]?.getText(sourceFile)
      }
    : findIdUrlProof(matches, sourceFile, modelText);
  if (!idProof?.type || !idProof.url) return undefined;

  const returnType = createMethod.declaration.type?.getText(sourceFile);
  if (!returnType || !new RegExp(`\\b${escapeRegex(expectedEntityType)}\\b`).test(returnType)) return undefined;

  return {
    sourceFile,
    classDeclaration,
    createMethod,
    updateMethod,
    updateMethodName: updateMethod?.declaration.name.getText(sourceFile) ?? requestedName,
    entityType,
    entityParameterName,
    idType: idProof.type,
    idParameterName: idProof.name ?? 'id',
    updateUrlExpression: idProof.url
  };
}

function findHttpMethodMatches(
  method: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
  entityType: string
): HttpMethodMatch[] {
  if (!method.body) return [];
  const parameters = method.parameters;
  const entityParameter = parameters.find(parameter =>
    parameter.type && normalizeWord(parameter.type.getText(sourceFile)) === normalizeWord(entityType)
  );
  const idParameter = parameters.find(parameter => parameter !== entityParameter && isIdParameter(parameter, sourceFile));
  const result: HttpMethodMatch[] = [];

  walk(method.body, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const verb = node.expression.name.text.toLowerCase();
    if (verb !== 'post' && verb !== 'put' && verb !== 'patch' && verb !== 'delete') return;
    const receiver = node.expression.expression;
    if (!ts.isPropertyAccessExpression(receiver) || receiver.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
    result.push({
      declaration: method,
      call: node,
      verb,
      httpField: receiver.name.text,
      entityParameter,
      idParameter
    });
  });
  return result;
}

function findIdUrlProof(
  matches: HttpMethodMatch[],
  sourceFile: ts.SourceFile,
  modelText: string | undefined
): { type?: string; name?: string; url?: string } | undefined {
  const byId = matches.find(match =>
    match.idParameter
    && match.call.arguments[0]
    && expressionContainsIdentifier(match.call.arguments[0]!, match.idParameter.name.getText(sourceFile), sourceFile)
  );
  if (byId?.idParameter && byId.call.arguments[0]) {
    return {
      type: byId.idParameter.type?.getText(sourceFile),
      name: byId.idParameter.name.getText(sourceFile),
      url: byId.call.arguments[0].getText(sourceFile)
    };
  }

  const modelIdType = modelText ? findModelIdType(modelText) : undefined;
  if (!modelIdType) return undefined;
  return undefined;
}

function findModelIdType(modelText: string): string | undefined {
  const sourceFile = ts.createSourceFile('model.ts', modelText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement) && !ts.isClassDeclaration(statement)) continue;
    const property = statement.members.find(member =>
      ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)
        ? member.name.getText(sourceFile) === 'id'
        : false
    );
    if (property && (ts.isPropertySignature(property) || ts.isPropertyDeclaration(property))) {
      return property.type?.getText(sourceFile);
    }
  }
  return undefined;
}

function buildComponentPlan(
  sourceText: string,
  filePath: string,
  expectedServiceClass: string | undefined,
  entityType: string,
  expectedEntityField: string | undefined,
  createMethodName: string,
  updateMethodName: string
): ComponentPlan | undefined {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const classDeclaration = sourceFile.statements.find(ts.isClassDeclaration);
  if (!classDeclaration) return undefined;

  const constructor = classDeclaration.members.find(ts.isConstructorDeclaration);
  const serviceParameter = constructor?.parameters.find(parameter => {
    const type = parameter.type?.getText(sourceFile);
    return type && (expectedServiceClass ? type === expectedServiceClass : /Service$/.test(type));
  });
  if (!serviceParameter) return undefined;
  const serviceField = serviceParameter.name.getText(sourceFile);

  const entityProperty = classDeclaration.members.filter(ts.isPropertyDeclaration).find(member => {
    if (!member.type || ts.isArrayTypeNode(member.type)) return false;
    if (expectedEntityField && member.name.getText(sourceFile) !== expectedEntityField) return false;
    return normalizeWord(member.type.getText(sourceFile)) === normalizeWord(entityType);
  });
  if (!entityProperty) return undefined;
  const entityField = entityProperty.name.getText(sourceFile);

  const methods = classDeclaration.members.filter(ts.isMethodDeclaration);
  for (const method of methods) {
    if (!method.body) continue;
    let createCall: ts.CallExpression | undefined;
    walk(method.body, node => {
      if (createCall || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const receiver = node.expression.expression;
      if (!ts.isPropertyAccessExpression(receiver) || receiver.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
      if (receiver.name.text !== serviceField || node.expression.name.text !== createMethodName) return;
      if (!node.arguments.some(argument => argument.getText(sourceFile) === `this.${entityField}`)) return;
      createCall = node;
    });
    if (!createCall) continue;
    if (!isObservableSubscription(createCall, sourceFile)) continue;
    return { sourceFile, classDeclaration, method, createCall, serviceField, entityField };
  }

  const alreadyUpdated = methods.find(method =>
    method.body && methodUsesUpdate(method, sourceFile, serviceField, updateMethodName)
  );
  if (alreadyUpdated) return undefined;
  return undefined;
}

function insertUpdateMethod(sourceText: string, plan: ServicePlan): string | undefined {
  const closing = plan.classDeclaration.end - 1;
  if (closing < 0 || sourceText[closing] !== '}') return undefined;
  const lineEnding = sourceText.includes('\r\n') ? '\r\n' : '\n';
  const indent = detectMemberIndent(sourceText, plan.classDeclaration, plan.sourceFile) || '  ';
  const bodyIndent = `${indent}  `;
  const returnType = plan.createMethod.declaration.type?.getText(plan.sourceFile);
  if (!returnType) return undefined;

  const method = [
    `${indent}${plan.updateMethodName}(${plan.idParameterName}: ${plan.idType}, ${plan.entityParameterName}: ${plan.entityType}): ${returnType} {`,
    `${bodyIndent}return this.${plan.createMethod.httpField}.put<${plan.entityType}>(${plan.updateUrlExpression}, ${plan.entityParameterName});`,
    `${indent}}`
  ].join(lineEnding);

  const before = sourceText.slice(0, closing).replace(/[ \t]+$/u, '');
  const after = sourceText.slice(closing);
  return `${before}${lineEnding}${lineEnding}${method}${lineEnding}${after}`;
}

function replaceCreateCallWithConditional(
  sourceText: string,
  plan: ComponentPlan,
  updateMethodName: string
): string | undefined {
  const start = plan.createCall.getStart(plan.sourceFile);
  const end = plan.createCall.end;
  const original = sourceText.slice(start, end);
  if (!original || sourceText.indexOf(original) !== sourceText.lastIndexOf(original)) {
    // Positional replacement remains safe even when the same expression appears elsewhere.
  }
  const indent = indentationAt(sourceText, start);
  const continuation = `${indent}  `;
  const entity = `this.${plan.entityField}`;
  const replacement = [
    `(${entity}.id != null`,
    `${continuation}? this.${plan.serviceField}.${updateMethodName}(${entity}.id, ${entity})`,
    `${continuation}: ${original})`
  ].join(sourceText.includes('\r\n') ? '\r\n' : '\n');
  return `${sourceText.slice(0, start)}${replacement}${sourceText.slice(end)}`;
}

function methodUsesUpdate(
  method: ts.MethodDeclaration,
  sourceFile: ts.SourceFile,
  serviceField: string,
  updateMethodName: string
): boolean {
  if (!method.body) return false;
  let found = false;
  walk(method.body, node => {
    if (found || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const receiver = node.expression.expression;
    if (!ts.isPropertyAccessExpression(receiver) || receiver.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
    if (receiver.name.text === serviceField && node.expression.name.text === updateMethodName) found = true;
  });
  return found && /\.id\b/.test(method.body.getText(sourceFile));
}

function isObservableSubscription(call: ts.CallExpression, sourceFile: ts.SourceFile): boolean {
  let current: ts.Node | undefined = call.parent;
  for (let depth = 0; current && depth < 6; depth += 1, current = current.parent) {
    if (ts.isPropertyAccessExpression(current) && current.name.text === 'subscribe') return true;
    if (ts.isStatement(current)) break;
  }
  const parentText = call.parent?.getText(sourceFile) ?? '';
  return parentText.includes('.subscribe');
}

function isIdParameter(parameter: ts.ParameterDeclaration, sourceFile: ts.SourceFile): boolean {
  const name = normalizeWord(parameter.name.getText(sourceFile));
  return name === 'id' || name.endsWith('id');
}

function expressionContainsIdentifier(expression: ts.Expression, identifier: string, sourceFile: ts.SourceFile): boolean {
  return new RegExp(`\\b${escapeRegex(identifier)}\\b`).test(expression.getText(sourceFile));
}


function requestedUpdateMethodName(request: string): string {
  const normalized = request.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\beditar\b/.test(normalized)) return 'editar';
  if (/\balterar\b/.test(normalized)) return 'alterar';
  if (/\batualizar\b/.test(normalized)) return 'atualizar';
  if (/\bedit\b/.test(normalized)) return 'edit';
  if (/\bupdate\b/.test(normalized)) return 'update';
  return UPDATE_WORD.test(request) ? 'atualizar' : 'update';
}

function applyEditCall(filePath: string, oldText: string, newText: string): ToolCall {
  return {
    id: randomUUID(),
    name: 'apply_edit',
    arguments: { filePath, oldText, newText, replaceAll: false }
  };
}

function detectMemberIndent(sourceText: string, classDeclaration: ts.ClassDeclaration, sourceFile: ts.SourceFile): string | undefined {
  const first = classDeclaration.members[0];
  return first ? indentationAt(sourceText, first.getStart(sourceFile)) : undefined;
}

function indentationAt(sourceText: string, offset: number): string {
  const lineStart = sourceText.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return sourceText.slice(lineStart, offset).match(/^\s*/)?.[0] ?? '';
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild(child => walk(child, visit));
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
