import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';
import { generatedFileContentIssue } from './AgentTaskPolicy';

export interface JavaUnitTestFastPathResult {
  text: string;
  calls: ToolCall[];
  results: ToolResult[];
}

export interface JavaUnitTestFastPathOptions {
  request: string;
  workspaceRoot?: string;
  priority: string[];
  execute: (call: ToolCall) => Promise<ToolResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface JavaImport {
  simpleName: string;
  qualifiedName: string;
}

interface JavaField {
  typeName: string;
  name: string;
}

interface JavaListMethodScenario {
  sourcePath: string;
  testPath: string;
  pomPath?: string;
  packageName: string;
  className: string;
  methodName: string;
  itemType: string;
  dependency: JavaField;
  dependencyMethod: string;
  imports: JavaImport[];
}

const CREATE_PATTERN = /\b(?:crie|criar|gere|gerar|adicione|adicionar|escreva|escrever|create|generate|add|write)\b/i;
const TEST_PATTERN = /\b(?:teste(?:s)?\s+unit[aá]rio(?:s)?|unit\s+tests?|junit|mockito)\b/i;
const JUNIT_FOUR_PATTERN = /\bjunit\s*4\b/i;
const METHOD_PATTERN = /\b(?:m[eé]todo|method)\s+([A-Za-z_$][\w$]*)\s*\(/i;
const MAIN_JAVA_SEGMENT = '/src/main/java/';

export async function tryPrepareJavaUnitTestFastPath(
  options: JavaUnitTestFastPathOptions
): Promise<JavaUnitTestFastPathResult | undefined> {
  const root = options.workspaceRoot;
  if (!root || !isCandidateRequest(options.request)) return undefined;

  const requestedMethod = options.request.match(METHOD_PATTERN)?.[1];
  const sourcePath = requestedMethod
    ? await resolveJavaSource(root, options.priority, requestedMethod)
    : undefined;
  if (!sourcePath) {
    const methodLabel = requestedMethod ? `${requestedMethod}()` : 'solicitado';
    options.warn?.(
      `[JavaTestFastPath] Não foi possível identificar com segurança o service do método ${methodLabel}; `
      + 'modelo não será chamado para evitar criar ou alterar o arquivo errado.'
    );
    return {
      calls: [],
      results: [],
      text: [
        `Não foi possível identificar com segurança qual service contém o método ${methodLabel}.`,
        'Nenhuma alteração foi preparada. Abra o arquivo do service e repita o pedido.'
      ].join('\n\n')
    };
  }

  const sourceText = await fsp.readFile(resolveInsideRoot(root, sourcePath), 'utf8');
  const scenario = analyzeJavaListMethod(sourcePath, sourceText, options.request, root);
  if (!scenario) {
    options.warn?.('[JavaTestFastPath] O service não corresponde a um padrão seguro de método List<T> delegado; usando o AgentLoop.');
    return undefined;
  }

  const content = buildJUnit4MockitoTest(scenario);
  const validationIssue = generatedFileContentIssue(scenario.testPath, content, {
    request: options.request,
    sources: [{ filePath: scenario.sourcePath, content: sourceText }]
  });
  if (validationIssue) {
    options.warn?.(`[JavaTestFastPath] Conteúdo local rejeitado pela validação: ${validationIssue}`);
    return undefined;
  }

  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];

  const testAbsolute = resolveInsideRoot(root, scenario.testPath);
  const existingTest = await readOptional(testAbsolute);
  if (existingTest === undefined) {
    calls.push(createFileCall(scenario.testPath, content));
  } else if (!isEquivalentJUnit4MockitoTest(existingTest, scenario)) {
    calls.push(replaceFileCall(scenario.testPath, existingTest, content));
  }

  if (scenario.pomPath) {
    const pomAbsolute = resolveInsideRoot(root, scenario.pomPath);
    const pom = await readOptional(pomAbsolute);
    if (pom !== undefined) {
      const pomEdit = buildPomDependencyEdit(scenario.pomPath, pom);
      if (pomEdit) calls.push(pomEdit);
    }
  }

  options.info?.([
    '[JavaTestFastPath] Teste JUnit 4 + Mockito detectado; modelo não será chamado.',
    `origem=${scenario.sourcePath}`,
    `arquivo=${scenario.testPath}`,
    `método=${scenario.methodName}`,
    `alterações=${calls.length}`
  ].join(' '));

  if (!calls.length) {
    return {
      calls,
      results,
      text: [
        'O teste unitário JUnit 4 já está atualizado.',
        `Arquivo: ${scenario.testPath}`
      ].join('\n\n')
    };
  }

  for (const call of calls) {
    const result = await options.execute(call);
    results.push(result);
    if (!result.ok) {
      options.warn?.(`[JavaTestFastPath] ${call.name} falhou; usando o AgentLoop: ${result.error ?? 'erro desconhecido'}`);
      return undefined;
    }
  }

  const changedFiles = calls
    .map(call => String(call.arguments.filePath ?? ''))
    .filter(Boolean);

  return {
    calls,
    results,
    text: [
      'Teste unitário JUnit 4 preparado para revisão.',
      `Arquivo: ${scenario.testPath}`,
      `Método testado: ${scenario.methodName}().`,
      changedFiles.length > 1
        ? `Dependências de teste verificadas em: ${scenario.pomPath}.`
        : 'As dependências JUnit 4 e Mockito já estavam configuradas.'
    ].join('\n\n')
  };
}

function isCandidateRequest(request: string): boolean {
  const normalized = String(request ?? '').replace(/\s+/g, ' ').trim();
  return CREATE_PATTERN.test(normalized)
    && TEST_PATTERN.test(normalized)
    && JUNIT_FOUR_PATTERN.test(normalized)
    && METHOD_PATTERN.test(normalized);
}

async function resolveJavaSource(
  root: string,
  priority: string[],
  methodName: string
): Promise<string | undefined> {
  const direct = resolvePriorityJavaSource(root, priority);
  if (direct) return direct;

  const fromPriorityTest = resolveSourceFromPriorityTest(root, priority);
  if (fromPriorityTest) return fromPriorityTest;

  const modulePrefixes = collectPriorityModulePrefixes(priority);
  const existingTestMatches = await findSourcesReferencedByExistingTests(root, methodName, modulePrefixes);
  if (existingTestMatches.length === 1) return existingTestMatches[0];
  if (existingTestMatches.length > 1) return undefined;

  const serviceMatches = await findServiceSourcesWithMethod(root, methodName, modulePrefixes);
  return serviceMatches.length === 1 ? serviceMatches[0] : undefined;
}

function resolvePriorityJavaSource(root: string, priority: string[]): string | undefined {
  for (const value of priority) {
    const withoutSelection = value.split('#')[0];
    if (!withoutSelection || !/\.java$/i.test(withoutSelection)) continue;
    try {
      const relative = normalizeRelativePath(withoutSelection);
      if (!relative.toLowerCase().includes(MAIN_JAVA_SEGMENT)) continue;
      const absolute = resolveInsideRoot(root, relative);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return relative;
    } catch {
      // Próxima prioridade.
    }
  }
  return undefined;
}

function resolveSourceFromPriorityTest(root: string, priority: string[]): string | undefined {
  for (const value of priority) {
    const withoutSelection = value.split('#')[0];
    if (!withoutSelection || !/Test\.java$/i.test(withoutSelection)) continue;
    try {
      const relative = normalizeRelativePath(withoutSelection);
      const marker = '/src/test/java/';
      const markerIndex = relative.toLowerCase().indexOf(marker);
      if (markerIndex < 0) continue;
      const source = `${relative.slice(0, markerIndex)}/src/main/java/${relative.slice(markerIndex + marker.length)}`
        .replace(/Test\.java$/i, '.java');
      const absolute = resolveInsideRoot(root, source);
      if (fileExists(absolute)) return source;
    } catch {
      // Próxima prioridade.
    }
  }
  return undefined;
}

function collectPriorityModulePrefixes(priority: string[]): string[] {
  const modules = new Set<string>();
  for (const value of priority) {
    try {
      const withoutSelection = value.split('#')[0];
      if (!withoutSelection) continue;
      const relative = normalizeRelativePath(withoutSelection);
      const srcIndex = relative.toLowerCase().indexOf('/src/');
      if (srcIndex >= 0) modules.add(relative.slice(0, srcIndex));
      else if (/\/pom\.xml$/i.test(relative)) modules.add(relative.slice(0, -'/pom.xml'.length));
    } catch {
      // Ignora prioridade inválida.
    }
  }
  return [...modules];
}

async function findSourcesReferencedByExistingTests(
  root: string,
  methodName: string,
  modulePrefixes: string[]
): Promise<string[]> {
  const candidates = await listWorkspaceJavaFiles(root, 'src/test/java', modulePrefixes);
  const matches = new Set<string>();
  const methodCall = new RegExp(`\\.${escapeRegex(methodName)}\\s*\\(`);

  for (const testPath of candidates) {
    if (!/Test\.java$/i.test(testPath)) continue;
    const text = await readOptional(resolveInsideRoot(root, testPath));
    if (!text || !methodCall.test(text)) continue;
    const marker = '/src/test/java/';
    const markerIndex = testPath.toLowerCase().indexOf(marker);
    if (markerIndex < 0) continue;
    const sourcePath = `${testPath.slice(0, markerIndex)}/src/main/java/${testPath.slice(markerIndex + marker.length)}`
      .replace(/Test\.java$/i, '.java');
    if (!fileExists(resolveInsideRoot(root, sourcePath))) continue;
    const source = await readOptional(resolveInsideRoot(root, sourcePath));
    if (source && findMethod(source, methodName)) matches.add(sourcePath);
  }
  return [...matches];
}

async function findServiceSourcesWithMethod(
  root: string,
  methodName: string,
  modulePrefixes: string[]
): Promise<string[]> {
  const candidates = await listWorkspaceJavaFiles(root, 'src/main/java', modulePrefixes);
  const matches: string[] = [];
  for (const sourcePath of candidates) {
    if (!/Service\.java$/i.test(sourcePath)) continue;
    const source = await readOptional(resolveInsideRoot(root, sourcePath));
    if (source && findMethod(source, methodName)) matches.push(sourcePath);
  }
  return matches;
}

async function listWorkspaceJavaFiles(
  root: string,
  requiredSegment: string,
  modulePrefixes: string[]
): Promise<string[]> {
  const results: string[] = [];
  const starts = modulePrefixes.length
    ? modulePrefixes.map(prefix => prefix || '.')
    : ['.'];

  for (const relativeStart of starts) {
    const absoluteStart = resolveInsideRoot(root, relativeStart);
    await walkJavaFiles(root, absoluteStart, requiredSegment.toLowerCase(), results, 600);
    if (results.length >= 600) break;
  }
  return [...new Set(results)];
}

async function walkJavaFiles(
  root: string,
  directory: string,
  requiredSegment: string,
  results: string[],
  limit: number
): Promise<void> {
  if (results.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= limit) return;
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'target' || entry.name === 'out') continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkJavaFiles(root, absolute, requiredSegment, results, limit);
      continue;
    }
    if (!entry.isFile() || !/\.java$/i.test(entry.name)) continue;
    const relative = normalizeRelativePath(path.relative(root, absolute).replace(/\\/g, '/'));
    if (relative.toLowerCase().includes(`/${requiredSegment}/`)) results.push(relative);
  }
}

