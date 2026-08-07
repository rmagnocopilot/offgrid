export type TaskLayer = 'endpoint' | 'service' | 'repository' | 'component' | 'model' | 'test' | 'unknown';
export type TaskOperation = 'create' | 'read' | 'update' | 'delete' | 'list' | 'test' | 'unknown';
export type TaskAction = 'create' | 'modify' | 'delete' | 'unknown';
export type TaskLanguage = 'java' | 'typescript' | 'unknown';

export interface LayeredTaskIntent {
  action: TaskAction;
  targetLayer: TaskLayer;
  targetLayers: TaskLayer[];
  referenceLayers: TaskLayer[];
  operation: TaskOperation;
  entityTerms: string[];
  language: TaskLanguage;
  explicitFiles: string[];
  confidence: 'high' | 'medium' | 'low';
  ambiguous: boolean;
}

interface LayerMention {
  layer: TaskLayer;
  index: number;
  end: number;
  text: string;
}

interface ActionMention {
  action: TaskAction;
  index: number;
  end: number;
  text: string;
}

const LAYER_PATTERNS: ReadonlyArray<{ layer: TaskLayer; pattern: RegExp }> = [
  {
    layer: 'endpoint',
    pattern: /\b(?:end[ -]?point|endpoint|rota|route|api\s+rest|recurso\s+rest|resource|controller|controlador|[\w$]+(?:resource|controller))\b/giu
  },
  {
    layer: 'service',
    pattern: /\b(?:service(?:\.(?:ts|java))?|servi[cç]o|camada\s+de\s+servi[cç]o|[\w$]+service)\b/giu
  },
  {
    layer: 'repository',
    pattern: /\b(?:repository|reposit[oó]rio|dao|data\s+access|[\w$]+repository)\b/giu
  },
  {
    layer: 'component',
    pattern: /\b(?:component(?:\.ts)?|componente|formul[aá]rio|form|view|tela|[\w$]+component)\b/giu
  },
  {
    layer: 'model',
    pattern: /\b(?:model|modelo|entity|entidade|dto|record|[\w$]+(?:dto|entity|model))\b/giu
  },
  {
    layer: 'test',
    pattern: /\b(?:teste|test|spec|unit[aá]rio|integra[cç][aã]o)\b/giu
  }
];

const ACTION_PATTERN = /\b(?:fa[cç]a|fazer|ajuste|ajustar|configure|configurar|crie|criar|cria|create|adicione|adicionar|adiciona|add|implemente|implementar|implementa|implement|gere|gerar|gera|generate|inclua|incluir|inclui|altere|modifique|atualize|edite|remova|remove|delete|exclua)\b/giu;
const REFERENCE_CONNECTOR = /(?:basead[oa]s?\s+(?:no|na|nos|nas|em)|a\s+partir\s+(?:do|da|dos|das|de)|usando|utilizando|seguindo|conforme|via|atrav[eé]s\s+(?:do|da|dos|das)|pelo|pela|pelos|pelas|equivalente\s+(?:ao|a|do|da)|para\s+(?:o|a|os|as))\s*$/iu;
const TARGET_PREPOSITION = /(?:\b(?:no|na|nos|nas|em|dentro\s+do|dentro\s+da|arquivo|ficheiro)\s+)$/iu;
const STOP_ENTITY = new Set([
  'adicionar', 'adicione', 'alterar', 'altere', 'atualizar', 'atualize', 'backend', 'baseado', 'criado',
  'criar', 'crie', 'delete', 'editar', 'edite', 'endpoint', 'equivalente', 'existente', 'frontend', 'implementar',
  'implemente', 'java', 'metodo', 'método', 'modelo', 'novo', 'nova', 'para', 'resource', 'controller', 'rota',
  'service', 'servico', 'serviço', 'typescript', 'usando', 'utilizando', 'update', 'pelo', 'pela', 'put', 'post', 'quando', 'tiver', 'continuar', 'formulario', 'formulário', 'form', 'usar', 'use'
]);

