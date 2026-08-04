import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as ts from 'typescript';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';
import { generatedFileContentIssue } from './AgentTaskPolicy';

export type TestFramework = 'jasmine' | 'jest' | 'vitest';

export interface TestGenerationFastPathResult {
  text: string;
  call: ToolCall;
  result: ToolResult;
}

export interface TestGenerationFastPathOptions {
  request: string;
  workspaceRoot?: string;
  priority: string[];
  execute: (call: ToolCall) => Promise<ToolResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface ImportBinding {
  importedName: string;
  modulePath: string;
  typeOnly: boolean;
}

interface ClassProperty {
  name: string;
  typeText?: string;
  initializerText?: string;
}

interface DependencyInfo {
  propertyName: string;
  typeName: string;
  importedName: string;
  importPath: string;
  methods: string[];
  unsupportedProperties: string[];
}

interface ObservableLoadScenario {
  dependencyProperty: string;
  dependencyType: string;
  dependencyImportPath: string;
  serviceMethod: string;
  targetProperty: string;
  responsePath: string[];
  responseTransforms: string[];
  loadingProperty?: string;
}

interface FilterScenario {
  accessorName: string;
  accessorKind: 'getter' | 'method';
  collectionProperty: string;
  filterProperty: string;
  itemFields: string[];
  primitiveItems: boolean;
}

interface SourceAnalysis {
  filePath: string;
  sourceText: string;
  className: string;
  standalone?: boolean;
  componentImportPath: string;
  dependencies: DependencyInfo[];
  properties: Map<string, ClassProperty>;
  loadScenario?: ObservableLoadScenario;
  filterScenario?: FilterScenario;
}

interface ProjectTestProfile {
  framework: TestFramework;
  sampleSpecPath?: string;
  usesSingleQuotes: boolean;
  angularMajor?: number;
}

interface DependencyCollection {
  dependencies: DependencyInfo[];
  unsupported: boolean;
}

interface ResponseDerivation {
  path: string[];
  transforms: string[];
}

const CREATE_TEST_PATTERN = /\b(?:crie|criar|gere|gerar|adicione|adicionar|escreva|escrever|create|generate|add|write)\b/i;
const TEST_PATTERN = /\b(?:testes?|spec(?:\.ts)?|tests?)\b/i;
const COMPONENT_REFERENCE_PATTERN = /([A-Za-z0-9._-]+\.component\.ts)\b/i;
const LOAD_REQUEST_PATTERN = /\b(?:carreg\w*|inicializ\w*|ngoninit|listar\w*|load\w*|initiali[sz]\w*|fetch\w*)\b/i;
const FILTER_REQUEST_PATTERN = /\b(?:filtr\w*|search\w*)\b/i;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.angular', '.vscode-test', 'node_modules', 'out', 'dist', 'build',
  'coverage', '.next', '.nuxt', '.cache', 'target'
]);

