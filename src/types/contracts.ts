export type Backend = 'auto' | 'cpu' | 'cuda' | 'vulkan' | 'metal';
export type EffectiveBackend = Exclude<Backend, 'auto'>;
export type EngineState = 'notStarted' | 'loading' | 'ready' | 'unloading' | 'unloaded' | 'error';
export type ConversationMode = 'chat' | 'plan' | 'readOnly' | 'agent';
export type AgentAutonomy = 'assisted' | 'autonomous';
export type DiagnosticsPanelMode = 'hidden' | 'compact' | 'expanded' | 'onError';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type ApprovalMode = 'ask' | 'readOnly' | 'full';

export interface ModelContextProfile {
  minimum: number;
  base: number;
  complex: number;
  maximum: number;
}

export interface ModelDefinition {
  id: string;
  displayName: string;
  fileName: string;
  description: string;
  hardware: string;
  approxSize: string;
  sha256: string;
  parts: string[];
  license: string;
  commercialUse: boolean;
  source: string;
  parameterCountB?: number;
  contextProfile?: ModelContextProfile;
  promptMode?: 'default' | 'no-think';
}

export type ModelInstallState = 'notInstalled' | 'installed' | 'active' | 'loaded' | 'error';
export interface ModelStatus extends ModelDefinition {
  state: ModelInstallState;
  filePath: string;
  fileSize: number;
  lastError?: string;
}

export interface EngineLoadOptions {
  modelPath: string;
  gpu: Backend;
  gpuLayers: number | 'auto';
  contextSize: number;
  maxTokens: number;
  temperature: number;
  fallbackToCpu: boolean;
  adaptiveGpu: boolean;
  promptMode?: 'default' | 'no-think';
}

export interface UnloadStep {
  name: 'session' | 'context' | 'model' | 'llama/runtime';
  status: 'absent' | 'completed' | 'error';
  message?: string;
}

export interface UnloadReport {
  reason: string;
  durationMs: number;
  steps: UnloadStep[];
  errors: Array<{ name: string; message: string; stack?: string }>;
}

export interface MemoryValue {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

export interface GpuMemoryValue extends MemoryValue {
  name: string;
  dedicated: boolean;
  source: 'nvidia-smi' | 'windows-cim' | 'unknown';
}

export interface ResourceSnapshot {
  capturedAt: string;
  platform: NodeJS.Platform;
  systemRam: MemoryValue;
  engineRam?: { pid: number; workingSetBytes: number };
  gpus: GpuMemoryValue[];
  gpuError?: string;
}

export interface EngineDiagnostics {
  loaded: boolean;
  loading: boolean;
  engineState: EngineState;
  agentActive: boolean;
  modelPath: string;
  backend: EffectiveBackend;
  contextSize: number | null;
  gpuLayers: number | 'auto';
  sequenceAcquisitions: number;
  workerPid: number | null;
  lastFallback: unknown | null;
  lastUnloadReport: UnloadReport | null;
  lastError: string | null;
  resources?: ResourceSnapshot;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw?: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  content: unknown;
  error?: string;
  durationMs: number;
}

export interface PendingFileChange {
  filePath: string;
  originalContent: string;
  proposedContent: string;
  existed: boolean;
  kind: PendingChangeKind;
}

export type PendingChangeKind = 'modified' | 'created' | 'deleted';
export interface PendingReviewFile {
  filePath: string;
  kind: PendingChangeKind;
}

export interface PendingReview {
  summary: string;
  files: PendingReviewFile[];
}

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';
export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: string;
}

export interface SessionMetadata {
  modelId?: string;
  backend?: EffectiveBackend;
  contextSize?: number;
  mode?: ConversationMode;
  contextFiles?: string[];
  lastError?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned: boolean;
  messages: ChatMessage[];
  metadata: SessionMetadata;
}

export type EngineRequestMethod =
  | 'load'
  | 'prompt'
  | 'agentStart'
  | 'agentStep'
  | 'agentFinish'
  | 'clearHistory'
  | 'diagnostics'
  | 'unload'
  | 'dispose';

export interface EngineRequest {
  type: 'request';
  requestId: string;
  method: EngineRequestMethod;
  params: Record<string, unknown>;
}

export interface EngineCancel { type: 'cancel'; requestId: string }
export interface EngineResult { type: 'result'; requestId: string; result: unknown }
export interface EngineErrorPayload { name: string; message: string; stack?: string; details?: unknown }
export interface EngineErrorMessage { type: 'error'; requestId: string; error: EngineErrorPayload }
export interface EngineChunk { type: 'chunk'; requestId: string; chunk: string }
export interface EngineReady { type: 'ready'; pid: number }
export interface EngineLog { type: 'log'; level: LogLevel; category: string; message: string }
export type WorkerOutboundMessage = EngineResult | EngineErrorMessage | EngineChunk | EngineReady | EngineLog;

export interface UiState {
  version: string;
  engine: EngineDiagnostics;
  models: ModelStatus[];
  activeModelId?: string;
  mode: ConversationMode;
  autonomy: AgentAutonomy;
  diagnosticsPanel: DiagnosticsPanelMode;
  pinnedFile?: string;
  autoFile?: string;
  contextItems: string[];
  sessions: ChatSession[];
  currentSessionId: string;
  pendingReview?: PendingReview;
  busy: boolean;
}
