const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('logging padrão usa info e preserva debug/trace como opt-in', () => {
  const pkg = JSON.parse(read('package.json'));
  const setting = pkg.contributes.configuration.properties['offgrid.logLevel'];
  assert.equal(setting.default, 'info');
  assert.deepEqual(setting.enum, ['trace', 'debug', 'info', 'warn', 'error']);
});

test('heartbeats e RPC internos não poluem log normal', () => {
  const worker = read('src/engine/EngineWorker.ts');
  const llama = read('src/llm/LlamaEngine.ts');
  assert.match(worker, /\[Worker\]\[EventLoop\][\s\S]*level: 'trace'/);
  assert.match(worker, /level: 'trace'[\s\S]*\[Worker\]\[RPC\] Recebido/);
  assert.match(llama, /this\.log\('trace', \[\s*'\[Agent\]\[Heartbeat\]'/);
  assert.doesNotMatch(llama, /Primeiros 500 chars do prompt enviado/);
});

test('runtime nativo do llama.cpp fica em warn na operação normal', () => {
  const llama = read('src/llm/LlamaEngine.ts');
  assert.match(llama, /logLevel: runtime\.LlamaLogLevel\?\.warn/);
  assert.doesNotMatch(llama, /logLevel: runtime\.LlamaLogLevel\?\.debug/);
});

test('README publicado reflete 2.0.6 e interface atual', () => {
  const readme = read('README.md');
  assert.match(readme, /# Offgrid 2\.0\.6/);
  assert.match(readme, /offgrid-2\.0\.6\.vsix/);
  assert.doesNotMatch(readme, /\*\*Somente leitura:\*\*/);
  assert.match(readme, /nível padrão é \*\*`info`\*\*/);
});


test('logs de ferramentas resumem conteúdo grande em vez de despejar código', () => {
  const tools = read('src/tools/WorkspaceTools.ts');
  assert.match(tools, /summarizeToolArguments\(call\.arguments\)/);
  assert.doesNotMatch(tools, /\[Tool\].*JSON\.stringify\(call\.arguments\)/);
  assert.match(tools, /content\|text\|source\|replacement\|patch\|diff/);
});
