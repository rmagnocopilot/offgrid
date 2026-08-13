const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const { AgentLoop } = require('../out/agent/AgentLoop');
const { looksLikeToolCall, looksLikeTruncatedCreateFileCall } = require('../out/agent/ToolCallParser');
const { tryPrepareSimpleEditFastPath } = require('../out/agent/SimpleEditFastPath');
const {
  agentOutputTokenFloor,
  generatedFileContentIssue,
  isFileCreationTask,
  isJavaUnitTestCreationTask,
  javaUnitTestCreationTarget
} = require('../out/agent/AgentTaskPolicy');

test('reserva orçamento estendido para criação de arquivo de testes', () => {
  const request = 'Crie 2 testes simples e gere cliente-vip-list.component.spec.ts';
  assert.equal(isFileCreationTask(request), true);
  assert.equal(agentOutputTokenFloor(request), 768);
});


test('reconhece criação de teste unitário Java em português', () => {
  const request = 'crie os testes unitarios dessa classe seguindo AcompanhamentoObrasHistoricoDTOTest';
  assert.equal(isJavaUnitTestCreationTask(request), true);
});

test('reconhece classe de testes Java sem exigir a palavra unitário quando há origem Java', () => {
  const request = 'crie a classe de testes para o arquivo (TarifaSiapfDTO) pode usar (AcompanhamentoObrasHistoricoDTOTest) como exemplo para local, e padrao dos testes';
  const source = 'siavo-ejb/src/main/java/br/gov/caixa/siavo/dto/TarifaSiapfDTO.java';
  assert.equal(isJavaUnitTestCreationTask(request, [source]), true);
  assert.equal(isJavaUnitTestCreationTask(request, ['src/app/cliente.component.ts']), false);
  assert.equal(agentOutputTokenFloor(request, [source]), 2048);
});

test('destino de teste Java usa diretório do exemplo explicitamente citado', () => {
  const request = 'crie a classe de testes para o arquivo (TarifaSiapfDTO) pode usar (AcompanhamentoObrasHistoricoDTOTest) como exemplo para local, e padrao dos testes';
  const source = 'siavo-ejb/src/main/java/br/gov/caixa/siavo/dto/TarifaSiapfDTO.java';
  const reference = 'siavo-ejb/src/test/java/br/gov/caixa/siavo/tests/dto/AcompanhamentoObrasHistoricoDTOTest.java';
  assert.equal(
    javaUnitTestCreationTarget(request, [source], [reference]),
    'siavo-ejb/src/test/java/br/gov/caixa/siavo/tests/dto/TarifaSiapfDTOTest.java'
  );
});

test('reserva saída longa para create_file de teste Java', () => {
  const request = 'crie os testes unitarios dessa classe seguindo AcompanhamentoObrasHistoricoDTOTest';
  assert.equal(agentOutputTokenFloor(request), 2048);
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
        return '{"name":"create_file","arguments":"argumentos-invalidos"}';
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


test('detecta create_file cortado no meio do content por maxTokens', () => {
  const response = '{"name":"create_file","arguments":{"filePath":"src/A.java","content":"class A {\n  void teste() {';
  assert.equal(looksLikeTruncatedCreateFileCall(response), true);
});

test('AgentLoop não desperdiça segunda geração quando create_file já veio truncado', async () => {
  let generations = 0;
  await assert.rejects(() => new AgentLoop().run({
    initialPrompt: 'crie o arquivo',
    taskReminder: 'Crie src/A.java.',
    maxSteps: 2,
    diagnosticMode: false,
    log() {},
    async invokeStep() {
      generations += 1;
      return '{"name":"create_file","arguments":{"filePath":"src/A.java","content":"class A {';
    },
    async executeTool(call) {
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 0 };
    }
  }), /truncada/i);
  assert.equal(generations, 1);
});

test('AgentLoop converte código completo em create_file quando criação possui destino determinístico', async () => {
  const executions = [];
  const result = await new AgentLoop().run({
    initialPrompt: 'crie o teste',
    taskReminder: 'Crie ATest.java.',
    maxSteps: 1,
    diagnosticMode: false,
    requiredWrite: true,
    expectedCreateFilePath: 'module/src/test/java/com/example/ATest.java',
    log() {},
    async invokeStep() {
      return 'Aqui está o conteúdo:\n```java\npackage com.example;\nimport org.junit.Test;\npublic class ATest { @Test public void ok() {} }\n```';
    },
    async executeTool(call) {
      executions.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 0 };
    }
  });
  assert.equal(executions.length, 1);
  assert.equal(executions[0].name, 'create_file');
  assert.equal(executions[0].arguments.filePath, 'module/src/test/java/com/example/ATest.java');
  assert.match(String(executions[0].arguments.content), /public class ATest/);
  assert.match(result.text, /Alteração preparada para revisão/);
});

test('AgentLoop não devolve código truncado no chat quando a tarefa exige criação', async () => {
  let generations = 0;
  await assert.rejects(() => new AgentLoop().run({
    initialPrompt: 'crie o teste',
    taskReminder: 'Crie ATest.java.',
    maxSteps: 2,
    diagnosticMode: false,
    requiredWrite: true,
    expectedCreateFilePath: 'module/src/test/java/com/example/ATest.java',
    log() {},
    async invokeStep() {
      generations += 1;
      return 'Aqui está:\n```java\npackage com.example;\nimport org.junit.Test;\npublic class ATest { @Test public void ok() {';
    },
    async executeTool(call) {
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 0 };
    }
  }), /incompleta|fechamento/i);
  assert.equal(generations, 1);
});

