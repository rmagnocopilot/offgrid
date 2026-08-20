import * as path from 'node:path';

export interface PatternSynthesisInput {
  request: string;
  sourcePath: string;
  sourceText: string;
  referencePath: string;
  referenceText: string;
  targetPath: string;
}

export interface PatternSynthesisResult {
  kind: string;
  content: string;
  confidence: number;
  evidence: string[];
}

interface AccessorPair {
  property: string;
  getter: string;
  setter: string;
  typeName: string;
}

interface ConstantValue {
  typeName: string;
  name: string;
  declaration: string;
}

export function trySynthesizePattern(input: PatternSynthesisInput): PatternSynthesisResult | undefined {
  return trySynthesizeJavaAccessorTest(input);
}

export function trySynthesizeJavaAccessorTest(input: PatternSynthesisInput): PatternSynthesisResult | undefined {
  if (!/\.java$/i.test(input.sourcePath) || !/Test\.java$/i.test(input.referencePath) || !/Test\.java$/i.test(input.targetPath)) {
    return undefined;
  }

  const sourcePackage = input.sourceText.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1];
  const referencePackage = input.referenceText.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1];
  const sourceClass = input.sourceText.match(/\b(?:public\s+)?class\s+([A-Za-z_$][\w$]*)\b/)?.[1];
  const referenceTestClass = input.referenceText.match(/\b(?:public\s+)?class\s+([A-Za-z_$][\w$]*Test)\b/)?.[1];
  if (!sourcePackage || !referencePackage || !sourceClass || !referenceTestClass) return undefined;

  const referenceSubject = referenceTestClass.replace(/Test$/, '');
  const instance = findReferenceInstance(input.referenceText, referenceSubject);
  if (!instance) return undefined;
  if (!hasUsableZeroArgConstructor(input.sourceText, sourceClass)) return undefined;

  const accessors = collectAccessorPairs(input.sourceText);
  if (!accessors.length) return undefined;

  const constants = collectConstants(input.referenceText);
  const valueByType = new Map<string, string>();
  for (const constant of constants) {
    if (!valueByType.has(normalizeType(constant.typeName))) valueByType.set(normalizeType(constant.typeName), constant.name);
  }
  const observedValues = collectObservedSetterValues(input.referenceText, instance.variableName);

  const testMethods: string[] = [];
  const extraImports = new Set<string>();
  for (const accessor of accessors) {
    const value = chooseValue(accessor.typeName, valueByType, observedValues, extraImports);
    testMethods.push(buildAccessorTestMethod(accessor, instance.variableName, value, input.referenceText));
  }

  const imports = buildImports({
    referenceText: input.referenceText,
    referenceSubject,
    sourcePackage,
    sourceClass,
    extraImports
  });
  const classAnnotations = collectClassAnnotations(input.referenceText, referenceTestClass);
  const instanceDeclaration = instance.declaration.replaceAll(referenceSubject, sourceClass);
  const constantDeclarations = constants.map(item => item.declaration);
  const indent = detectIndent(input.referenceText);

  const content = [
    `package ${referencePackage};`,
    '',
    ...imports,
    imports.length ? '' : undefined,
    ...classAnnotations,
    `public class ${sourceClass}Test {`,
    '',
    `${indent}${instanceDeclaration.trim()}`,
    ...(constantDeclarations.length ? ['', ...constantDeclarations.map(line => `${indent}${line.trim()}`)] : []),
    '',
    testMethods.join('\n\n'),
    '}',
    ''
  ].filter(value => value !== undefined).join('\n');

  return {
    kind: 'java-accessor-test-pattern',
    content,
    confidence: 0.97,
    evidence: [
      `${accessors.length} pares getter/setter comprovados na origem`,
      `instância ${referenceSubject} observada na referência`,
      `${constants.length} constantes de dados reutilizadas da referência`,
      `pacote de teste ${referencePackage}`
    ]
  };
}

function hasUsableZeroArgConstructor(source: string, className: string): boolean {
  const escaped = escapeRegex(className);
  const constructors = [...source.matchAll(new RegExp(
    `\\b(public|protected|private)?\\s*${escaped}\\s*\\(([^)]*)\\)\\s*\\{`,
    'g'
  ))];
  if (!constructors.length) return true;
  return constructors.some(match => {
    const visibility = match[1] ?? '';
    const parameters = String(match[2] ?? '').trim();
    return visibility !== 'private' && parameters.length === 0;
  });
}

