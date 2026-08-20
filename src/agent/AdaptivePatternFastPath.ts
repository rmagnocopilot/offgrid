import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeRelativePath, resolveInsideRoot } from '../safety/PathSafety';
import type { ToolCall, ToolResult } from '../types/contracts';
import { generatedFileContentIssue, isFileCreationTask, isJavaUnitTestCreationTask } from './AgentTaskPolicy';
import { trySynthesizePattern } from './PatternSynthesizers';
import {
  compactSourceForPattern,
  findWorkspaceReference,
  findWorkspaceSource,
  formatProjectProfile,
  profileProject,
  workspaceModuleRoot,
  type AdaptiveProjectProfile
} from './ProjectProfiler';

export interface AdaptivePatternFastPathResult {
  text: string;
  call?: ToolCall;
  result?: ToolResult;
  complete: boolean;
}

export interface AdaptivePatternFastPathOptions {
  request: string;
  workspaceRoot?: string;
  priority: string[];
  contextSize: number;
  generate: (params: {
    systemPrompt: string;
    prompt: string;
    maxTokens: number;
  }) => Promise<string>;
  execute: (call: ToolCall) => Promise<ToolResult>;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

const PATTERN_REFERENCE = /\b(?:seguindo|siga|conforme|padr[aã]o|modelo|exemplo|basead[oa]|refer[eê]ncia|use|usar|using|follow(?:ing)?|based\s+on|example|pattern)\b/i;
const SAME_LOCATION = /\b(?:mesm[oa]\s+(?:pacote|pasta|diret[oó]rio)|same\s+(?:package|folder|directory))\b/i;
const TEST_REFERENCE = /(?:Test|Tests|Spec)(?:\.[A-Za-z0-9]+)?$/i;

export async function tryPrepareAdaptivePatternFastPath(
  options: AdaptivePatternFastPathOptions
): Promise<AdaptivePatternFastPathResult | undefined> {
  const root = options.workspaceRoot;
  if (!root || !isAdaptiveCandidate(options.request)) return undefined;

  const prioritySource = resolvePrioritySource(root, options.priority);
  const priorityExtension = prioritySource ? path.extname(prioritySource).toLowerCase() : undefined;
  const requestedSource = await findWorkspaceSource(root, options.request, options.priority, priorityExtension);
  const sourceForScope = requestedSource ?? prioritySource;
  const preferredExtension = sourceForScope ? path.extname(sourceForScope).toLowerCase() : priorityExtension;
  const moduleRootHint = sourceForScope ? workspaceModuleRoot(root, sourceForScope) : '';
  const referencePath = await findWorkspaceReference(
    root,
    options.request,
    options.priority,
    preferredExtension,
    moduleRootHint
  );
  if (!referencePath) return undefined;
  const sourcePath = requestedSource
    ?? (prioritySource && prioritySource.toLowerCase() !== referencePath.toLowerCase() ? prioritySource : undefined);

  const [sourceText, referenceText] = await Promise.all([
    sourcePath ? fsp.readFile(resolveInsideRoot(root, sourcePath), 'utf8') : Promise.resolve(''),
    fsp.readFile(resolveInsideRoot(root, referencePath), 'utf8')
  ]);
  const profile = await profileProject({
    workspaceRoot: root,
    sourcePath,
    referencePath,
    sourceText: sourceText || undefined,
    referenceText
  });
  const targetPath = inferTargetPath(options.request, sourcePath, referencePath, profile);
  if (!targetPath) {
    const unresolvedJavaTest = /Test\.java$/i.test(referencePath)
      && isJavaUnitTestCreationTask(options.request, [...options.priority, referencePath]);
    if (unresolvedJavaTest) {
      options.warn?.('[AdaptiveFastPath] Referência de teste encontrada, mas a classe Java alvo não pôde ser determinada; AgentLoop não será iniciado.');
      return {
        complete: false,
        text: [
          'O padrão de testes foi encontrado, mas não foi possível determinar com segurança qual classe Java deve ser testada.',
          `Referência encontrada: ${referencePath}`,
          'Mantenha a classe de produção aberta no editor ou cite o nome dela no pedido. Nenhuma geração longa foi iniciada.'
        ].join('\n\n')
      };
    }
    options.warn?.('[AdaptiveFastPath] Estrutura reconhecida, mas o destino não pôde ser inferido com confiança; usando AgentLoop.');
    return undefined;
  }
  const synthesized = sourcePath ? trySynthesizePattern({
    request: options.request,
    sourcePath,
    sourceText,
    referencePath,
    referenceText,
    targetPath
  }) : undefined;
  if (synthesized?.confidence && synthesized.confidence >= 0.9) {
    const localContent = normalizeGeneratedContent(synthesized.content, targetPath);
    const localIssue = adaptiveContentIssue(
      targetPath,
      localContent,
      options.request,
      sourcePath,
      sourceText,
      referencePath,
      referenceText
    );
    if (!localIssue) {
      const prepared = await prepareAdaptiveWrite({
        root,
        targetPath,
        content: localContent,
        reason: `Arquivo sintetizado localmente a partir do padrão comprovado em ${referencePath}.`,
        execute: options.execute
      });
      options.info?.([
        '[AdaptiveFastPath] Padrão mecânico reconhecido; modelo não será chamado.',
        `tipo=${synthesized.kind}`,
        `confiança=${synthesized.confidence.toFixed(2)}`,
        `destino=${targetPath}`,
        `evidências=${synthesized.evidence.join(' | ')}`
      ].join(' '));
      if (prepared.unchanged) {
        return {
          complete: true,
          text: [
            'O arquivo já segue o padrão esperado; nenhuma alteração foi necessária.',
            `Arquivo: ${targetPath}`,
            `Padrão extraído de: ${referencePath}`
          ].join('\n\n')
        };
      }
      if (prepared.result?.ok) {
        return {
          call: prepared.call,
          result: prepared.result,
          complete: true,
          text: [
            'Arquivo preparado para revisão pelo Fast Path adaptativo.',
            `Arquivo: ${targetPath}`,
            `Padrão extraído de: ${referencePath}`,
            'A estrutura era determinística e foi sintetizada localmente, sem geração LLM.'
          ].join('\n\n')
        };
      }
      return {
        call: prepared.call,
        result: prepared.result,
        complete: false,
        text: `O padrão foi sintetizado, mas não foi possível preparar ${targetPath}: ${prepared.result?.error ?? 'erro desconhecido'}`
      };
    }
    options.warn?.(`[AdaptiveFastPath] Síntese local rejeitada (${localIssue}); usando geração direta compacta.`);
  }

  const budget = adaptiveGenerationBudget(options.contextSize);
  const sourceCompact = sourcePath
    ? compactSourceForPattern(sourcePath, sourceText, budget.sourceChars)
    : '';
  const referenceCompact = compactSourceForPattern(referencePath, referenceText, budget.referenceChars);
  const systemPrompt = buildSystemPrompt(profile, targetPath);
  const prompt = buildGenerationPrompt({
    request: options.request,
    sourcePath,
    sourceCompact,
    referencePath,
    referenceCompact,
    targetPath,
    profile
  });

  options.info?.([
    '[AdaptiveFastPath] Padrão do projeto resolvido; gerando conteúdo direto, sem tool-call JSON.',
    sourcePath ? `origem=${sourcePath}` : 'origem=nenhuma (criação por referência)',
    `referencia=${referencePath}`,
    `destino=${targetPath}`,
    `perfil=${profile.language}/${profile.buildSystem}`,
    `prompt=${prompt.length} chars`,
    `maxTokens=${budget.maxTokens}`
  ].join(' '));

  let generated: string;
  try {
    generated = await options.generate({
      systemPrompt,
      prompt,
      maxTokens: budget.maxTokens
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.warn?.(`[AdaptiveFastPath] Geração direta falhou: ${message}.`);
    return {
      complete: false,
      text: [
        'O padrão e o destino foram resolvidos pelo Fast Path adaptativo, mas a geração direta falhou.',
        `Motivo: ${message}`,
        'Nenhuma alteração foi preparada e o AgentLoop não será iniciado para evitar uma segunda tentativa longa.'
      ].join('\n\n')
    };
  }

  const content = normalizeGeneratedContent(generated, targetPath);
  const issue = adaptiveContentIssue(targetPath, content, options.request, sourcePath, sourceText, referencePath, referenceText);
  if (issue) {
    options.warn?.(`[AdaptiveFastPath] Conteúdo direto rejeitado: ${issue}`);
    return {
      complete: false,
      text: [
        'O padrão do projeto foi identificado, mas o conteúdo gerado não passou na validação local.',
        `Motivo: ${issue}`,
        'Nenhuma alteração foi preparada.'
      ].join('\n\n')
    };
  }

  const prepared = await prepareAdaptiveWrite({
    root,
    targetPath,
    content,
    reason: `Arquivo gerado pelo Adaptive Fast Path a partir do padrão comprovado em ${referencePath}.`,
    execute: options.execute
  });
  if (prepared.unchanged) {
    return {
      complete: true,
      text: `O arquivo ${targetPath} já contém o conteúdo esperado; nenhuma alteração foi necessária.`
    };
  }
  if (!prepared.result?.ok) {
    options.warn?.(`[AdaptiveFastPath] Escrita adaptativa falhou: ${prepared.result?.error ?? 'erro desconhecido'}.`);
    return {
      call: prepared.call,
      result: prepared.result,
      complete: false,
      text: `O conteúdo foi gerado, mas não foi possível preparar ${targetPath}: ${prepared.result?.error ?? 'erro desconhecido'}`
    };
  }

  return {
    call: prepared.call,
    result: prepared.result,
    complete: true,
    text: [
      'Arquivo preparado para revisão pelo Fast Path adaptativo.',
      `Arquivo: ${targetPath}`,
      `Padrão extraído de: ${referencePath}`
    ].join('\n\n')
  };
}

export function inferTargetPath(
  request: string,
  sourcePath: string | undefined,
  referencePath: string,
  profile: AdaptiveProjectProfile
): string | undefined {
  const normalizedSource = sourcePath ? normalizeRelativePath(sourcePath) : undefined;
  const normalizedReference = normalizeRelativePath(referencePath);
  const explicitTarget = explicitCreationTarget(request, normalizedReference);
  if (explicitTarget) return explicitTarget;
  if (!normalizedSource) return undefined;
  const sourceBase = path.posix.basename(normalizedSource);
  const referenceBase = path.posix.basename(normalizedReference);
  const sourceExt = path.extname(sourceBase);
  const referenceExt = path.extname(referenceBase);
  if (sourceExt.toLowerCase() !== referenceExt.toLowerCase()) return undefined;

  if (isJavaUnitTestCreationTask(request, [normalizedSource]) && sourceExt.toLowerCase() === '.java' && /Test\.java$/i.test(referenceBase)) {
    const className = path.posix.basename(sourceBase, '.java');

    // Uma referência de teste explicitamente citada pelo usuário é a melhor
    // evidência disponível para a convenção real de localização/pacote. Não
    // pressupomos que o pacote de testes espelha o package da produção: vários
    // projetos usam convenções como br.gov...tests.dto para testar ...dto.
    // O ProjectProfiler já garante que referência/origem pertencem ao workspace.
    return path.posix.join(path.posix.dirname(normalizedReference), `${className}Test.java`);
  }

  if (/\.component\.ts$/i.test(sourceBase) && /\.component\.spec\.ts$/i.test(referenceBase)) {
    return normalizedSource.replace(/\.component\.ts$/i, '.component.spec.ts');
  }
  if (/\.(?:ts|tsx|js|jsx)$/i.test(sourceBase) && /\.(?:spec|test)\.(?:ts|tsx|js|jsx)$/i.test(referenceBase)) {
    const suffix = referenceBase.match(/(\.(?:spec|test)\.(?:ts|tsx|js|jsx))$/i)?.[1];
    if (!suffix) return undefined;
    return path.posix.join(path.posix.dirname(normalizedReference), `${path.posix.basename(sourceBase, sourceExt)}${suffix}`);
  }

  // Para outras criações guiadas por padrão, só inferimos automaticamente se a
  // referência é claramente um artefato de teste. Evita inventar nomes em tarefas
  // de domínio que podem ter convenções específicas não observadas.
  if (TEST_REFERENCE.test(referenceBase) && SAME_LOCATION.test(request)) {
    const sourceStem = path.posix.basename(sourceBase, sourceExt);
    const refStem = path.posix.basename(referenceBase, referenceExt);
    const suffix = refStem.match(/(Test|Tests|Spec)$/i)?.[1];
    if (suffix) return path.posix.join(path.posix.dirname(normalizedReference), `${sourceStem}${suffix}${referenceExt}`);
  }
  return undefined;
}

export function normalizeGeneratedContent(response: string, targetPath: string): string {
  let value = String(response ?? '').trim();
  const fenced = value.match(/^```(?:[A-Za-z0-9_+.-]+)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/);
  if (fenced?.[1]) value = fenced[1].trim();

  // Pequenos modelos ocasionalmente ainda devolvem o envelope de create_file.
  // Extraímos apenas quando o JSON está completo; nunca tentamos reparar JSON truncado.
  if (/^\s*\{/.test(value) && /"(?:content|filePath)"\s*:/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      const candidate = parsed?.arguments?.content ?? parsed?.content;
      if (typeof candidate === 'string') value = candidate.trim();
    } catch {
      // Mantém o texto bruto para a validação acusar truncamento/invalidez.
    }
  }

  if (/\.java$/i.test(targetPath)) {
    value = value.replace(/^\s*(?:Aqui está|Segue|Conteúdo[^:]*:)\s*/i, '');
  }
  return value.replace(/\r?\n/g, '\n').trimEnd() + '\n';
}

function explicitCreationTarget(request: string, referencePath: string): string | undefined {
  const referenceBase = path.posix.basename(referencePath).toLowerCase();
  const connectorIndex = request.search(PATTERN_REFERENCE);
  const creationSegment = connectorIndex >= 0 ? request.slice(0, connectorIndex) : request;
  const files = creationSegment.match(/[A-Za-z0-9_$@.-]+\.(?:java|ts|tsx|js|jsx|py|cs|go|rs|xml|json|ya?ml)/gi) ?? [];
  const candidate = files.find(value => path.posix.basename(value.replace(/\\/g, '/')).toLowerCase() !== referenceBase);
  if (!candidate) return undefined;
  const normalized = candidate.replace(/\\/g, '/');
  try {
    if (normalized.includes('/')) return normalizeRelativePath(normalized);
    if (SAME_LOCATION.test(request)) return path.posix.join(path.posix.dirname(referencePath), normalized);
  } catch {
    return undefined;
  }
  return undefined;
}

function isAdaptiveCandidate(request: string): boolean {
  const normalized = String(request ?? '').replace(/\s+/g, ' ').trim();
  const explicitNamedFileCreation = /\b(?:crie|criar|gere|gerar|adicione|adicionar|escreva|escrever|create|generate|add|write)\b[\s\S]{0,120}\b[A-Za-z0-9_$@.-]+\.(?:java|ts|tsx|js|jsx|py|cs|go|rs|xml|json|ya?ml)\b/i.test(normalized);
  return (isFileCreationTask(normalized) || explicitNamedFileCreation) && PATTERN_REFERENCE.test(normalized);
}

function resolvePrioritySource(root: string, priority: readonly string[]): string | undefined {
  for (const value of priority) {
    const raw = String(value ?? '').split('#')[0];
    if (!raw) continue;
    try {
      const relative = normalizeRelativePath(raw);
      if (isLikelyReferenceArtifact(relative) || !isSourceCodeArtifact(relative)) continue;
      if (fileExists(resolveInsideRoot(root, relative))) return relative;
    } catch {
      // Próximo.
    }
  }
  return undefined;
}

function isLikelyReferenceArtifact(filePath: string): boolean {
  return /(?:Test|Tests)\.java$|\.(?:spec|test)\.[jt]sx?$/i.test(path.posix.basename(filePath));
}

function isSourceCodeArtifact(filePath: string): boolean {
  return /\.(?:java|ts|tsx|js|jsx|py|cs|go|rs)$/i.test(path.posix.basename(filePath));
}

function adaptiveGenerationBudget(contextSize: number): { sourceChars: number; referenceChars: number; maxTokens: number } {
  if (contextSize <= 4_096) return { sourceChars: 2_100, referenceChars: 2_400, maxTokens: 1_600 };
  if (contextSize <= 8_192) return { sourceChars: 4_000, referenceChars: 5_000, maxTokens: 2_400 };
  return { sourceChars: 6_000, referenceChars: 8_000, maxTokens: 3_200 };
}

function buildSystemPrompt(profile: AdaptiveProjectProfile, targetPath: string): string {
  return [
    'Você gera UM arquivo de código para um projeto existente.',
    'Responda SOMENTE com o conteúdo completo do arquivo, sem Markdown, sem JSON, sem explicações e sem chamadas de ferramenta.',
    'Use exclusivamente fatos observáveis na origem, referência e perfil fornecidos. Não invente APIs, campos, imports ou dependências.',
    'Preserve framework, convenções, estilo, pacote e nomenclatura da referência.',
    `Destino obrigatório: ${targetPath}.`,
    profile.testFramework ? `Framework observado: ${profile.testFramework}.` : '',
    'O arquivo deve terminar completo e sintaticamente fechado.'
  ].filter(Boolean).join('\n');
}

function buildGenerationPrompt(params: {
  request: string;
  sourcePath?: string;
  sourceCompact: string;
  referencePath: string;
  referenceCompact: string;
  targetPath: string;
  profile: AdaptiveProjectProfile;
}): string {
  return [
    `<perfil_projeto>${formatProjectProfile(params.profile)}</perfil_projeto>`,
    params.sourcePath
      ? `<arquivo_origem caminho="${params.sourcePath}">\n${params.sourceCompact}\n</arquivo_origem>`
      : undefined,
    `<arquivo_referencia caminho="${params.referencePath}">\n${params.referenceCompact}\n</arquivo_referencia>`,
    `<destino>${params.targetPath}</destino>`,
    `<tarefa>${params.request}</tarefa>`,
    'Gere agora somente o conteúdo completo do arquivo de destino.'
  ].filter(Boolean).join('\n\n');
}

function adaptiveContentIssue(
  targetPath: string,
  content: string,
  request: string,
  sourcePath: string | undefined,
  sourceText: string,
  referencePath: string,
  referenceText: string
): string | undefined {
  if (!content.trim()) return 'A geração retornou conteúdo vazio.';
  if (/^\s*\{\s*"(?:name|arguments|filePath|content)"/.test(content)) return 'O modelo retornou JSON em vez do conteúdo puro do arquivo.';
  const genericIssue = generatedFileContentIssue(targetPath, content, {
    request,
    sources: sourcePath ? [{ filePath: sourcePath, content: sourceText }] : []
  });
  if (genericIssue) return genericIssue;

  if (/\.java$/i.test(targetPath)) {
    const className = path.posix.basename(targetPath, '.java');
    const referencePackage = referenceText.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1];
    if (referencePackage && SAME_LOCATION.test(request)) {
      const generatedPackage = content.match(/\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/)?.[1];
      if (generatedPackage !== referencePackage) {
        return `O arquivo Java deve permanecer no pacote ${referencePackage}, observado em ${referencePath}.`;
      }
    }
    if (!new RegExp(`\\bclass\\s+${escapeRegex(className)}\\b`).test(content)) {
      return `O arquivo Java não declara a classe esperada ${className}.`;
    }
    if (!balancedBraces(content)) return 'O arquivo Java parece truncado: chaves não estão balanceadas.';
  }
  if (/\.json$/i.test(targetPath)) {
    try { JSON.parse(content); } catch { return 'O JSON gerado está incompleto ou inválido.'; }
  }
  if (/\.(?:ts|tsx|js|jsx)$/i.test(targetPath) && !balancedDelimiters(content)) {
    return 'O arquivo TypeScript/JavaScript parece truncado: delimitadores não estão balanceados.';
  }
  return undefined;
}

function balancedBraces(content: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const ch = content[index];
    const next = content[index + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (ch === '"' || ch === '\'') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth < 0) return false; }
  }
  return depth === 0 && !quote && !blockComment;
}

async function prepareAdaptiveWrite(params: {
  root: string;
  targetPath: string;
  content: string;
  reason: string;
  execute: (call: ToolCall) => Promise<ToolResult>;
}): Promise<{ call?: ToolCall; result?: ToolResult; unchanged?: boolean }> {
  const absolute = resolveInsideRoot(params.root, params.targetPath);
  let current: string | undefined;
  try { current = await fsp.readFile(absolute, 'utf8'); } catch { current = undefined; }
  if (current !== undefined && normalizeComparable(current) === normalizeComparable(params.content)) {
    return { unchanged: true };
  }

  const call: ToolCall = current === undefined
    ? {
        id: randomUUID(),
        name: 'create_file',
        arguments: { filePath: params.targetPath, content: params.content, reason: params.reason }
      }
    : {
        id: randomUUID(),
        name: 'apply_edit',
        arguments: {
          filePath: params.targetPath,
          oldText: current,
          newText: params.content,
          replaceAll: false
        }
      };
  return { call, result: await params.execute(call) };
}

function normalizeComparable(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function balancedDelimiters(content: string): boolean {
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const closers = new Set(Object.values(pairs));
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const ch = content[index];
    const next = content[index + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (!ch) continue;
    const expectedCloser = pairs[ch];
    if (expectedCloser) stack.push(expectedCloser);
    else if (closers.has(ch) && stack.pop() !== ch) return false;
  }
  return stack.length === 0 && !quote && !blockComment;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fileExists(filePath: string): boolean {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}