export function interpretLayeredTask(request: string): LayeredTaskIntent {
  const text = request.trim();
  const normalized = fold(text);

  const testIntent = interpretExplicitTestCreation(text, normalized);
  if (testIntent) return testIntent;
  const layers = findLayerMentions(normalized);
  const actions = findActionMentions(normalized);
  const explicitFiles = extractExplicitFiles(text);
  const lastAction = actions.at(-1);

  const explicitFileTarget = resolveExplicitFileTarget(explicitFiles, layers, lastAction);
  const locativeTarget = lastAction ? findLocativeTarget(normalized, layers, lastAction) : undefined;
  const directTarget = lastAction ? findDirectTarget(normalized, layers, lastAction) : undefined;
  const leadingTarget = lastAction ? findLeadingDirectiveTarget(normalized, layers, lastAction) : undefined;

  const targetMention = explicitFileTarget ?? locativeTarget ?? directTarget ?? leadingTarget
    ?? (layers.length === 1 ? layers[0] : undefined);

  const actionSegmentLayers = lastAction
    ? layers.filter(mention => mention.index >= lastAction.end && !isReferenceMention(normalized, mention))
    : [];
  const targetLayers = uniqueLayers(
    targetMention
      ? [targetMention.layer, ...actionSegmentLayers
          .filter(mention => mention.index !== targetMention.index)
          .filter(mention => isCoordinatedTarget(normalized, targetMention, mention))
          .map(mention => mention.layer)]
      : []
  );
  const ambiguous = targetLayers.length > 1 || (!targetMention && layers.length > 1);
  const targetLayer = ambiguous ? 'unknown' : targetMention?.layer ?? 'unknown';
  const referenceLayers = uniqueLayers(
    layers
      .filter(mention => !targetMention || mention.index !== targetMention.index)
      .filter(mention => !targetLayers.includes(mention.layer) || isReferenceMention(normalized, mention))
      .map(mention => mention.layer)
  );

  const confidence: LayeredTaskIntent['confidence'] = ambiguous
    ? 'low'
    : explicitFileTarget || locativeTarget || directTarget
      ? 'high'
      : targetMention
        ? 'medium'
        : 'low';

  return {
    action: lastAction?.action ?? inferAction(normalized),
    targetLayer,
    targetLayers,
    referenceLayers,
    operation: inferOperation(normalized),
    entityTerms: extractEntityTerms(text, explicitFiles),
    language: inferLanguage(normalized, explicitFiles),
    explicitFiles,
    confidence,
    ambiguous
  };
}

export function taskTargetsLayer(request: string, layer: TaskLayer): boolean {
  const intent = interpretLayeredTask(request);
  return !intent.ambiguous && intent.targetLayer === layer;
}

