const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const {
  tryPrepareAdaptivePatternFastPath,
  inferTargetPath,
  normalizeGeneratedContent
} = require('../out/agent/AdaptivePatternFastPath');
const {
  compactSourceForPattern,
  findWorkspaceReference,
  profileProject
} = require('../out/agent/ProjectProfiler');

async function createSiavoWorkspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-adaptive-fastpath-'));
  const sourcePath = 'siavo-ejb/src/main/java/br/gov/caixa/siavo/dto/TarifaSiapfDTO.java';
  const referencePath = 'siavo-ejb/src/test/java/br/gov/caixa/siavo/tests/dto/AcompanhamentoObrasHistoricoDTOTest.java';
  const source = `package br.gov.caixa.siavo.dto;

public class TarifaSiapfDTO {
    private String codObjetivo;
    private String numeroOperacao;
    private int taxa;
    private String codTarifa;
    private String descricaoTarifa;
    public String getCodObjetivo() { return codObjetivo; }
    public void setCodObjetivo(String value) { codObjetivo = value; }
    public String getNumeroOperacao() { return numeroOperacao; }
    public void setNumeroOperacao(String value) { numeroOperacao = value; }
    public int getTaxa() { return taxa; }
    public void setTaxa(int value) { taxa = value; }
    public String getCodTarifa() { return codTarifa; }
    public void setCodTarifa(String value) { codTarifa = value; }
    public String getDescricaoTarifa() { return descricaoTarifa; }
    public void setDescricaoTarifa(String value) { descricaoTarifa = value; }
}
`;
  const reference = `package br.gov.caixa.siavo.tests.dto;

import static org.junit.Assert.assertEquals;
import org.junit.Test;
import br.gov.caixa.siavo.dto.AcompanhamentoObrasHistoricoDTO;

public class AcompanhamentoObrasHistoricoDTOTest {
    AcompanhamentoObrasHistoricoDTO dto = new AcompanhamentoObrasHistoricoDTO();
    private static final String STR = "teste";

    @Test
    public void testGetSetCodigo() {
        dto.setCodigo(STR);
        String resultado = dto.getCodigo();
        assertEquals(STR, resultado);
    }

    @Test
    public void testGetSetDescricao() {
        dto.setDescricao(STR);
        String resultado = dto.getDescricao();
        assertEquals(STR, resultado);
    }
}
`;
  const pom = `<project><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version></dependency></dependencies></project>`;
  for (const [relative, content] of Object.entries({
    [sourcePath]: source,
    [referencePath]: reference,
    'siavo-ejb/pom.xml': pom
  })) {
    const absolute = path.join(root, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, content, 'utf8');
  }
  return { root, sourcePath, referencePath, source, reference };
}

const REQUEST = 'crie os testes unitarios dessa classe, os testes devem seguir o modelo da classe de teste ja criada (AcompanhamentoObrasHistoricoDTOTest) o novo teste deve estar no mesmo pacote e seguir o mesmo padrao de nomeclatura';
const REQUEST_208_LOG = 'crie a classe de testes para o arquivo (TarifaSiapfDTO)\npode usar (AcompanhamentoObrasHistoricoDTOTest) como exemplo para local, e padrao dos testes';

const GENERATED = `package br.gov.caixa.siavo.tests.dto;

import static org.junit.Assert.assertEquals;
import org.junit.Test;
import br.gov.caixa.siavo.dto.TarifaSiapfDTO;

public class TarifaSiapfDTOTest {
    TarifaSiapfDTO dto = new TarifaSiapfDTO();
    private static final String STR = "teste";

    @Test
    public void testGetSetCodObjetivo() {
        dto.setCodObjetivo(STR);
        String resultado = dto.getCodObjetivo();
        assertEquals(STR, resultado);
    }
}
`;

test('resolve referência citada e monta perfil Maven/JUnit a partir do projeto', async t => {
  const { root, sourcePath, referencePath, source, reference } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const found = await findWorkspaceReference(root, REQUEST, [sourcePath], '.java');
  assert.equal(found, referencePath);
  const profile = await profileProject({ workspaceRoot: root, sourcePath, referencePath, sourceText: source, referenceText: reference });
  assert.equal(profile.language, 'java');
  assert.equal(profile.buildSystem, 'maven');
  assert.equal(profile.testFramework, 'JUnit 4');
  assert.equal(profile.sourceRoot, 'siavo-ejb/src/main/java');
  assert.equal(profile.testRoot, 'siavo-ejb/src/test/java');
});

