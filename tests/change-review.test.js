'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { WorkspaceAgent } = require('../src/workspace-agent');
Module._load = originalLoad;

test('mantém alterações preparadas até o usuário revisar', () => {
  const agent = new WorkspaceAgent({ globalState: {} });
  agent.staged.set('src/exemplo.js', {
    absolute: '/workspace/src/exemplo.js',
    content: 'const novo = true;\n',
    originalContent: 'const novo = false;\n',
    existed: true
  });

  const review = agent.preparePendingReview('Atualiza exemplo');
  assert.equal(agent.hasPendingReview, true);
  assert.deepEqual(review, {
    summary: 'Atualiza exemplo',
    files: ['src/exemplo.js']
  });

  const change = agent.getPendingChange('src/exemplo.js');
  assert.equal(change.originalContent, 'const novo = false;\n');
  assert.equal(change.proposedContent, 'const novo = true;\n');
});

test('rejeitar revisão descarta proposta sem marcar arquivos como aplicados', () => {
  const agent = new WorkspaceAgent({ globalState: {} });
  agent.staged.set('README.md', {
    absolute: '/workspace/README.md',
    content: 'novo',
    originalContent: 'antigo',
    existed: true
  });
  agent.preparePendingReview('Teste');

  assert.deepEqual(agent.rejectPendingChanges(), ['README.md']);
  assert.equal(agent.hasPendingReview, false);
  assert.equal(agent.staged.size, 0);
  assert.deepEqual(agent.appliedFiles, []);
});
