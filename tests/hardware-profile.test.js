'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chooseAttempts, HardwareProfileStore } = require('../src/hardware-profile');
const { genericSnapshot, summarizeResources } = require('../src/resource-monitor');

function temporaryModel(size = 10 * 1024 * 1024) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-profile-'));
  const model = path.join(dir, 'qwen2.5-coder-7b-instruct-q4_k_m.gguf');
  fs.writeFileSync(model, Buffer.alloc(size));
  return { dir, model };
}

test('perfil manual preserva backend e inclui fallback CPU', () => {
  const { dir, model } = temporaryModel();
  try {
    const attempts = chooseAttempts({ modelPath: model, gpu: 'vulkan', gpuLayers: 10, fallbackToCpu: true, adaptiveGpu: true }, genericSnapshot());
    assert.deepEqual(attempts.map(item => [item.gpu, item.gpuLayers]), [['vulkan', 10], ['cpu', 0]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('fora do Windows mantém detecção padrão e fallback sem exigir VRAM', () => {
  const { dir, model } = temporaryModel();
  try {
    const snapshot = { ...genericSnapshot({ rssBytes: 1234 }), platform: 'linux' };
    const attempts = chooseAttempts({ modelPath: model, gpu: 'auto', gpuLayers: 'auto', fallbackToCpu: true, adaptiveGpu: true }, snapshot);
    assert.ok(attempts.some(item => item.gpu === 'auto'));
    assert.ok(attempts.some(item => item.gpu === 'cpu'));
    const summary = summarizeResources(snapshot);
    assert.match(summary.gpu, /somente Windows|indisponível/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('perfil bem-sucedido é persistido por máquina e modelo', async () => {
  const { dir, model } = temporaryModel();
  const storage = path.join(dir, 'storage');
  const snapshot = genericSnapshot();
  const store = new HardwareProfileStore(storage);
  await store.init();
  await store.recordSuccess(model, snapshot, { gpu: 'cpu', gpuLayers: 0 }, { backend: 'cpu' });
  assert.equal(store.get(model, snapshot).gpu, 'cpu');
  await store.clear(model, snapshot);
  assert.equal(store.get(model, snapshot), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