export async function tryPrepareTestGenerationFastPath(
  options: TestGenerationFastPathOptions
): Promise<TestGenerationFastPathResult | undefined> {
  const root = options.workspaceRoot;
  if (!root || !isCandidateRequest(options.request)) return undefined;

  const sourcePath = await resolveRequestedComponent(root, options.request, options.priority);
  if (!sourcePath) {
    options.warn?.('[TestFastPath] O componente citado não foi encontrado; usando o AgentLoop.');
    return undefined;
  }

  const specPath = sourcePath.replace(/\.component\.ts$/i, '.component.spec.ts');
  if (await fileExists(resolveInsideRoot(root, specPath))) {
    options.warn?.(`[TestFastPath] O arquivo ${specPath} já existe; usando o AgentLoop para evitar sobrescrita.`);
    return undefined;
  }

  const sourceText = await fsp.readFile(resolveInsideRoot(root, sourcePath), 'utf8');
  const analysis = analyzeAngularComponent(sourcePath, sourceText);
  if (!analysis) {
    options.warn?.('[TestFastPath] O componente não corresponde a um padrão estrutural seguro; usando o AgentLoop.');
    return undefined;
  }

  const wantsLoad = LOAD_REQUEST_PATTERN.test(options.request);
  const wantsFilter = FILTER_REQUEST_PATTERN.test(options.request);
  if ((wantsLoad && !analysis.loadScenario) || (wantsFilter && !analysis.filterScenario)) {
    options.warn?.('[TestFastPath] Nem todos os comportamentos pedidos puderam ser comprovados no AST; usando o AgentLoop.');
    return undefined;
  }

  const selectedScenarios = [
    wantsLoad && analysis.loadScenario ? 'load' : undefined,
    wantsFilter && analysis.filterScenario ? 'filter' : undefined
  ].filter((value): value is 'load' | 'filter' => Boolean(value));

  if (!selectedScenarios.length) return undefined;

  const profile = await detectProjectTestProfile(root, sourcePath);
  const content = buildAngularSpec(analysis, profile, selectedScenarios);
  const validationIssue = generatedFileContentIssue(specPath, content, {
    request: options.request,
    sources: [{ filePath: sourcePath, content: sourceText }]
  });

  if (validationIssue) {
    options.warn?.(`[TestFastPath] Conteúdo local rejeitado pela validação: ${validationIssue}`);
    return undefined;
  }

  const call: ToolCall = {
    id: randomUUID(),
    name: 'create_file',
    arguments: {
      filePath: specPath,
      content,
      reason: 'Gerar testes unitários a partir da estrutura TypeScript comprovada do componente.'
    }
  };

  options.info?.(
    [
      '[TestFastPath] Teste Angular estrutural detectado; modelo não será chamado.',
      `arquivo=${specPath}`,
      `framework=${profile.framework}`,
      `cenários=${selectedScenarios.join(',')}`
    ].join(' ')
  );

  const result = await options.execute(call);
  if (!result.ok) {
    options.warn?.(`[TestFastPath] create_file falhou; usando o AgentLoop: ${result.error ?? 'erro desconhecido'}`);
    return undefined;
  }

  const descriptions = selectedScenarios.map(scenario =>
    scenario === 'load'
      ? 'carregamento durante a inicialização'
      : 'filtragem da coleção pelo campo de pesquisa'
  );

  return {
    call,
    result,
    text: [
      'Arquivo de testes preparado para revisão.',
      `Arquivo: ${specPath}`,
      `Cenários: ${descriptions.join('; ')}.`
    ].join('\n\n')
  };
}

function isCandidateRequest(request: string): boolean {
  const normalized = String(request ?? '').replace(/\s+/g, ' ').trim();
  return CREATE_TEST_PATTERN.test(normalized)
    && TEST_PATTERN.test(normalized)
    && COMPONENT_REFERENCE_PATTERN.test(normalized)
    && (LOAD_REQUEST_PATTERN.test(normalized) || FILTER_REQUEST_PATTERN.test(normalized));
}

async function resolveRequestedComponent(
  root: string,
  request: string,
  priority: string[]
): Promise<string | undefined> {
  const requestedBase = request.match(COMPONENT_REFERENCE_PATTERN)?.[1]?.toLowerCase();
  const candidates = priority
    .map(value => value.split('#')[0])
    .filter((value): value is string => Boolean(value))
    .filter(value => /\.component\.ts$/i.test(value));

  for (const candidate of candidates) {
    try {
      const relative = normalizeRelativePath(candidate);
      const stat = await fsp.stat(resolveInsideRoot(root, relative));
      if (stat.isFile() && (!requestedBase || path.posix.basename(relative).toLowerCase() === requestedBase)) {
        return relative;
      }
    } catch {
      // Tenta resolver pelo nome abreviado abaixo.
    }
  }

  return requestedBase ? findFileByBaseName(root, requestedBase) : undefined;
}

async function findFileByBaseName(root: string, targetBase: string): Promise<string | undefined> {
  const stack = [root];
  const matches: string[] = [];
  let visited = 0;

  while (stack.length && visited < 20_000 && matches.length < 20) {
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
      if (visited >= 20_000) break;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || entry.name.toLowerCase() !== targetBase) continue;
      matches.push(path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/'));
    }
  }

  return matches.sort((left, right) => left.length - right.length || left.localeCompare(right))[0];
}

