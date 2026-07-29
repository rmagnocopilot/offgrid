'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');

const GB = 1024 ** 3;

function modelKind(modelPath = '') {
  const name = path.basename(modelPath).toLowerCase();
  if (name.includes('3b')) return { label: '3B', layers: 36, reserveRamBytes: 1.5 * GB };
  if (name.includes('7b')) return { label: '7B', layers: 28, reserveRamBytes: 2.2 * GB };
  return { label: 'GGUF', layers: 32, reserveRamBytes: 2 * GB };
}

function machineFingerprint(snapshot) {
  const payload = JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    totalMemory: snapshot?.system?.totalBytes || os.totalmem(),
    gpus: (snapshot?.gpus || []).map(gpu => [gpu.name, gpu.totalBytes])
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function normalizeAttempt(attempt) {
  return {
    gpu: attempt.gpu || 'auto',
    gpuLayers: attempt.gpu === 'cpu' ? 0 : (attempt.gpuLayers ?? 'auto'),
    reason: attempt.reason || ''
  };
}

function uniqueAttempts(attempts) {
  const seen = new Set();
  return attempts.map(normalizeAttempt).filter(attempt => {
    const key = `${attempt.gpu}:${attempt.gpuLayers}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chooseAttempts(options, snapshot, savedProfile = null) {
  const requestedGpu = options.gpu || 'auto';
  const requestedLayers = options.gpuLayers ?? 'auto';
  const fallback = options.fallbackToCpu !== false;
  const adaptive = options.adaptiveGpu !== false;
  const attempts = [];

  if (savedProfile && adaptive && requestedGpu === 'auto' && requestedLayers === 'auto') {
    attempts.push({ ...savedProfile, reason: 'Perfil validado anteriormente neste computador' });
  }

  if (!adaptive || requestedGpu !== 'auto' || requestedLayers !== 'auto') {
    attempts.push({ gpu: requestedGpu, gpuLayers: requestedLayers, reason: 'Configuração manual' });
    if (fallback && requestedGpu !== 'cpu') attempts.push({ gpu: 'cpu', gpuLayers: 0, reason: 'Fallback para CPU' });
    return uniqueAttempts(attempts);
  }

  const kind = modelKind(options.modelPath);
  let modelBytes = 0;
  try { modelBytes = fs.statSync(options.modelPath).size; } catch { /* handled by engine */ }
  const availableRam = Number(snapshot?.system?.availableBytes || 0);
  const gpu = [...(snapshot?.gpus || [])]
    .filter(item => Number(item.availableBytes || 0) > 0)
    .sort((a, b) => Number(b.availableBytes || 0) - Number(a.availableBytes || 0))[0];
  const gpuFree = Number(gpu?.availableBytes || 0);

  // O modelo precisa de folga para contexto, buffers e outros aplicativos.
  const safeGpuCapacity = gpuFree * 0.78;
  const targetBytes = modelBytes + 0.75 * GB;
  const ramNeeded = modelBytes + kind.reserveRamBytes;

  const platform = snapshot?.platform || process.platform;

  if (platform === 'win32' && gpu && safeGpuCapacity >= targetBytes) {
    attempts.push({ gpu: 'auto', gpuLayers: 'auto', reason: `GPU com folga estimada para ${kind.label}` });
  } else if (platform === 'win32' && gpuFree >= 1.8 * GB) {
    const ratio = Math.max(0.15, Math.min(0.85, safeGpuCapacity / Math.max(modelBytes, 1)));
    const first = Math.max(4, Math.min(kind.layers, Math.floor(kind.layers * ratio)));
    const rounded = Math.max(4, Math.floor(first / 4) * 4);
    attempts.push({ gpu: 'auto', gpuLayers: rounded, reason: `Carga parcial calculada para ${gpu.name}` });
    if (rounded > 12) attempts.push({ gpu: 'auto', gpuLayers: Math.max(8, Math.floor(rounded / 2)), reason: 'Redução progressiva de camadas' });
    attempts.push({ gpu: 'auto', gpuLayers: 4, reason: 'Tentativa mínima de aceleração GPU' });
  } else if (platform !== 'win32') {
    attempts.push({ gpu: 'auto', gpuLayers: 'auto', reason: 'Detecção padrão fora do Windows' });
  }

  if (availableRam >= ramNeeded || fallback) {
    attempts.push({ gpu: 'cpu', gpuLayers: 0, reason: availableRam >= ramNeeded ? 'CPU com RAM suficiente estimada' : 'Fallback final para CPU' });
  }
  return uniqueAttempts(attempts.length ? attempts : [{ gpu: 'cpu', gpuLayers: 0, reason: 'Perfil conservador' }]);
}

class HardwareProfileStore {
  constructor(storageDir, logger = () => {}) {
    this.storageDir = storageDir;
    this.filePath = path.join(storageDir, 'hardware-profiles.json');
    this.logger = logger;
    this.data = { version: 1, profiles: {}, failures: [] };
  }

  async init() {
    await fsp.mkdir(this.storageDir, { recursive: true });
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') this.data = { version: 1, profiles: {}, failures: [], ...parsed };
    } catch (error) {
      if (error?.code !== 'ENOENT') this.logger(`Não foi possível ler perfis de hardware: ${error.message || error}`);
    }
  }

  key(modelPath, snapshot) {
    return `${machineFingerprint(snapshot)}:${path.basename(modelPath).toLowerCase()}`;
  }

  get(modelPath, snapshot) {
    return this.data.profiles[this.key(modelPath, snapshot)] || null;
  }

  async recordSuccess(modelPath, snapshot, attempt, diagnostics = {}) {
    this.data.profiles[this.key(modelPath, snapshot)] = {
      gpu: attempt.gpu,
      gpuLayers: attempt.gpuLayers,
      backend: diagnostics.backend || attempt.gpu,
      updatedAt: new Date().toISOString()
    };
    await this.#save();
  }

  async recordFailure(modelPath, snapshot, attempt, error) {
    this.data.failures.unshift({
      key: this.key(modelPath, snapshot),
      model: path.basename(modelPath),
      gpu: attempt.gpu,
      gpuLayers: attempt.gpuLayers,
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString()
    });
    this.data.failures = this.data.failures.slice(0, 30);
    await this.#save();
  }

  async clear(modelPath, snapshot) {
    delete this.data.profiles[this.key(modelPath, snapshot)];
    await this.#save();
  }

  async #save() {
    await fsp.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

module.exports = { chooseAttempts, HardwareProfileStore, machineFingerprint, modelKind, uniqueAttempts };
