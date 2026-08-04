const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { AgentLoop } = require('../out/agent/AgentLoop');
const { detectToolCall, detectToolCalls } = require('../out/agent/ToolCallParser');
const {
  detectSimpleReplacement,
  tryPrepareSimpleEditFastPath
} = require('../out/agent/SimpleEditFastPath');

test('normaliza rename_symbol para apply_edit', () => {
  const call = detectToolCall(JSON.stringify({
    name: 'rename_symbol',
    arguments: {
      filePath: 'src/a.html',
      oldName: 'Pesquisar',
      newName: 'Pesquisar Clientes Vip'
    }
  }));

  assert.equal(call.name, 'apply_edit');
  assert.deepEqual(call.arguments, {
    filePath: 'src/a.html',
    oldText: 'Pesquisar',
    newText: 'Pesquisar Clientes Vip',
    replaceAll: true
  });
});

test('remove argumento extra de find_symbol', () => {
  const call = detectToolCall('{"name":"find_symbol","arguments":{"query":"Pesquisar","filePath":"a.html"}}');
  assert.deepEqual(call.arguments, { query: 'Pesquisar' });
});

test('interpreta várias ferramentas preservando a ordem', () => {
  const calls = detectToolCalls([
    '{"name":"read_file","arguments":{"filePath":"a.html"}}',
    '{"name":"apply_edit","arguments":{"filePath":"a.html","oldText":"A","newText":"B"}}',
    '{"name":"apply_changes","arguments":{"summary":"ok"}}'
  ].join('\n'));
  assert.deepEqual(calls.map(call => call.name), ['read_file', 'apply_edit', 'apply_changes']);
});

test('AgentLoop encerra após escrita válida sem pedir outra geração', async () => {
  let generations = 0;
  const result = await new AgentLoop().run({
    initialPrompt: 'x',
    taskReminder: '<tarefa_usuario>Troque A por B</tarefa_usuario>',
    maxSteps: 10,
    diagnosticMode: false,
    log() {},
    async invokeStep() {
      generations += 1;
      return '{"name":"apply_edit","arguments":{"filePath":"a.html","oldText":"A","newText":"B"}}';
    },
    async executeTool(call) {
      return { callId: call.id, name: call.name, ok: true, content: { prepared: true }, durationMs: 1 };
    }
  });

  assert.equal(generations, 1);
  assert.equal(result.steps, 1);
  assert.match(result.text, /Alteração preparada para revisão/);
});

test('AgentLoop executa apply_changes somente depois da escrita', async () => {
  const executed = [];
  const result = await new AgentLoop().run({
    initialPrompt: 'x',
    maxSteps: 2,
    diagnosticMode: false,
    log() {},
    async invokeStep() {
      return [
        '{"name":"apply_changes","arguments":{"summary":"ok"}}',
        '{"name":"apply_edit","arguments":{"filePath":"a.html","oldText":"A","newText":"B"}}'
      ].join('\n');
    },
    async executeTool(call) {
      executed.push(call.name);
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 0 };
    }
  });

  assert.deepEqual(executed, ['apply_edit', 'apply_changes']);
  assert.match(result.text, /ok/);
});

test('detecta substituição simples sem modelo', () => {
  const replacement = detectSimpleReplacement(
    'Altere Pesquisar para Pesquisar Clientes Vip',
    '<button>Pesquisar</button>'
  );
  assert.deepEqual(replacement, {
    oldText: 'Pesquisar',
    newText: 'Pesquisar Clientes Vip',
    replaceAll: true,
    occurrences: 1
  });
});

test('não usa caminho rápido quando há várias ocorrências ambíguas', () => {
  const replacement = detectSimpleReplacement(
    'Altere Pesquisar para Pesquisar Clientes Vip',
    '<button>Pesquisar</button><span>Pesquisar</span>'
  );
  assert.equal(replacement, undefined);
});

test('caminho rápido prepara apply_edit diretamente', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-fast-edit-'));
  const filePath = 'src/a.html';
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.writeFile(path.join(root, filePath), '<button>Pesquisar</button>', 'utf8');
  const calls = [];

  const result = await tryPrepareSimpleEditFastPath({
    request: 'Altere Pesquisar para Pesquisar Clientes Vip',
    workspaceRoot: root,
    priority: [filePath],
    async execute(call) {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { prepared: true }, durationMs: 1 };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'apply_edit');
  assert.match(result.text, /Substituição/);
});
