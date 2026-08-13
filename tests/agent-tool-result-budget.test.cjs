const test = require('node:test');
const assert = require('node:assert/strict');

const {
  serializeToolArgumentsForPrompt,
  serializeToolResultForPrompt
} = require('../out/agent/AgentToolResultBudget');
const { AgentLoop } = require('../out/agent/AgentLoop');

test('read_file grande é compactado preservando metadados, início e fim', () => {
  const content = `INICIO\n${'linha de código xxxxxxxxxxxxxxxxxxxxxxxxx\n'.repeat(240)}FIM`;
  const serialized = serializeToolResultForPrompt('read_file', {
    filePath: 'src/test/java/ExemploTest.java',
    startLine: 1,
    endLine: 242,
    totalLines: 242,
    content
  }, 900);

  assert.ok(serialized.length <= 900);
  assert.match(serialized, /ExemploTest\.java/);
  assert.match(serialized, /INICIO/);
  assert.match(serialized, /FIM/);
  assert.match(serialized, /omitidos/);
});

test('argumentos de create_file não repetem o arquivo inteiro no próximo prompt', () => {
  const serialized = serializeToolArgumentsForPrompt('create_file', {
    filePath: 'src/test/java/NovoTest.java',
    content: 'public class NovoTest {\n' + 'x'.repeat(6000) + '\n}'
  }, 420);

  assert.ok(serialized.length <= 420);
  assert.match(serialized, /NovoTest\.java/);
  assert.match(serialized, /content omitido/);
  assert.doesNotMatch(serialized, /x{500}/);
});

test('AgentLoop limita prompt após ferramenta de leitura grande', async () => {
  const prompts = [];
  const loop = new AgentLoop();
  const result = await loop.run({
    initialPrompt: 'prompt inicial',
    taskReminder: '<tarefa_usuario>crie o teste seguindo ExemploTest</tarefa_usuario>',
    maxSteps: 3,
    diagnosticMode: false,
    continuationPromptMaxChars: 1400,
    log: () => undefined,
    invokeStep: async (prompt, step) => {
      prompts.push(prompt);
      if (step === 1) {
        return '{"name":"read_file","arguments":{"filePath":"src/test/java/ExemploTest.java"}}';
      }
      return 'Concluído sem novas ferramentas.';
    },
    executeTool: async call => ({
      callId: call.id,
      name: call.name,
      ok: true,
      durationMs: 1,
      content: {
        filePath: 'src/test/java/ExemploTest.java',
        startLine: 1,
        endLine: 240,
        totalLines: 240,
        content: `CABECALHO\n${'assertEquals(1, 1);\n'.repeat(600)}RODAPE`
      }
    })
  });

  assert.equal(result.text, 'Concluído sem novas ferramentas.');
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].length <= 1550, `continuação grande demais: ${prompts[1].length}`);
  assert.match(prompts[1], /ExemploTest\.java/);
  assert.match(prompts[1], /crie o teste/);
  assert.doesNotMatch(prompts[1], /assertEquals\(1, 1\);(?:\\nassertEquals\(1, 1\);){100}/);
});

test('resultado JaCoCo preserva resumo e omite saída extensa do build', () => {
  const serialized = serializeToolResultForPrompt('run_java_coverage', {
    moduleRoot: 'app',
    buildSystem: 'maven',
    reportPath: 'app/target/site/jacoco/jacoco.xml',
    className: 'TarifaService',
    summary: {
      methodsTotal: 3,
      methodsFullyCovered: 1,
      methodsPartiallyCovered: 1,
      methodsUncovered: 1,
      uncoveredMethods: [{ name: 'calcularEspecial', missedInstructions: 12, missedBranches: 2 }],
      partialMethods: [{ name: 'calcular', missedInstructions: 4, missedBranches: 1 }]
    },
    stdout: 'x'.repeat(12000),
    stderr: ''
  }, 900);
  assert.ok(serialized.length <= 900);
  assert.match(serialized, /calcularEspecial/);
  assert.match(serialized, /buildOutputOmitted/);
  assert.doesNotMatch(serialized, /x{200}/);
});