export function analyzeAngularComponent(
  filePath: string,
  sourceText: string
): SourceAnalysis | undefined {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const imports = collectImports(sourceFile);
  const componentClass = sourceFile.statements.find(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && Boolean(componentDecorator(statement))
  );

  if (!componentClass?.name) return undefined;

  const decorator = componentDecorator(componentClass);
  if (!decorator) return undefined;

  const standalone = componentStandalone(decorator);
  const properties = collectClassProperties(componentClass, sourceFile);
  const dependencyCollection = collectDependencies(componentClass, imports);
  if (dependencyCollection.unsupported) return undefined;
  const dependencies = dependencyCollection.dependencies;

  const loadScenario = findObservableLoadScenario(
    componentClass,
    dependencies,
    properties
  );
  const filterScenario = findFilterScenario(componentClass, properties, sourceFile);

  if (!loadScenario && !filterScenario) return undefined;
  if (dependencies.some(dependency => dependency.unsupportedProperties.length > 0)) return undefined;

  return {
    filePath: normalizeRelativePath(filePath),
    sourceText,
    className: componentClass.name.text,
    standalone,
    componentImportPath: `./${path.posix.basename(filePath, '.ts')}`,
    dependencies,
    properties,
    loadScenario,
    filterScenario
  };
}

function collectImports(sourceFile: ts.SourceFile): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const modulePath = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) continue;

    if (clause.name) {
      bindings.set(clause.name.text, {
        importedName: 'default',
        modulePath,
        typeOnly: clause.isTypeOnly
      });
    }

    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          importedName: element.propertyName?.text ?? element.name.text,
          modulePath,
          typeOnly: clause.isTypeOnly || element.isTypeOnly
        });
      }
    }
  }

  return bindings;
}

function componentDecorator(node: ts.ClassDeclaration): ts.Decorator | undefined {
  const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  return decorators?.find(decorator => {
    const expression = decorator.expression;
    return ts.isCallExpression(expression)
      && ts.isIdentifier(expression.expression)
      && expression.expression.text === 'Component';
  });
}

function componentStandalone(decorator: ts.Decorator): boolean | undefined {
  if (!ts.isCallExpression(decorator.expression)) return undefined;
  const metadata = decorator.expression.arguments[0];
  if (!metadata || !ts.isObjectLiteralExpression(metadata)) return undefined;

  for (const property of metadata.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== 'standalone') continue;
    if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
    return undefined;
  }
  return undefined;
}

function collectClassProperties(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile
): Map<string, ClassProperty> {
  const properties = new Map<string, ClassProperty>();

  for (const member of node.members) {
    if (!ts.isPropertyDeclaration(member)) continue;
    const name = propertyName(member.name);
    if (!name) continue;
    properties.set(name, {
      name,
      typeText: member.type?.getText(sourceFile),
      initializerText: member.initializer?.getText(sourceFile)
    });
  }

  return properties;
}

function collectDependencies(
  node: ts.ClassDeclaration,
  imports: Map<string, ImportBinding>
): DependencyCollection {
  const dependencies: DependencyInfo[] = [];
  let unsupported = false;

  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        const parameterProperty = parameter.modifiers?.some(modifier =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword
          || modifier.kind === ts.SyntaxKind.PublicKeyword
          || modifier.kind === ts.SyntaxKind.ProtectedKeyword
          || modifier.kind === ts.SyntaxKind.ReadonlyKeyword
        );

        if (!parameterProperty || !ts.isIdentifier(parameter.name) || !parameter.type) {
          unsupported = true;
          continue;
        }

        const typeName = rootTypeName(parameter.type);
        const binding = typeName ? imports.get(typeName) : undefined;
        if (!typeName || !binding || binding.typeOnly || !isLikelyRuntimeToken(typeName)) {
          unsupported = true;
          continue;
        }

        dependencies.push({
          propertyName: parameter.name.text,
          typeName,
          importedName: binding.importedName,
          importPath: binding.modulePath,
          methods: [],
          unsupportedProperties: []
        });
      }
    }

    if (ts.isPropertyDeclaration(member) && member.initializer && ts.isCallExpression(member.initializer)) {
      const call = member.initializer;
      if (!ts.isIdentifier(call.expression) || call.expression.text !== 'inject') continue;
      const argument = call.arguments[0];
      const name = propertyName(member.name);
      if (!name || !argument || !ts.isIdentifier(argument)) {
        unsupported = true;
        continue;
      }
      const binding = imports.get(argument.text);
      if (!binding || binding.typeOnly || !isLikelyRuntimeToken(argument.text)) {
        unsupported = true;
        continue;
      }
      dependencies.push({
        propertyName: name,
        typeName: argument.text,
        importedName: binding.importedName,
        importPath: binding.modulePath,
        methods: [],
        unsupportedProperties: []
      });
    }
  }

  const unique = new Map(dependencies.map(dependency => [dependency.propertyName, dependency]));
  const result = [...unique.values()];

  walk(node, current => {
    if (!ts.isPropertyAccessExpression(current)) return;
    const owner = thisPropertyName(current.expression);
    if (!owner) return;
    const dependency = result.find(item => item.propertyName === owner);
    if (!dependency) return;

    const parent = current.parent;
    if (ts.isCallExpression(parent) && parent.expression === current) {
      dependency.methods.push(current.name.text);
      return;
    }

    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      dependency.unsupportedProperties.push(current.name.text);
      return;
    }

    if (!ts.isCallExpression(parent)) {
      dependency.unsupportedProperties.push(current.name.text);
    }
  });

  for (const dependency of result) {
    dependency.methods = [...new Set(dependency.methods)].sort();
    dependency.unsupportedProperties = [...new Set(dependency.unsupportedProperties)].sort();
  }

  return { dependencies: result, unsupported };
}

