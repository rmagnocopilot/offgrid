import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as ts from 'typescript';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';

export interface StructuralEditFastPathResult {
  text: string;
  call: ToolCall;
  result: ToolResult;
}

export interface StructuralEditFastPathOptions {
  request: string;
  workspaceRoot?: string;
  priority: string[];
  execute: (call: ToolCall) => Promise<ToolResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface MethodRequest {
  methodName: string;
  parameterName: string;
  parameterType: string;
  returnType: string;
  helperName: string;
  collectionName: string;
}

const ADD_METHOD_PATTERN = /\b(?:adicione|adicionar|inclua|incluir|crie|criar|implemente|implementar|add|create|implement)\b/i;
const METHOD_SIGNATURE_PATTERN = /\bm[eé]todo\s+(?:p[uú]blico\s+)?([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*(?:\s*<[^>]+>)?(?:\s*\[\])?)\s*\)\s*(?::\s*([A-Za-z_$][\w$]*(?:\s*<[^>]+>)?(?:\s*\[\])?))?/i;
const TRANSFORM_PATTERN = /\b(?:converta|converter|transforme|transformar|mapeie|mapear|convert|transform|map)\b/i;
const APPEND_PATTERN = /\b(?:adicione|adicionar|inclua|incluir|acrescente|acrescentar|append|push)\b/i;

export async function tryPrepareStructuralEditFastPath(
  options: StructuralEditFastPathOptions
): Promise<StructuralEditFastPathResult | undefined> {
  const root = options.workspaceRoot;
  if (!root) return undefined;

  const parsedRequest = parseMethodRequest(options.request);
  if (!parsedRequest) return undefined;

  const prioritized = options.priority
    .map(item => item.split('#')[0]?.replace(/\\/g, '/'))
    .find((item): item is string => typeof item === 'string' && /\.(?:ts|tsx)$/i.test(item) && !/\.(?:spec|test)\./i.test(item));
  if (!prioritized) return undefined;

  let filePath: string;
  let sourceText: string;
  try {
    filePath = normalizeRelativePath(prioritized);
    sourceText = await fsp.readFile(resolveInsideRoot(root, filePath), 'utf8');
  } catch (error) {
    options.warn?.(`[StructuralFastPath] Não foi possível ler o arquivo prioritário: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const edit = buildMethodInsertion(sourceText, filePath, parsedRequest);
  if (!edit) return undefined;

  const call: ToolCall = {
    id: randomUUID(),
    name: 'apply_edit',
    arguments: {
      filePath,
      oldText: edit.oldText,
      newText: edit.newText,
      replaceAll: false
    }
  };

  options.info?.(
    `[StructuralFastPath] Inserção estrutural de método detectada; modelo não será chamado. arquivo=${filePath} método=${parsedRequest.methodName}`
  );

  const result = await options.execute(call);
  if (!result.ok) {
    options.warn?.(`[StructuralFastPath] apply_edit falhou; seguindo pelo AgentLoop: ${result.error ?? 'erro desconhecido'}`);
    return undefined;
  }

  return {
    call,
    result,
    text: [
      'Alteração preparada para revisão.',
      `Arquivo: ${filePath}`,
      `Método adicionado: ${parsedRequest.methodName}`
    ].join('\n\n')
  };
}

export function parseMethodRequest(request: string): MethodRequest | undefined {
  const normalized = String(request ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized || !ADD_METHOD_PATTERN.test(normalized)) return undefined;
  if (!TRANSFORM_PATTERN.test(normalized) || !APPEND_PATTERN.test(normalized)) return undefined;

  const signature = normalized.match(METHOD_SIGNATURE_PATTERN);
  if (!signature) return undefined;

  const helperName = normalized.match(
    /\b(?:com|usando|utilizando|atrav[eé]s\s+de)\s+(?:o\s+m[eé]todo\s+)?([A-Za-z_$][\w$]*)\b/i
  )?.[1];
  const collectionName = normalized.match(
    /\b(?:ao\s+final\s+de|no\s+final\s+de|final\s+de)\s+(?:this\.)?([A-Za-z_$][\w$]*)\b/i
  )?.[1];

  if (!helperName || !collectionName) return undefined;

  return {
    methodName: signature[1]!,
    parameterName: signature[2]!,
    parameterType: signature[3]!.replace(/\s+/g, ' ').trim(),
    returnType: (signature[4] ?? 'void').replace(/\s+/g, ' ').trim(),
    helperName,
    collectionName
  };
}

function buildMethodInsertion(
  sourceText: string,
  filePath: string,
  request: MethodRequest
): { oldText: string; newText: string } | undefined {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    filePath.toLowerCase().endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const classDeclaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement)
      && Boolean(statement.name)
      && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  ) ?? sourceFile.statements.find(ts.isClassDeclaration);

  if (!classDeclaration || !classDeclaration.name) return undefined;

  const existingMethod = classDeclaration.members.find(
    member => ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === request.methodName
  );
  if (existingMethod) return undefined;

  const helper = classDeclaration.members.find(
    (member): member is ts.MethodDeclaration =>
      ts.isMethodDeclaration(member) && member.name.getText(sourceFile) === request.helperName
  );
  if (!helper || !helper.body || helper.parameters.length < 1 || helper.parameters.length > 2) {
    return undefined;
  }

  const collection = classDeclaration.members.find(
    (member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && member.name.getText(sourceFile) === request.collectionName
  );
  if (!collection || !isArrayProperty(collection, sourceFile)) return undefined;

  if (!typeAppearsInSource(request.parameterType, sourceText)) return undefined;

  const members = classDeclaration.members;
  const lastMember = members.at(-1);
  if (!lastMember) return undefined;

  const lineEnding = sourceText.includes('\r\n') ? '\r\n' : '\n';
  const memberStart = lastMember.getStart(sourceFile);
  const oldText = sourceText.slice(memberStart, classDeclaration.end);
  if (!oldText || sourceText.indexOf(oldText) !== sourceText.lastIndexOf(oldText)) return undefined;

  const lastMemberText = sourceText.slice(memberStart, lastMember.end);
  const classTail = sourceText.slice(lastMember.end, classDeclaration.end);
  const indent = indentationAt(sourceText, memberStart);
  const bodyIndent = `${indent}  `;
  const helperArguments = helper.parameters.length === 2
    ? `${request.parameterName}, this.${request.collectionName}.length`
    : request.parameterName;

  const methodText = [
    `${indent}public ${request.methodName}(${request.parameterName}: ${request.parameterType}): ${request.returnType} {`,
    `${bodyIndent}const valorConvertido = this.${request.helperName}(${helperArguments});`,
    `${bodyIndent}this.${request.collectionName} = [...this.${request.collectionName}, valorConvertido];`,
    `${indent}}`
  ].join(lineEnding);

  return {
    oldText,
    newText: `${lastMemberText}${lineEnding}${lineEnding}${methodText}${classTail}`
  };
}

function isArrayProperty(property: ts.PropertyDeclaration, sourceFile: ts.SourceFile): boolean {
  if (property.type) {
    if (ts.isArrayTypeNode(property.type)) return true;
    const typeText = property.type.getText(sourceFile).replace(/\s+/g, '');
    if (/^(?:Readonly)?Array<.+>$/.test(typeText) || /\[\]$/.test(typeText)) return true;
  }

  return Boolean(property.initializer && ts.isArrayLiteralExpression(property.initializer));
}

function typeAppearsInSource(typeText: string, sourceText: string): boolean {
  const baseType = typeText.match(/[A-Za-z_$][\w$]*/)?.[0];
  if (!baseType) return false;
  if (['any', 'unknown', 'string', 'number', 'boolean', 'object'].includes(baseType)) return true;
  return new RegExp(`\\b${escapeRegExp(baseType)}\\b`).test(sourceText);
}

function indentationAt(sourceText: string, offset: number): string {
  const lineStart = sourceText.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return sourceText.slice(lineStart, offset).match(/^\s*/)?.[0] ?? '  ';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
