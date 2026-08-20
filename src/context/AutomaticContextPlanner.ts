import type { ModelDefinition, ResourceSnapshot } from '../types/contracts';

export type ContextMode = 'automatic' | 'manual';
export type TaskComplexity = 'simple' | 'multiFile' | 'complex';

export interface ContextTaskEstimate {
  complexity: TaskComplexity;
  estimatedFiles: number;
  reason: string;
}

export interface ContextPlanInput {
  mode: ContextMode;
  manualContextSize: number;
  model: ModelDefinition;
  modelFileSizeBytes: number;
  resources: ResourceSnapshot;
  currentContextSize?: number | null;
  reclaimableBytes?: number;
  task?: ContextTaskEstimate;
}

export interface ContextPlan {
  contextSize: number;
  desiredContextSize: number;
  mode: ContextMode;
  complexity: TaskComplexity;
  estimatedFiles: number;
  availableBytes: number;
  estimatedRequiredBytes: number;
  reserveBytes: number;
  fallbackContexts: number[];
  reason: string;
  constrainedByMemory: boolean;
}

const GIB = 1024 ** 3;
const STANDARD_CONTEXTS = [2_048, 4_096, 8_192, 12_288, 16_384, 24_576, 32_768] as const;

/**
 * Estima a complexidade sem precisar abrir o workspace. O chamador pode
 * complementar estimatedFiles com a prioridade estrutural já calculada.
 */
export function estimateTaskComplexity(params: {
  request: string;
  estimatedFiles?: number;
  fullStack?: boolean;
  multiLayer?: boolean;
  createsFiles?: boolean;
}): ContextTaskEstimate {
  const normalized = normalize(params.request);
  const estimatedFiles = Math.max(1, Math.floor(params.estimatedFiles ?? 1));

  const complexByText = [
    'fluxo completo', 'full stack', 'full-stack', 'varias camadas', 'várias camadas',
    'projeto inteiro', 'workspace inteiro', 'refatore o fluxo', 'migracao', 'migração'
  ].some(fragment => normalized.includes(fragment));

  if (params.fullStack || complexByText || estimatedFiles >= 6) {
    return {
      complexity: 'complex',
      estimatedFiles,
      reason: params.fullStack ? 'fluxo full-stack' : estimatedFiles >= 6 ? `${estimatedFiles} arquivos estimados` : 'pedido de alta complexidade'
    };
  }

  const multiByText = [
    'componente e service', 'controller e service', 'endpoint e service',
    'mais de um arquivo', 'multiplos arquivos', 'múltiplos arquivos',
    'backend e frontend', 'model e service', 'dto e service'
  ].some(fragment => normalized.includes(fragment));

  // Criar um único artefato costuma precisar ler 2–3 arquivos de referência,
  // mas isso não transforma a tarefa em multi-arquivo. Classificar pelas entradas
  // inflava o contexto (ex.: DTO + teste-exemplo => 12288 no Qwen3 4B) sem
  // benefício para a geração e com forte penalidade no Vulkan.
  const smallCreation = Boolean(params.createsFiles)
    && !params.multiLayer
    && !multiByText
    && estimatedFiles <= 3;

  if (!smallCreation && (params.multiLayer || multiByText || estimatedFiles >= 2)) {
    return {
      complexity: 'multiFile',
      estimatedFiles,
      reason: params.multiLayer ? 'múltiplas camadas' : estimatedFiles >= 2 ? `${estimatedFiles} arquivos estimados` : 'tarefa multi-arquivo'
    };
  }

  return {
    complexity: 'simple',
    estimatedFiles,
    reason: smallCreation ? 'criação de um único artefato com referências' : 'tarefa simples'
  };
}