function isLikelyRuntimeToken(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(name) && !/(?:^|_)TOKEN$/i.test(name);
}

function findObservableLoadScenario(
  node: ts.ClassDeclaration,
  dependencies: DependencyInfo[],
  properties: Map<string, ClassProperty>
): ObservableLoadScenario | undefined {
  const bodies = reachableLifecycleBodies(node);
  let found: ObservableLoadScenario | undefined;

  for (const body of bodies) {
    walk(body, current => {
      if (found || !ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) return;
      if (current.expression.name.text !== 'subscribe') return;

      const serviceCall = unwrapServiceCall(current.expression.expression, dependencies);
      if (!serviceCall) return;

      const callback = subscribeCallback(current.arguments);
      if (!callback || callback.parameters.length < 1 || !ts.isIdentifier(callback.parameters[0]!.name)) return;
      const responseName = callback.parameters[0]!.name.text;
      const bodyNode = callback.body;

      let targetProperty: string | undefined;
      let derivation: ResponseDerivation | undefined;
      let loadingProperty: string | undefined;

      walk(bodyNode, candidate => {
        if (!ts.isBinaryExpression(candidate) || candidate.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
        const leftProperty = thisPropertyName(candidate.left);
        if (!leftProperty) return;

        const candidateDerivation = responseDerivation(candidate.right, responseName);
        if (candidateDerivation && !targetProperty) {
          targetProperty = leftProperty;
          derivation = candidateDerivation;
        }

        if (candidate.right.kind === ts.SyntaxKind.FalseKeyword) {
          const property = properties.get(leftProperty);
          if (property?.typeText === 'boolean' || /^(?:true|false)$/.test(property?.initializerText ?? '')) {
            loadingProperty = leftProperty;
          }
        }
      });

      if (!targetProperty || !derivation) return;
      const dependency = dependencies.find(item => item.propertyName === serviceCall.dependencyProperty);
      if (!dependency) return;

      found = {
        dependencyProperty: dependency.propertyName,
        dependencyType: dependency.typeName,
        dependencyImportPath: dependency.importPath,
        serviceMethod: serviceCall.methodName,
        targetProperty,
        responsePath: derivation.path,
        responseTransforms: derivation.transforms,
        loadingProperty
      };
    });
    if (found) break;
  }

  return found;
}

function reachableLifecycleBodies(node: ts.ClassDeclaration): ts.Block[] {
  const methods = new Map<string, ts.MethodDeclaration>();
  for (const member of node.members) {
    if (!ts.isMethodDeclaration(member) || !member.body) continue;
    const name = propertyName(member.name);
    if (name) methods.set(name, member);
  }

  const initial = methods.get('ngOnInit');
  if (!initial?.body) return [];

  const queue: ts.MethodDeclaration[] = [initial];
  const visited = new Set<string>();
  const bodies: ts.Block[] = [];

  while (queue.length && visited.size < 12) {
    const method = queue.shift();
    if (!method?.body) continue;
    const methodName = propertyName(method.name);
    if (!methodName || visited.has(methodName)) continue;
    visited.add(methodName);
    bodies.push(method.body);

    walk(method.body, current => {
      if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) return;
      if (current.expression.expression.kind !== ts.SyntaxKind.ThisKeyword) return;
      const called = methods.get(current.expression.name.text);
      if (called && !visited.has(current.expression.name.text)) queue.push(called);
    });
  }

  return bodies;
}

