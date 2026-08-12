import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import type { Backend, EngineLoadOptions, ResourceSnapshot } from '../types/contracts';

export interface LoadAttempt { gpu: Backend; gpuLayers: number | 'auto'; reason: string }
const PROFILE_STRATEGY_VERSION = 2;
interface StoredProfile {
  strategyVersion: number;
  modelKey: string;
  machineKey: string;
  contextSize?: number;
  attempt: LoadAttempt;
  updatedAt: string;
}

function recommendedFreeReserveGb(totalGb: number, contextSize: number): number {
  const contextExtra = contextSize >= 8_192 ? 0.25 : 0;
  if (totalGb <= 4.5) return 1.0 + contextExtra;
  if (totalGb <= 8.5) return 0.85 + contextExtra;
  return 0.65 + Math.min(0.25, contextExtra);
}

/**
 * Folga mínima depois da carga. Carregar o modelo não basta: placas de 4 GB
 * com menos de ~1,15 GB livres ficaram sujeitas a realocações de grafo durante
 * a inferência. Essa margem deixa espaço para KV/cache e buffers temporários.
 */
export function minimumPostLoadGpuFreeBytes(totalBytes: number, contextSize: number): number {
  const GIB = 1024 ** 3;
  const totalGb = Math.max(0, totalBytes / GIB);
  const baseGb = totalGb <= 4.5 ? 1.15
    : totalGb <= 8.5 ? 1.0
      : 0.75;
  const contextExtraGb = contextSize >= 8_192 ? 0.20 : 0;
  return Math.floor((baseGb + contextExtraGb) * GIB);
}

export function chooseLoadAttempts(options: EngineLoadOptions, resources: ResourceSnapshot, saved?: LoadAttempt): LoadAttempt[] {
  if (options.gpu !== 'auto') {
    const attempts: LoadAttempt[] = [{ gpu: options.gpu, gpuLayers: options.gpu === 'cpu' ? 0 : options.gpuLayers, reason: 'Configuração manual' }];
    if (options.fallbackToCpu && options.gpu !== 'cpu') attempts.push({ gpu: 'cpu', gpuLayers: 0, reason: 'Fallback final para CPU' });
    return dedupe(attempts);
  }

  const attempts: LoadAttempt[] = [];
  if (!options.adaptiveGpu) {
    attempts.push({ gpu: 'auto', gpuLayers: options.gpuLayers, reason: 'Detecção padrão sem perfil adaptativo' });
    if (options.fallbackToCpu) attempts.push({ gpu: 'cpu', gpuLayers: 0, reason: 'Fallback final para CPU' });
    return dedupe(attempts);
  }
  if (saved) attempts.push({ ...saved, reason: 'Perfil que funcionou anteriormente' });
  const bestGpu = [...resources.gpus].sort((a, b) => b.freeBytes - a.freeBytes)[0];
  if (bestGpu && bestGpu.freeBytes > 0) {
    const GIB = 1024 ** 3;
    const freeGb = bestGpu.freeBytes / GIB;
    const totalGb = bestGpu.totalBytes / GIB;
    if (options.gpuLayers !== 'auto') attempts.push({ gpu: 'vulkan', gpuLayers: options.gpuLayers, reason: 'Camadas configuradas pelo usuário' });
    else {
      // Não transforme toda VRAM livre em camadas. A inferência ainda precisa
      // de espaço para KV cache e buffers temporários do grafo.
      const reserveGb = recommendedFreeReserveGb(totalGb, options.contextSize);
      const usableGb = Math.max(0.2, freeGb - reserveGb);
      const baseline = Math.max(1, Math.min(40, Math.floor(usableGb * 8)));
      const qwen4b = /qwen3[-_]?4b/i.test(path.basename(options.modelPath));
      const qwen4bAt8k = qwen4b
        && options.contextSize > 4_096
        && options.contextSize <= 8_192;
      // Em 4K/4 GB, 34 camadas podem ser saudáveis quando a carga ainda deixa
      // folga real de VRAM. Tente o perfil rápido primeiro e deixe a verificação
      // pós-carga decidir; se ficar abaixo da margem, o próximo perfil é menor.
      const qwen4bAt4k = qwen4b && options.contextSize <= 4_096 && totalGb <= 4.5;
      const fast4k = qwen4bAt4k ? Math.max(baseline, Math.min(34, Math.floor(freeGb * 9))) : baseline;
      const initial = qwen4bAt8k
        ? Math.max(baseline, Math.min(30, baseline + 2))
        : fast4k;
      const nearInitial = initial > baseline ? Math.max(baseline, Math.min(30, initial - 4)) : baseline;
      for (const layers of [initial, nearInitial, baseline, Math.floor(initial * 0.75), Math.floor(initial * 0.5), 1]) {
        if (layers > 0) {
          attempts.push({
            gpu: 'vulkan',
            gpuLayers: layers,
            reason: `Perfil adaptativo (${freeGb.toFixed(1)} GB livres; reserva ${reserveGb.toFixed(1)} GB)`
          });
        }
      }
    }
  } else {
    // Diagnóstico indisponível não significa GPU ausente. A tentativa automática é obrigatória.
    attempts.push({ gpu: 'auto', gpuLayers: options.gpuLayers, reason: 'Detecção automática do backend' });
  }
  if (options.fallbackToCpu) attempts.push({ gpu: 'cpu', gpuLayers: 0, reason: 'Fallback final para CPU' });
  return dedupe(attempts);
}