function interpretExplicitTestCreation(text: string, normalized: string): LayeredTaskIntent | undefined {
  const asksToCreate = /\b(?:crie|criar|gere|gerar|adicione|adicionar|escreva|escrever|create|generate|write)\b/i.test(normalized);
  const asksForTests = /\b(?:testes?|tests?|specs?)\b/i.test(normalized);
  const strongTestArtifact = /\b(?:testes?\s+unit[aá]rios?|unit\s+tests?|arquivo\s+de\s+testes?)\b/i.test(text)
    || /\b[A-Z][A-Za-z0-9_$]*Test\b/.test(text)
    || /\.(?:spec|test)\.[jt]s\b/i.test(text);
  if (!asksToCreate || !asksForTests || !strongTestArtifact) return undefined;

  const explicitFiles = extractExplicitFiles(text);
  const javaEvidence = inferLanguage(normalized, explicitFiles) === 'java'
    || /\b[A-Z][A-Za-z0-9_$]*(?:DTO|Dto|Entity|Model|VO|Service|Controller|Resource)?Test\b/.test(text)
    || /\b(?:[a-z_$][\w$]*\.){2,}[a-z_$][\w$]*\b/i.test(text);
  const typescriptEvidence = inferLanguage(normalized, explicitFiles) === 'typescript'
    || /\.component(?:\.spec)?\.ts\b/i.test(text);
  const language: TaskLanguage = javaEvidence && !typescriptEvidence
    ? 'java'
    : typescriptEvidence && !javaEvidence
      ? 'typescript'
      : inferLanguage(normalized, explicitFiles);

  const mentions = findLayerMentions(normalized);
  const references = uniqueLayers(
    mentions
      .filter(mention => mention.layer !== 'test' || isReferenceMention(normalized, mention))
      .map(mention => mention.layer)
  );
  if (/\b(?:exemplo|example|padrao|padrão|seguindo|basead[oa]|use|usar)\b/i.test(text)
    && /\b[A-Z][A-Za-z0-9_$]*Test\b/.test(text)
    && !references.includes('test')) {
    references.push('test');
  }
  if (/\b(?:DTO|Dto|Entity|Model|VO)\b/.test(text) && !references.includes('model')) {
    references.push('model');
  }

  return {
    action: 'create',
    targetLayer: 'test',
    targetLayers: ['test'],
    referenceLayers: references,
    operation: 'test',
    entityTerms: extractEntityTerms(text, explicitFiles),
    language,
    explicitFiles,
    confidence: language === 'unknown' ? 'medium' : 'high',
    ambiguous: false
  };
}

function findLayerMentions(text: string): LayerMention[] {
  const mentions: LayerMention[] = [];
  for (const definition of LAYER_PATTERNS) {
    definition.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = definition.pattern.exec(text)) !== null) {
      mentions.push({
        layer: definition.layer,
        index: match.index,
        end: match.index + match[0].length,
        text: match[0]
      });
    }
  }
  return mentions.sort((left, right) => left.index - right.index || right.end - left.end);
}

function findActionMentions(text: string): ActionMention[] {
  const result: ActionMention[] = [];
  ACTION_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ACTION_PATTERN.exec(text)) !== null) {
    result.push({
      action: actionForWord(match[0]),
      index: match.index,
      end: match.index + match[0].length,
      text: match[0]
    });
  }
  return result;
}

function actionForWord(word: string): TaskAction {
  if (/^(?:remov|delete|exclu)/i.test(word)) return 'delete';
  if (/^(?:fa[cç]|faz|ajust|configur|alter|modify|modific|atualiz|update|edit)/i.test(word)) return 'modify';
  return 'create';
}

function inferAction(text: string): TaskAction {
  if (/\b(?:remover|delete|excluir)\b/i.test(text)) return 'delete';
  if (/\b(?:fazer|fa[cç]a|ajustar|ajuste|configurar|configure|alterar|modificar|atualizar|editar|update|modify)\b/i.test(text)) return 'modify';
  if (/\b(?:criar|adicionar|implementar|gerar|create|add|implement)\b/i.test(text)) return 'create';
  return 'unknown';
}

function findLocativeTarget(text: string, layers: LayerMention[], action: ActionMention): LayerMention | undefined {
  const after = layers.filter(mention => mention.index >= action.end);
  for (const mention of after) {
    const prefix = text.slice(Math.max(action.end, mention.index - 48), mention.index);
    if (TARGET_PREPOSITION.test(prefix) && !REFERENCE_CONNECTOR.test(prefix)) return mention;
  }
  return undefined;
}

function findDirectTarget(text: string, layers: LayerMention[], action: ActionMention): LayerMention | undefined {
  const after = layers.filter(mention => mention.index >= action.end);
  for (const mention of after) {
    const between = text.slice(action.end, mention.index);
    if (between.length > 100 || /[.!?;]/.test(between)) break;
    if (REFERENCE_CONNECTOR.test(between)) continue;
    if (/\b(?:basead|usando|utilizando|seguindo|conforme|a\s+partir)\b/iu.test(between)) continue;
    return mention;
  }
  return undefined;
}

