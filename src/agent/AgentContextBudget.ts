export type AgentModelTier = 'small' | 'medium' | 'large';

export interface AgentContextBudgetParams {
  contextSize: number;
  configuredMaxTokens: number;
  systemPromptChars: number;
  taskChars: number;
  modelFileSizeBytes: number;
  minimumOutputTokens?: number;
  /**
   * Contexto de workspace é majoritariamente código e tokeniza de forma mais
   * densa que prosa. Em janelas pequenas usamos uma razão conservadora para
   * evitar que o primeiro step consuma todo o KV cache.
   */
  compactCodeInput?: boolean;
}

export interface AgentContextBudget {
  maxOutputTokens: number;
  safetyTokens: number;
  continuationTokens: number;
  workspaceChars: number;
  maxFiles: number;
  maxCharsPerFile: number;
  modelTier: AgentModelTier;
}

// Calibração por tamanho do modelo (proxy via fileSize do GGUF Q4):
//   small  < 0,7 GB  → modelos ultracompactos
//   medium 0,7–3 GB  → 3B e 4B
//   large  > 3 GB    → 7B+
export function detectModelTier(modelFileSizeBytes: number): AgentModelTier {
  const GIB = 1024 ** 3;
  return modelFileSizeBytes > 3 * GIB ? 'large'
    : modelFileSizeBytes > 0.7 * GIB ? 'medium'
      : 'small';
}

/**
 * Reserva contexto não apenas para a resposta atual, mas também para pelo
 * menos uma continuação do AgentLoop. Isso é especialmente importante em
 * fallback de 4096: sem essa reserva, o primeiro prompt pode caber, mas o
 * segundo step (resultado de ferramenta + create_file) estoura o KV cache.
 */
export function calculateAgentContextBudget(params: AgentContextBudgetParams): AgentContextBudget {
  const contextSize = Math.max(256, Math.floor(params.contextSize));
  const configuredMaxTokens = Math.max(64, Math.floor(params.configuredMaxTokens));
  const minimumOutputTokens = Math.max(0, Math.floor(params.minimumOutputTokens ?? 0));

  const standardOutputCap = Math.max(96, Math.floor(contextSize * 0.16));
  const longFileGeneration = minimumOutputTokens >= 1_536;
  const extendedOutputCap = Math.max(
    standardOutputCap,
    Math.floor(contextSize * (longFileGeneration ? 0.50 : 0.25))
  );
  const outputCap = minimumOutputTokens > standardOutputCap
    ? extendedOutputCap
    : standardOutputCap;
  const maxOutputTokens = Math.min(
    Math.max(configuredMaxTokens, minimumOutputTokens),
    outputCap
  );

  const safetyTokens = Math.max(64, Math.floor(contextSize * 0.06));
  const continuationTokens = longFileGeneration
    ? 128
    : contextSize <= 4_096
      ? Math.max(512, Math.floor(contextSize * 0.18))
      : contextSize <= 8_192
        ? Math.max(512, Math.floor(contextSize * 0.10))
        : Math.max(384, Math.floor(contextSize * 0.06));

  const availableInitialInputTokens = Math.max(
    0,
    contextSize - maxOutputTokens - safetyTokens - continuationTokens
  );

  // System prompt e tarefa são majoritariamente prosa; 3 chars/token é uma
  // aproximação conservadora suficiente para Qwen. O workspace, por conter
  // código e pontuação, recebe uma razão menor nas janelas de 4K.
  const fixedOverheadChars = 384;
  const fixedInputTokens = Math.ceil(
    (params.systemPromptChars + params.taskChars + fixedOverheadChars) / 3
  );
  const workspaceTokenBudget = Math.max(0, availableInitialInputTokens - fixedInputTokens);
  const workspaceCharsPerToken = params.compactCodeInput || contextSize <= 4_096
    ? 2.0
    : 2.6;
  const workspaceChars = Math.max(128, Math.floor(workspaceTokenBudget * workspaceCharsPerToken));

  const modelTier = detectModelTier(params.modelFileSizeBytes);
  const tierMaxFiles = modelTier === 'large' ? 8 : modelTier === 'medium' ? 4 : 1;
  const tierMaxCharsPerFile = modelTier === 'large' ? 6_000 : modelTier === 'medium' ? 3_000 : 1_500;

  const maxFiles = Math.min(
    tierMaxFiles,
    workspaceChars >= 8_000 ? 8
      : workspaceChars >= 4_000 ? 5
        : workspaceChars >= 1_800 ? 3
          : workspaceChars >= 700 ? 2
            : 1
  );

  const maxCharsPerFile = Math.max(
    128,
    Math.min(tierMaxCharsPerFile, Math.floor(workspaceChars / maxFiles))
  );

  return {
    maxOutputTokens,
    safetyTokens,
    continuationTokens,
    workspaceChars,
    maxFiles,
    maxCharsPerFile,
    modelTier
  };
}