test('caso corporativo de DTO é sintetizado localmente sem chamar o modelo', async t => {
  const { root, sourcePath, referencePath } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let generations = 0;
  const calls = [];
  const result = await tryPrepareAdaptivePatternFastPath({
    request: REQUEST,
    workspaceRoot: root,
    priority: [sourcePath],
    contextSize: 4096,
    async generate() {
      generations += 1;
      return GENERATED;
    },
    async execute(call) {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 1 };
    }
  });

  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(generations, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create_file');
  assert.equal(calls[0].arguments.filePath, 'siavo-ejb/src/test/java/br/gov/caixa/siavo/tests/dto/TarifaSiapfDTOTest.java');
  const content = String(calls[0].arguments.content);
  assert.match(content, /package br\.gov\.caixa\.siavo\.tests\.dto;/);
  assert.match(content, /class TarifaSiapfDTOTest/);
  assert.match(content, /testGetSetCodObjetivo/);
  assert.match(content, /testGetSetNumeroOperacao/);
  assert.match(content, /testGetSetTaxa/);
  assert.match(content, /testGetSetCodTarifa/);
  assert.match(content, /testGetSetDescricaoTarifa/);
  assert.match(content, /assertEquals/);
  assert.match(result.text, /sem geração LLM/i);
  assert.match(result.text, new RegExp(referencePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('pedido real da 2.0.8 infere destino pelo teste de referência e não cai no AgentLoop', async t => {
  const { root, sourcePath, referencePath } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let generations = 0;
  const calls = [];
  const result = await tryPrepareAdaptivePatternFastPath({
    request: REQUEST_208_LOG,
    workspaceRoot: root,
    priority: [sourcePath],
    contextSize: 4096,
    async generate() {
      generations += 1;
      return GENERATED;
    },
    async execute(call) {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 1 };
    }
  });

  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(generations, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create_file');
  assert.equal(calls[0].arguments.filePath, 'siavo-ejb/src/test/java/br/gov/caixa/siavo/tests/dto/TarifaSiapfDTOTest.java');
  assert.match(String(calls[0].arguments.content), /class TarifaSiapfDTOTest/);
  assert.match(String(calls[0].arguments.content), /testGetSetDescricaoTarifa/);
  assert.match(result.text, /sem geração LLM/i);
  assert.match(result.text, new RegExp(referencePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('quando o padrão não é mecanicamente seguro usa geração direta sem JSON de ferramenta', async t => {
  const { root, sourcePath, referencePath } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const absolute = path.join(root, sourcePath);
  const source = await fsp.readFile(absolute, 'utf8');
  await fsp.writeFile(absolute, source.replace('private String codObjetivo;', 'private ConfiguracaoTarifa codObjetivo;').replace('public String getCodObjetivo()', 'public ConfiguracaoTarifa getCodObjetivo()').replace('public void setCodObjetivo(String value)', 'public void setCodObjetivo(ConfiguracaoTarifa value)'), 'utf8');
  const generatedPrompts = [];
  const calls = [];
  const result = await tryPrepareAdaptivePatternFastPath({
    request: REQUEST,
    workspaceRoot: root,
    priority: [sourcePath],
    contextSize: 4096,
    async generate(params) {
      generatedPrompts.push(params);
      return GENERATED;
    },
    async execute(call) {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 1 };
    }
  });
  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(generatedPrompts.length, 1);
  assert.equal(generatedPrompts[0].maxTokens, 1600);
  assert.ok(generatedPrompts[0].prompt.length < 7000);
  assert.match(generatedPrompts[0].systemPrompt, /sem JSON/i);
  assert.match(generatedPrompts[0].prompt, /AcompanhamentoObrasHistoricoDTOTest/);
  assert.match(generatedPrompts[0].prompt, /testGetSetCodigo/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.content, GENERATED);
});

test('não executa escrita se geração direta vier truncada', async t => {
  const { root, sourcePath } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const absolute = path.join(root, sourcePath);
  const source = await fsp.readFile(absolute, 'utf8');
  await fsp.writeFile(absolute, source.replace('private String codObjetivo;', 'private ConfiguracaoTarifa codObjetivo;').replace('public String getCodObjetivo()', 'public ConfiguracaoTarifa getCodObjetivo()').replace('public void setCodObjetivo(String value)', 'public void setCodObjetivo(ConfiguracaoTarifa value)'), 'utf8');
  let executions = 0;
  const result = await tryPrepareAdaptivePatternFastPath({
    request: REQUEST,
    workspaceRoot: root,
    priority: [sourcePath],
    contextSize: 4096,
    async generate() {
      return 'package br.gov.caixa.siavo.tests.dto;\nimport org.junit.Test;\npublic class TarifaSiapfDTOTest { @Test public void x() {';
    },
    async execute(call) {
      executions += 1;
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 0 };
    }
  });
  assert.ok(result);
  assert.equal(result.complete, false);
  assert.equal(executions, 0);
  assert.match(result.text, /não passou na validação/i);
});

test('normaliza fence e envelope JSON completo sem depender de tool parser', () => {
  assert.equal(normalizeGeneratedContent('```java\nclass A {}\n```', 'A.java'), 'class A {}\n');
  const wrapped = JSON.stringify({ name: 'create_file', arguments: { filePath: 'A.java', content: 'class A {}' } });
  assert.equal(normalizeGeneratedContent(wrapped, 'A.java'), 'class A {}\n');
});

test('compactação da referência Java preserva corpos de testes para aprender o padrão', async t => {
  const { root, referencePath, reference } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repeated = reference.repeat(8);
  const compact = compactSourceForPattern(referencePath, repeated, 2400);
  assert.match(compact, /@Test/);
  assert.match(compact, /assertEquals\(STR, resultado\)/);
});

test('inferência genérica também reconhece convenção Angular spec ao lado da origem', () => {
  const target = inferTargetPath(
    'crie os testes seguindo cliente.component.spec.ts como exemplo',
    'src/app/pedido/pedido.component.ts',
    'src/app/cliente/cliente.component.spec.ts',
    { workspaceRoot: '.', moduleRoot: '', language: 'typescript', buildSystem: 'npm', manifests: [] }
  );
  assert.equal(target, 'src/app/pedido/pedido.component.spec.ts');
});

test('fast path adaptativo genérico cria artefato novo por referência explícita sem depender de regra de teste', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-adaptive-generic-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const referencePath = 'app/src/main/java/com/example/service/ClienteService.java';
  const absolute = path.join(root, referencePath);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, 'package com.example.service;\npublic class ClienteService { public void executar() {} }\n', 'utf8');
  await fsp.writeFile(path.join(root, 'app/pom.xml'), '<project/>', 'utf8');

  const calls = [];
  const prompts = [];
  const result = await tryPrepareAdaptivePatternFastPath({
    request: 'crie PedidoService.java no mesmo pacote seguindo ClienteService.java como padrão',
    workspaceRoot: root,
    priority: [referencePath],
    contextSize: 4096,
    async generate(params) {
      prompts.push(params);
      return 'package com.example.service;\npublic class PedidoService { public void executar() {} }\n';
    },
    async execute(call) {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 0 };
    }
  });

  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(prompts.length, 1);
  assert.equal(calls[0].arguments.filePath, 'app/src/main/java/com/example/service/PedidoService.java');
  assert.match(prompts[0].prompt, /arquivo_referencia/iu);
  assert.match(prompts[0].prompt, /ClienteService/);
});

test('Adaptive Fast Path roda antes do planejamento/AgentLoop genérico', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const adaptive = source.indexOf('tryPrepareAdaptivePatternFastPath({');
  const planner = source.indexOf('ensureAutomaticContextForTask(s, taskContextEstimate)');
  const agentLoop = source.indexOf('const runAgentOnce = () => s.engine.runAgent({');
  assert.ok(adaptive >= 0);
  assert.ok(planner > adaptive);
  assert.ok(agentLoop > adaptive);
});

test('geração direta usa sessão isolada e restaura chat sem tool-call JSON', async () => {
  const source = await fsp.readFile(path.join(__dirname, '..', 'src', 'engine', 'EngineClient.ts'), 'utf8');
  const start = source.indexOf('async generateDirect(');
  assert.ok(start >= 0);
  const block = source.slice(start, source.indexOf('async runAgent(', start));
  assert.match(block, /agentStart/);
  assert.match(block, /agentStep/);
  assert.match(block, /agentFinish/);
  assert.doesNotMatch(block, /new AgentLoop/);
});

test('resolve classe-alvo citada mesmo quando o arquivo ativo não é Java', async t => {
  const { root, sourcePath, referencePath } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const calls = [];
  const result = await tryPrepareAdaptivePatternFastPath({
    request: REQUEST_208_LOG,
    workspaceRoot: root,
    priority: ['siavo-ejb/pom.xml'],
    contextSize: 4096,
    async generate() { throw new Error('LLM não deveria ser chamado'); },
    async execute(call) {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 0 };
    }
  });
  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create_file');
  assert.equal(calls[0].arguments.filePath, 'siavo-ejb/src/test/java/br/gov/caixa/siavo/tests/dto/TarifaSiapfDTOTest.java');
  const foundSource = await require('../out/agent/ProjectProfiler').findWorkspaceSource(root, REQUEST_208_LOG, ['siavo-ejb/pom.xml'], '.java');
  assert.equal(foundSource, sourcePath);
  const moduleRef = await findWorkspaceReference(root, REQUEST_208_LOG, [], '.java', 'siavo-ejb');
  assert.equal(moduleRef, referencePath);
});

test('referência explícita fica no mesmo módulo da origem quando há nomes duplicados', async t => {
  const { root, sourcePath, referencePath } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const other = path.join(root, 'outro-modulo/src/test/java/br/gov/exemplo/AcompanhamentoObrasHistoricoDTOTest.java');
  await fsp.mkdir(path.dirname(other), { recursive: true });
  await fsp.writeFile(other, 'package br.gov.exemplo; public class AcompanhamentoObrasHistoricoDTOTest {}', 'utf8');
  await fsp.writeFile(path.join(root, 'outro-modulo/pom.xml'), '<project/>', 'utf8');
  const found = await findWorkspaceReference(root, REQUEST_208_LOG, [], '.java', 'siavo-ejb');
  assert.equal(found, referencePath);
  assert.equal(sourcePath.startsWith('siavo-ejb/'), true);
});

test('destino já existente é atualizado por apply_edit em vez de cair no AgentLoop', async t => {
  const { root, sourcePath } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = 'siavo-ejb/src/test/java/br/gov/caixa/siavo/tests/dto/TarifaSiapfDTOTest.java';
  const absolute = path.join(root, target);
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, 'package br.gov.caixa.siavo.tests.dto;\npublic class TarifaSiapfDTOTest {\n}\n', 'utf8');
  const calls = [];
  const result = await tryPrepareAdaptivePatternFastPath({
    request: REQUEST_208_LOG,
    workspaceRoot: root,
    priority: [sourcePath],
    contextSize: 4096,
    async generate() { throw new Error('LLM não deveria ser chamado'); },
    async execute(call) {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 0 };
    }
  });
  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'apply_edit');
  assert.equal(calls[0].arguments.filePath, target);
  assert.match(String(calls[0].arguments.newText), /testGetSetCodObjetivo/);
});

