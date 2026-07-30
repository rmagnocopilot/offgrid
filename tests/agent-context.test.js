'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractExplicitFileReferences, basenameReference } = require('../src/agent-context');

test('prioriza componente citado com abreviação html / ts', () => {
  const refs = extractExplicitFileReferences('pegando o componente agenteFinanceiro.component.html / ts como exemplo');
  assert.deepEqual(refs, ['agenteFinanceiro.component.html', 'agenteFinanceiro.component.ts']);
});

test('normaliza caminhos Windows e remove duplicados', () => {
  const refs = extractExplicitFileReferences('Use src\\app\\Teste.java e src/app/Teste.java.');
  assert.deepEqual(refs, ['src/app/Teste.java']);
  assert.equal(basenameReference(refs[0]), 'Teste.java');
});
