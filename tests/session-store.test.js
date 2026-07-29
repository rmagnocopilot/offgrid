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
    assert.equal(store.getMessages().length, 2);
    assert.equal(store.snapshot().sessions[0].title, 'Refatoração Angular');

    const second = await store.create('Erro no Maven');
    assert.equal(store.snapshot().activeSessionId, second.id);
    await store.select(firstId);
    await store.togglePin(firstId);
    assert.equal(store.snapshot().sessions[0].pinned, true);

    const reloaded = new SessionStore(dir);
    await reloaded.init();
    assert.equal(reloaded.getMessages().length, 2);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