function collectAccessorPairs(source: string): AccessorPair[] {
  const getters = new Map<string, { method: string; typeName: string }>();
  const setters = new Map<string, { method: string; typeName: string }>();

  const getterPattern = /\bpublic\s+([A-Za-z_$][\w$<>?, .\[\]]*)\s+(get|is)([A-Z][A-Za-z0-9_$]*)\s*\(\s*\)\s*(?:throws\s+[^\{]+)?\{/g;
  for (const match of source.matchAll(getterPattern)) {
    const typeName = match[1]?.trim();
    const prefix = match[2];
    const property = match[3];
    if (!typeName || !prefix || !property || typeName === 'void') continue;
    if (prefix === 'is' && !/^(?:boolean|Boolean)$/i.test(typeName)) continue;
    getters.set(property, { method: `${prefix}${property}`, typeName });
  }

  const setterPattern = /\bpublic\s+void\s+(set)([A-Z][A-Za-z0-9_$]*)\s*\(\s*([A-Za-z_$][\w$<>?, .\[\]]*)\s+[A-Za-z_$][\w$]*\s*\)\s*(?:throws\s+[^\{]+)?\{/g;
  for (const match of source.matchAll(setterPattern)) {
    const property = match[2];
    const typeName = match[3]?.trim();
    if (!property || !typeName) continue;
    setters.set(property, { method: `set${property}`, typeName });
  }

  const result: AccessorPair[] = [];
  for (const [property, getter] of getters) {
    const setter = setters.get(property);
    if (!setter) continue;
    if (normalizeType(getter.typeName) !== normalizeType(setter.typeName)) continue;
    result.push({ property, getter: getter.method, setter: setter.method, typeName: getter.typeName });
  }
  return result;
}

function findReferenceInstance(reference: string, subject: string): { variableName: string; declaration: string } | undefined {
  const escaped = escapeRegex(subject);
  const pattern = new RegExp(
    `(?:^|\\n)\\s*((?:(?:public|protected|private)\\s+)?${escaped}\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*new\\s+${escaped}\\s*\\(\\s*\\)\\s*;)`,
    'm'
  );
  const match = pattern.exec(reference);
  if (!match?.[1] || !match[2]) return undefined;
  return { variableName: match[2], declaration: match[1].trim() };
}

function collectConstants(reference: string): ConstantValue[] {
  const result: ConstantValue[] = [];
  const pattern = /(?:^|\n)\s*((?:(?:public|protected|private)\s+)?static\s+final\s+([A-Za-z_$][\w$<>?, .\[\]]*)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]+;)/g;
  for (const match of reference.matchAll(pattern)) {
    if (!match[1] || !match[2] || !match[3]) continue;
    result.push({ typeName: match[2].trim(), name: match[3], declaration: match[1].trim() });
  }
  return result;
}

function collectObservedSetterValues(reference: string, variableName: string): Map<string, string> {
  const result = new Map<string, string>();
  const pattern = new RegExp(`${escapeRegex(variableName)}\\.set([A-Z][A-Za-z0-9_$]*)\\s*\\(\\s*([^;\\n]+?)\\s*\\)\\s*;`, 'g');
  for (const match of reference.matchAll(pattern)) {
    const expression = match[2]?.trim();
    if (!expression) continue;
    const kind = expressionKind(expression);
    if (kind && !result.has(kind)) result.set(kind, expression);
  }
  return result;
}

function chooseValue(
  typeName: string,
  valuesByType: Map<string, string>,
  observedValues: Map<string, string>,
  extraImports: Set<string>
): string {
  const normalized = normalizeType(typeName);
  const direct = valuesByType.get(normalized);
  if (direct) return direct;

  // Arrays são referências em Java. Evita reutilizar um literal escalar
  // incompatível (por exemplo, String[] recebendo "teste").
  if (/\[\]\s*$/.test(typeName.trim())) return 'null';

  const simple = baseType(typeName);
  const primitiveKind = typeKind(simple);
  const observed = primitiveKind ? observedValues.get(primitiveKind) : undefined;
  if (observed) return observed;

  switch (simple) {
    case 'String': return '"teste"';
    case 'int': case 'Integer': case 'short': case 'Short': case 'byte': case 'Byte': return '10';
    case 'long': case 'Long': return '10L';
    case 'double': case 'Double': return '10.0d';
    case 'float': case 'Float': return '10.0f';
    case 'boolean': case 'Boolean': return 'true';
    case 'char': case 'Character': return "'A'";
    case 'BigDecimal': extraImports.add('java.math.BigDecimal'); return 'BigDecimal.TEN';
    case 'BigInteger': extraImports.add('java.math.BigInteger'); return 'BigInteger.TEN';
    case 'Date': extraImports.add('java.util.Date'); return 'new Date()';
    case 'LocalDate': extraImports.add('java.time.LocalDate'); return 'LocalDate.of(2026, 1, 1)';
    case 'LocalDateTime': extraImports.add('java.time.LocalDateTime'); return 'LocalDateTime.of(2026, 1, 1, 12, 0)';
    default:
      // Para tipos de domínio, enums, coleções e outros objetos, null é um
      // valor mecanicamente seguro para comprovar o contrato setter/getter sem
      // inventar construtores, mocks, fixtures ou dependências.
      return 'null';
  }
}

function buildAccessorTestMethod(accessor: AccessorPair, variableName: string, value: string, reference: string): string {
  const indent = detectIndent(reference);
  const methodIndent = indent.repeat(2);
  const testName = inferTestName(reference, accessor.property);
  if (value === 'null') {
    // Não declara uma variável do tipo complexo. Assim o teste não precisa
    // importar o tipo apenas para validar que o setter/getter aceita null.
    return [
      `${indent}@Test`,
      `${indent}public void ${testName}() {`,
      `${methodIndent}${variableName}.${accessor.setter}(null);`,
      `${methodIndent}assertEquals(null, ${variableName}.${accessor.getter}());`,
      `${indent}}`
    ].join('\n');
  }
  const resultType = accessor.typeName.trim();
  const assertion = /^(?:double|Double|float|Float)$/i.test(resultType)
    ? `assertEquals(${value}, resultado, 0.0);`
    : `assertEquals(${value}, resultado);`;
  return [
    `${indent}@Test`,
    `${indent}public void ${testName}() {`,
    `${methodIndent}${variableName}.${accessor.setter}(${value});`,
    `${methodIndent}${resultType} resultado = ${variableName}.${accessor.getter}();`,
    `${methodIndent}${assertion}`,
    `${indent}}`
  ].join('\n');
}

function inferTestName(reference: string, property: string): string {
  const names = [...reference.matchAll(/\bpublic\s+void\s+([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\{/g)]
    .map(match => match[1])
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  if (names.some(name => /^testGetSet[A-Z]/.test(name))) return `testGetSet${property}`;
  if (names.some(name => /^deve[A-Z]/.test(name))) return `devePermitirGetSet${property}`;
  return `testGetSet${property}`;
}

function buildImports(params: {
  referenceText: string;
  referenceSubject: string;
  sourcePackage: string;
  sourceClass: string;
  extraImports: Set<string>;
}): string[] {
  const imports = [...params.referenceText.matchAll(/^\s*import\s+([^;]+);/gm)]
    .map(match => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  const result = new Set<string>();
  for (const imported of imports) {
    if (new RegExp(`\\.${escapeRegex(params.referenceSubject)}$`).test(imported)) continue;
    result.add(imported);
  }
  result.add(`${params.sourcePackage}.${params.sourceClass}`);
  for (const imported of params.extraImports) result.add(imported);
  return [...result]
    .sort((left, right) => importGroup(left) - importGroup(right) || left.localeCompare(right))
    .map(value => `import ${value};`);
}

function collectClassAnnotations(reference: string, className: string): string[] {
  const classIndex = reference.search(new RegExp(`\\b(?:public\\s+)?class\\s+${escapeRegex(className)}\\b`));
  if (classIndex < 0) return [];
  const prefix = reference.slice(Math.max(0, classIndex - 500), classIndex);
  return (prefix.match(/^\s*@[^\n]+$/gm) ?? []).map(line => line.trim());
}

function detectIndent(reference: string): string {
  const line = reference.match(/^([ \t]+)@Test\b/m)?.[1]
    ?? reference.match(/^([ \t]+)(?:private|protected|public)?\s*[A-Za-z_$][\w$<>?, .\[\]]*\s+[A-Za-z_$][\w$]*\s*[=;]/m)?.[1];
  return line && line.length <= 8 ? line : '    ';
}

function normalizeType(value: string): string {
  return value.replace(/\s+/g, '').replace(/^java\.lang\./, '');
}

function baseType(value: string): string {
  const cleaned = value.trim().replace(/\[\]$/, '');
  const generic = cleaned.indexOf('<');
  const raw = generic >= 0 ? cleaned.slice(0, generic) : cleaned;
  return raw.slice(raw.lastIndexOf('.') + 1);
}

function typeKind(typeName: string): string | undefined {
  if (/^(?:String|CharSequence)$/i.test(typeName)) return 'string';
  if (/^(?:int|Integer|short|Short|byte|Byte)$/i.test(typeName)) return 'integer';
  if (/^(?:long|Long)$/i.test(typeName)) return 'long';
  if (/^(?:double|Double|float|Float)$/i.test(typeName)) return 'decimal';
  if (/^(?:boolean|Boolean)$/i.test(typeName)) return 'boolean';
  return undefined;
}

function expressionKind(expression: string): string | undefined {
  if (/^['"]/.test(expression)) return 'string';
  if (/^-?\d+[lL]$/.test(expression)) return 'long';
  if (/^-?\d+(?:\.\d+)?[dDfF]?$/.test(expression)) return expression.includes('.') ? 'decimal' : 'integer';
  if (/^(?:true|false)$/.test(expression)) return 'boolean';
  return undefined;
}

function importGroup(value: string): number {
  if (value.startsWith('static ')) return 3;
  if (value.startsWith('java.')) return 0;
  if (value.startsWith('javax.') || value.startsWith('jakarta.')) return 1;
  if (value.startsWith('org.')) return 2;
  return 1;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
