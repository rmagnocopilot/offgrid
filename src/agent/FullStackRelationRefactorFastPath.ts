import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';
import type {
  FullStackRelationRefactorAnalysis,
  RelationRefactorField
} from './FullStackRelationRefactorIntent';

export interface FullStackRelationRefactorFastPathResult {
  text: string;
  calls: ToolCall[];
  results: ToolResult[];
  complete: boolean;
}

export interface FullStackRelationRefactorFastPathOptions {
  request: string;
  workspaceRoot?: string;
  analysis?: FullStackRelationRefactorAnalysis;
  execute: (call: ToolCall) => Promise<ToolResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface ExistingField {
  name: string;
  type: string;
}

export async function tryPrepareFullStackRelationRefactorFastPath(
  options: FullStackRelationRefactorFastPathOptions
): Promise<FullStackRelationRefactorFastPathResult | undefined> {
  const root = options.workspaceRoot;
  const analysis = options.analysis;
  if (!root || !analysis) return undefined;

  if (analysis.errors.length || !analysis.entityType || !analysis.backendModelFile
    || !analysis.frontendModelFile || !analysis.componentTemplateFile || !analysis.desiredFields.length) {
    options.warn?.(`[FullStackRelationRefactorFastPath] Refatoração bloqueada sem chamar o modelo. erros=${analysis.errors.join(' | ') || 'estrutura incompleta'}`);
    return {
      text: [
        'A refatoração do relacionamento não foi preparada.',
        `Entidade: ${analysis.entityType ?? 'não identificada'}`,
        ...(analysis.errors.length ? analysis.errors : ['A estrutura necessária não foi comprovada.']),
        'Nenhum arquivo foi criado ou alterado.'
      ].join('\n\n'),
      calls: [],
      results: [],
      complete: true
    };
  }

  const backendOriginal = await readRequired(root, analysis.backendModelFile);
  const frontendOriginal = await readRequired(root, analysis.frontendModelFile);
  const templateOriginal = await readRequired(root, analysis.componentTemplateFile);
  if (!backendOriginal || !frontendOriginal || !templateOriginal) {
    return blocked(analysis, 'Um ou mais arquivos-alvo não puderam ser lidos.');
  }

  if (!isPlainJavaDataModel(backendOriginal, analysis.entityType)) {
    return blocked(analysis, `O modelo Java ${analysis.entityType} possui lógica além de campos, construtores e acessores; a refatoração automática foi bloqueada.`);
  }
  if (!isPlainTypeScriptModel(frontendOriginal, analysis.entityType)) {
    return blocked(analysis, `O model TypeScript ${analysis.entityType} não é uma interface ou classe de dados simples.`);
  }

  const existingJavaFields = parseJavaFields(backendOriginal);
  if (isRelationRefactorAlreadyApplied(
    backendOriginal,
    frontendOriginal,
    templateOriginal,
    analysis.frontendModelFile,
    analysis.desiredFields,
    root
  )) {
    options.info?.([
      '[FullStackRelationRefactorFastPath] Refatoração já aplicada; nenhuma alteração será preparada.',
      `entidade=${analysis.entityType}`
    ].join(' '));
    return {
      text: [
        'Nenhuma alteração foi necessária.',
        `A entidade ${analysis.entityType} já possui os relacionamentos solicitados, o model TypeScript já utiliza esses objetos e a listagem já acessa os campos relacionados.`,
        'Nenhum arquivo foi criado ou alterado.'
      ].join('\n\n'),
      calls: [],
      results: [],
      complete: true
    };
  }

  const mappings = buildFlattenedFieldMappings(existingJavaFields, analysis.desiredFields);
  const backendUpdated = buildJavaModel(backendOriginal, analysis.entityType, analysis.desiredFields, root);
  const frontendUpdated = buildTypeScriptModel(
    frontendOriginal,
    analysis.entityType,
    analysis.frontendModelFile,
    analysis.desiredFields
  );
  const templateUpdated = updateTemplate(templateOriginal, mappings);

  if (!backendUpdated || !frontendUpdated) {
    return blocked(analysis, 'Os modelos Java e TypeScript não puderam ser reconstruídos com segurança.');
  }
  if (mappings.length === 0) {
    return blocked(analysis, 'Nenhum campo duplicado pôde ser associado aos novos relacionamentos.');
  }
  if (templateUpdated === templateOriginal) {
    return blocked(analysis, 'A listagem existente não contém referências aos campos duplicados que seriam substituídos.');
  }

  const changes = [
    { filePath: analysis.backendModelFile, oldText: backendOriginal, newText: backendUpdated },
    { filePath: analysis.frontendModelFile, oldText: frontendOriginal, newText: frontendUpdated },
    { filePath: analysis.componentTemplateFile, oldText: templateOriginal, newText: templateUpdated }
  ].filter(change => change.oldText !== change.newText);

  if (!changes.length) {
    return {
      text: `Nenhuma alteração foi necessária. A entidade ${analysis.entityType} já usa os relacionamentos solicitados.`,
      calls: [],
      results: [],
      complete: true
    };
  }

  options.info?.([
    '[FullStackRelationRefactorFastPath] Refatoração estrutural comprovada; modelo não será chamado.',
    `entidade=${analysis.entityType}`,
    `alterações=${changes.length}`,
    `mapeamentos=${mappings.map(mapping => `${mapping.oldName}->${mapping.newPath}`).join(',')}`
  ].join(' '));

  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];
  for (const change of changes) {
    const call: ToolCall = {
      id: randomUUID(),
      name: 'apply_edit',
      arguments: {
        filePath: change.filePath,
        oldText: change.oldText,
        newText: change.newText,
        replaceAll: false
      }
    };
    calls.push(call);
    const result = await options.execute(call);
    results.push(result);
    if (!result.ok) {
      return {
        text: [
          'A refatoração não foi preparada integralmente.',
          `Falha em: ${change.filePath}`,
          'Revise ou rejeite eventuais alterações já preparadas.'
        ].join('\n\n'),
        calls,
        results,
        complete: false
      };
    }
  }

