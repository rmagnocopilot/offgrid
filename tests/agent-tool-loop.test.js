'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectToolCall,
  executeAgentToolLoop,
  looksLikeToolCall
} = require('../src/agent-tool-loop');

test('detecta tool call JSON com argumentos aninhados', () => {
  const call = detectToolCall('{"name":"listWorkspaceFiles","arguments":{"pattern":"**/*.ts"}}');
  assert.deepEqual(call.name, 'listWorkspaceFiles');
  assert.deepEqual(call.arguments, { pattern: '**/*.ts' });
});

test('detecta formatos fenced, function_call e tool_calls', () => {
  assert.equal(detectToolCall('```json\n{"function":{"name":"readFile","arguments":"{\\"filePath\\":\\"a.ts\\"}"}}\n```').name, 'readFile');
  assert.equal(detectToolCall('{"function_call":{"name":"applyChanges","arguments":{"summary":"ok"}}}').name, 'applyChanges');
  assert.equal(detectToolCall('{"tool_calls":[{"function":{"name":"searchWorkspaceText","arguments":{"query":"x","pattern":"**/*"}}}]}').name, 'searchWorkspaceText');
});

test('loop executa ferramentas textuais e devolve resultado ao modelo até resposta final', async () => {
  const prompts = [];
  const calls = [];
  const responses = [
    '{"name":"listWorkspaceFiles","arguments":{"pattern":"**/*.html"}}',
    '```json\n{"name":"readWorkspaceFile","arguments":{"filePath":"src/a.html","startLine":1,"endLine":20}}\n```',
    'Análise concluída.'
  ];
  const result = await executeAgentToolLoop({
    initialPrompt: 'tarefa',
    maxSteps: 10,
    invokeStep: async prompt => { prompts.push(prompt); return responses.shift(); },
    handlers: {
      listWorkspaceFiles: async args => { calls.push(['list', args]); return { files: ['src/a.html'] }; },
      readWorkspaceFile: async args => { calls.push(['read', args]); return { content: '<p-table>' }; }
    }
  });
  assert.equal(result.text, 'Análise concluída.');
  assert.equal(result.steps, 3);
  assert.equal(calls.length, 2);
  assert.match(prompts[1], /resultado_ferramenta/);
  assert.match(prompts[2], /readWorkspaceFile/);
});

test('não entrega JSON de ferramenta inválido como resposta final', async () => {
  assert.equal(looksLikeToolCall('{"name":"readFile","arguments":'), true);
  await assert.rejects(() => executeAgentToolLoop({
    initialPrompt: 'tarefa',
    invokeStep: async () => '{"name":"readFile","arguments":',
    handlers: {}
  }), /chamada de ferramenta inválida/i);
});

test('interrompe loop ao exceder maxAgentSteps', async () => {
  await assert.rejects(() => executeAgentToolLoop({
    initialPrompt: 'tarefa',
    maxSteps: 2,
    invokeStep: async () => '{"name":"again","arguments":{}}',
    handlers: { again: async () => ({ ok: true }) }
  }), /máximo de etapas \(2\)/i);
});
