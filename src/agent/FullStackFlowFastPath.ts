import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';
import type { FullStackFlowAnalysis } from './FullStackFlowIntent';

export interface FullStackFlowFastPathResult {
  text: string;
  calls: ToolCall[];
  results: ToolResult[];
  complete: boolean;
}

export interface FullStackFlowFastPathOptions {
  request: string;
  workspaceRoot?: string;
  analysis?: FullStackFlowAnalysis;
  execute: (call: ToolCall) => Promise<ToolResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface PlannedChange {
  call: ToolCall;
  description: string;
}

interface BackendModelPlan {
  filePath: string;
  content: string;
  existed: boolean;
  originalContent?: string;
}

interface DataAccessPlan {
  filePath: string;
  className: string;
  methodName: string;
  content: string;
  existed: boolean;
  originalContent?: string;
}

interface BackendServicePlan {
  filePath: string;
  className: string;
  methodName: string;
  content: string;
  existed: boolean;
  originalContent?: string;
}

interface BackendResourcePlan {
  filePath: string;
  methodName: string;
  content: string;
  existed: boolean;
  originalContent?: string;
}

interface FrontendServicePlan {
  filePath: string;
  className: string;
  methodName: string;
  content: string;
  existed: boolean;
  originalContent?: string;
}

const LIST_METHOD_NAMES = /^(?:listar|listartodos|listarTodos|list|getall|findall|buscarTodos|obterTodos|carregarTodos)$/i;

export async function tryPrepareFullStackFlowFastPath(
  options: FullStackFlowFastPathOptions
): Promise<FullStackFlowFastPathResult | undefined> {
  const root = options.workspaceRoot;
  const analysis = options.analysis;
  if (!root || !analysis || analysis.operation !== 'list') return undefined;

  const requiredPaths = [
    analysis.componentFile,
    analysis.componentTemplateFile,
    analysis.componentStyleFile,
    analysis.frontendServiceFile,
    analysis.frontendModelFile,
    analysis.backendResourceFile,
    analysis.backendServiceFile,
    analysis.backendModelFile,
    analysis.dataAccessFile
  ];
  if (requiredPaths.some(value => !value) || !analysis.javaFramework || analysis.modelFields.length === 0) {
    const missing = describeMissingStructure(analysis);
    options.warn?.(`[FullStackFlowFastPath] Estrutura incompleta; execução bloqueada sem chamar o modelo. faltando=${missing.join(',') || 'dependências estruturais'}`);
    return blockedFullStackResult(
      analysis,
      analysis.modelFields.length === 0 || !analysis.backendModelFile
        ? [
            `Não encontrei uma estrutura existente para ${analysis.entityType} com campos comprovados.`,
            'Informe os campos da entidade e seus tipos para que o fluxo completo possa ser planejado com segurança.'
          ]
        : [
            `Não foi possível comprovar toda a estrutura necessária para o fluxo de ${analysis.entityType}.`,
            `Dependências não resolvidas: ${missing.join(', ')}.`
          ]
    );
  }

  const backendModelPlan = await buildBackendModelPlan(root, analysis);
  if (!backendModelPlan) {
    options.warn?.('[FullStackFlowFastPath] Modelo Java não pôde ser montado com segurança; execução bloqueada sem chamar o modelo.');
    return blockedFullStackResult(analysis, [
      `O modelo Java de ${analysis.entityType} não pôde ser criado ou reutilizado com segurança.`,
      'Revise os campos e tipos informados.'
    ]);
  }

  const dataAccessPlan = await buildDataAccessPlan(root, analysis, backendModelPlan);
  if (!dataAccessPlan) {
    options.warn?.('[FullStackFlowFastPath] Persistência/listagem Java não comprovada; execução bloqueada sem chamar o modelo.');
    return blockedFullStackResult(analysis, [
      `Não encontrei um padrão seguro de Repository/DAO/Database para listar ${analysis.entityType}.`,
      'Indique ou crie a camada de acesso a dados correspondente.'
    ]);
  }

  const targetResourceText = await readOptional(root, analysis.backendResourceFile!);
  const resourceExistingList = targetResourceText ? detectResourceListCall(targetResourceText) : undefined;
  const backendServicePlan = await buildBackendServicePlan(root, analysis, dataAccessPlan, backendModelPlan, resourceExistingList?.serviceMethod);
  if (!backendServicePlan) {
    options.warn?.('[FullStackFlowFastPath] Persistência/listagem Java não comprovada; execução bloqueada sem chamar o modelo.');
    return blockedFullStackResult(analysis, [
      `Não encontrei um acesso a dados comprovado para listar ${analysis.entityType}.`,
      'Crie ou indique o Repository/DAO/Database correspondente antes de gerar o restante do fluxo.'
    ]);
  }

  const backendResourcePlan = await buildBackendResourcePlan(root, analysis, backendServicePlan, backendModelPlan);
  if (!backendResourcePlan) {
    options.warn?.('[FullStackFlowFastPath] Resource/Controller não pôde ser montado com segurança; execução bloqueada sem chamar o modelo.');
    return blockedFullStackResult(analysis, [
      `Não foi possível comprovar o padrão de Resource/Controller para ${analysis.entityType}.`,
      'Nenhuma alteração foi preparada.'
    ]);
  }

  const frontendModelPlan = await buildFrontendModelPlan(root, analysis);
  if (!frontendModelPlan) {
    options.warn?.('[FullStackFlowFastPath] Model TypeScript não pôde ser comprovado; execução bloqueada sem chamar o modelo.');
    return blockedFullStackResult(analysis, [
      `Não foi possível criar ou reutilizar o model TypeScript de ${analysis.entityType}.`,
      'Nenhuma alteração foi preparada.'
    ]);
  }

  const frontendServicePlan = await buildFrontendServicePlan(root, analysis);
  if (!frontendServicePlan) {
    options.warn?.('[FullStackFlowFastPath] Service TypeScript não pôde ser comprovado; execução bloqueada sem chamar o modelo.');
    return blockedFullStackResult(analysis, [
      `Não foi possível comprovar o padrão HTTP do service.ts de ${analysis.entityType}.`,
      'Nenhuma alteração foi preparada.'
    ]);
  }

  const componentPlans = await buildComponentPlans(root, analysis, frontendServicePlan);
  if (!componentPlans) {
    options.warn?.('[FullStackFlowFastPath] Componente Angular externo não pôde ser comprovado; execução bloqueada sem chamar o modelo.');
    return blockedFullStackResult(analysis, [
      `Não foi possível criar ou reutilizar com segurança o componente Angular de ${analysis.entityType}.`,
      'Nenhuma alteração foi preparada.'
    ]);
  }

  const plans: PlannedChange[] = [];
  addFilePlan(plans, backendModelPlan.filePath, backendModelPlan.content, backendModelPlan.existed, 'Modelo Java', backendModelPlan.originalContent);
  addFilePlan(plans, dataAccessPlan.filePath, dataAccessPlan.content, dataAccessPlan.existed, 'Acesso a dados Java', dataAccessPlan.originalContent);
  addFilePlan(plans, backendServicePlan.filePath, backendServicePlan.content, backendServicePlan.existed, 'Service Java de listagem', backendServicePlan.originalContent);
  addFilePlan(plans, backendResourcePlan.filePath, backendResourcePlan.content, backendResourcePlan.existed, 'Endpoint GET de listagem', backendResourcePlan.originalContent);
  if (frontendModelPlan.changed) {
    addFilePlan(plans, frontendModelPlan.filePath, frontendModelPlan.content, frontendModelPlan.existed, 'Model TypeScript');
  }
  addFilePlan(plans, frontendServicePlan.filePath, frontendServicePlan.content, frontendServicePlan.existed, 'Service TypeScript de listagem', frontendServicePlan.originalContent);
  for (const componentPlan of componentPlans) {
    addFilePlan(plans, componentPlan.filePath, componentPlan.content, componentPlan.existed, componentPlan.description);
  }

  if (!plans.length) {
    return {
      text: [
        'Nenhuma alteração foi necessária.',
        `O fluxo full-stack de listagem de ${analysis.entityType} já está implementado.`
      ].join('\n\n'),
      calls: [],
      results: [],
      complete: true
    };
  }

  options.info?.(
    [
      '[FullStackFlowFastPath] Plano estrutural full-stack comprovado; modelo não será chamado.',
      `entidade=${analysis.entityType}`,
      `alterações=${plans.length}`,
      `framework=${analysis.javaFramework}`
    ].join(' ')
  );

  const calls: ToolCall[] = [];
  const results: ToolResult[] = [];
  for (const plan of plans) {
    calls.push(plan.call);
    const result = await options.execute(plan.call);
    results.push(result);
    if (!result.ok) {
      options.warn?.(`[FullStackFlowFastPath] ${plan.call.name} falhou em ${plan.call.arguments.filePath}: ${result.error ?? 'erro desconhecido'}`);
      return {
        text: [
          'O fluxo full-stack não foi preparado integralmente.',
          `Falha em: ${String(plan.call.arguments.filePath)}`,
          'Revise ou rejeite eventuais alterações já preparadas antes de tentar novamente.'
        ].join('\n\n'),
        calls,
        results,
        complete: false
      };
    }
  }

  return {
    calls,
    results,
    complete: true,
    text: [
      'Fluxo full-stack de listagem preparado para revisão.',
      `Entidade: ${analysis.entityType}`,
      `Componente: ${analysis.componentFile}`,
      `Template: ${analysis.componentTemplateFile}`,
      `Estilo: ${analysis.componentStyleFile}`,
      `Service TypeScript: ${analysis.frontendServiceFile}`,
      `Endpoint Java: ${analysis.backendResourceFile}`,
      `Modelo Java: ${analysis.backendModelFile}`,
      `Acesso a dados: ${analysis.dataAccessFile}`,
      `Service Java: ${analysis.backendServiceFile}`,
      `Operação: GET /${analysis.pluralRoute}`
    ].join('\n\n')
  };
}

function describeMissingStructure(analysis: FullStackFlowAnalysis): string[] {
  const missing: string[] = [];
  if (!analysis.componentFile) missing.push('componente Angular');
  if (!analysis.componentTemplateFile) missing.push('template HTML');
  if (!analysis.componentStyleFile) missing.push('estilo CSS/SCSS');
  if (!analysis.frontendServiceFile) missing.push('service.ts');
  if (!analysis.frontendModelFile) missing.push('model TypeScript');
  if (!analysis.backendResourceFile) missing.push('Resource/Controller Java');
  if (!analysis.backendServiceFile) missing.push('Service Java');
  if (!analysis.backendModelFile) missing.push('modelo Java');
  if (!analysis.dataAccessFile) missing.push('Repository/DAO/Database Java');
  if (!analysis.javaFramework) missing.push('framework Java');
  if (analysis.modelFields.length === 0) missing.push('campos da entidade');
  return missing;
}

function blockedFullStackResult(
  analysis: FullStackFlowAnalysis,
  reasons: string[]
): FullStackFlowFastPathResult {
  return {
    calls: [],
    results: [],
    complete: true,
    text: [
      'O fluxo full-stack não foi preparado.',
      `Entidade: ${analysis.entityType}`,
      ...reasons,
      'Nenhum arquivo foi criado ou alterado.'
    ].join('\n\n')
  };
}


async function buildBackendModelPlan(
  root: string,
  analysis: FullStackFlowAnalysis
): Promise<BackendModelPlan | undefined> {
  const filePath = analysis.backendModelFile!;
  const existing = await readOptional(root, filePath);
  if (existing !== undefined) {
    if (declaredJavaType(existing) !== analysis.entityType) return undefined;
    return { filePath, content: existing, existed: true, originalContent: existing };
  }

  const reference = await readOptional(root, analysis.referenceBackendModelFile);
  if (!reference || !analysis.modelFields.length) return undefined;
  const packageName = javaPackage(reference);
  if (!packageName) return undefined;

  const fields = analysis.modelFields.map(field => ({ ...field, javaType: field.javaType ?? typeScriptToJavaType(field.type) }));
  if (fields.some(field => !field.javaType)) return undefined;

  const referenceIsEntity = /@Entity\b/.test(reference);
  if (referenceIsEntity && !fields.some(field => field.name === 'id')) return undefined;

  const line = lineEnding(reference);
  const imports = new Set<string>();
  const serializable = /\bimplements\s+Serializable\b/.test(reference) || /import\s+java\.io\.Serializable\s*;/.test(reference);
  if (serializable) imports.add('java.io.Serializable');
  if (referenceIsEntity) {
    const entityImport = importForSimpleName(reference, 'Entity')?.replace(/^import\s+|;$/g, '');
    const idImport = importForSimpleName(reference, 'Id')?.replace(/^import\s+|;$/g, '');
    if (entityImport) imports.add(entityImport);
    if (idImport) imports.add(idImport);
  }
  for (const field of fields) {
    const qualified = javaImportForType(field.javaType!);
    if (qualified) imports.add(qualified);
  }

  const annotations: string[] = [];
  if (referenceIsEntity) annotations.push('@Entity');
  const declaration = `public class ${analysis.entityType}${serializable ? ' implements Serializable' : ''} {`;
  const fieldLines: string[] = [];
  for (const field of fields) {
    if (referenceIsEntity && field.name === 'id') fieldLines.push('    @Id');
    fieldLines.push(`    private ${field.javaType} ${field.name};`);
  }

  const constructorParams = fields.map(field => `${field.javaType} ${field.name}`).join(', ');
  const constructorAssignments = fields.map(field => `        this.${field.name} = ${field.name};`);
  const accessors = fields.flatMap(field => {
    const suffix = capitalize(field.name);
    const getterPrefix = field.javaType === 'boolean' || field.javaType === 'Boolean' ? 'is' : 'get';
    return [
      `    public ${field.javaType} ${getterPrefix}${suffix}() { return ${field.name}; }`,
      `    public void set${suffix}(${field.javaType} ${field.name}) { this.${field.name} = ${field.name}; }`
    ];
  });

  const content = [
    `package ${packageName};`,
    '',
    ...[...imports].sort().map(value => `import ${value};`),
    ...(imports.size ? [''] : []),
    ...annotations,
    declaration,
    ...fieldLines,
    '',
    `    public ${analysis.entityType}() {}`,
    ...(fields.length ? [
      '',
      `    public ${analysis.entityType}(${constructorParams}) {`,
      ...constructorAssignments,
      '    }'
    ] : []),
    '',
    ...accessors,
    '}',
    ''
  ].join(line);
  return { filePath, content, existed: false };
}

async function buildDataAccessPlan(
  root: string,
  analysis: FullStackFlowAnalysis,
  backendModelPlan: BackendModelPlan
): Promise<DataAccessPlan | undefined> {
  const filePath = analysis.dataAccessFile!;
  const existing = await readOptional(root, filePath);
  if (existing !== undefined) {
    const className = declaredJavaType(existing) ?? path.posix.basename(filePath, '.java');
    const existingMethod = detectDataListMethod(existing, analysis.entityType);
    if (existingMethod) {
      return { filePath, className, methodName: existingMethod, content: existing, existed: true, originalContent: existing };
    }
    if (isSharedCollectionStore(filePath, existing)) {
      const updated = extendSharedCollectionStore(existing, analysis, backendModelPlan);
      if (!updated) return undefined;
      return {
        filePath,
        className,
        methodName: updated.methodName,
        content: updated.content,
        existed: true,
        originalContent: existing
      };
    }
    if (/(?:JpaRepository|CrudRepository)\s*</.test(existing)) {
      return { filePath, className, methodName: 'findAll', content: existing, existed: true, originalContent: existing };
    }
    return undefined;
  }

  const reference = await readOptional(root, analysis.referenceDataAccessFile);
  if (!reference || !/(?:JpaRepository|CrudRepository)\s*</.test(reference)) return undefined;
  const packageName = javaPackage(reference);
  const modelPackage = javaPackage(backendModelPlan.content);
  if (!packageName || !modelPackage) return undefined;
  const baseMatch = reference.match(/extends\s+(JpaRepository|CrudRepository)\s*<\s*[^,>]+\s*,\s*([^>]+)>/);
  if (!baseMatch) return undefined;
  const baseType = baseMatch[1]!;
  const idType = baseMatch[2]!.trim();
  const baseImport = importForSimpleName(reference, baseType)?.replace(/^import\s+|;$/g, '');
  if (!baseImport) return undefined;
  const className = path.posix.basename(filePath, '.java');
  const line = lineEnding(reference);
  const content = [
    `package ${packageName};`,
    '',
    `import ${modelPackage}.${analysis.entityType};`,
    `import ${baseImport};`,
    '',
    `public interface ${className} extends ${baseType}<${analysis.entityType}, ${idType}> {`,
    '}',
    ''
  ].join(line);
  return { filePath, className, methodName: 'findAll', content, existed: false };
}

function isSharedCollectionStore(filePath: string, content: string): boolean {
  return /(?:Database|Store)\.java$/i.test(filePath) && /\bList\s*<[^>]+>\s+[A-Za-z_$][\w$]*\s*=\s*new\s+ArrayList/.test(content);
}

function extendSharedCollectionStore(
  content: string,
  analysis: FullStackFlowAnalysis,
  backendModelPlan: BackendModelPlan
): { content: string; methodName: string } | undefined {
  const modelPackage = javaPackage(backendModelPlan.content);
  if (!modelPackage) return undefined;
  const line = lineEnding(content);
  const fieldName = routeToJavaIdentifier(analysis.pluralRoute);
  const methodName = `get${capitalize(fieldName)}`;
  if (new RegExp(`\\bList<\\s*${escapeRegex(analysis.entityType)}\\s*>\\s+${escapeRegex(fieldName)}\\b`).test(content)) {
    return { content, methodName };
  }

  let updated = ensureJavaImport(content, `${modelPackage}.${analysis.entityType}`);
  updated = ensureJavaImport(updated, 'java.util.ArrayList');
  updated = ensureJavaImport(updated, 'java.util.List');

  const listFields = [...updated.matchAll(/^\s*private\s+List<[^>]+>\s+[A-Za-z_$][\w$]*\s*=\s*new\s+ArrayList<[^;]*;\s*$/gm)];
  const lastField = listFields.at(-1);
  if (!lastField || lastField.index === undefined) return undefined;
  const fieldEnd = lastField.index + lastField[0].length;
  updated = `${updated.slice(0, fieldEnd)}${line}    private List<${analysis.entityType}> ${fieldName} = new ArrayList<>();${updated.slice(fieldEnd)}`;

  const getter = `    public List<${analysis.entityType}> ${methodName}() { return ${fieldName}; }`;
  const inserted = insertBeforeClassClosing(updated, getter);
  return inserted ? { content: inserted, methodName } : undefined;
}

function routeToJavaIdentifier(route: string): string {
  const parts = route.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return 'items';
  return parts[0]!.toLowerCase() + parts.slice(1).map(capitalize).join('');
}

function typeScriptToJavaType(type: string): string | undefined {
  const normalized = type.replace(/\s*\|\s*(?:null|undefined)/g, '').trim();
  if (normalized === 'string') return 'String';
  if (normalized === 'boolean') return 'Boolean';
  return undefined;
}

function javaImportForType(type: string): string | undefined {
  if (/^(?:LocalDate|LocalDateTime|OffsetDateTime|Instant)$/.test(type)) return `java.time.${type}`;
  if (/^(?:BigDecimal|BigInteger)$/.test(type)) return `java.math.${type}`;
  if (type === 'UUID' || type === 'Date') return `java.util.${type}`;
  return undefined;
}

async function buildBackendServicePlan(
  root: string,
  analysis: FullStackFlowAnalysis,
  dataAccessPlan: DataAccessPlan,
  backendModelPlan: BackendModelPlan,
  preferredMethod?: string
): Promise<BackendServicePlan | undefined> {
  const filePath = analysis.backendServiceFile!;
  const existing = await readOptional(root, filePath);
  const dataAccess = dataAccessPlan.content;
  const dataAccessType = dataAccessPlan.className;
  const dataMethod = dataAccessPlan.methodName;

  if (existing !== undefined) {
    const className = declaredJavaType(existing) ?? `${analysis.entityType}Service`;
    const existingMethod = detectJavaListMethod(existing, analysis.entityType);
    if (existingMethod) return { filePath, className, methodName: existingMethod, content: existing, existed: true, originalContent: existing };
    if (!dataAccess || !dataAccessType || !dataMethod) return undefined;
    const binding = detectJavaFieldBinding(existing, dataAccessType);
    if (!binding) return undefined;
    const methodName = uniqueMethodName(preferredMethod ?? preferredJavaListMethod(await readOptional(root, analysis.referenceBackendServiceFile)) ?? 'listarTodos', existing);
    let updated = ensureJavaImport(existing, 'java.util.List');
    const method = [
      `    public List<${analysis.entityType}> ${methodName}() {`,
      `        return ${binding.field}.${dataMethod}();`,
      '    }'
    ].join(lineEnding(updated));
    const inserted = insertBeforeClassClosing(updated, method);
    return inserted ? { filePath, className, methodName, content: inserted, existed: true, originalContent: existing } : undefined;
  }

  const reference = await readOptional(root, analysis.referenceBackendServiceFile);
  const backendModel = backendModelPlan.content;
  if (!reference || !backendModel || !dataAccess || !dataAccessType || !dataMethod) return undefined;

  const packageName = javaPackage(reference);
  const modelPackage = javaPackage(backendModel);
  const dataPackage = javaPackage(dataAccess);
  if (!packageName || !modelPackage || !dataPackage) return undefined;

  const className = `${analysis.entityType}Service`;
  const methodName = preferredMethod ?? preferredJavaListMethod(reference) ?? 'listarTodos';
  const line = lineEnding(reference);
  const annotation = serviceAnnotation(reference, analysis.javaFramework!);
  const injection = injectionNamespace(reference);
  const fieldName = detectJavaFieldBinding(reference, dataAccessType)?.field ?? defaultDataAccessField(dataAccessType);

  const imports = [
    `import ${modelPackage}.${analysis.entityType};`,
    `import ${dataPackage}.${dataAccessType};`,
    annotation.importLine,
    analysis.javaFramework === 'spring' ? undefined : injection.importLine,
    'import java.util.List;'
  ].filter((value): value is string => Boolean(value));

  const members = analysis.javaFramework === 'spring'
    ? [
        `    private final ${dataAccessType} ${fieldName};`,
        '',
        `    public ${className}(${dataAccessType} ${fieldName}) {`,
        `        this.${fieldName} = ${fieldName};`,
        '    }'
      ]
    : [
        `    ${injection.annotation}`,
        `    private ${dataAccessType} ${fieldName};`
      ];

  const content = [
    `package ${packageName};`,
    '',
    ...imports,
    '',
    annotation.annotation,
    `public class ${className} {`,
    ...members,
    '',
    `    public List<${analysis.entityType}> ${methodName}() {`,
    `        return ${fieldName}.${dataMethod}();`,
    '    }',
    '}',
    ''
  ].join(line);
  return { filePath, className, methodName, content, existed: false };
}

async function buildBackendResourcePlan(
  root: string,
  analysis: FullStackFlowAnalysis,
  servicePlan: BackendServicePlan,
  backendModelPlan: BackendModelPlan
): Promise<BackendResourcePlan | undefined> {
  const filePath = analysis.backendResourceFile!;
  const existing = await readOptional(root, filePath);
  if (existing !== undefined) {
    const existingList = detectResourceListCall(existing);
    if (existingList) {
      return {
        filePath,
        methodName: existingList.methodName,
        content: existing,
        existed: true,
        originalContent: existing
      };
    }
    const binding = detectJavaFieldBinding(existing, servicePlan.className);
    if (!binding) return undefined;
    const methodName = uniqueMethodName(preferredResourceListMethod(await readOptional(root, analysis.referenceResourceFile)) ?? 'listar', existing);
    let updated = existing;
    const line = lineEnding(existing);
    if (analysis.javaFramework === 'jax-rs') {
      updated = ensureJavaImport(updated, 'java.util.List');
      const method = [
        '    @GET',
        `    public List<${analysis.entityType}> ${methodName}() {`,
        `        return ${binding.field}.${servicePlan.methodName}();`,
        '    }'
      ].join(line);
      updated = insertBeforeClassClosing(updated, method) ?? '';
    } else {
      const method = [
        '    @GetMapping',
        `    public List<${analysis.entityType}> ${methodName}() {`,
        `        return ${binding.field}.${servicePlan.methodName}();`,
        '    }'
      ].join(line);
      updated = ensureJavaImport(updated, 'java.util.List');
      updated = ensureJavaImport(updated, 'org.springframework.web.bind.annotation.GetMapping');
      updated = insertBeforeClassClosing(updated, method) ?? '';
    }
    return updated ? { filePath, methodName, content: updated, existed: true, originalContent: existing } : undefined;
  }

  const reference = await readOptional(root, analysis.referenceResourceFile);
  const backendModel = backendModelPlan.content;
  const serviceText = servicePlan.content;
  if (!reference || !backendModel) return undefined;
  const packageName = javaPackage(reference);
  const modelPackage = javaPackage(backendModel);
  const servicePackage = javaPackage(serviceText);
  if (!packageName || !modelPackage || !servicePackage) return undefined;

  const suffix = path.posix.basename(filePath, '.java').replace(analysis.entityType, '') || (analysis.javaFramework === 'spring' ? 'Controller' : 'Resource');
  const className = `${analysis.entityType}${suffix}`;
  const methodName = preferredResourceListMethod(reference) ?? 'listar';
  const serviceField = 'service';
  const line = lineEnding(reference);

  let content: string;
  if (analysis.javaFramework === 'jax-rs') {
    const namespace = wsRsNamespace(reference);
    const inject = injectionNamespace(reference);
    content = [
      `package ${packageName};`,
      '',
      `import ${modelPackage}.${analysis.entityType};`,
      `import ${servicePackage}.${servicePlan.className};`,
      inject.importLine,
      `import ${namespace}.GET;`,
      `import ${namespace}.Path;`,
      `import ${namespace}.Produces;`,
      `import ${namespace}.core.MediaType;`,
      'import java.util.List;',
      '',
      `@Path("/${analysis.pluralRoute}")`,
      '@Produces(MediaType.APPLICATION_JSON)',
      `public class ${className} {`,
      `    ${inject.annotation}`,
      `    private ${servicePlan.className} ${serviceField};`,
      '',
      '    @GET',
      `    public List<${analysis.entityType}> ${methodName}() {`,
      `        return ${serviceField}.${servicePlan.methodName}();`,
      '    }',
      '}',
      ''
    ].join(line);
  } else {
    content = [
      `package ${packageName};`,
      '',
      `import ${modelPackage}.${analysis.entityType};`,
      `import ${servicePackage}.${servicePlan.className};`,
      'import org.springframework.web.bind.annotation.GetMapping;',
      'import org.springframework.web.bind.annotation.RequestMapping;',
      'import org.springframework.web.bind.annotation.RestController;',
      'import java.util.List;',
      '',
      '@RestController',
      `@RequestMapping("/${analysis.pluralRoute}")`,
      `public class ${className} {`,
      `    private final ${servicePlan.className} ${serviceField};`,
      '',
      `    public ${className}(${servicePlan.className} ${serviceField}) {`,
      `        this.${serviceField} = ${serviceField};`,
      '    }',
      '',
      '    @GetMapping',
      `    public List<${analysis.entityType}> ${methodName}() {`,
      `        return ${serviceField}.${servicePlan.methodName}();`,
      '    }',
      '}',
      ''
    ].join(line);
  }
  return { filePath, methodName, content, existed: false };
}

async function buildFrontendModelPlan(
  root: string,
  analysis: FullStackFlowAnalysis
): Promise<{ filePath: string; content: string; existed: boolean; changed: boolean } | undefined> {
  const filePath = analysis.frontendModelFile!;
  const existing = await readOptional(root, filePath);
  if (existing !== undefined) {
    if (!new RegExp(`\\b(?:interface|class|type)\\s+${escapeRegex(analysis.entityType)}\\b`).test(existing)) return undefined;
    return { filePath, content: existing, existed: true, changed: false };
  }
  const fields = analysis.modelFields;
  if (!fields.length) return undefined;
  const line = '\n';
  const body = fields.map(field => `  ${field.name}${field.optional ? '?' : ''}: ${field.type};`);
  const content = [`export interface ${analysis.entityType} {`, ...body, '}', ''].join(line);
  return { filePath, content, existed: false, changed: true };
}

async function buildFrontendServicePlan(
  root: string,
  analysis: FullStackFlowAnalysis
): Promise<FrontendServicePlan | undefined> {
  const filePath = analysis.frontendServiceFile!;
  const existing = await readOptional(root, filePath);
  if (existing !== undefined) {
    const className = declaredTypeScriptClass(existing) ?? `${analysis.entityType}Service`;
    const existingMethod = detectFrontendListMethod(existing, analysis.entityType);
    if (existingMethod) return { filePath, className, methodName: existingMethod, content: existing, existed: true, originalContent: existing };
    const httpField = detectHttpClientField(existing);
    const apiField = detectApiUrlField(existing);
    if (!httpField || !apiField) return undefined;
    const methodName = uniqueMethodName(preferredFrontendListMethod(await readOptional(root, analysis.referenceFrontendServiceFile)) ?? 'listar', existing);
    const line = lineEnding(existing);
    const method = [
      `  ${methodName}(): Observable<${analysis.entityType}[]> {`,
      `    return this.${httpField}.get<${analysis.entityType}[]>(this.${apiField});`,
      '  }'
    ].join(line);
    let updated = ensureTypeScriptImport(existing, 'Observable', 'rxjs');
    updated = insertBeforeClassClosing(updated, method) ?? '';
    return updated ? { filePath, className, methodName, content: updated, existed: true, originalContent: existing } : undefined;
  }

  const reference = await readOptional(root, analysis.referenceFrontendServiceFile);
  if (!reference) return undefined;
  const referenceUrl = detectApiUrlLiteral(reference);
  if (!referenceUrl) return undefined;
  const apiUrl = replaceLastRouteSegment(referenceUrl, analysis.pluralRoute);
  if (!apiUrl) return undefined;
  const className = `${analysis.entityType}Service`;
  const methodName = preferredFrontendListMethod(reference) ?? 'listar';
  const modelImport = relativeTypeScriptImport(filePath, analysis.frontendModelFile!);
  const line = lineEnding(reference);
  const content = [
    "import { Injectable } from '@angular/core';",
    "import { HttpClient } from '@angular/common/http';",
    "import { Observable } from 'rxjs';",
    `import { ${analysis.entityType} } from '${modelImport}';`,
    '',
    "@Injectable({ providedIn: 'root' })",
    `export class ${className} {`,
    `  private readonly apiUrl = '${apiUrl}';`,
    '',
    '  constructor(private readonly http: HttpClient) {}',
    '',
    `  ${methodName}(): Observable<${analysis.entityType}[]> {`,
    `    return this.http.get<${analysis.entityType}[]>(this.apiUrl);`,
    '  }',
    '}',
    ''
  ].join(line);
  return { filePath, className, methodName, content, existed: false };
}

async function buildComponentPlans(
  root: string,
  analysis: FullStackFlowAnalysis,
  servicePlan: FrontendServicePlan
): Promise<Array<{ filePath: string; content: string; existed: boolean; description: string }> | undefined> {
  const componentPath = analysis.componentFile!;
  const templatePath = analysis.componentTemplateFile!;
  const stylePath = analysis.componentStyleFile!;
  const existingComponent = await readOptional(root, componentPath);
  const existingTemplate = await readOptional(root, templatePath);
  const existingStyle = await readOptional(root, stylePath);

  if (existingComponent !== undefined) {
    if (!/@Component\s*\(/.test(existingComponent) || !new RegExp(`\\b${escapeRegex(servicePlan.className)}\\b`).test(existingComponent)) return undefined;
    if (existingTemplate === undefined || existingStyle === undefined) return undefined;
    return [];
  }
  if (existingTemplate !== undefined || existingStyle !== undefined) return undefined;

  const modelImport = relativeTypeScriptImport(componentPath, analysis.frontendModelFile!);
  const serviceImport = relativeTypeScriptImport(componentPath, servicePlan.filePath);
  const componentClass = `${analysis.entityType}ListComponent`;
  const selector = `app-${analysis.entityKebab}-list`;
  const templateName = path.posix.basename(templatePath);
  const styleName = path.posix.basename(stylePath);
  const loadMethod = /^listar/i.test(servicePlan.methodName) ? 'carregar' : 'load';
  const line = '\n';
  const component = [
    "import { CommonModule } from '@angular/common';",
    "import { Component, OnInit } from '@angular/core';",
    `import { ${analysis.entityType} } from '${modelImport}';`,
    `import { ${servicePlan.className} } from '${serviceImport}';`,
    '',
    '@Component({',
    `  selector: '${selector}',`,
    '  standalone: true,',
    '  imports: [CommonModule],',
    `  templateUrl: './${templateName}',`,
    `  styleUrls: ['./${styleName}']`,
    '})',
    `export class ${componentClass} implements OnInit {`,
    `  items: ${analysis.entityType}[] = [];`,
    '  loading = false;',
    "  errorMessage = '';",
    '',
    `  constructor(private readonly service: ${servicePlan.className}) {}`,
    '',
    '  ngOnInit(): void {',
    `    this.${loadMethod}();`,
    '  }',
    '',
    `  ${loadMethod}(): void {`,
    '    this.loading = true;',
    "    this.errorMessage = '';",
    '',
    `    this.service.${servicePlan.methodName}().subscribe({`,
    '      next: items => {',
    '        this.items = items;',
    '        this.loading = false;',
    '      },',
    '      error: () => {',
    "        this.errorMessage = 'Não foi possível carregar os dados.';",
    '        this.loading = false;',
    '      }',
    '    });',
    '  }',
    '}',
    ''
  ].join(line);

  const displayFields = analysis.modelFields.slice(0, 6);
  const title = humanize(pluralizeLabel(analysis.entityType));
  const headerCells = displayFields.map(field => `          <th>${humanize(field.name)}</th>`);
  const valueCells = displayFields.map(field => `          <td>{{ item.${field.name} }}</td>`);
  const template = [
    '<section class="list-page">',
    `  <h2>${title}</h2>`,
    '',
    '  <p *ngIf="loading">Carregando...</p>',
    '  <p *ngIf="errorMessage" class="error">{{ errorMessage }}</p>',
    '',
    '  <table *ngIf="!loading && !errorMessage">',
    '    <thead>',
    '      <tr>',
    ...headerCells,
    '      </tr>',
    '    </thead>',
    '    <tbody>',
    '      <tr *ngFor="let item of items">',
    ...valueCells,
    '      </tr>',
    '      <tr *ngIf="items.length === 0">',
    `        <td [attr.colspan]="${Math.max(1, displayFields.length)}">Nenhum registro encontrado.</td>`,
    '      </tr>',
    '    </tbody>',
    '  </table>',
    '</section>',
    ''
  ].join(line);

  const style = [
    '.list-page {',
    '  display: grid;',
    '  gap: 1rem;',
    '}',
    '',
    'table {',
    '  width: 100%;',
    '  border-collapse: collapse;',
    '}',
    '',
    'th,',
    'td {',
    '  padding: 0.75rem;',
    '  border-bottom: 1px solid #d9d9d9;',
    '  text-align: left;',
    '}',
    '',
    '.error {',
    '  font-weight: 600;',
    '}',
    ''
  ].join(line);

  return [
    { filePath: componentPath, content: component, existed: false, description: 'Componente Angular' },
    { filePath: templatePath, content: template, existed: false, description: 'Template HTML' },
    { filePath: stylePath, content: style, existed: false, description: 'Estilo do componente' }
  ];
}

function addFilePlan(
  plans: PlannedChange[],
  filePath: string,
  content: string,
  existed: boolean,
  description: string,
  originalContent?: string
): void {
  const call: ToolCall = existed
    ? {
        id: randomUUID(),
        name: 'apply_edit',
        arguments: { filePath, oldText: originalContent ?? content, newText: content, replaceAll: false }
      }
    : {
        id: randomUUID(),
        name: 'create_file',
        arguments: { filePath, content, reason: description }
      };
  if (existed && (originalContent === undefined || originalContent === content)) return;
  plans.push({ call, description });
}

async function readOptional(root: string, filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) return undefined;
  const absolute = resolveInsideRoot(root, filePath);
  if (!fs.existsSync(absolute)) return undefined;
  try { return await fsp.readFile(absolute, 'utf8'); } catch { return undefined; }
}

function detectJavaListMethod(content: string, entityType: string): string | undefined {
  const pattern = new RegExp(`\\b(?:public|protected)\\s+(?:java\\.util\\.)?(?:List|Collection|Iterable)<\\s*${escapeRegex(entityType)}\\s*>\\s+([A-Za-z_$][\\w$]*)\\s*\\(\\s*\\)`, 'g');
  const methods = [...content.matchAll(pattern)].map(match => match[1]!).filter(Boolean);
  const preferred = methods.find(name => LIST_METHOD_NAMES.test(name));
  return preferred ?? (methods.length === 1 ? methods[0] : undefined);
}

function detectDataListMethod(content: string, entityType: string): string | undefined {
  if (new RegExp(`(?:JpaRepository|CrudRepository)<\\s*${escapeRegex(entityType)}\\s*,`).test(content)) return 'findAll';
  return detectJavaListMethod(content, entityType);
}

function detectResourceListCall(content: string): { methodName: string; serviceMethod: string } | undefined {
  const blocks = [...content.matchAll(/@(?:GET|GetMapping)(?:\s*\([^)]*\))?[\s\S]{0,260}?\b(?:public|protected)\s+[^\r\n{]+\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{([\s\S]{0,360}?)\}/g)];
  for (const block of blocks) {
    const call = block[2]?.match(/\b(?:this\.)?([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(\s*\)/);
    if (call) return { methodName: block[1]!, serviceMethod: call[2]! };
  }
  return undefined;
}

function detectJavaFieldBinding(content: string, typeName: string): { type: string; field: string } | undefined {
  const fields = [...content.matchAll(/(?:^|\n)\s*(?:(?:@[\w.]+(?:\([^\r\n]*\))?)\s*)*(?:private|protected|public)\s+(?:final\s+)?([A-Za-z_$][\w$]*)\s+([A-Za-z_$][\w$]*)\s*;/g)]
    .map(match => ({ type: match[1]!, field: match[2]! }));
  return fields.find(field => field.type === typeName);
}

function preferredJavaListMethod(reference: string | undefined): string | undefined {
  if (!reference) return undefined;
  const methods = [...reference.matchAll(/\bpublic\s+(?:java\.util\.)?(?:List|Collection|Iterable)<[^>]+>\s+([A-Za-z_$][\w$]*)\s*\(\s*\)/g)]
    .map(match => match[1]!);
  return methods.find(name => LIST_METHOD_NAMES.test(name)) ?? methods[0];
}

function preferredResourceListMethod(reference: string | undefined): string | undefined {
  return reference ? detectResourceListCall(reference)?.methodName : undefined;
}

function preferredFrontendListMethod(reference: string | undefined): string | undefined {
  if (!reference) return undefined;
  const methods = [...reference.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*\)\s*:\s*Observable<[^>]+\[\]>/g)].map(match => match[1]!);
  return methods.find(name => LIST_METHOD_NAMES.test(name)) ?? methods[0];
}

function detectFrontendListMethod(content: string, entityType: string): string | undefined {
  const pattern = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\(\\s*\\)\\s*:\\s*Observable<\\s*${escapeRegex(entityType)}\\s*\\[\\]\\s*>[\\s\\S]{0,220}?\\.get<\\s*${escapeRegex(entityType)}\\s*\\[\\]\\s*>`, 'g');
  const methods = [...content.matchAll(pattern)].map(match => match[1]!);
  return methods.find(name => LIST_METHOD_NAMES.test(name)) ?? (methods.length === 1 ? methods[0] : undefined);
}

function detectHttpClientField(content: string): string | undefined {
  return content.match(/constructor\s*\([^)]*?(?:private|protected|public)?\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*HttpClient/)?.[1]
    ?? content.match(/(?:private|protected|public)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*HttpClient\s*;/)?.[1];
}

function detectApiUrlField(content: string): string | undefined {
  return content.match(/(?:private|protected|public)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*(?:Url|URL|Api|API)[A-Za-z_$\d]*)\s*=\s*['"`]/)?.[1]
    ?? content.match(/(?:private|protected|public)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*=\s*['"`][^'"`]*\/api\//)?.[1];
}

function detectApiUrlLiteral(content: string): string | undefined {
  return content.match(/(?:private|protected|public)\s+(?:readonly\s+)?[A-Za-z_$][\w$]*\s*=\s*['"]([^'"]+)['"]\s*;/)?.[1];
}

function replaceLastRouteSegment(url: string, route: string): string | undefined {
  const clean = url.replace(/\/+$/, '');
  if (!clean.includes('/')) return undefined;
  return `${clean.slice(0, clean.lastIndexOf('/') + 1)}${route}`;
}

function serviceAnnotation(reference: string, framework: 'jax-rs' | 'spring'): { annotation: string; importLine: string } {
  if (/@Stateless\b/.test(reference)) return { annotation: '@Stateless', importLine: importForSimpleName(reference, 'Stateless') ?? 'import jakarta.ejb.Stateless;' };
  if (/@ApplicationScoped\b/.test(reference)) return { annotation: '@ApplicationScoped', importLine: importForSimpleName(reference, 'ApplicationScoped') ?? 'import jakarta.enterprise.context.ApplicationScoped;' };
  if (/@Service\b/.test(reference) || framework === 'spring') return { annotation: '@Service', importLine: 'import org.springframework.stereotype.Service;' };
  return { annotation: '@ApplicationScoped', importLine: 'import jakarta.enterprise.context.ApplicationScoped;' };
}

function injectionNamespace(reference: string): { annotation: string; importLine: string } {
  if (/import\s+javax\.inject\.Inject\s*;/.test(reference)) return { annotation: '@Inject', importLine: 'import javax.inject.Inject;' };
  if (/import\s+jakarta\.inject\.Inject\s*;/.test(reference)) return { annotation: '@Inject', importLine: 'import jakarta.inject.Inject;' };
  if (/@Autowired\b/.test(reference)) return { annotation: '@Autowired', importLine: 'import org.springframework.beans.factory.annotation.Autowired;' };
  return { annotation: '@Inject', importLine: 'import jakarta.inject.Inject;' };
}

function wsRsNamespace(reference: string): string {
  return /import\s+javax\.ws\.rs\./.test(reference) ? 'javax.ws.rs' : 'jakarta.ws.rs';
}

function importForSimpleName(content: string, name: string): string | undefined {
  return content.match(new RegExp(`^\\s*import\\s+([\\w.]+\\.${escapeRegex(name)})\\s*;`, 'm'))?.[1]
    ? `import ${content.match(new RegExp(`^\\s*import\\s+([\\w.]+\\.${escapeRegex(name)})\\s*;`, 'm'))?.[1]};`
    : undefined;
}

function ensureJavaImport(content: string, qualifiedName: string): string {
  const simple = qualifiedName.split('.').at(-1)!;
  if (new RegExp(`^\\s*import\\s+${escapeRegex(qualifiedName)}\\s*;`, 'm').test(content)) return content;
  if (new RegExp(`^\\s*import\\s+[\\w.]+\\.${escapeRegex(simple)}\\s*;`, 'm').test(content)) return content;
  const imports = [...content.matchAll(/^\s*import\s+[\w.*]+\s*;\s*$/gm)];
  const insertion = imports.at(-1)?.index;
  const line = lineEnding(content);
  if (insertion !== undefined) {
    const match = imports.at(-1)!;
    const end = match.index! + match[0].length;
    return `${content.slice(0, end)}${line}import ${qualifiedName};${content.slice(end)}`;
  }
  const packageMatch = content.match(/^\s*package\s+[\w.]+\s*;\s*$/m);
  if (!packageMatch || packageMatch.index === undefined) return content;
  const end = packageMatch.index + packageMatch[0].length;
  return `${content.slice(0, end)}${line}${line}import ${qualifiedName};${content.slice(end)}`;
}

function ensureTypeScriptImport(content: string, name: string, modulePath: string): string {
  const importPattern = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegex(modulePath)}['"];?`);
  const existing = content.match(importPattern);
  if (existing) {
    const names = existing[1]!.split(',').map(value => value.trim()).filter(Boolean);
    if (names.includes(name)) return content;
    const replacement = `import { ${[...names, name].join(', ')} } from '${modulePath}';`;
    return content.replace(importPattern, replacement);
  }
  const line = lineEnding(content);
  const imports = [...content.matchAll(/^import[^\r\n]+;\s*$/gm)];
  const last = imports.at(-1);
  if (!last || last.index === undefined) return `import { ${name} } from '${modulePath}';${line}${content}`;
  const end = last.index + last[0].length;
  return `${content.slice(0, end)}${line}import { ${name} } from '${modulePath}';${content.slice(end)}`;
}

function insertBeforeClassClosing(content: string, member: string): string | undefined {
  const closing = content.lastIndexOf('}');
  if (closing < 0) return undefined;
  const line = lineEnding(content);
  const before = content.slice(0, closing).replace(/[ \t\r\n]+$/u, '');
  return `${before}${line}${line}${member}${line}${content.slice(closing)}`;
}

function relativeTypeScriptImport(fromFile: string, targetFile: string): string {
  const relative = path.posix.relative(path.posix.dirname(fromFile), targetFile).replace(/\.ts$/i, '');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function declaredJavaType(content: string): string | undefined {
  return content.match(/\b(?:public\s+)?(?:class|record|interface)\s+([A-Za-z_$][\w$]*)/)?.[1];
}

function declaredTypeScriptClass(content: string): string | undefined {
  return content.match(/\bexport\s+class\s+([A-Za-z_$][\w$]*)/)?.[1];
}

function javaPackage(content: string): string | undefined {
  return content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1];
}

function uniqueMethodName(preferred: string, content: string): string {
  const used = new Set([...content.matchAll(/\b([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:\{|:)/g)].map(match => match[1]!));
  if (!used.has(preferred)) return preferred;
  let index = 2;
  while (used.has(`${preferred}${index}`)) index += 1;
  return `${preferred}${index}`;
}

function lineEnding(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n';
}


function defaultDataAccessField(typeName: string): string {
  if (/Repository$/i.test(typeName)) return 'repository';
  if (/Dao$/i.test(typeName)) return 'dao';
  if (/Database$/i.test(typeName)) return 'db';
  if (/Store$/i.test(typeName)) return 'store';
  return lowerFirst(typeName);
}

function capitalize(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function lowerFirst(value: string): string {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function pluralizeLabel(value: string): string {
  if (/y$/i.test(value) && !/[aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
  return `${value}s`;
}

function humanize(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
  return spaced ? `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}` : value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
