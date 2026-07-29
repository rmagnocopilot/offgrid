'use strict';

const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const GB = 1024 ** 3;

function bytesToGb(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number / GB) * 100) / 100 : null;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function genericSnapshot(workerMemory = null) {
  const total = os.totalmem();
  const free = os.freemem();
  const current = process.memoryUsage();
  return {
    platform: process.platform,
    hostname: os.hostname(),
    capturedAt: new Date().toISOString(),
    system: {
      totalBytes: total,
      availableBytes: free,
      usedBytes: Math.max(0, total - free),
      usagePercent: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : null
    },
    extensionHost: {
      pid: process.pid,
      rssBytes: current.rss,
      heapUsedBytes: current.heapUsed,
      externalBytes: current.external
    },
    engineProcess: workerMemory || null,
    gpus: [],
    windowsAdvancedAvailable: false,
    notes: process.platform === 'win32'
      ? []
      : ['Medição avançada de VRAM e autoajuste por orçamento estão disponíveis somente no Windows.']
  };
}

class ResourceMonitor {
  constructor({ extensionPath, logger = () => {} } = {}) {
    this.extensionPath = extensionPath || path.resolve(__dirname, '..');
    this.logger = logger;
    this.lastSnapshot = null;
    this.lastWindowsProbeAt = 0;
    this.cachedWindowsGpus = [];
  }

  async snapshot({ workerMemory = null, forceGpuRefresh = false } = {}) {
    const result = genericSnapshot(workerMemory);
    if (process.platform !== 'win32') {
      this.lastSnapshot = result;
      return result;
    }

    const now = Date.now();
    if (forceGpuRefresh || now - this.lastWindowsProbeAt > 15000) {
      try {
        this.cachedWindowsGpus = await this.#probeWindowsGpus();
        this.lastWindowsProbeAt = now;
      } catch (error) {
        this.logger(`Diagnóstico de GPU indisponível: ${error instanceof Error ? error.message : String(error)}`);
        result.notes.push('Não foi possível consultar a VRAM. O chat e o agente continuam disponíveis.');
      }
    }

    result.gpus = this.cachedWindowsGpus;
    result.windowsAdvancedAvailable = result.gpus.some(gpu => gpu.availableBytes !== null || gpu.totalBytes !== null);
    if (!result.windowsAdvancedAvailable) {
      result.notes.push('VRAM detalhada indisponível. O Offgrid usará fallback e tentativas progressivas.');
    }
    this.lastSnapshot = result;
    return result;
  }

  async #probeWindowsGpus() {
    const script = path.join(this.extensionPath, 'resources', 'windows', 'gpu-memory.ps1');
    const powershell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    const { stdout } = await execFileAsync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script
    ], { timeout: 12000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const text = String(stdout || '').trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    return items.map((gpu, index) => {
      const totalBytes = safeNumber(gpu.totalBytes);
      const usedBytes = safeNumber(gpu.usedBytes);
      const availableBytes = safeNumber(gpu.availableBytes)
        ?? (totalBytes !== null && usedBytes !== null ? Math.max(0, totalBytes - usedBytes) : null);
      return {
        index,
        name: String(gpu.name || `GPU ${index + 1}`),
        vendor: String(gpu.vendor || ''),
        source: String(gpu.source || 'windows'),
        totalBytes,
        usedBytes,
        availableBytes,
        dedicated: gpu.dedicated !== false,
        note: gpu.note ? String(gpu.note) : ''
      };
    });
  }
}

function summarizeResources(snapshot) {
  if (!snapshot) return {
    ram: '—', engine: '—', gpu: '—', lowMemory: false
  };
  const available = bytesToGb(snapshot.system?.availableBytes);
  const total = bytesToGb(snapshot.system?.totalBytes);
  const engine = bytesToGb(snapshot.engineProcess?.rssBytes);
  const primaryGpu = [...(snapshot.gpus || [])]
    .sort((a, b) => (b.availableBytes || 0) - (a.availableBytes || 0))[0];
  const gpuAvailable = bytesToGb(primaryGpu?.availableBytes);
  const gpuTotal = bytesToGb(primaryGpu?.totalBytes);
  return {
    ram: available === null ? '—' : `${available} GB livres / ${total} GB`,
    engine: engine === null ? 'não iniciado' : `${engine} GB`,
    gpu: primaryGpu
      ? `${primaryGpu.name}: ${gpuAvailable ?? '?'} GB livres / ${gpuTotal ?? '?'} GB`
      : (snapshot.platform === 'win32' ? 'indisponível' : 'somente Windows'),
    lowMemory: Number(snapshot.system?.availableBytes || 0) < 6 * GB
  };
}

module.exports = { ResourceMonitor, genericSnapshot, summarizeResources, bytesToGb, GB };
