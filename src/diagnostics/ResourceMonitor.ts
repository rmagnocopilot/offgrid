import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GpuMemoryValue, ResourceSnapshot } from '../types/contracts';
import type { FileLogger } from './FileLogger';

const execFileAsync = promisify(execFile);

export class ResourceMonitor {
  private lastGpu: GpuMemoryValue[] = [];
  private lastGpuAt = 0;
  private lastError = '';
  private lastErrorAt = 0;

  constructor(
    private readonly extensionPath: string,
    private readonly logger: FileLogger,
    private readonly gpuTtlMs = 15_000,
    private readonly errorCooldownMs = 60_000
  ) {}

  async snapshot(options: { workerPid?: number; forceGpu?: boolean; skipGpu?: boolean } = {}): Promise<ResourceSnapshot> {
    const total = os.totalmem();
    const free = os.freemem();
    const result: ResourceSnapshot = {
      capturedAt: new Date().toISOString(),
      platform: process.platform,
      systemRam: { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - free) },
      gpus: []
    };
    if (options.workerPid) {
      const memory = await this.processMemory(options.workerPid).catch(() => undefined);
      if (memory !== undefined) result.engineRam = { pid: options.workerPid, workingSetBytes: memory };
    }
    if (!options.skipGpu) {
      const gpu = await this.gpuMemory(Boolean(options.forceGpu));
      result.gpus = gpu.values;
      if (gpu.error) result.gpuError = gpu.error;
    }
    return result;
  }

  private async processMemory(pid: number): Promise<number | undefined> {
    if (process.platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const value = Number(String(stdout).trim());
      return Number.isFinite(value) ? value : undefined;
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const kb = Number(String(stdout).trim());
    return Number.isFinite(kb) ? kb * 1024 : undefined;
  }

  private async gpuMemory(force: boolean): Promise<{ values: GpuMemoryValue[]; error?: string }> {
    if (process.platform !== 'win32') return { values: [] };
    const now = Date.now();
    if (!force && now - this.lastGpuAt < this.gpuTtlMs) return { values: this.lastGpu };
    const script = path.join(this.extensionPath, 'resources', 'windows', 'gpu-memory.ps1');
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', script
      ], { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
      const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim() || '[]') as unknown;
      const array = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      this.lastGpu = array.map(item => {
        const value = item as Record<string, unknown>;
        return {
          name: String(value.name ?? 'GPU'),
          totalBytes: Number(value.totalBytes ?? 0),
          usedBytes: Number(value.usedBytes ?? 0),
          freeBytes: Number(value.freeBytes ?? 0),
          dedicated: Boolean(value.dedicated),
          source: (value.source === 'nvidia-smi' || value.source === 'windows-cim') ? value.source : 'unknown'
        } satisfies GpuMemoryValue;
      });
      this.lastGpuAt = now;
      this.lastError = '';
      return { values: this.lastGpu };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastError || now - this.lastErrorAt >= this.errorCooldownMs) {
        this.logger.debug('diagnostics', `Diagnóstico de GPU indisponível: ${message}`);
        this.lastError = message;
        this.lastErrorAt = now;
      }
      return { values: this.lastGpu, error: message };
    }
  }
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 GB';
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
