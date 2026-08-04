import * as fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as ts from 'typescript';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';

export interface DocumentationFastPathResult {
  text: string;
  call?: ToolCall;
  result?: ToolResult;
}

export interface DocumentationFastPathOptions {
  request: string;
  workspaceRoot?: string;
  priority: string[];
  execute: (call: ToolCall) => Promise<ToolResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

const DOCUMENT_ACTION = /\b(?:adicione|adicionar|inclua|incluir|crie|criar|escreva|escrever|documente|documentar|add|write|document)\b/i;
const JSDOC_TARGET = /\b(?:coment[aá]rio\s+)?jsdoc\b|\bdocumenta(?:c|ç)(?:a|ã)o\b/i;
const CLASS_TARGET = /\bclasse\b|\bclass\b/i;

export async function tryPrepareDocumentationFastPath(
  options: DocumentationFastPathOptions
): Promise<DocumentationFastPathResult | undefined> {
  const root = options.workspaceRoot;
  if (!root || !isClassDocumentationRequest(options.request)) return undefined;

  const prioritized = options.priority
    .map(item => item.split('#')[0]?.replace(/\\/g, '/'))
    .find((item): item is string =>
      typeof item === 'string'
      && /\.(?:ts|tsx|js|jsx)$/i.test(item)
      && !/\.(?:spec|test)\./i.test(item)
    );
  if (!prioritized) return undefined;

  let filePath: string;
  let sourceText: string;
  try {
    filePath = normalizeRelativePath(prioritized);
    sourceText = await fsp.readFile(resolveInsideRoot(root, filePath), 'utf8');
  } catch (error) {
    options.warn?.(`[DocumentationFastPath] Não foi possível ler o arquivo prioritário: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }

  const edit = buildClassDocumentationEdit(sourceText, filePath);
  if (!edit) return undefined;

  if (edit.alreadyDocumented) {
    options.info?.(`[DocumentationFastPath] A classe já possui JSDoc. arquivo=${filePath} classe=${edit.className}`);
    return {
      text: [
        'Nenhuma alteração foi necessária.',
        `Arquivo: ${filePath}`,
        `A classe ${edit.className} já possui documentação JSDoc.`
      ].join('\n\n')
    };
  }

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

  options.info?.(`[DocumentationFastPath] JSDoc de classe detectado; modelo não será chamado. arquivo=${filePath} classe=${edit.className}`);
  const result = await options.execute(call);
  if (!result.ok) {
    options.warn?.(`[DocumentationFastPath] apply_edit falhou; seguindo pelo AgentLoop: ${result.error ?? 'erro desconhecido'}`);
    return undefined;
  }

  return {
    call,
    result,
    text: [
      'Alteração preparada para revisão.',
      `Arquivo: ${filePath}`,
      `Documentação adicionada à classe: ${edit.className}`
    ].join('\n\n')
  };
}

export function isClassDocumentationRequest(request: string): boolean {
  const normalized = String(request ?? '').replace(/\s+/g, ' ').trim();
  return Boolean(
    normalized
    && DOCUMENT_ACTION.test(normalized)
    && JSDOC_TARGET.test(normalized)
    && CLASS_TARGET.test(normalized)
  );
}

interface DocumentationEdit {
  className: string;
  oldText: string;
  newText: string;
  alreadyDocumented: boolean;
}

function buildClassDocumentationEdit(
  sourceText: string,
  filePath: string
): DocumentationEdit | undefined {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(filePath)
  );

  const classDeclaration = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement)
      && Boolean(statement.name)
      && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
  ) ?? sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration => ts.isClassDeclaration(statement) && Boolean(statement.name)
  );

  const className = classDeclaration?.name?.text;
  if (!classDeclaration || !className) return undefined;

  const start = classDeclaration.getStart(sourceFile);
  const fullStart = classDeclaration.getFullStart();
  const leading = sourceText.slice(fullStart, start);
  if (/\/\*\*[\s\S]*?\*\/\s*$/.test(leading)) {
    return { className, oldText: '', newText: '', alreadyDocumented: true };
  }

  const anchorEnd = classDeclaration.name.end;
  const oldText = sourceText.slice(start, anchorEnd);
  if (!oldText || sourceText.indexOf(oldText) !== sourceText.lastIndexOf(oldText)) return undefined;

  const lineEnding = sourceText.includes('\r\n') ? '\r\n' : '\n';
  const indent = indentationAt(sourceText, start);
  const description = describeResponsibility(classDeclaration, sourceFile, className);
  const jsdoc = [
    `${indent}/**`,
    `${indent} * ${description}`,
    `${indent} */`
  ].join(lineEnding);

  return {
    className,
    oldText,
    newText: `${jsdoc}${lineEnding}${oldText}`,
    alreadyDocumented: false
  };
}

function describeResponsibility(
  declaration: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  className: string
): string {
  const text = declaration.getText(sourceFile);
  const baseName = humanizeClassName(className);

  if (/\bListComponent$/.test(className) || /\b(?:listar|carregar|load)\s*\(/i.test(text)) {
    return `Responsável por carregar e exibir a listagem de ${baseName}.`;
  }
  if (/\bComponent$/.test(className) || /@Component\s*\(/.test(text)) {
    return `Responsável pela interface e pelo comportamento de ${baseName}.`;
  }
  if (/\bService$/.test(className) || /@Injectable\s*\(/.test(text)) {
    return `Centraliza as operações e integrações de ${baseName}.`;
  }
  if (/\b(?:Controller|Resource)$/.test(className)) {
    return `Expõe as operações disponíveis para ${baseName}.`;
  }
  if (/\b(?:Repository|Store)$/.test(className)) {
    return `Gerencia o acesso aos dados de ${baseName}.`;
  }
  return `Centraliza a responsabilidade de ${baseName} neste módulo.`;
}

function humanizeClassName(className: string): string {
  const withoutSuffix = className
    .replace(/ListComponent$/, '')
    .replace(/Component$/, '')
    .replace(/Service$/, '')
    .replace(/Controller$/, '')
    .replace(/Resource$/, '')
    .replace(/Repository$/, '')
    .replace(/Store$/, '');

  const words = withoutSuffix
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();

  return words || className;
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (normalized.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (normalized.endsWith('.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function indentationAt(sourceText: string, offset: number): string {
  const lineStart = sourceText.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return sourceText.slice(lineStart, offset).match(/^\s*/)?.[0] ?? '';
}
