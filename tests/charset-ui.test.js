'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = [
  'src/extension.js', 'src/chat-view.js', 'src/llama-engine.js', 'src/workspace-agent.js',
  'src/engine-client.js', 'src/engine-worker.js', 'src/file-logger.js',
  'resources/system-prompt.md', 'resources/agent-system-prompt.md', 'README.md'
];

test('arquivos críticos permanecem em UTF-8 sem mojibake conhecido', () => {
  const bad = /\uFFFD|Mem��ria|nÃ£o|NÃ£o|alteraÃ|AlteraÃ|execuÃ|ExecuÃ|configuraÃ|ConfiguraÃ|revisÃ|RevisÃ|usuÃ|UsuÃ/;
  for (const relative of TARGETS) {
    const content = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(content, bad, relative);
  }
});

test('interface contém textos acentuados e modos solicitados', () => {
  const content = fs.readFileSync(path.join(ROOT, 'src/chat-view.js'), 'utf8');
  for (const expected of ['memória', 'Configurações', 'Revisar alterações', 'Planejar', 'Somente leitura', 'Agente']) {
    assert.match(content, new RegExp(expected), expected);
  }
  assert.match(content, /@media \(max-width: 380px\)/);
  assert.match(content, /diagnosticsPanel/);
});