export function planContext(input: ContextPlanInput): ContextPlan {
  const mode = input.mode === 'manual' ? 'manual' : 'automatic';
  const task = input.task ?? { complexity: 'simple', estimatedFiles: 1, reason: 'carga inicial' };
  const profile = normalizedProfile(input.model);
  const desired = mode === 'manual'
    ? clampContext(input.manualContextSize, profile.maximum)
    : task.complexity === 'complex'
      ? profile.maximum
      : task.complexity === 'multiFile'
        ? profile.complex
        : profile.base;

  const engineWorkingSetBytes = Math.max(0, input.resources.engineRam?.workingSetBytes ?? 0);
  const estimatedReclaimableBytes = Math.max(0, input.reclaimableBytes ?? 0);
  // A RAM livre já exclui o processo atual do motor. Ao trocar/recarregar o
  // modelo, somente essa memória volta a ficar disponível. Somar working set e
  // uma segunda estimativa do mesmo modelo inflava o orçamento e autorizava
  // expansões que deixavam RAM/VRAM praticamente esgotadas.
  const recoverableEngineBytes = engineWorkingSetBytes > 0
    ? engineWorkingSetBytes
    : estimatedReclaimableBytes;
  const availableBytes = Math.max(
    0,
    input.resources.systemRam.freeBytes + recoverableEngineBytes
  );
  const reserveBytes = Math.min(3 * GIB, Math.max(1.25 * GIB, input.resources.systemRam.totalBytes * 0.15));

  if (mode === 'manual') {
    const required = estimateRequiredBytes(input.model, input.modelFileSizeBytes, desired);
    return {
      contextSize: desired,
      desiredContextSize: desired,
      mode,
      complexity: task.complexity,
      estimatedFiles: task.estimatedFiles,
      availableBytes,
      estimatedRequiredBytes: required,
      reserveBytes,
      fallbackContexts: contextFallbacks(desired, profile.minimum),
      reason: 'contexto manual configurado pelo usuário',
      constrainedByMemory: false
    };
  }

  const candidates = contextFallbacks(desired, profile.minimum);
  let selected = candidates.at(-1) ?? profile.minimum;
  let selectedRequired = estimateRequiredBytes(input.model, input.modelFileSizeBytes, selected);
  let constrainedByMemory = true;

  for (const candidate of candidates) {
    const required = estimateRequiredBytes(input.model, input.modelFileSizeBytes, candidate);
    const current = Number(input.currentContextSize ?? 0);
    const expansionBuffer = current > 0 && candidate > current ? 0.75 * GIB : 0;
    if (availableBytes - required >= reserveBytes + expansionBuffer) {
      selected = candidate;
      selectedRequired = required;
      constrainedByMemory = candidate < desired;
      break;
    }
  }

  // Uma queda posterior da RAM livre não reduz retroativamente a janela de um
  // motor que já está carregado. A memória dessa sessão já foi alocada. Antes,
  // o planner podia registrar contextoSelecionado=4096 e ação=keep enquanto o
  // runtime continuava efetivamente em 8192. Reduções só passam a existir após
  // uma carga/reinício real do motor.
  const current = Number(input.currentContextSize ?? 0);
  if (Number.isFinite(current) && current >= profile.minimum && current > selected) {
    selected = current;
    selectedRequired = estimateRequiredBytes(input.model, input.modelFileSizeBytes, selected);
    constrainedByMemory = selected < desired;
  }

  return {
    contextSize: selected,
    desiredContextSize: desired,
    mode,
    complexity: task.complexity,
    estimatedFiles: task.estimatedFiles,
    availableBytes,
    estimatedRequiredBytes: selectedRequired,
    reserveBytes,
    fallbackContexts: contextFallbacks(selected, profile.minimum),
    reason: constrainedByMemory
      ? `${task.reason}; reduzido para preservar memória do sistema`
      : `${task.reason}; memória suficiente`,
    constrainedByMemory
  };
}

export function contextFallbacks(selected: number, minimum = 4_096): number[] {
  const safeSelected = Math.max(2_048, Math.floor(selected));
  const safeMinimum = Math.max(2_048, Math.min(safeSelected, Math.floor(minimum)));
  const values = [safeSelected, ...STANDARD_CONTEXTS]
    .filter(value => value <= safeSelected && value >= safeMinimum)
    .sort((left, right) => right - left);
  return [...new Set(values)];
}

export function shouldExpandContext(currentContextSize: number | null | undefined, plan: ContextPlan): boolean {
  return plan.mode === 'automatic'
    && Number.isFinite(currentContextSize)
    && Number(currentContextSize) > 0
    && plan.contextSize > Number(currentContextSize);
}

export function formatContextPlan(plan: ContextPlan, modelId: string, currentContextSize?: number | null): string {
  const gb = (value: number): string => `${(value / GIB).toFixed(2)}GB`;
  const action = currentContextSize && plan.contextSize > currentContextSize ? 'restart' : 'keep';
  return [
    '[ContextPlanner]',
    `modelo=${modelId}`,
    `modo=${plan.mode}`,
    `complexidade=${plan.complexity}`,
    `arquivosEstimados=${plan.estimatedFiles}`,
    `ramDisponivel=${gb(plan.availableBytes)}`,
    `reserva=${gb(plan.reserveBytes)}`,
    `contextoAtual=${currentContextSize ?? 'nenhum'}`,
    `contextoDesejado=${plan.desiredContextSize}`,
    `contextoSelecionado=${plan.contextSize}`,
    `limitadoPorMemoria=${plan.constrainedByMemory}`,
    `acao=${action}`
  ].join(' ');
}

function normalizedProfile(model: ModelDefinition): { minimum: number; base: number; complex: number; maximum: number } {
  const profile = model.contextProfile;
  const minimum = clampContext(profile?.minimum ?? 4_096, 32_768);
  const base = Math.max(minimum, clampContext(profile?.base ?? 4_096, 32_768));
  const complex = Math.max(base, clampContext(profile?.complex ?? base, 32_768));
  const maximum = Math.max(complex, clampContext(profile?.maximum ?? complex, 32_768));
  return { minimum, base, complex, maximum };
}

function clampContext(value: number, maximum: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(value) : 4_096;
  return Math.max(2_048, Math.min(Math.max(2_048, Math.floor(maximum)), normalized));
}

export function estimateRequiredBytes(model: ModelDefinition, modelFileSizeBytes: number, contextSize: number): number {
  const parameters = Math.max(0.5, model.parameterCountB ?? inferParameterCount(model));
  const modelBytes = modelFileSizeBytes > 0
    ? modelFileSizeBytes
    : Math.max(0.5 * GIB, parameters * 0.62 * GIB);

  // Estimativa conservadora do KV cache em F16. A arquitetura real pode usar
  // GQA e consumir menos; a margem evita que o modo automático ocupe toda RAM.
  const kvBytes = parameters * 32 * 1024 * contextSize;
  const runtimeOverhead = 0.35 * GIB;
  return modelBytes + kvBytes + runtimeOverhead;
}

function inferParameterCount(model: ModelDefinition): number {
  const text = `${model.id} ${model.displayName}`.toLowerCase();
  const match = text.match(/(?:^|[^0-9.])(\d+(?:\.\d+)?)\s*b(?:[^a-z]|$)/i);
  return match ? Number(match[1]) : 3;
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