  return {
    text: [
      'Relacionamentos do fluxo preparados para revisão.',
      `Entidade: ${analysis.entityType}`,
      `Modelo Java: ${analysis.backendModelFile}`,
      `Model TypeScript: ${analysis.frontendModelFile}`,
      `Listagem: ${analysis.componentTemplateFile}`,
      `Relacionamentos: ${analysis.desiredFields.filter(field => field.kind === 'relation').map(field => field.javaType).join(', ')}`,
      'Endpoint, services e componente TypeScript foram preservados.'
    ].join('\n\n'),
    calls,
    results,
    complete: true
  };
}

function blocked(
  analysis: FullStackRelationRefactorAnalysis,
  reason: string
): FullStackRelationRefactorFastPathResult {
  return {
    text: [
      'A refatoração do relacionamento não foi preparada.',
      `Entidade: ${analysis.entityType ?? 'não identificada'}`,
      reason,
      'Nenhum arquivo foi criado ou alterado.'
    ].join('\n\n'),
    calls: [],
    results: [],
    complete: true
  };
}

function isRelationRefactorAlreadyApplied(
  backendModel: string,
  frontendModel: string,
  template: string,
  frontendModelFile: string,
  desiredFields: RelationRefactorField[],
  root: string
): boolean {
  const javaFields = parseJavaFields(backendModel);
  const typeScriptFields = parseTypeScriptFields(frontendModel);
  if (!sameFieldShape(
    javaFields,
    desiredFields.map(field => ({ name: field.name, type: field.javaType }))
  )) return false;
  if (!sameFieldShape(
    typeScriptFields,
    desiredFields.map(field => ({ name: field.name, type: field.typeScriptType }))
  )) return false;

  for (const relation of desiredFields.filter(field => field.kind === 'relation')) {
    if (!hasNestedTemplateAccess(template, relation.name)) return false;
    if (!hasTypeScriptRelationImport(
      frontendModel,
      frontendModelFile,
      relation
    )) return false;
    if (!hasJavaRelationImport(backendModel, relation, root)) return false;
  }

  return true;
}

function sameFieldShape(actual: ExistingField[], expected: ExistingField[]): boolean {
  if (actual.length !== expected.length) return false;
  return expected.every(field => actual.some(candidate =>
    sameIdentifier(candidate.name, field.name)
      && normalizeType(candidate.type) === normalizeType(field.type)
  ));
}

function parseTypeScriptFields(content: string): ExistingField[] {
  const body = content.match(/(?:interface|class)\s+\w+(?:\s+extends\s+[^\{]+)?\s*\{([\s\S]*?)\}/m)?.[1];
  if (!body) return [];
  return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(?:\?)?\s*:\s*([^;\r\n]+)[;]?/gm)]
    .map(match => ({ name: match[1]!, type: match[2]!.trim() }));
}

function hasNestedTemplateAccess(template: string, relationName: string): boolean {
  return new RegExp(`\\b[A-Za-z_$][\\w$]*\\.${escapeRegex(relationName)}\\.[A-Za-z_$][\\w$]*\\b`).test(template);
}

