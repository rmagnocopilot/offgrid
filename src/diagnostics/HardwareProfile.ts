import * as os from 'node:os';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import type { Backend, EngineLoadOptions, ResourceSnapshot } from '../types/contracts';

export interface LoadAttempt { gpu: Backend; gpuLayers: number | 'auto'; reason: string }
interface StoredProfile { modelKey: string; machineKey: string; attempt: LoadAttempt; updatedAt: string }

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
    const freeGb = bestGpu.freeBytes / 1024 ** 3;
    if (options.gpuLayers !== 'auto') attempts.push({ gpu: 'vulkan', gpuLayers: options.gpuLayers, reason: 'Camadas configuradas pelo usuário' });
    else {
      const initial = Math.max(1, Math.min(40, Math.floor(freeGb * 8)));
      for (const layers of [initial, Math.floor(initial * 0.66), Math.floor(initial * 0.33), 1]) {
        if (layers > 0) attempts.push({ gpu: 'vulkan', gpuLayers: layers, reason: `Perfil adaptativo (${freeGb.toFixed(1)} GB livres)` });
      }
    }
  } else {
    // Diagnóstico indisponível não significa GPU ausente. A tentativa automática é obrigatória.
    attempts.push({ gpu: 'auto', gpuLayers: options.gpuLayers, reason: 'Detecção padrão do node-llama-cpp' });
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
    try { this.profiles = JSON.parse(await fsp.readFile(this.file, 'utf8')) as StoredProfile[]; } catch { this.profiles = []; }
  }
  get(modelPath: string): LoadAttempt | undefined {
    return this.profiles.find(item => item.modelKey === path.basename(modelPath) && item.machineKey === machineKey())?.attempt;
  }
  async recordSuccess(modelPath: string, attempt: LoadAttempt): Promise<void> {
    const modelKey = path.basename(modelPath);
    const key = machineKey();
    this.profiles = this.profiles.filter(item => item.modelKey !== modelKey || item.machineKey !== key);
    this.profiles.push({ modelKey, machineKey: key, attempt, updatedAt: new Date().toISOString() });
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify(this.profiles, null, 2), 'utf8');
  }
  async clear(): Promise<void> { this.profiles = []; await fsp.unlink(this.file).catch(() => undefined); }
}

function machineKey(): string { return `${process.platform}:${process.arch}:${os.hostname()}:${Math.round(os.totalmem() / 1024 ** 3)}`; }
