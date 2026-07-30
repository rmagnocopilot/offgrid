'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileLogger } = require('../src/file-logger');

test('grava categorias em UTF-8 e mantém linhas recentes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-logger-'));
  try {
    const output = [];
    const logger = new FileLogger({ storagePath: dir, outputChannel: { appendLine: line => output.push(line) }, level: 'debug' });
    logger.info('offgrid', 'Memória, Configuração e Revisão');
    logger.debug('agent', 'Execução do usuário');
    const files = fs.readdirSync(path.join(dir, 'logs'));
    assert.ok(files.some(name => name.startsWith('offgrid-')));
    assert.ok(files.some(name => name.startsWith('agent-')));
    const content = files.map(name => fs.readFileSync(path.join(dir, 'logs', name), 'utf8')).join('\n');
    assert.match(content, /Memória, Configuração e Revisão/);
    assert.match(content, /Execução do usuário/);
    assert.equal(logger.lastLines(1).length, 1);
    assert.ok(output.length >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rotaciona por tamanho e limita arquivos por categoria', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-rotate-'));
  try {
    const logger = new FileLogger({ storagePath: dir, level: 'trace', maxBytes: 220, maxFiles: 3 });
    for (let index = 0; index < 20; index += 1) logger.info('model', `linha-${index}-${'x'.repeat(80)}`);
    const files = fs.readdirSync(path.join(dir, 'logs')).filter(name => name.startsWith('model-'));
    assert.ok(files.length <= 3);
    assert.ok(files.length >= 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
