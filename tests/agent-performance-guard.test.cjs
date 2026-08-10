const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fsp = require('node:fs/promises');

const root = path.join(__dirname, '..');

async function source(relativePath) {
  return fsp.readFile(path.join(root, relativePath), 'utf8');
}

test('criacao de arquivo usa piso de 768 tokens', async () => {
  const policy = await source('src/agent/AgentTaskPolicy.ts');
  assert.match(policy, /isFileCreationTask\(request\) \? 768 : 0/);
});

test('todas as etapas usam o orçamento completo calculado para a tarefa', async () => {
  const engine = await source('src/engine/EngineClient.ts');
  assert.match(engine, /const stepMaxTokens = params\.maxTokens/);
  assert.doesNotMatch(engine, /Math\.min\(params\.maxTokens \?\? 256, 256\)/);
  assert.doesNotMatch(engine, /Math\.min\(params\.maxTokens \?\? 192, 192\)/);
  assert.match(engine, /maxTokens: stepMaxTokens/);
});

test('falha corrigível de escrita volta ao modelo e rejeição do usuário encerra', async () => {
  const loop = await source('src/agent/AgentLoop.ts');
  assert.match(loop, /Escrita inválida; devolvendo o erro ao modelo/);
  assert.match(loop, /isExplicitUserRejection/);
  assert.match(loop, /Escrita rejeitada pelo usuário; encerrando sem nova geração/);
});

test('criacao limita ferramentas e etapas', async () => {
  const extension = await source('src/extension.ts');
  assert.match(extension, /const fileCreationTools = new Set/);
  assert.match(extension, /Math\.min\(configuredAgentSteps, 4\)/);
  assert.match(extension, /maxSteps: effectiveAgentSteps/);
});
test('instalação do servidor não bloqueia fallback embarcado', async () => {
  const client = await source('src/engine/EngineClient.ts');
  const worker = await source('src/engine/EngineWorker.ts');
  assert.match(client, /continuando para o fallback embarcado/);
  assert.match(worker, /llama-server\.\*\(\?:não encontrado\|not found\|indisponível\)/);
});

test('motor HTTP preserva histórico do agente e recusa contexto esgotado', async () => {
  const engine = await source('src/llm/LlamaServerEngine.ts');
  assert.match(engine, /private agentHistory: ChatMessage\[\]/);
  assert.match(engine, /\.\.\.this\.agentHistory/);
  assert.match(engine, /this\.agentHistory\.push\(\{ role: 'assistant'/);
  assert.match(engine, /availableOutputTokens < 32/);
  assert.match(engine, /ContextWindowError/);
});

test('revisão em lote valida conflitos e reverte gravações parciais', async () => {
  const tools = await source('src/tools/WorkspaceTools.ts');
  assert.match(tools, /assertEntryUnchanged/);
  assert.match(tools, /restoreEntry/);
  assert.match(tools, /Falha adicional ao reverter alterações/);
  assert.match(tools, /cancelledCreation: true/);
});


test('fallback 4K reserva continuação e possui compactação de emergência', async () => {
  const budget = await source('src/agent/AgentContextBudget.ts');
  const extension = await source('src/extension.ts');
  assert.match(budget, /continuationTokens/);
  assert.match(budget, /contextSize <= 4_096/);
  assert.match(extension, /Prompt ainda excedeu 4K; aplicando compactação de emergência/);
  assert.match(extension, /agentToolExecutions === 0/);
});
