const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const {
  contextFallbacks,
  estimateTaskComplexity,
  planContext,
  shouldExpandContext
} = require('../out/context/AutomaticContextPlanner');

const GIB = 1024 ** 3;
const resources = (totalGb, freeGb) => ({
  capturedAt: new Date().toISOString(),
  platform: process.platform,
  systemRam: {
    totalBytes: totalGb * GIB,
    usedBytes: (totalGb - freeGb) * GIB,
    freeBytes: freeGb * GIB
  },
  gpus: []
});

const model = (id, parameterCountB, base, complex, maximum, fileGb) => ({
  id,
  displayName: id,
  fileName: `${id}.gguf`,
  description: '',
  hardware: '',
  approxSize: '',
  sha256: 'a'.repeat(64),
  parts: [`${id}.gguf`],
  license: 'Apache-2.0',
  commercialUse: true,
  source: 'https://example.invalid',
  parameterCountB,
  contextProfile: { minimum: 4096, base, complex, maximum },
  promptMode: 'default',
  fileGb
});

function plan(modelDefinition, fileGb, task, totalGb = 16, freeGb = 10, mode = 'automatic', manual = 4096) {
  return planContext({
    mode,
    manualContextSize: manual,
    model: modelDefinition,
    modelFileSizeBytes: fileGb * GIB,
    resources: resources(totalGb, freeGb),
    task
  });
}

test('3B usa 4096 em tarefa simples', () => {
  const qwen3b = model('qwen-3b', 3.09, 4096, 8192, 8192, 2.1);
  const result = plan(qwen3b, 2.1, { complexity: 'simple', estimatedFiles: 1, reason: 'simples' }, 8, 5.5);
  assert.equal(result.contextSize, 4096);
  assert.equal(result.constrainedByMemory, false);
});

test('3B amplia para 8192 em tarefa multi-arquivo quando há memória', () => {
  const qwen3b = model('qwen-3b', 3.09, 4096, 8192, 8192, 2.1);
  const result = plan(qwen3b, 2.1, { complexity: 'multiFile', estimatedFiles: 4, reason: 'multi' }, 16, 10);
  assert.equal(result.contextSize, 8192);
});

test('Qwen3 4B usa 8192 como base', () => {
  const qwen4b = model('qwen3-4b', 4, 8192, 8192, 12288, 2.5);
  const result = plan(qwen4b, 2.5, { complexity: 'simple', estimatedFiles: 1, reason: 'simples' }, 16, 10);
  assert.equal(result.contextSize, 8192);
});

test('Qwen3 4B usa 12288 em tarefa complexa com memória suficiente', () => {
  const qwen4b = model('qwen3-4b', 4, 8192, 8192, 12288, 2.5);
  const result = plan(qwen4b, 2.5, { complexity: 'complex', estimatedFiles: 8, reason: 'full-stack' }, 16, 11);
  assert.equal(result.contextSize, 12288);
});

test('Qwen3 4B reduz o contexto em máquina apertada', () => {
  const qwen4b = model('qwen3-4b', 4, 8192, 8192, 12288, 2.5);
  const result = plan(qwen4b, 2.5, { complexity: 'complex', estimatedFiles: 8, reason: 'full-stack' }, 8, 4.2);
  assert.ok(result.contextSize < 12288);
  assert.equal(result.constrainedByMemory, true);
  assert.ok(result.contextSize >= 4096);
});

test('modo manual respeita o contexto fixo', () => {
  const qwen4b = model('qwen3-4b', 4, 8192, 8192, 12288, 2.5);
  const result = plan(qwen4b, 2.5, { complexity: 'complex', estimatedFiles: 8, reason: 'full-stack' }, 8, 3, 'manual', 8192);
  assert.equal(result.contextSize, 8192);
  assert.equal(result.reason, 'contexto manual configurado pelo usuário');
});

test('não reinicia quando o contexto atual já é suficiente', () => {
  const qwen4b = model('qwen3-4b', 4, 8192, 8192, 12288, 2.5);
  const result = plan(qwen4b, 2.5, { complexity: 'simple', estimatedFiles: 1, reason: 'simples' }, 16, 10);
  assert.equal(shouldExpandContext(8192, result), false);
  assert.equal(shouldExpandContext(4096, result), true);
});

test('fallbacks são decrescentes e não passam do mínimo', () => {
  assert.deepEqual(contextFallbacks(12288, 4096), [12288, 8192, 4096]);
});

test('classifica fluxo full-stack como complexo', () => {
  const estimate = estimateTaskComplexity({
    request: 'Crie um fluxo completo de backend e frontend',
    estimatedFiles: 8,
    fullStack: true
  });
  assert.equal(estimate.complexity, 'complex');
});

