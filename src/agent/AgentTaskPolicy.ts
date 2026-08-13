import * as path from 'node:path';

const DIRECT_FILE_CREATION = /\b(?:crie|criar|gere|gerar|produza|produzir|monte|montar)\s+(?:(?:um|uma|o|a)\s+)?(?:(?:novo|nova)\s+)?(?:arquivo|spec(?:\.ts)?|arquivo\s+de\s+testes?|componente|servi(?:c|\u00e7)o|service|classe|m(?:o|\u00f3)dulo)\b/i;
const ADD_NEW_FILE = /\b(?:adicione|adicionar|implemente|implementar)\s+(?:(?:um|uma|o|a)\s+)?(?:novo|nova)\s+(?:arquivo|spec(?:\.ts)?|componente|servi(?:c|\u00e7)o|service|classe|m(?:o|\u00f3)dulo)\b/i;
const DIRECT_TEST_CREATION = /\b(?:crie|criar|gere|gerar|adicione|adicionar|escreva|escrever)\b[\s\S]{0,100}\b\d*\s*testes?\b/i;
const JAVA_UNIT_TEST_CREATION = /\b(?:testes?\s+unit[aá]rio(?:s)?|unit\s+tests?|junit)\b/i;
const GENERIC_TEST_CLASS_CREATION = /\b(?:classe\s+de\s+testes?|classe\s+de\s+teste|test\s+class|tests?\s+(?:para|da|dessa|desta)\s+(?:classe|arquivo))\b/i;

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
 * Identifica pedidos explícitos de criação de teste unitário Java.
 */
export function isJavaUnitTestCreationTask(
  request: string,
  sourceHints: readonly string[] = []
): boolean {
  const normalized = String(request ?? '').replace(/\s+/g, ' ').trim();
  if (!isFileCreationTask(normalized)) return false;
  if (JAVA_UNIT_TEST_CREATION.test(normalized)) return true;

  // Usuários frequentemente pedem "crie a classe de testes" sem escrever
  // explicitamente "unitários". Só tratamos essa forma genérica como teste
  // Java quando já existe uma origem Java comprovada no contexto/prioridade,
  // evitando classificar specs TypeScript como JUnit por engano.
  const hasJavaSource = sourceHints.some(value =>
    /(?:^|\/)src\/main\/java\/.*\.java$/i.test(String(value ?? '').replace(/\\/g, '/').split('#')[0] ?? '')
  );
  return hasJavaSource && GENERIC_TEST_CLASS_CREATION.test(normalized);
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

/**
 * Para pedidos explícitos de teste Java que informam o pacote de destino,
 * deriva o caminho do teste a partir do arquivo Java prioritário. Isso evita
 * que modelos pequenos gastem uma etapa perguntando pelo arquivo ativo ou
 * escolham uma pasta de testes incorreta.
 */
export function javaUnitTestCreationTarget(
  request: string,
  priority: readonly string[],
  referenceFiles: readonly string[] = []
): string | undefined {
  const normalized = String(request ?? '').replace(/\s+/g, ' ').trim();
  if (!isJavaUnitTestCreationTask(normalized, priority)) return undefined;

  const source = priority
    .map(value => String(value ?? '').split('#')[0]?.replace(/\\/g, '/'))
    .find(value => /\/src\/main\/java\/.*\.java$/i.test(value ?? ''));
  if (!source) return undefined;

  const marker = source.toLowerCase().indexOf('/src/main/java/');
  if (marker < 0) return undefined;
  const modulePrefix = source.slice(0, marker);
  const className = path.posix.basename(source, '.java');
  if (!/^[A-Za-z_$][\w$]*$/.test(className)) return undefined;

  const packageMatch = normalized.match(/\b([a-z_$][\w$]*(?:\.[a-z_$][\w$]*){2,})\b/i);
  const explicitPackage = packageMatch?.[1];
  if (explicitPackage && !/\.(?:java|ts|tsx|js|json|xml|yml|yaml)$/i.test(explicitPackage)) {
    return path.posix.join(
      modulePrefix,
      'src/test/java',
      explicitPackage.replace(/\./g, '/'),
      `${className}Test.java`
    );
  }

  // Quando o usuário cita explicitamente um teste-exemplo, o diretório desse
  // arquivo é a evidência mais forte para a convenção de pacote/local de testes.
  // Isso cobre projetos em que src/main/java/br/.../dto é testado em
  // src/test/java/br/.../tests/dto, sem pressupor que os pacotes são espelhados.
  const normalizedModule = modulePrefix.toLowerCase();
  const explicitExample = referenceFiles
    .map(value => String(value ?? '').split('#')[0]?.replace(/\\/g, '/'))
    .find(value => {
      if (!value || !/\/src\/test\/java\/.*(?:Test|Tests)\.java$/i.test(value)) return false;
      if (path.posix.basename(value).toLowerCase() === `${className.toLowerCase()}test.java`) return false;
      const valueMarker = value.toLowerCase().indexOf('/src/test/java/');
      const valueModule = valueMarker >= 0 ? value.slice(0, valueMarker).toLowerCase() : '';
      if (valueModule !== normalizedModule) return false;
      const stem = path.posix.basename(value, '.java');
      return new RegExp(`\\b${escapeRegExp(stem)}\\b`, 'i').test(normalized);
    });
  if (explicitExample) return path.posix.join(path.posix.dirname(explicitExample), `${className}Test.java`);

  // Mantém a formulação explícita "mesmo pacote/pasta" como fallback quando
  // a referência foi resolvida pelo contexto, mesmo sem o nome aparecer no texto.
  if (/\b(?:mesm[oa]\s+(?:pacote|pasta)|same\s+package)\b/i.test(normalized)) {
    const example = referenceFiles
      .map(value => String(value ?? '').split('#')[0]?.replace(/\\/g, '/'))
      .find(value => {
        if (!value || !/\/src\/test\/java\/.*(?:Test|Tests)\.java$/i.test(value)) return false;
        const valueMarker = value.toLowerCase().indexOf('/src/test/java/');
        const valueModule = valueMarker >= 0 ? value.slice(0, valueMarker).toLowerCase() : '';
        return valueModule === normalizedModule;
      });
    if (example) return path.posix.join(path.posix.dirname(example), `${className}Test.java`);
  }

  return undefined;
}

export function agentOutputTokenFloor(request: string, sourceHints: readonly string[] = []): number {
  // Testes Java de DTO costumam carregar dezenas de métodos dentro de create_file.
  // Em 4K, 1024 tokens truncavam o JSON no meio do conteúdo e o retry repetia
  // a mesma falha. Reserve 2048 tokens para esse caso e mantenha 768 para
  // criações menores. O motor ainda reduz o valor se o tokenizer real exigir.
  if (isJavaUnitTestCreationTask(request, sourceHints)) return 2_048;
  return isFileCreationTask(request) ? 768 : 0;
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
    if (!/\bclass\s+[A-Za-z_$][\w$]*Test\b/.test(content) || !content.trimEnd().endsWith('}')) {
      return 'O arquivo Java de teste parece incompleto ou truncado antes do fechamento da classe.';
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