function hasTypeScriptRelationImport(
  content: string,
  targetFile: string,
  relation: RelationRefactorField
): boolean {
  const relatedPath = relation.relatedTypeScriptModelFile;
  if (!relatedPath) return false;
  let modulePath = path.posix.relative(path.posix.dirname(targetFile), relatedPath).replace(/\.ts$/i, '');
  if (!modulePath.startsWith('.')) modulePath = `./${modulePath}`;
  return new RegExp(
    `^\\s*import\\s*\\{[^}]*\\b${escapeRegex(relation.typeScriptType)}\\b[^}]*\\}\\s*from\\s*['"]${escapeRegex(modulePath)}['"]\\s*;?`,
    'm'
  ).test(content);
}

function hasJavaRelationImport(
  content: string,
  relation: RelationRefactorField,
  root: string
): boolean {
  const relatedPath = relation.relatedJavaModelFile;
  if (!relatedPath) return false;
  const relatedContent = safeRead(root, relatedPath);
  const relatedPackage = relatedContent?.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
  const currentPackage = content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
  if (!relatedPackage || relatedPackage === currentPackage) return true;
  return new RegExp(
    `^\\s*import\\s+${escapeRegex(relatedPackage)}\\.${escapeRegex(relation.javaType)}\\s*;`,
    'm'
  ).test(content);
}

function normalizeType(value: string): string {
  return value.replace(/\s+/g, '').replace(/;$/, '');
}

function buildJavaModel(
  original: string,
  entityType: string,
  fields: RelationRefactorField[],
  root: string
): string | undefined {
  const classMatch = original.match(new RegExp(`\\b(?:public\\s+)?class\\s+${escapeRegex(entityType)}\\b[^\\{]*\\{`));
  if (!classMatch || classMatch.index === undefined) return undefined;
  const openBrace = classMatch.index + classMatch[0].length - 1;
  const closeBrace = findMatchingBrace(original, openBrace);
  if (closeBrace < 0) return undefined;

  let prefix = original.slice(0, openBrace + 1);
  const suffix = original.slice(closeBrace);
  const packageName = original.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
  for (const field of fields.filter(item => item.kind === 'relation')) {
    const relatedPath = field.relatedJavaModelFile;
    if (!relatedPath) continue;
    const relatedContent = safeRead(root, relatedPath);
    const relatedPackage = relatedContent?.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
    if (relatedPackage && relatedPackage !== packageName) {
      prefix = ensureJavaImport(prefix, `${relatedPackage}.${field.javaType}`);
    }
  }

  const line = lineEnding(original);
  const fieldLines = fields.map(field => `    private ${field.javaType} ${field.name};`);
  const args = fields.map(field => `${field.javaType} ${field.name}`).join(', ');
  const assignments = fields.map(field => `        this.${field.name} = ${field.name};`);
  const accessors = fields.flatMap(field => {
    const upper = capitalize(field.name);
    const getter = field.javaType === 'boolean' || field.javaType === 'Boolean' ? `is${upper}` : `get${upper}`;
    return [
      `    public ${field.javaType} ${getter}() { return ${field.name}; }`,
      `    public void set${upper}(${field.javaType} ${field.name}) { this.${field.name} = ${field.name}; }`
    ];
  });

  const body = [
    '',
    ...fieldLines,
    '',
    `    public ${entityType}() {}`,
    '',
    `    public ${entityType}(${args}) {`,
    ...assignments,
    '    }',
    '',
    ...accessors,
    ''
  ].join(line);

  return `${prefix}${body}${suffix}`;
}

function buildTypeScriptModel(
  original: string,
  entityType: string,
  targetFile: string,
  fields: RelationRefactorField[]
): string | undefined {
  if (!new RegExp(`\\b(?:interface|class)\\s+${escapeRegex(entityType)}\\b`).test(original)) return undefined;
  const line = lineEnding(original);
  const imports = fields.filter(field => field.kind === 'relation').map(field => {
    const relatedPath = field.relatedTypeScriptModelFile;
    if (!relatedPath) return undefined;
    let modulePath = path.posix.relative(path.posix.dirname(targetFile), relatedPath).replace(/\.ts$/i, '');
    if (!modulePath.startsWith('.')) modulePath = `./${modulePath}`;
    return `import { ${field.typeScriptType} } from '${modulePath}';`;
  }).filter((value): value is string => Boolean(value));
  const body = fields.map(field => `  ${field.name}: ${field.typeScriptType};`);
  return [
    ...imports,
    ...(imports.length ? [''] : []),
    `export interface ${entityType} {`,
    ...body,
    '}',
    ''
  ].join(line);
}

