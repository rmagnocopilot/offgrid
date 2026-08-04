import * as path from 'node:path';

const DIRECT_FILE_CREATION = /\b(?:crie|criar|gere|gerar|produza|produzir|monte|montar)\s+(?:(?:um|uma|o|a)\s+)?(?:(?:novo|nova)\s+)?(?:arquivo|spec(?:\.ts)?|arquivo\s+de\s+testes?|componente|servi(?:c|\u00e7)o|service|classe|m(?:o|\u00f3)dulo)\b/i;
const ADD_NEW_FILE = /\b(?:adicione|adicionar|implemente|implementar)\s+(?:(?:um|uma|o|a)\s+)?(?:novo|nova)\s+(?:arquivo|spec(?:\.ts)?|componente|servi(?:c|\u00e7)o|service|classe|m(?:o|\u00f3)dulo)\b/i;
const DIRECT_TEST_CREATION = /\b(?:crie|criar|gere|gerar|adicione|adicionar|escreva|escrever)\b[\s\S]{0,100}\b\d*\s*testes?\b/i;

const PLACEHOLDER_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTODO\b/i, label: 'TODO' },
  { pattern: /\bFIXME\b/i, label: 'FIXME' },
  { pattern: /implement\s+(?:your|the)\s+(?:test\s+)?logic\s+here/i, label: 'Implement your test logic here' },
  {
    pattern: /(?:implemente|adicione|escreva)\s+(?:a\s+)?(?:l(?:o|\u00f3)gica|implementa(?:c|\u00e7)(?:a|\u00e3)o|teste)[^\n]{0,40}\baqui\b/i,
    label: 'coment\u00e1rio de implementa\u00e7\u00e3o pendente'
  },
  { pattern: /throw\s+new\s+Error\s*\(\s*['"`]Not implemented/i, label: 'Not implemented' },
  {
    pattern: /\/\/\s*(?:teste|test|implementa(?:c|\u00e7)(?:a|\u00e3)o)\s+(?:pendente|aqui)\b/i,
    label: 'coment\u00e1rio de teste pendente'
  }
];

export interface GeneratedFileSource {
  filePath: string;
  content: string;
}

export interface GeneratedFileValidationContext {
  request?: string;
  sources?: GeneratedFileSource[];
}

export function isFileCreationTask(request: string): boolean {
  const normalized = String(request ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;

  return DIRECT_TEST_CREATION.test(normalized)
    || DIRECT_FILE_CREATION.test(normalized)
    || ADD_NEW_FILE.test(normalized);
}

/**
 * Quando o usuário cita exatamente um nome de arquivo sem informar pasta,
 * o destino determinístico é a raiz do workspace.
 */
export function workspaceRootCreationTarget(
  explicitFiles: readonly string[],
  enabled = true
): string | undefined {
  if (!enabled || explicitFiles.length !== 1) return undefined;

  const candidate = String(explicitFiles[0] ?? '')
    .trim()
    .replace(/\\/g, '/');

  if (
    !candidate
    || candidate.includes('/')
    || /^[A-Za-z]:/u.test(candidate)
    || candidate === '.'
    || candidate === '..'
    || !/^[\w.@()-]+\.[A-Za-z0-9.]+$/u.test(candidate)
  ) {
    return undefined;
  }

  return candidate;
}

export function agentOutputTokenFloor(request: string): number {
  return isFileCreationTask(request) ? 512 : 0;
}

export function generatedFileContentIssue(
  filePath: unknown,
  content: unknown,
  context: GeneratedFileValidationContext = {}
): string | undefined {
  if (typeof content !== 'string' || !content.trim()) {
    return 'O conte\u00fado do arquivo gerado est\u00e1 vazio.';
  }

  for (const placeholder of PLACEHOLDER_PATTERNS) {
    if (placeholder.pattern.test(content)) {
      return `O arquivo gerado cont\u00e9m um placeholder n\u00e3o permitido (${placeholder.label}). Gere o conte\u00fado completo antes de chamar create_file.`;
    }
  }

  const normalizedPath = typeof filePath === 'string'
    ? filePath.replace(/\\/g, '/').toLowerCase()
    : '';

  if (/\/src\/test\/java\/.*(?:test|tests)\.java$/.test(normalizedPath)) {
    if (/^\s*\{\s*"@class"\s*:\s*"java\.lang\.String"/.test(content)) {
      return 'O conteúdo Java foi serializado como objeto em vez de código-fonte. Envie somente o texto do arquivo em content.';
    }

    const request = String(context.request ?? '');
    if (/\bjunit\s*4\b/i.test(request)) {
      if (/\borg\.junit\.jupiter\b/.test(content)) {
        return 'A tarefa pediu JUnit 4, mas o arquivo gerado usa JUnit 5 (org.junit.jupiter).';
      }
      if (!/\bimport\s+org\.junit\.Test\s*;/.test(content)) {
        return 'A tarefa pediu JUnit 4, mas o arquivo não importa org.junit.Test.';
      }
    }

    if (!/@Test\b/.test(content)) {
      return 'O arquivo Java de teste não contém nenhum método anotado com @Test.';
    }
    return undefined;
  }

  if (!/\.(?:spec|test)\.(?:ts|tsx|js|jsx)$/.test(normalizedPath)) {
    return undefined;
  }

  const tests = content.match(/\b(?:it|test)\s*\(/g)?.length ?? 0;
  if (tests === 0) {
    return 'O arquivo de teste gerado n\u00e3o cont\u00e9m nenhum caso it(...) ou test(...).';
  }

  const requestedTests = requestedTestCount(context.request);
  if (requestedTests > 0 && tests < requestedTests) {
    return `A tarefa pediu ${requestedTests} testes, mas o arquivo gerado cont\u00e9m apenas ${tests}.`;
  }

  if (
    /\bComponentFixture\s*</.test(content)
    && !/import\s*\{[^}]*\bComponentFixture\b[^}]*\}\s*from\s*['"]@angular\/core\/testing['"]/.test(content)
  ) {
    return 'O teste usa ComponentFixture, mas n\u00e3o o importa de @angular/core/testing.';
  }

  const source = companionComponentSource(normalizedPath, context.sources ?? []);
  if (!source) {
    return 'O componente de origem n\u00e3o estava no contexto. Leia o arquivo .component.ts correto antes de criar o spec.ts.';
  }

  const expectedSpecPath = source.filePath
    .replace(/\.component\.ts$/i, '.component.spec.ts')
    .replace(/\\/g, '/')
    .toLowerCase();

  if (normalizedPath !== expectedSpecPath) {
    return `O spec.ts deve ser criado ao lado do componente: ${expectedSpecPath}.`;
  }

  const componentClass = source.content.match(
    /\bexport\s+class\s+([A-Za-z_$][\w$]*)/
  )?.[1];

  if (
    /\bstandalone\s*:\s*true\b/.test(source.content)
    && componentClass
    && new RegExp(
      `\\bdeclarations\\s*:\\s*\\[[^\\]]*\\b${escapeRegExp(componentClass)}\\b`,
      'i'
    ).test(content)
  ) {
    return 'O componente \u00e9 standalone e deve ser configurado em imports, n\u00e3o em declarations.';
  }

  const sourceIdentifiers = new Set(
    source.content.match(/[A-Za-z_$][\w$]*/g) ?? []
  );

  const invalidMembers = [
    ...content.matchAll(/\bcomponent\.([A-Za-z_$][\w$]*)/g)
  ]
    .map(match => match[1])
    .filter(
      (member): member is string =>
        typeof member === 'string'
        && member.length > 0
        && !sourceIdentifiers.has(member)
    );

  if (invalidMembers.length) {
    return `O teste referencia membros que n\u00e3o existem no componente: ${[
      ...new Set(invalidMembers)
    ].join(', ')}.`;
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requestedTestCount(request: string | undefined): number {
  const match = String(request ?? '').match(/\b(\d+)\s+testes?\b/i);
  const value = Number(match?.[1] ?? 0);

  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function companionComponentSource(
  filePath: string,
  sources: GeneratedFileSource[]
): GeneratedFileSource | undefined {
  const expectedSource = filePath.replace(
    /\.component\.spec\.ts$/i,
    '.component.ts'
  );

  const exact = sources.find(
    source =>
      source.filePath.replace(/\\/g, '/').toLowerCase() === expectedSource
  );

  if (exact) return exact;

  const targetBase = path.posix.basename(expectedSource);

  return sources.find(
    source =>
      path.posix.basename(
        source.filePath.replace(/\\/g, '/')
      ).toLowerCase() === targetBase
  ) ?? sources.find(
    source => /\.component\.ts$/i.test(source.filePath)
  );
}