function findLeadingDirectiveTarget(text: string, layers: LayerMention[], action: ActionMention): LayerMention | undefined {
  const before = layers.filter(mention => mention.end <= action.index).reverse();
  for (const mention of before) {
    const prefix = text.slice(Math.max(0, mention.index - 32), mention.index);
    const suffix = text.slice(mention.end, action.index);
    if (TARGET_PREPOSITION.test(prefix) && /^[\s,:-]*$/u.test(suffix)) return mention;
  }
  return undefined;
}

function resolveExplicitFileTarget(
  explicitFiles: string[],
  layers: LayerMention[],
  action: ActionMention | undefined
): LayerMention | undefined {
  if (!explicitFiles.length) return undefined;
  const targetFiles = explicitFiles.filter(file => {
    const folded = fold(file);
    return /(?:\.service\.ts|service\.java|\.controller\.ts|resource\.java|controller\.java|\.component\.ts|\.repository\.(?:ts|java)|\.spec\.ts)$/i.test(folded);
  });
  if (!targetFiles.length) return undefined;

  const mapped = targetFiles.map(file => layerForFile(file)).filter((layer): layer is TaskLayer => layer !== 'unknown');
  if (mapped.length !== 1) return undefined;
  const layer = mapped[0]!;
  const candidates = layers.filter(mention => mention.layer === layer);
  if (!candidates.length) {
    return { layer, index: action?.end ?? 0, end: action?.end ?? 0, text: targetFiles[0] ?? '' };
  }
  if (!action) return candidates[0];
  return candidates.find(mention => mention.index >= action.end) ?? candidates.at(-1);
}

function layerForFile(file: string): TaskLayer {
  const normalized = fold(file);
  if (/(?:service\.java|\.service\.ts)$/i.test(normalized)) return 'service';
  if (/(?:resource|controller)\.java$|\.(?:controller|resource)\.ts$/i.test(normalized)) return 'endpoint';
  if (/\.repository\.(?:ts|java)$|repository\.java$/i.test(normalized)) return 'repository';
  if (/\.component\.ts$/i.test(normalized)) return 'component';
  if (/\.spec\.ts$|\.test\.[jt]s$/i.test(normalized)) return 'test';
  return 'unknown';
}

function isReferenceMention(text: string, mention: LayerMention): boolean {
  const prefix = text.slice(Math.max(0, mention.index - 64), mention.index);
  return REFERENCE_CONNECTOR.test(prefix)
    || /\b(?:basead|usando|utilizando|seguindo|conforme|a\s+partir)\b/iu.test(prefix.slice(-40));
}

function isCoordinatedTarget(text: string, first: LayerMention, candidate: LayerMention): boolean {
  if (candidate.index <= first.end || candidate.index - first.end > 40) return false;
  const between = text.slice(first.end, candidate.index);
  return /^\s*(?:,|e|and|\/|\+)\s*$/iu.test(between);
}

function inferOperation(text: string): TaskOperation {
  if (/(?:^|\s|@)(?:PUT|PATCH)(?=\s|\/|$)/i.test(text)
    || /\b(?:editar|edite|alterar|altere|atualizar|atualize|update|modify|patch)\b/i.test(text)) return 'update';
  if (/(?:^|\s|@)DELETE(?=\s|\/|$)/i.test(text)
    || /\b(?:excluir|exclua|remover|remova|deletar|delete)\b/i.test(text)) return 'delete';
  if (/(?:^|\s|@)GET(?=\s|\/|$)/i.test(text)
    || /\b(?:listar|consultar|buscar|obter|carregar|list|get|find|fetch)\b/i.test(text)) return 'list';
  if (/\b(?:teste|test|spec)\b/i.test(text)) return 'test';
  if (/(?:^|\s|@)POST(?=\s|\/|$)/i.test(text)
    || /\b(?:cadastrar|registrar|salvar|incluir|create|save|register)\b/i.test(text)) return 'create';
  return 'unknown';
}