function dedupe(attempts: LoadAttempt[]): LoadAttempt[] {
  const seen = new Set<string>();
  return attempts.filter(item => {
    const key = `${item.gpu}:${item.gpuLayers}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class HardwareProfileStore {
  private profiles: StoredProfile[] = [];
  private readonly file: string;
  constructor(storagePath: string) { this.file = path.join(storagePath, 'hardware-profiles.json'); }
  async init(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      const candidates = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.profiles)
          ? parsed.profiles
          : isRecord(parsed)
            ? Object.values(parsed)
            : [];

      // Perfis gravados por estratégias anteriores são descartados. Isso evita
      // ressuscitar, por exemplo, um Qwen3 4B/4K com 34 camadas em uma GPU de
      // 4 GB depois que a política passou a exigir folga pós-carga.
      this.profiles = candidates.filter(isStoredProfile);
    } catch {
      this.profiles = [];
    }
  }
  get(modelPath: string, contextSize?: number): LoadAttempt | undefined {
    const normalizedContext = normalizeContextSize(contextSize);
    return this.profiles.find(item =>
      item.modelKey === path.basename(modelPath)
      && item.machineKey === machineKey()
      && item.contextSize === normalizedContext
    )?.attempt;
  }
  async recordSuccess(modelPath: string, contextSize: number | undefined, attempt: LoadAttempt): Promise<void> {
    const modelKey = path.basename(modelPath);
    const key = machineKey();
    const normalizedContext = normalizeContextSize(contextSize);
    this.profiles = this.profiles.filter(item =>
      item.modelKey !== modelKey
      || item.machineKey !== key
      || item.contextSize !== normalizedContext
    );
    this.profiles.push({
      strategyVersion: PROFILE_STRATEGY_VERSION,
      modelKey,
      machineKey: key,
      contextSize: normalizedContext,
      attempt,
      updatedAt: new Date().toISOString()
    });
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.profiles, null, 2), 'utf8');
  }
  async clear(): Promise<void> { this.profiles = []; await fsp.unlink(this.file).catch(() => undefined); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStoredProfile(value: unknown): value is StoredProfile {
  if (
    !isRecord(value)
    || value.strategyVersion !== PROFILE_STRATEGY_VERSION
    || typeof value.modelKey !== 'string'
    || typeof value.machineKey !== 'string'
    || typeof value.updatedAt !== 'string'
  ) return false;
  if (!isRecord(value.attempt) || typeof value.attempt.reason !== 'string') return false;
  const gpu = value.attempt.gpu;
  const gpuLayers = value.attempt.gpuLayers;
  const contextSize = value.contextSize;
  return ['auto', 'cpu', 'cuda', 'vulkan', 'metal'].includes(String(gpu))
    && (contextSize === undefined || (typeof contextSize === 'number' && Number.isInteger(contextSize) && contextSize >= 2_048))
    && (gpuLayers === 'auto' || (typeof gpuLayers === 'number' && Number.isFinite(gpuLayers) && gpuLayers >= 0));
}

function normalizeContextSize(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(2_048, Math.floor(value))
    : undefined;
}

function machineKey(): string { return `${process.platform}:${process.arch}:${os.hostname()}:${Math.round(os.totalmem() / 1024 ** 3)}`; }
