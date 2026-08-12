const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateAgentContextBudget } = require('../out/agent/AgentContextBudget');

const GIB = 1024 ** 3;

test('orçamento 4K reserva saída e continuação para AgentLoop', () => {
  const budget = calculateAgentContextBudget({
    contextSize: 4096,
    configuredMaxTokens: 1024,
    systemPromptChars: 1200,
    taskChars: 420,
    modelFileSizeBytes: 2.5 * GIB,
    minimumOutputTokens: 768,
    compactCodeInput: true
  });

  assert.equal(budget.maxOutputTokens, 1024);
  assert.ok(budget.continuationTokens >= 700);
  assert.ok(budget.workspaceChars > 1000);
  assert.ok(budget.workspaceChars < 4000);
  assert.ok(budget.maxCharsPerFile <= 3000);
});

test('orçamento 8K libera mais contexto de workspace que 4K', () => {
  const common = {
    configuredMaxTokens: 1024,
    systemPromptChars: 1600,
    taskChars: 420,
    modelFileSizeBytes: 2.5 * GIB,
    minimumOutputTokens: 768,
    compactCodeInput: true
  };
  const four = calculateAgentContextBudget({ ...common, contextSize: 4096 });
  const eight = calculateAgentContextBudget({ ...common, contextSize: 8192 });
  assert.ok(eight.workspaceChars > four.workspaceChars);
});


test('orçamento 4K prioriza saída de 2048 para teste Java longo sem zerar contexto', () => {
  const budget = calculateAgentContextBudget({
    contextSize: 4096,
    configuredMaxTokens: 1024,
    systemPromptChars: 1200,
    taskChars: 420,
    modelFileSizeBytes: 2.5 * GIB,
    minimumOutputTokens: 2048,
    compactCodeInput: true
  });

  assert.equal(budget.maxOutputTokens, 2048);
  assert.equal(budget.continuationTokens, 128);
  assert.ok(budget.workspaceChars >= 1200);
});
