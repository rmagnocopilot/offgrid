'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { SessionStore } = require('../src/session-store');

test('cria, persiste, renomeia e alterna sessões', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-sessions-'));
  try {
    const store = new SessionStore(dir);
    await store.init();
    const firstId = store.snapshot().activeSessionId;
    await store.addMessage('user', 'Refatoração Angular', 'chat');
    await store.addMessage('assistant', 'Resposta local', 'chat');
    await store.updateMetadata({ model: 'Qwen 3B', backend: 'VULKAN', contextSize: 4096, contextFiles: ['src/app.ts'], lastError: '' });
    assert.equal(store.getMessages().length, 2);
    assert.equal(store.snapshot().sessions[0].title, 'Refatoração Angular');

    const second = await store.create('Erro no Maven');
    assert.equal(store.snapshot().activeSessionId, second.id);
    await store.select(firstId);
    await store.togglePin(firstId);
    assert.equal(store.snapshot().sessions[0].pinned, true);
    const duplicate = await store.duplicate(firstId);
    assert.equal(duplicate.metadata.model, 'Qwen 3B');
    assert.equal(duplicate.metadata.backend, 'VULKAN');
    await store.select(firstId);

    const reloaded = new SessionStore(dir);
    await reloaded.init();
    assert.equal(reloaded.getMessages().length, 2);
    const restored = reloaded.snapshot().sessions.find(item => item.id === firstId);
    assert.equal(restored.metadata.contextSize, 4096);
    assert.match(restored.searchText, /Refatoração Angular/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
