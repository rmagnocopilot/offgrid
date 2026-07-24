'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeRelativePath,
  isWriteProtectedPath,
  resolveInsideRoot,
  assertNoSymlinkEscape
} = require('../src/agent-safety');

test('normaliza caminhos relativos do workspace', () => {
  assert.equal(normalizeRelativePath('.\\src\\index.js'), 'src/index.js');
  assert.equal(normalizeRelativePath('./src/../src/index.js'), 'src/index.js');
});

test('bloqueia saída do workspace e caminhos absolutos', () => {
  assert.throws(() => normalizeRelativePath('../segredo.txt'));
  assert.throws(() => normalizeRelativePath('C:/segredo.txt'));
  assert.throws(() => normalizeRelativePath('/segredo.txt'));
});

test('node_modules e .git são somente leitura', () => {
  assert.equal(isWriteProtectedPath('node_modules/pacote/index.js'), true);
  assert.equal(isWriteProtectedPath('app/node_modules/pacote/index.js'), true);
  assert.equal(isWriteProtectedPath('.git/config'), true);
  assert.equal(isWriteProtectedPath('src/index.js'), false);
});

test('resolve apenas caminhos dentro da raiz', () => {
  const root = path.resolve('/tmp/projeto');
  assert.equal(resolveInsideRoot(root, 'src/index.js'), path.join(root, 'src', 'index.js'));
  assert.throws(() => resolveInsideRoot(root, '../../fora.txt'));
});


test('bloqueia link simbólico que aponta para fora do workspace', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-symlink-'));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const link = path.join(root, 'atalho');
  try {
    fs.symlinkSync(outside, link, 'dir');
  } catch (error) {
    t.skip(`Sistema não permitiu criar symlink: ${error.message}`);
    return;
  }
  assert.throws(() => assertNoSymlinkEscape(root, path.join(link, 'arquivo.txt')));
  fs.rmSync(base, { recursive: true, force: true });
});