function responseDerivation(expression: ts.Expression, responseName: string): ResponseDerivation | undefined {
  const unwrapped = unwrapExpression(expression);
  const directPath = expressionPathFromIdentifier(unwrapped, responseName);
  if (directPath) return { path: directPath, transforms: [] };

  if (!ts.isCallExpression(unwrapped) || !ts.isPropertyAccessExpression(unwrapped.expression)) return undefined;
  const method = unwrapped.expression.name.text;
  if (!new Set(['map', 'filter', 'slice', 'flatMap']).has(method)) return undefined;

  const parent = responseDerivation(unwrapped.expression.expression, responseName);
  return parent ? { path: parent.path, transforms: [...parent.transforms, method] } : undefined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function unwrapServiceCall(
  expression: ts.Expression,
  dependencies: DependencyInfo[]
): { dependencyProperty: string; methodName: string } | undefined {
  let current: ts.Expression = expression;

  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    if (current.expression.name.text === 'pipe') {
      current = current.expression.expression;
      continue;
    }

    const dependencyProperty = thisPropertyName(current.expression.expression);
    if (!dependencyProperty) return undefined;
    if (!dependencies.some(dependency => dependency.propertyName === dependencyProperty)) return undefined;
    return { dependencyProperty, methodName: current.expression.name.text };
  }

  return undefined;
}

function subscribeCallback(argumentsList: ts.NodeArray<ts.Expression>): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const first = argumentsList[0];
  if (!first) return undefined;
  if (ts.isArrowFunction(first) || ts.isFunctionExpression(first)) return first;
  if (!ts.isObjectLiteralExpression(first)) return undefined;

  for (const property of first.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== 'next') continue;
    if (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer)) {
      return property.initializer;
    }
  }
  return undefined;
}

function findFilterScenario(
  node: ts.ClassDeclaration,
  properties: Map<string, ClassProperty>,
  sourceFile: ts.SourceFile
): FilterScenario | undefined {
  for (const member of node.members) {
    const isGetter = ts.isGetAccessorDeclaration(member);
    const isMethod = ts.isMethodDeclaration(member) && member.parameters.length === 0;
    if ((!isGetter && !isMethod) || !member.body) continue;

    const accessorName = propertyName(member.name);
    if (!accessorName) continue;

    const aliases = new Map<string, string>();
    walk(member.body, current => {
      if (!ts.isVariableDeclaration(current) || !ts.isIdentifier(current.name) || !current.initializer) return;
      const referenced = firstThisProperty(current.initializer);
      if (referenced) aliases.set(current.name.text, referenced);
    });

    let scenario: FilterScenario | undefined;
    walk(member.body, current => {
      if (scenario || !ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) return;
      if (current.expression.name.text !== 'filter') return;

      const collectionProperty = thisPropertyName(current.expression.expression);
      if (!collectionProperty) return;
      const predicate = current.arguments[0];
      if (!predicate || (!ts.isArrowFunction(predicate) && !ts.isFunctionExpression(predicate))) return;
      const itemParameter = predicate.parameters[0];
      if (!itemParameter || !ts.isIdentifier(itemParameter.name)) return;
      const itemName = itemParameter.name.text;

      const filterCandidates = new Set<string>();
      walk(member.body!, candidate => {
        const direct = thisPropertyName(candidate);
        if (direct && direct !== collectionProperty) filterCandidates.add(direct);
        if (ts.isIdentifier(candidate)) {
          const alias = aliases.get(candidate.text);
          if (alias && alias !== collectionProperty) filterCandidates.add(alias);
        }
      });

      const filterProperty = [...filterCandidates].find(candidate => isStringProperty(properties.get(candidate)));
      if (!filterProperty) return;

      if (!hasTextMatchOperation(predicate.body)) return;

      const itemFields = new Set<string>();
      let itemIdentifierUsed = false;
      walk(predicate.body, candidate => {
        if (ts.isPropertyAccessExpression(candidate)) {
          const field = propertyPathFromIdentifier(candidate, itemName);
          if (field?.length) itemFields.add(field[0]!);
        }
        if (ts.isIdentifier(candidate) && candidate.text === itemName) itemIdentifierUsed = true;
      });

      scenario = {
        accessorName,
        accessorKind: isGetter ? 'getter' : 'method',
        collectionProperty,
        filterProperty,
        itemFields: [...itemFields].sort(),
        primitiveItems: itemIdentifierUsed && itemFields.size === 0
      };
    });

    if (scenario) return scenario;
  }

  return undefined;
}