test('JSON órfão com filePath e content é tratado como chamada inválida', () => {
  const response = 'Aqui está o arquivo:\n```json\n{"filePath":"src/A.java","content":"class A {}"}\n```';
  assert.equal(looksLikeToolCall(response), true);
});

test('AgentLoop corrige JSON órfão em vez de mostrá-lo como resposta final', async () => {
  const prompts = [];
  let attempt = 0;
  const result = await new AgentLoop().run({
    initialPrompt: 'crie o arquivo',
    taskReminder: 'Crie src/A.java.',
    maxSteps: 2,
    diagnosticMode: false,
    log() {},
    async invokeStep(prompt) {
      prompts.push(prompt);
      attempt += 1;
      return attempt === 1
        ? 'Aqui está:\n```json\n{"filePath":"src/A.java","content":"class A {}"}\n```'
        : '{"name":"create_file","arguments":{"filePath":"src/A.java","content":"class A {}"}}';
    },
    async executeTool(call) {
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 0 };
    }
  });
  assert.equal(result.calls[0].name, 'create_file');
  assert.match(prompts[1], /refaça a chamada COMPLETA/);
});

test('AgentLoop permite corrigir erro de validação de escrita', async () => {
  let generation = 0;
  let execution = 0;
  const result = await new AgentLoop().run({
    initialPrompt: 'crie o arquivo',
    taskReminder: 'Crie src/A.java.',
    maxSteps: 3,
    diagnosticMode: false,
    log() {},
    async invokeStep() {
      generation += 1;
      return generation === 1
        ? '{"name":"create_file","arguments":{"filePath":"src/A.java","content":"TODO"}}'
        : '{"name":"create_file","arguments":{"filePath":"src/A.java","content":"class A {}"}}';
    },
    async executeTool(call) {
      execution += 1;
      return execution === 1
        ? { callId: call.id, name: call.name, ok: false, content: null, error: 'Conteúdo contém TODO.', durationMs: 0 }
        : { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 0 };
    }
  });
  assert.equal(generation, 2);
  assert.equal(result.calls.length, 2);
  assert.match(result.text, /Alteração preparada para revisão/);
});

test('AgentLoop não insiste após rejeição explícita do usuário', async () => {
  let generation = 0;
  await assert.rejects(() => new AgentLoop().run({
    initialPrompt: 'crie o arquivo',
    taskReminder: 'Crie src/A.java.',
    maxSteps: 3,
    diagnosticMode: false,
    log() {},
    async invokeStep() {
      generation += 1;
      return '{"name":"create_file","arguments":{"filePath":"src/A.java","content":"class A {}"}}';
    },
    async executeTool(call) {
      return { callId: call.id, name: call.name, ok: false, content: null, error: 'Alteração rejeitada pelo usuário.', durationMs: 0 };
    }
  }), /rejeitada pelo usuário/);
  assert.equal(generation, 1);
});


test('AgentLoop também reconhece rejeição explícita em inglês', async () => {
  let generation = 0;
  await assert.rejects(() => new AgentLoop().run({
    initialPrompt: 'create the file',
    taskReminder: 'Create src/A.java.',
    maxSteps: 3,
    diagnosticMode: false,
    log() {},
    async invokeStep() {
      generation += 1;
      return '{"name":"create_file","arguments":{"filePath":"src/A.java","content":"class A {}"}}';
    },
    async executeTool(call) {
      return { callId: call.id, name: call.name, ok: false, content: null, error: 'Change rejected by user.', durationMs: 0 };
    }
  }), /rejected by user/);
  assert.equal(generation, 1);
});

test('AgentLoop não encerra após leitura intermediária enquanto corrige escrita parcial', async () => {
  let generation = 0;
  const result = await new AgentLoop().run({
    initialPrompt: 'crie dois arquivos',
    taskReminder: 'Crie src/A.java e src/B.java.',
    maxSteps: 4,
    diagnosticMode: false,
    log() {},
    async invokeStep() {
      generation += 1;
      if (generation === 1) {
        return JSON.stringify([
          { name: 'create_file', arguments: { filePath: 'src/A.java', content: 'class A {}' } },
          { name: 'create_file', arguments: { filePath: 'src/B.java', content: 'TODO' } }
        ]);
      }
      if (generation === 2) {
        return '{"name":"read_file","arguments":{"filePath":"src/A.java"}}';
      }
      return '{"name":"create_file","arguments":{"filePath":"src/B.java","content":"class B {}"}}';
    },
    async executeTool(call) {
      if (call.name === 'create_file' && call.arguments.content === 'TODO') {
        return { callId: call.id, name: call.name, ok: false, content: null, error: 'Conteúdo contém TODO.', durationMs: 0 };
      }
      return { callId: call.id, name: call.name, ok: true, content: { staged: call.name === 'create_file' }, durationMs: 0 };
    }
  });

  assert.equal(generation, 3);
  assert.match(result.text, /src\/A\.java, src\/B\.java/);
});