function analyzeJavaListMethod(
  sourcePath: string,
  sourceText: string,
  request: string,
  root: string
): JavaListMethodScenario | undefined {
  const packageName = sourceText.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1];
  const className = sourceText.match(/\bpublic\s+class\s+([A-Za-z_$][\w$]*)\b/)?.[1]
    ?? sourceText.match(/\bclass\s+([A-Za-z_$][\w$]*)\b/)?.[1];
  const methodName = request.match(METHOD_PATTERN)?.[1];
  if (!packageName || !className || !methodName) return undefined;

  const method = findMethod(sourceText, methodName);
  if (!method || method.parameters.trim()) return undefined;

  const listMatch = method.returnType.replace(/\s+/g, '').match(/^List<([A-Za-z_$][\w$]*)>$/);
  if (!listMatch?.[1]) return undefined;
  const itemType = listMatch[1];

  const delegation = method.body.match(/\breturn\s+([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;/);
  const dependencyName = delegation?.[1];
  const dependencyMethod = delegation?.[2];
  if (!dependencyName || !dependencyMethod) return undefined;

  const fields = collectFields(sourceText);
  const dependency = fields.find(field => field.name === dependencyName);
  if (!dependency) return undefined;

  const normalizedSource = normalizeRelativePath(sourcePath);
  const markerIndex = normalizedSource.toLowerCase().indexOf(MAIN_JAVA_SEGMENT);
  if (markerIndex < 0) return undefined;

  const modulePrefix = normalizedSource.slice(0, markerIndex);
  const packagePath = packageName.replace(/\./g, '/');
  const testPath = path.posix.join(
    modulePrefix,
    'src/test/java',
    packagePath,
    `${className}Test.java`
  );
  const pomPathCandidate = path.posix.join(modulePrefix, 'pom.xml');
  const pomPath = fileExists(resolveInsideRoot(root, pomPathCandidate))
    ? pomPathCandidate
    : undefined;

  return {
    sourcePath: normalizedSource,
    testPath,
    pomPath,
    packageName,
    className,
    methodName,
    itemType,
    dependency,
    dependencyMethod,
    imports: collectImports(sourceText)
  };
}

function findMethod(source: string, methodName: string): { returnType: string; parameters: string; body: string } | undefined {
  const expression = new RegExp(
    `(?:^|\\n)\\s*(?:public|protected|private)\\s+(?:static\\s+)?(?:final\\s+)?([A-Za-z_$][\\w$<>, ?.[\\]]*)\\s+${escapeRegex(methodName)}\\s*\\(([^)]*)\\)\\s*(?:throws\\s+[^\\{]+)?\\{`,
    'm'
  );
  const match = expression.exec(source);
  if (!match?.[1] || match.index < 0) return undefined;
  const openBrace = source.indexOf('{', match.index + match[0].length - 1);
  if (openBrace < 0) return undefined;
  const closeBrace = matchingBrace(source, openBrace);
  if (closeBrace < 0) return undefined;
  return {
    returnType: match[1].trim(),
    parameters: match[2] ?? '',
    body: source.slice(openBrace + 1, closeBrace)
  };
}

function matchingBrace(source: string, openBrace: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openBrace; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === '\'') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function collectFields(source: string): JavaField[] {
  const fields: JavaField[] = [];
  const expression = /\b(?:private|protected|public)\s+(?:static\s+)?(?:final\s+)?([A-Za-z_$][\w$<>?, .\[\]]*)\s+([A-Za-z_$][\w$]*)\s*;/g;
  for (const match of source.matchAll(expression)) {
    if (!match[1] || !match[2]) continue;
    fields.push({ typeName: match[1].trim(), name: match[2] });
  }
  return fields;
}

function collectImports(source: string): JavaImport[] {
  return [...source.matchAll(/\bimport\s+(?!static\b)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*;/g)]
    .map(match => match[1])
    .filter((value): value is string => Boolean(value))
    .map(qualifiedName => ({
      qualifiedName,
      simpleName: qualifiedName.slice(qualifiedName.lastIndexOf('.') + 1)
    }));
}

function buildJUnit4MockitoTest(scenario: JavaListMethodScenario): string {
  const imports = new Set<string>([
    'java.util.Arrays',
    'java.util.List',
    'org.junit.Test',
    'org.junit.runner.RunWith',
    'org.mockito.InjectMocks',
    'org.mockito.Mock',
    'org.mockito.junit.MockitoJUnitRunner'
  ]);

  for (const simpleName of [scenario.itemType, baseType(scenario.dependency.typeName)]) {
    const existing = scenario.imports.find(item => item.simpleName === simpleName);
    if (existing && !existing.qualifiedName.startsWith('java.lang.')) imports.add(existing.qualifiedName);
  }

  const importLines = [...imports]
    .sort((left, right) => importGroup(left) - importGroup(right) || left.localeCompare(right))
    .map(value => `import ${value};`);

  const serviceVariable = decapitalize(scenario.className.replace(/Service$/, 'Service'));
  const testMethod = `deve${capitalize(scenario.methodName)}`;
  const dependencyCall = `${scenario.dependency.name}.${scenario.dependencyMethod}()`;

  return [
    `package ${scenario.packageName};`,
    '',
    ...importLines,
    '',
    'import static org.junit.Assert.assertEquals;',
    'import static org.mockito.Mockito.verify;',
    'import static org.mockito.Mockito.when;',
    '',
    '@RunWith(MockitoJUnitRunner.class)',
    `public class ${scenario.className}Test {`,
    '',
    '    @Mock',
    `    private ${scenario.dependency.typeName} ${scenario.dependency.name};`,
    '',
    '    @InjectMocks',
    `    private ${scenario.className} ${serviceVariable};`,
    '',
    '    @Test',
    `    public void ${testMethod}() {`,
    `        List<${scenario.itemType}> esperado = Arrays.asList(`,
    `            new ${scenario.itemType}(),`,
    `            new ${scenario.itemType}()`,
    '        );',
    '',
    `        when(${dependencyCall}).thenReturn(esperado);`,
    '',
    `        List<${scenario.itemType}> resultado = ${serviceVariable}.${scenario.methodName}();`,
    '',
    '        assertEquals(esperado, resultado);',
    `        verify(${scenario.dependency.name}).${scenario.dependencyMethod}();`,
    '    }',
    '}',
    ''
  ].join('\n');
}

function isEquivalentJUnit4MockitoTest(existing: string, scenario: JavaListMethodScenario): boolean {
  const normalized = existing.replace(/\r\n/g, '\n');
  if (/"@class"\s*:\s*"java\.lang\.String"|org\.junit\.jupiter|MockitoAnnotations\.openMocks|List\.of\s*\(/.test(normalized)) {
    return false;
  }

  const required = [
    new RegExp(`\\bpackage\\s+${escapeRegex(scenario.packageName)}\\s*;`),
    /import\s+org\.junit\.Test\s*;/,
    /import\s+org\.junit\.runner\.RunWith\s*;/,
    /import\s+org\.mockito\.junit\.MockitoJUnitRunner\s*;/,
    new RegExp(`\\bclass\\s+${escapeRegex(scenario.className)}Test\\b`),
    new RegExp(`@RunWith\\s*\\(\\s*MockitoJUnitRunner\\.class\\s*\\)`),
    new RegExp(`\\.${escapeRegex(scenario.methodName)}\\s*\\(\\s*\\)`),
    new RegExp(`verify\\s*\\(\\s*${escapeRegex(scenario.dependency.name)}\\s*\\)\\s*\\.${escapeRegex(scenario.dependencyMethod)}\\s*\\(`),
    /assertEquals\s*\(/
  ];
  return required.every(expression => expression.test(normalized));
}

function createFileCall(filePath: string, content: string): ToolCall {
  return {
    id: randomUUID(),
    name: 'create_file',
    arguments: {
      filePath,
      content,
      reason: 'Criar teste unitário Java com JUnit 4 e Mockito a partir do método comprovado no service.'
    }
  };
}

function replaceFileCall(filePath: string, oldText: string, newText: string): ToolCall {
  return {
    id: randomUUID(),
    name: 'apply_edit',
    arguments: {
      filePath,
      oldText,
      newText,
      replaceAll: false,
      reason: 'Corrigir ou atualizar o teste unitário Java para JUnit 4 e Mockito.'
    }
  };
}

function buildPomDependencyEdit(filePath: string, pom: string): ToolCall | undefined {
  const hasJUnit4 = /<groupId>\s*junit\s*<\/groupId>[\s\S]{0,300}<artifactId>\s*junit\s*<\/artifactId>/i.test(pom);
  const hasMockito = /<groupId>\s*org\.mockito\s*<\/groupId>[\s\S]{0,300}<artifactId>\s*mockito-(?:core|all|inline)\s*<\/artifactId>/i.test(pom);
  if (hasJUnit4 && hasMockito) return undefined;

  const blocks = [
    !hasJUnit4 ? [
      '        <dependency>',
      '            <groupId>junit</groupId>',
      '            <artifactId>junit</artifactId>',
      '            <version>4.13.2</version>',
      '            <scope>test</scope>',
      '        </dependency>'
    ].join('\n') : undefined,
    !hasMockito ? [
      '        <dependency>',
      '            <groupId>org.mockito</groupId>',
      '            <artifactId>mockito-core</artifactId>',
      '            <version>5.12.0</version>',
      '            <scope>test</scope>',
      '        </dependency>'
    ].join('\n') : undefined
  ].filter((value): value is string => Boolean(value));

  let oldText: string;
  let newText: string;
  if (/<\/dependencies>/.test(pom)) {
    oldText = '</dependencies>';
    newText = `${blocks.join('\n')}\n    </dependencies>`;
  } else if (/<\/project>/.test(pom)) {
    oldText = '</project>';
    newText = `    <dependencies>\n${blocks.join('\n')}\n    </dependencies>\n</project>`;
  } else {
    return undefined;
  }

  return {
    id: randomUUID(),
    name: 'apply_edit',
    arguments: {
      filePath,
      oldText,
      newText,
      replaceAll: false,
      reason: 'Adicionar dependências de teste JUnit 4 e Mockito ausentes no módulo Maven.'
    }
  };
}

function baseType(typeName: string): string {
  return typeName.replace(/<.*$/, '').replace(/\[\]$/, '').trim();
}

function importGroup(value: string): number {
  if (value.startsWith('java.')) return 0;
  if (value.startsWith('org.')) return 2;
  return 1;
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}` : value;
}

function decapitalize(value: string): string {
  return value ? `${value[0]?.toLowerCase() ?? ''}${value.slice(1)}` : value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fileExists(filePath: string): boolean {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try { return await fsp.readFile(filePath, 'utf8'); } catch { return undefined; }
}