function hasTextMatchOperation(node: ts.Node): boolean {
  let found = false;
  walk(node, current => {
    if (found || !ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression)) return;
    found = new Set(['includes', 'startsWith', 'endsWith', 'indexOf']).has(current.expression.name.text);
  });
  return found;
}

function isStringProperty(property: ClassProperty | undefined): boolean {
  if (!property) return false;
  return property.typeText === 'string'
    || property.initializerText === "''"
    || property.initializerText === '""'
    || property.initializerText === '``';
}

async function detectProjectTestProfile(root: string, sourcePath: string): Promise<ProjectTestProfile> {
  const sample = await findNearestSpec(root, sourcePath);
  let sampleText = '';
  if (sample) {
    try {
      sampleText = await fsp.readFile(resolveInsideRoot(root, sample), 'utf8');
    } catch {
      sampleText = '';
    }
  }

  const packageData = await readNearestPackageJson(root, sourcePath);
  const dependencies = {
    ...(packageData?.dependencies ?? {}),
    ...(packageData?.devDependencies ?? {})
  };

  let framework: TestFramework = 'jasmine';
  if (/from\s+['"]vitest['"]|\bvi\.(?:fn|mock)\b/.test(sampleText) || dependencies.vitest) {
    framework = 'vitest';
  } else if (/\bjest\.(?:fn|mock)\b/.test(sampleText) || dependencies.jest || dependencies['jest-preset-angular']) {
    framework = 'jest';
  } else if (/\bjasmine\.|toBeTrue\(|toBeFalse\(/.test(sampleText)
    || dependencies['jasmine-core']
    || dependencies['karma-jasmine']) {
    framework = 'jasmine';
  }

  const singleQuotes = (sampleText.match(/'/g)?.length ?? 0) >= (sampleText.match(/"/g)?.length ?? 0);
  const angularMajor = dependencyMajor(dependencies['@angular/core']);
  return {
    framework,
    sampleSpecPath: sample,
    usesSingleQuotes: singleQuotes || !sampleText,
    angularMajor
  };
}

function dependencyMajor(version: string | undefined): number | undefined {
  const match = String(version ?? '').match(/(?:^|[^0-9])(\d{1,3})(?:\.|$)/);
  return match ? Number(match[1]) : undefined;
}

async function readNearestPackageJson(
  root: string,
  sourcePath: string
): Promise<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined> {
  const rootResolved = path.resolve(root);
  let directory = path.dirname(resolveInsideRoot(root, sourcePath));

  while (directory.startsWith(rootResolved)) {
    const packagePath = path.join(directory, 'package.json');
    try {
      return JSON.parse(await fsp.readFile(packagePath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    } catch {
      // Continua até a raiz do workspace.
    }
    if (directory === rootResolved) break;
    directory = path.dirname(directory);
  }
  return undefined;
}

async function findNearestSpec(root: string, sourcePath: string): Promise<string | undefined> {
  const sourceDirectory = path.posix.dirname(sourcePath.replace(/\\/g, '/')).split('/');
  const stack = [root];
  const candidates: Array<{ filePath: string; score: number }> = [];
  let visited = 0;

  while (stack.length && visited < 20_000 && candidates.length < 60) {
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
      if (visited >= 20_000) break;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !/\.(?:spec|test)\.ts$/i.test(entry.name)) continue;
      const filePath = path.relative(root, path.join(directory, entry.name)).replace(/\\/g, '/');
      if (filePath.toLowerCase() === sourcePath.replace(/\.component\.ts$/i, '.component.spec.ts').toLowerCase()) continue;
      const parts = path.posix.dirname(filePath).split('/');
      let common = 0;
      while (common < sourceDirectory.length && common < parts.length && sourceDirectory[common] === parts[common]) common += 1;
      candidates.push({ filePath, score: common * 10_000 - filePath.length });
    }
  }

  return candidates.sort((left, right) => right.score - left.score)[0]?.filePath;
}

function buildAngularSpec(
  analysis: SourceAnalysis,
  profile: ProjectTestProfile,
  scenarios: Array<'load' | 'filter'>
): string {
  const quote = profile.usesSingleQuotes ? "'" : '"';
  const q = (value: string): string => `${quote}${value}${quote}`;
  const standalone = analysis.standalone ?? (profile.angularMajor !== undefined && profile.angularMajor >= 19);
  const lines: string[] = [];

  lines.push(`import { ComponentFixture, TestBed } from ${q('@angular/core/testing')};`);
  if (scenarios.includes('load')) lines.push(`import { of } from ${q('rxjs')};`);
  if (profile.framework === 'vitest') {
    lines.push(`import { beforeEach, describe, expect, it, vi } from ${q('vitest')};`);
  }
  lines.push(`import { ${analysis.className} } from ${q(analysis.componentImportPath)};`);

  const dependenciesByType = new Map<string, DependencyInfo>();
  for (const dependency of analysis.dependencies) dependenciesByType.set(dependency.typeName, dependency);
  for (const dependency of [...dependenciesByType.values()].sort((a, b) => a.typeName.localeCompare(b.typeName))) {
    if (dependency.importedName === 'default') {
      lines.push(`import ${dependency.typeName} from ${q(dependency.importPath)};`);
    } else if (dependency.importedName === dependency.typeName) {
      lines.push(`import { ${dependency.typeName} } from ${q(dependency.importPath)};`);
    } else {
      lines.push(`import { ${dependency.importedName} as ${dependency.typeName} } from ${q(dependency.importPath)};`);
    }
  }

  lines.push('');
  lines.push(`describe(${q(analysis.className)}, () => {`);
  lines.push(`  let component: ${analysis.className};`);
  lines.push(`  let fixture: ComponentFixture<${analysis.className}>;`);

  for (const dependency of analysis.dependencies) {
    if (profile.framework === 'jasmine') {
      lines.push(`  let ${dependency.propertyName}: jasmine.SpyObj<${dependency.typeName}>;`);
    } else {
      lines.push(`  let ${dependency.propertyName}: Record<string, any>;`);
    }
  }

  lines.push('');
  lines.push('  beforeEach(async () => {');
  for (const dependency of analysis.dependencies) {
    const methods = dependency.methods.map(q).join(', ');
    if (profile.framework === 'jasmine') {
      if (dependency.methods.length) {
        lines.push(`    ${dependency.propertyName} = jasmine.createSpyObj<${dependency.typeName}>(${q(dependency.typeName)}, [${methods}]);`);
      } else {
        lines.push(`    ${dependency.propertyName} = {} as jasmine.SpyObj<${dependency.typeName}>;`);
      }
    } else {
      const factory = profile.framework === 'vitest' ? 'vi.fn()' : 'jest.fn()';
      const entries = dependency.methods.map(method => `${method}: ${factory}`).join(', ');
      lines.push(`    ${dependency.propertyName} = { ${entries} };`);
    }
  }

  if (scenarios.includes('load') && analysis.loadScenario) {
    const emptyResponse = responseExpression(analysis.loadScenario.responsePath, '[]');
    lines.push(mockReturnLine(profile.framework, analysis.loadScenario.dependencyProperty, analysis.loadScenario.serviceMethod, `of(${emptyResponse} as any)`));
  }

  lines.push('');
  lines.push('    await TestBed.configureTestingModule({');
  lines.push(standalone
    ? `      imports: [${analysis.className}],`
    : `      declarations: [${analysis.className}],`);
  if (analysis.dependencies.length) {
    lines.push('      providers: [');
    for (const dependency of analysis.dependencies) {
      lines.push(`        { provide: ${dependency.typeName}, useValue: ${dependency.propertyName} },`);
    }
    lines.push('      ]');
  }
  lines.push('    }).compileComponents();');
  lines.push('');
  lines.push(`    fixture = TestBed.createComponent(${analysis.className});`);
  lines.push('    component = fixture.componentInstance;');
  lines.push('  });');

  if (scenarios.includes('load') && analysis.loadScenario) {
    const scenario = analysis.loadScenario;
    lines.push('');
    lines.push(`  it(${q('deve carregar os dados ao inicializar')}, () => {`);
    const response = responseExpression(scenario.responsePath, '[]');
    lines.push(`    (component as any).${scenario.targetProperty} = [{ marcador: true }];`);
    lines.push(mockReturnLine(profile.framework, scenario.dependencyProperty, scenario.serviceMethod, `of(${response} as any)`));
    lines.push('');
    lines.push('    fixture.detectChanges();');
    lines.push('');
    lines.push(callExpectation(profile.framework, scenario.dependencyProperty, scenario.serviceMethod));
    lines.push(`    expect((component as any).${scenario.targetProperty}).toEqual([]);`);
    if (scenario.loadingProperty) {
      lines.push(`    expect((component as any).${scenario.loadingProperty}).toBe(false);`);
    }
    lines.push('  });');
  }

  if (scenarios.includes('filter') && analysis.filterScenario) {
    const scenario = analysis.filterScenario;
    lines.push('');
    lines.push(`  it(${q('deve filtrar os dados pelo conteúdo do campo de pesquisa')}, () => {`);
    lines.push(...indentLines(buildGenericValues(scenario.itemFields, scenario.primitiveItems), 4));
    lines.push(`    (component as any).${scenario.collectionProperty} = valores;`);
    lines.push(`    (component as any).${scenario.filterProperty} = ${q('alpha')};`);
    lines.push('');
    const accessor = scenario.accessorKind === 'getter'
      ? `(component as any).${scenario.accessorName}`
      : `(component as any).${scenario.accessorName}()`;
    lines.push(`    const resultado = ${accessor};`);
    lines.push('');
    lines.push('    expect(resultado.length).toBe(1);');
    lines.push('    expect(resultado[0]).toBe(valores[0]);');
    lines.push('  });');
  }

  lines.push('});');
  lines.push('');
  return lines.join('\n');
}

function buildGenericValues(itemFields: string[], primitiveItems = false): string[] {
  if (primitiveItems || itemFields.length === 0) {
    return [
      "const valores = ['Alpha', 'Beta'] as any;"
    ];
  }

  const firstFields = itemFields.map(field => `${field}: 'Alpha'`).join(', ');
  const secondFields = itemFields.map(field => `${field}: 'Beta'`).join(', ');
  return [
    'const valores = [',
    `  { ${firstFields} },`,
    `  { ${secondFields} }`,
    '] as any;'
  ];
}

function indentLines(lines: string[], spaces: number): string[] {
  const prefix = ' '.repeat(spaces);
  return lines.map(line => `${prefix}${line}`);
}

function responseExpression(pathSegments: string[], valueExpression: string): string {
  return [...pathSegments].reverse().reduce(
    (current, segment) => `{ ${segment}: ${current} }`,
    valueExpression
  );
}

function mockReturnLine(
  framework: TestFramework,
  dependency: string,
  method: string,
  value: string
): string {
  if (framework === 'jasmine') {
    return `    ${dependency}.${method}.and.returnValue(${value});`;
  }
  return `    ${dependency}.${method}.mockReturnValue(${value});`;
}

function callExpectation(framework: TestFramework, dependency: string, method: string): string {
  if (framework === 'jasmine') {
    return `    expect(${dependency}.${method}).toHaveBeenCalledTimes(1);`;
  }
  return `    expect(${dependency}.${method}).toHaveBeenCalledTimes(1);`;
}

function rootTypeName(typeNode: ts.TypeNode): string | undefined {
  if (ts.isTypeReferenceNode(typeNode)) {
    if (ts.isIdentifier(typeNode.typeName)) return typeNode.typeName.text;
    if (ts.isQualifiedName(typeNode.typeName)) return typeNode.typeName.right.text;
  }
  return undefined;
}

function propertyName(name: ts.PropertyName | ts.BindingName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function thisPropertyName(node: ts.Node): string | undefined {
  if (!ts.isPropertyAccessExpression(node) || node.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  return node.name.text;
}

function firstThisProperty(node: ts.Node): string | undefined {
  let found: string | undefined;
  walk(node, current => {
    if (!found) found = thisPropertyName(current);
  });
  return found;
}

function expressionPathFromIdentifier(expression: ts.Expression, identifier: string): string[] | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isIdentifier(unwrapped)) return unwrapped.text === identifier ? [] : undefined;
  if (!ts.isPropertyAccessExpression(unwrapped)) return undefined;
  const parent = expressionPathFromIdentifier(unwrapped.expression, identifier);
  return parent ? [...parent, unwrapped.name.text] : undefined;
}

function propertyPathFromIdentifier(expression: ts.PropertyAccessExpression, identifier: string): string[] | undefined {
  const segments: string[] = [expression.name.text];
  let current: ts.Expression = expression.expression;
  while (ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = current.expression;
  }
  return ts.isIdentifier(current) && current.text === identifier ? segments : undefined;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild(child => walk(child, visit));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}