function inferLanguage(text: string, files: string[]): TaskLanguage {
  if (files.some(file => /\.(?:ts|tsx)$/i.test(file)) || /\b(?:typescript|angular|nestjs?|node\.js)\b/i.test(text)) return 'typescript';
  const dottedJavaPackage = /\b(?:[a-z_$][\w$]*\.){2,}[a-z_$][\w$]*\b/i.test(text)
    && !/\.(?:ts|tsx|js|jsx|json|xml|yml|yaml)\b/i.test(text);
  if (files.some(file => /\.java$/i.test(file))
    || /\b(?:java|jakarta|jax-?rs|spring|junit|mockito)\b/i.test(text)
    || dottedJavaPackage
    || /\b[A-Z][A-Za-z0-9_$]*(?:DTO|Dto|Entity|Model|VO)Test\b/.test(text)) return 'java';
  return 'unknown';
}

function extractExplicitFiles(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z]:[\\/])?(?:[\w.@()-]+[\\/])*[\w.@()-]+\.(?:service\.ts|component\.ts|controller\.ts|resource\.ts|repository\.ts|spec\.ts|test\.[jt]s|java|ts|tsx)/giu) ?? [];
  return [...new Set(matches.map(value => value.trim().replace(/^["'`]|["'`,.;:]$/g, '')))];
}

function extractEntityTerms(text: string, files: string[]): string[] {
  const result: string[] = [];
  const add = (value: string | undefined): void => {
    if (!value) return;
    let normalized = fold(value)
      .replace(/\.(?:service|component|controller|resource|repository|spec)\.(?:ts|tsx)$/i, '')
      .replace(/\.java$/i, '')
      .replace(/(?:service|resource|controller|repository|component|dto|entity|model)$/i, '')
      .replace(/[^\p{L}\p{N}_$-]/gu, '')
      .replace(/s$/i, '');
    normalized = normalized.trim();
    if (normalized.length < 3 || STOP_ENTITY.has(normalized)) return;
    if (!result.includes(normalized)) result.push(normalized);
  };

  for (const file of files) {
    const base = file.split(/[\\/]/).at(-1);
    add(base);
  }

  const structuralMatches = [
    text.match(/\b(?:formul[aá]rio|form|tela|componente)\s+(?:de|do|da|dos|das)?\s*([\p{L}_$][\p{L}\p{N}_$-]*)/iu)?.[1],
    text.match(/\b([\p{L}_$][\p{L}\p{N}_$-]*)\s+(?:tiver|possuir|tem|tenha)\s+(?:um\s+)?id\b/iu)?.[1],
    text.match(/\b(?:service|servi[cç]o|endpoint|resource|controller)\s+(?:de|do|da)?\s*([\p{L}_$][\p{L}\p{N}_$-]*)/iu)?.[1]
  ];
  for (const match of structuralMatches) add(match);

  const operationMatch = text.match(
    /\b(?:editar|alterar|atualizar|cadastrar|salvar|listar|buscar|excluir|remover|update|edit|create|save|list|delete)\s+(?:(?:o|a|os|as|um|uma)\s+)?([\p{L}_$][\p{L}\p{N}_$-]*)/iu
  );
  add(operationMatch?.[1]);

  for (const token of text.match(/[A-Z][A-Za-z0-9_$]*(?:Service|Resource|Controller|Repository|Dto|DTO|Entity|Model)?/g) ?? []) add(token);
  return result.slice(0, 3);
}

function uniqueLayers(values: TaskLayer[]): TaskLayer[] {
  return [...new Set(values.filter(value => value !== 'unknown'))];
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