function buildFlattenedFieldMappings(
  existingFields: ExistingField[],
  desiredFields: RelationRefactorField[]
): Array<{ oldName: string; newPath: string }> {
  const mappings: Array<{ oldName: string; newPath: string }> = [];
  for (const relation of desiredFields.filter(field => field.kind === 'relation')) {
    const relationName = normalizeIdentifier(relation.name);
    const relationType = normalizeIdentifier(relation.javaType);
    for (const existing of existingFields) {
      const existingName = normalizeIdentifier(existing.name);
      if (desiredFields.some(field => sameIdentifier(field.name, existing.name))) continue;
      let nestedName: string | undefined;
      if (existingName.endsWith(relationType) && existingName.length > relationType.length) {
        nestedName = existingName.slice(0, -relationType.length);
      } else if (existingName.startsWith(relationName) && existingName.length > relationName.length) {
        nestedName = existingName.slice(relationName.length);
      }
      if (!nestedName) continue;
      const relatedField = relation.relatedFields.find(field => normalizeIdentifier(field) === nestedName);
      if (!relatedField) continue;
      mappings.push({ oldName: existing.name, newPath: `${relation.name}.${relatedField}` });
    }
  }
  return deduplicateMappings(mappings);
}

function updateTemplate(
  original: string,
  mappings: Array<{ oldName: string; newPath: string }>
): string {
  let updated = original;
  for (const mapping of mappings) {
    updated = updated.replace(
      new RegExp(`\\b([A-Za-z_$][\\w$]*)\\.${escapeRegex(mapping.oldName)}\\b`, 'g'),
      `$1.${mapping.newPath}`
    );
  }
  return updated;
}

function isPlainJavaDataModel(content: string, entityType: string): boolean {
  const classMatch = content.match(new RegExp(`\\bclass\\s+${escapeRegex(entityType)}\\b[^\\{]*\\{`));
  if (!classMatch || classMatch.index === undefined) return false;
  const openBrace = classMatch.index + classMatch[0].length - 1;
  const closeBrace = findMatchingBrace(content, openBrace);
  if (closeBrace < 0) return false;
  const body = content.slice(openBrace + 1, closeBrace);
  const methodNames = [...body.matchAll(/\b(?:public|protected|private)\s+(?:static\s+)?(?:[A-Za-z_$][\w$<>?, .\[\]]*\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{/g)]
    .map(match => match[1]!);
  return methodNames.every(name => name === entityType || /^(?:get|set|is)[A-Z_$]/.test(name));
}

function isPlainTypeScriptModel(content: string, entityType: string): boolean {
  if (new RegExp(`\\binterface\\s+${escapeRegex(entityType)}\\b`).test(content)) return true;
  if (!new RegExp(`\\bclass\\s+${escapeRegex(entityType)}\\b`).test(content)) return false;
  return !/\b(?:public|private|protected)?\s*[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.test(content);
}

function parseJavaFields(content: string): ExistingField[] {
  return [...content.matchAll(/\bprivate\s+(?:final\s+)?([A-Za-z_$][\w$<>?, .]*)\s+([A-Za-z_$][\w$]*)\s*;/g)]
    .map(match => ({ type: match[1]!.trim(), name: match[2]! }));
}

async function readRequired(root: string, filePath: string): Promise<string | undefined> {
  try { return await fsp.readFile(resolveInsideRoot(root, filePath), 'utf8'); } catch { return undefined; }
}

function safeRead(root: string, filePath: string): string | undefined {
  try {
    const absolute = resolveInsideRoot(root, filePath);
    return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined;
  } catch { return undefined; }
}

function ensureJavaImport(content: string, qualifiedName: string): string {
  const simple = qualifiedName.split('.').at(-1)!;
  if (new RegExp(`^\\s*import\\s+${escapeRegex(qualifiedName)}\\s*;`, 'm').test(content)) return content;
  if (new RegExp(`^\\s*import\\s+[\\w.]+\\.${escapeRegex(simple)}\\s*;`, 'm').test(content)) return content;
  const imports = [...content.matchAll(/^\s*import\s+[\w.*]+\s*;\s*$/gm)];
  const line = lineEnding(content);
  const last = imports.at(-1);
  if (last?.index !== undefined) {
    const end = last.index + last[0].length;
    return `${content.slice(0, end)}${line}import ${qualifiedName};${content.slice(end)}`;
  }
  const packageMatch = content.match(/^\s*package\s+[\w.]+\s*;\s*$/m);
  if (!packageMatch || packageMatch.index === undefined) return content;
  const end = packageMatch.index + packageMatch[0].length;
  return `${content.slice(0, end)}${line}${line}import ${qualifiedName};${content.slice(end)}`;
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function deduplicateMappings(
  mappings: Array<{ oldName: string; newPath: string }>
): Array<{ oldName: string; newPath: string }> {
  const seen = new Set<string>();
  return mappings.filter(mapping => {
    const key = normalizeIdentifier(mapping.oldName);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeIdentifier(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_$]+/g, '');
}

function sameIdentifier(left: string, right: string): boolean {
  return normalizeIdentifier(left) === normalizeIdentifier(right);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function lineEnding(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
