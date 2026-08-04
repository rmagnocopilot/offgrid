const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const { AgentLoop } = require('../out/agent/AgentLoop');
const { tryPrepareSimpleEditFastPath } = require('../out/agent/SimpleEditFastPath');
const {
  agentOutputTokenFloor,
  generatedFileContentIssue,
  isFileCreationTask
} = require('../out/agent/AgentTaskPolicy');

test('reserva 512 tokens para criacao de arquivo de testes', () => {
  const request = 'Crie 2 testes simples e gere cliente-vip-list.component.spec.ts';
  assert.equal(isFileCreationTask(request), true);
  assert.equal(agentOutputTokenFloor(request), 512);
});

test('mantem orcamento padrao para edicao simples', () => {
  assert.equal(agentOutputTokenFloor('Altere Pesquisar para Buscar'), 0);
});

test('rejeita placeholder em arquivo gerado', () => {
  const issue = generatedFileContentIssue(
    'cliente.component.spec.ts',
    "it('filtra', () => { // Implement your test logic here\n});"
  );

  assert.match(issue, /placeholder n\u00e3o permitido/);
});

test('aceita arquivo de teste completo sem placeholder', () => {
  const issue = generatedFileContentIssue(
    'src/app/cliente/cliente.component.spec.ts',
    "it('filtra', () => { expect(['Rafa']).toContain('Rafa'); });",
    {
      sources: [
        {
          filePath: 'src/app/cliente/cliente.component.ts',
          content: 'export class ClienteComponent {}'
        }
      ]
    }
  );

  assert.equal(issue, undefined);
});

test('recuperacao de JSON preserva a tarefa original', async () => {
  const prompts = [];
  let attempt = 0;

  const result = await new AgentLoop().run({
    initialPrompt: 'contexto inicial',
    taskReminder: '<tarefa_usuario>Crie dois testes completos para ClienteVip.</tarefa_usuario>',
    maxSteps: 2,
    diagnosticMode: false,
    log() {},
    async invokeStep(prompt) {
      prompts.push(prompt);
      attempt += 1;

      if (attempt === 1) {
        return '{"name":"create_file","arguments":{"filePath":"a.spec.ts","content":"';
      }

      return '{"name":"create_file","arguments":{"filePath":"a.spec.ts","content":"it(\\"ok\\", () => expect(true).toBeTrue());"}}';
    },
    async executeTool(call) {
      return {
        callId: call.id,
        name: call.name,
        ok: true,
        content: { prepared: true },
        durationMs: 0
      };
    }
  });

  assert.equal(result.calls[0].name, 'create_file');
  assert.match(prompts[1], /Crie dois testes completos para ClienteVip/);
  assert.match(prompts[1], /refa\u00e7a a chamada COMPLETA/);
});

test('caminho rapido ignora tarefa de criacao sem tentar ler caminho inexistente', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-fastpath-create-'));
  const warnings = [];
  const result = await tryPrepareSimpleEditFastPath({
    request: 'Crie dois testes para cliente-vip-list.component.ts',
    workspaceRoot: root,
    priority: ['cliente-vip-list.component.ts'],
    execute: async call => ({ callId: call.id, name: call.name, ok: true, content: null, durationMs: 0 }),
    warn: message => warnings.push(message)
  });

  assert.equal(result, undefined);
  assert.deepEqual(warnings, []);
});

test('fonte registra autonomia e politica de seguranca separadamente', async () => {
  const extensionSource = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );

  assert.match(
    extensionSource,
    /autonomia=\$\{s\.autonomy\}; seguran\u00e7a=\$\{approvalMode\}/
  );
});

test('não confunde comentário JSDoc em classe existente com criação de arquivo', () => {
  const request = 'No arquivo aberto, adicione um comentário JSDoc à classe explicando sua responsabilidade, sem alterar o comportamento.';
  assert.equal(isFileCreationTask(request), false);
  assert.equal(agentOutputTokenFloor(request), 0);
});

test('rejeita JUnit 5 quando a tarefa pede JUnit 4', () => {
  const issue = generatedFileContentIssue(
    'module/src/test/java/com/example/ServiceTest.java',
    'import org.junit.jupiter.api.Test;\nclass ServiceTest { @Test void ok() {} }',
    { request: 'Crie um teste usando JUnit 4 e Mockito.' }
  );

  assert.match(issue, /pediu JUnit 4/);
});
