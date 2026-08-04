const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fsp = require('node:fs/promises');

const root = path.join(__dirname, '..');

async function source(relativePath) {
  return fsp.readFile(path.join(root, relativePath), 'utf8');
}

test('criacao de arquivo usa 512 tokens', async () => {
  const policy = await source('src/agent/AgentTaskPolicy.ts');
  assert.match(policy, /isFileCreationTask\(request\) \? 512 : 0/);
});

test('recuperacao e etapas posteriores usam limite curto', async () => {
  const engine = await source('src/engine/EngineClient.ts');
  assert.match(engine, /prompt\.includes\('<correcao_chamada_ferramenta>'\)/);
  assert.match(engine, /Math\.min\(params\.maxTokens \?\? 192, 192\)/);
  assert.match(engine, /Math\.min\(params\.maxTokens \?\? 256, 256\)/);
  assert.match(engine, /maxTokens: stepMaxTokens/);
});

test('escrita rejeitada nao provoca nova geracao', async () => {
  const loop = await source('src/agent/AgentLoop.ts');
  assert.match(loop, /Escrita rejeitada; encerrando sem nova geracao do modelo/);
  assert.match(loop, /REVIEW_WRITE_TOOLS\.has\(call\.name\)/);
});

test('criacao limita ferramentas e etapas', async () => {
  const extension = await source('src/extension.ts');
  assert.match(extension, /const fileCreationTools = new Set/);
  assert.match(extension, /Math\.min\(configuredAgentSteps, 4\)/);
  assert.match(extension, /maxSteps: effectiveAgentSteps/);
});