test('catálogo substitui 1.5B pelo Qwen3 4B e define no-think', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'models', 'manifest.json'), 'utf8'));
  assert.equal(manifest.models.some(item => item.id.includes('1.5b')), false);
  const qwen4b = manifest.models.find(item => item.id === 'qwen3-4b-q4_k_m');
  assert.ok(qwen4b);
  assert.equal(qwen4b.promptMode, 'no-think');
  assert.equal(qwen4b.contextProfile.base, 8192);
  assert.equal(qwen4b.contextProfile.complex, 8192);
  assert.equal(qwen4b.contextProfile.maximum, 12288);
  assert.equal(qwen4b.sha256, '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5');
});

test('modo no-think é aplicado no chat e no agente pelos dois motores', () => {
  const server = fs.readFileSync(path.join(root, 'src', 'llm', 'LlamaServerEngine.ts'), 'utf8');
  const embedded = fs.readFileSync(path.join(root, 'src', 'llm', 'LlamaEngine.ts'), 'utf8');
  for (const engine of [server, embedded]) {
    assert.match(engine, /withPromptMode\(systemPrompt, options\.promptMode\)/);
    assert.match(engine, /withPromptMode\(systemPrompt, this\.options\?\.promptMode\)/);
    assert.match(engine, /\/no_think/);
  }
  assert.match(embedded, /accumulatedInputTokens = kvTokensAtStep \+ promptTokens/);
});

test('FastPaths são avaliados antes da ampliação automática de contexto', () => {
  const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  const fastPath = extension.indexOf('tryPrepareFullStackRelationRefactorFastPath');
  const planner = extension.indexOf('const taskContextEstimate = estimateTaskComplexity');
  assert.ok(fastPath >= 0 && planner > fastPath);
});

test('criação de um único arquivo não amplia o contexto como tarefa multi-arquivo', () => {
  const estimate = estimateTaskComplexity({
    request: 'Crie TarifaSiapfDTOTest para TarifaSiapfDTO.',
    estimatedFiles: 1,
    createsFiles: true
  });
  assert.equal(estimate.complexity, 'simple');
});
test('criação de um teste com dois arquivos de referência continua simples', () => {
  const estimate = estimateTaskComplexity({
    request: 'Crie o teste unitário seguindo o teste de exemplo existente.',
    estimatedFiles: 2,
    createsFiles: true
  });
  assert.equal(estimate.complexity, 'simple');
});


test('dois arquivos estimados já caracterizam tarefa multi-arquivo', () => {
  const estimate = estimateTaskComplexity({
    request: 'Atualize os dois arquivos relacionados',
    estimatedFiles: 2
  });
  assert.equal(estimate.complexity, 'multiFile');
});

test('criação genérica não oferece get_active_file quando já há contexto prioritário', () => {
  const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /if \(!contextPriority\.length\) fileCreationTools\.add\('get_active_file'\)/);
  assert.doesNotMatch(extension, /const fileCreationTools = new Set\(\[\s*'get_active_file'/);
});

test('tarefa simples limita o contexto automático do workspace a um arquivo', () => {
  const extension = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /taskContextEstimate\.complexity === 'simple'[\s\S]*?javaUnitTestTask[\s\S]*?Math\.min\(2, budget\.maxFiles\)[\s\S]*?Math\.min\(3, budget\.maxFiles\)[\s\S]*?: budget\.maxFiles/);
  assert.match(extension, /maxFiles: effectiveMaxFiles/);
});

test('não amplia 3B para 8192 quando a margem extra de reinício é pequena', () => {
  const qwen3b = model('qwen-3b', 3.09, 4096, 8192, 8192, 2.1);
  const result = planContext({
    mode: 'automatic',
    manualContextSize: 4096,
    model: qwen3b,
    modelFileSizeBytes: 0,
    resources: resources(10, 4.6),
    currentContextSize: 4096,
    task: { complexity: 'multiFile', estimatedFiles: 2, reason: 'teste Java' }
  });

  assert.equal(result.contextSize, 4096);
  assert.equal(result.constrainedByMemory, true);
  assert.equal(shouldExpandContext(4096, result), false);
});


test('não soma duas vezes a memória recuperável do motor atual', () => {
  const qwen4b = model('qwen3-4b', 4, 8192, 8192, 12288, 2.5);
  const result = planContext({
    mode: 'automatic',
    manualContextSize: 4096,
    model: qwen4b,
    modelFileSizeBytes: 2.5 * GIB,
    resources: {
      ...resources(32, 3),
      engineRam: { pid: 10, workingSetBytes: 2 * GIB }
    },
    currentContextSize: 8192,
    reclaimableBytes: 6 * GIB,
    task: { complexity: 'complex', estimatedFiles: 8, reason: 'teste' }
  });

  assert.equal(result.availableBytes, 5 * GIB);
  assert.equal(shouldExpandContext(8192, result), false);
});
