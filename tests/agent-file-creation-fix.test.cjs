const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { detectToolCalls } = require('../out/agent/ToolCallParser');
const {
  generatedFileContentIssue,
  workspaceRootCreationTarget
} = require('../out/agent/AgentTaskPolicy');
const { tryPrepareSimpleEditFastPath } = require('../out/agent/SimpleEditFastPath');
const { buildAgentWorkspaceContext } = require('../out/agent/WorkspaceContextBuilder');

const componentPath = 'locadora-frontend/src/app/components/cliente-vip/cliente-vip-list.component.ts';
const specPath = 'locadora-frontend/src/app/components/cliente-vip/cliente-vip-list.component.spec.ts';
const componentSource = `
@Component({ standalone: true })
export class ClienteVipListComponent {
  clientesVip = [];
  filtro = '';
  get clientesFiltrados() { return this.clientesVip; }
}
`;

test('interpreta create_file com conteúdo em template literal', () => {
  const response = `\`\`\`json
{
  "name": "create_file",
  "arguments": {
    "filePath": "${specPath}",
    "content": \`
import { TestBed } from '@angular/core/testing';
it('carrega', () => {});
it('filtra', () => {});
\`
  }
}
\`\`\``;

  const calls = detectToolCalls(response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create_file');
  assert.equal(calls[0].arguments.filePath, specPath);
  assert.match(calls[0].arguments.content, /it\('filtra'/);
});

test('interpreta create_file com quebras de linha não escapadas', () => {
  const response = `{"name":"create_file","arguments":{"filePath":"${specPath}","content":"import { TestBed } from '@angular/core/testing';

it('carrega', () => {});
it('filtra', () => {});
","reason":"testes"}`;

  const calls = detectToolCalls(response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.reason, 'testes');
  assert.match(calls[0].arguments.content, /it\('carrega'/);
});

test('mantém normalização anterior de rename_symbol e find_symbol', () => {
  const calls = detectToolCalls([
    '{"name":"rename_symbol","arguments":{"filePath":"a.html","oldName":"A","newName":"B"}}',
    '{"name":"find_symbol","arguments":{"query":"A","filePath":"a.html"}}'
  ].join('\n'));

  assert.equal(calls[0].name, 'apply_edit');
  assert.deepEqual(calls[0].arguments, { filePath: 'a.html', oldText: 'A', newText: 'B', replaceAll: true });
  assert.equal(calls[1].name, 'find_symbol');
  assert.deepEqual(calls[1].arguments, { query: 'A' });
});

test('caminho rápido ignora criação mesmo quando o pedido contém não altere', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-fastpath-'));
  const filePath = 'cliente-vip-list.component.ts';
  await fsp.writeFile(path.join(root, filePath), 'Pesquisar', 'utf8');
  let executed = false;
  let warned = false;

  try {
    const result = await tryPrepareSimpleEditFastPath({
      request: 'Crie 2 testes e não altere outros arquivos.',
      workspaceRoot: root,
      priority: [filePath],
      execute: async () => {
        executed = true;
        throw new Error('não deveria executar');
      },
      warn: () => { warned = true; }
    });
    assert.equal(result, undefined);
    assert.equal(executed, false);
    assert.equal(warned, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('resolve nome abreviado e inclui fonte, modelo, service e spec existente', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-context-'));
  const files = {
    [componentPath]: `import { Cliente } from '../../models/cliente.model';\nimport { ClienteService } from '../../services/cliente.service';\n${componentSource}`,
    'locadora-frontend/src/app/models/cliente.model.ts': 'export interface Cliente { nome: string; }',
    'locadora-frontend/src/app/services/cliente.service.ts': 'export class ClienteService { listar() {} }',
    'locadora-frontend/src/app/components/outro/outro.component.spec.ts': "describe('Outro', () => { it('cria', () => {}); });"
  };

  try {
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(root, relative);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, content, 'utf8');
    }

    const context = await buildAgentWorkspaceContext({
      workspaceRoot: root,
      priority: ['cliente-vip-list.component.ts', 'cliente-vip-list.component.spec.ts'],
      maxFiles: 4,
      maxCharsPerFile: 5000,
      maxTotalChars: 12000,
      includeTestRelated: true
    });
    const loaded = context.files.map(file => file.filePath);
    assert.equal(loaded[0], componentPath);
    assert.ok(loaded.some(file => file.endsWith('cliente.model.ts')));
    assert.ok(loaded.some(file => file.endsWith('cliente.service.ts')));
    assert.ok(loaded.some(file => file.endsWith('.spec.ts')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('rejeita spec no caminho errado e uso de declarations em standalone', () => {
  const context = { request: 'Crie 2 testes', sources: [{ filePath: componentPath, content: componentSource }] };
  const base = `import { ComponentFixture } from '@angular/core/testing';\ndescribe('x', () => { it('a', () => {}); it('b', () => {}); });`;
  assert.match(generatedFileContentIssue('src/app/cliente-vip-list.component.spec.ts', base, context), /ao lado do componente/);

  const declarations = `import { ComponentFixture } from '@angular/core/testing';\nTestBed.configureTestingModule({ declarations: [ClienteVipListComponent] });\ndescribe('x', () => { it('a', () => {}); it('b', () => {}); });`;
  assert.match(generatedFileContentIssue(specPath, declarations, context), /standalone/);
});

test('rejeita membros inexistentes e aceita membros reais do componente', () => {
  const context = { request: 'Crie 2 testes', sources: [{ filePath: componentPath, content: componentSource }] };
  const invalid = `import { ComponentFixture } from '@angular/core/testing';\ndescribe('x', () => { it('a', () => { component.filter = 'x'; }); it('b', () => {}); });`;
  assert.match(generatedFileContentIssue(specPath, invalid, context), /filter/);

  const valid = `import { ComponentFixture } from '@angular/core/testing';\ndescribe('x', () => { it('a', () => { component.filtro = 'x'; }); it('b', () => { expect(component.clientesFiltrados).toEqual([]); }); });`;
  assert.equal(generatedFileContentIssue(specPath, valid, context), undefined);
});

test('ContextManager procura arquivo real entre editores visíveis', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'context', 'ContextManager.ts'), 'utf8');
  assert.match(source, /visibleTextEditors/);
  assert.match(source, /getWorkspaceFolder/);
  assert.match(source, /this\.updateActive\(\);/);
});

test('remove envelope java.lang.String do conteúdo de create_file', () => {
  const java = 'package com.example;\npublic class SampleTest {}\n';
  const response = JSON.stringify({
    name: 'create_file',
    arguments: {
      filePath: 'src/test/java/com/example/SampleTest.java',
      content: JSON.stringify({ '@class': 'java.lang.String', content: java })
    }
  });

  const [call] = detectToolCalls(response);
  assert.ok(call);
  assert.equal(call.arguments.content, java);
});


test('arquivo explícito sem pasta usa a raiz do workspace', () => {
  assert.equal(
    workspaceRootCreationTarget(['agents-md-check.ts'], true),
    'agents-md-check.ts'
  );
  assert.equal(
    workspaceRootCreationTarget(['src/agents-md-check.ts'], true),
    undefined
  );
  assert.equal(
    workspaceRootCreationTarget(['a.ts', 'b.ts'], true),
    undefined
  );
  assert.equal(
    workspaceRootCreationTarget(['agents-md-check.ts'], false),
    undefined
  );
});

test('criação na raiz não herda arquivo ativo nem contexto arbitrário', () => {
  const extension = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  assert.match(extension, /const contextPriority = rootCreationTarget \? \[\] : priority/);
  assert.match(extension, /priority: contextPriority/);
  assert.match(extension, /call\.arguments\.filePath = rootCreationTarget/);
  assert.match(extension, /createsFiles: genericFileCreationTask && !rootCreationTarget/);
});