test('falha na geração direta é terminal e não devolve undefined para iniciar AgentLoop', async t => {
  const { root, sourcePath } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const absolute = path.join(root, sourcePath);
  const source = await fsp.readFile(absolute, 'utf8');
  await fsp.writeFile(absolute, source.replace('private String codObjetivo;', 'private ConfiguracaoTarifa codObjetivo;').replace('public String getCodObjetivo()', 'public ConfiguracaoTarifa getCodObjetivo()').replace('public void setCodObjetivo(String value)', 'public void setCodObjetivo(ConfiguracaoTarifa value)'), 'utf8');
  const result = await tryPrepareAdaptivePatternFastPath({
    request: REQUEST,
    workspaceRoot: root,
    priority: [sourcePath],
    contextSize: 4096,
    async generate() { throw new Error('timeout simulado'); },
    async execute(call) { return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 0 }; }
  });
  assert.ok(result);
  assert.equal(result.complete, false);
  assert.match(result.text, /AgentLoop não será iniciado/i);
});

test('sintetizador local não presume construtor vazio quando a origem exige argumentos', async t => {
  const { root, sourcePath } = await createSiavoWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const absolute = path.join(root, sourcePath);
  const source = await fsp.readFile(absolute, 'utf8');
  await fsp.writeFile(absolute, source.replace('public class TarifaSiapfDTO {', 'public class TarifaSiapfDTO {\n    public TarifaSiapfDTO(String obrigatorio) {}'), 'utf8');
  let generations = 0;
  const result = await tryPrepareAdaptivePatternFastPath({
    request: REQUEST_208_LOG,
    workspaceRoot: root,
    priority: [sourcePath],
    contextSize: 4096,
    async generate() { generations += 1; return GENERATED; },
    async execute(call) { return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 0 }; }
  });
  assert.ok(result);
  assert.equal(generations, 1);
});
