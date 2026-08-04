const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const {
  isClassDocumentationRequest,
  tryPrepareDocumentationFastPath
} = require('../out/agent/DocumentationFastPath');
const { isFileCreationTask } = require('../out/agent/AgentTaskPolicy');
const { estimateTaskComplexity } = require('../out/context/AutomaticContextPlanner');

async function workspaceWithSource(source) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-doc-fastpath-'));
  const relativePath = 'src/app/orders/order-list.component.ts';
  const absolutePath = path.join(root, ...relativePath.split('/'));
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, source, 'utf8');
  return { root, relativePath };
}

const source = `import { Component } from '@angular/core';

@Component({ selector: 'app-order-list', template: '' })
export class OrderListComponent {
  items: unknown[] = [];

  carregar(): void {}
}
`;

test('reconhece pedido de JSDoc para a classe do arquivo aberto', () => {
  const request = 'No arquivo aberto, adicione um comentário JSDoc à classe explicando sua responsabilidade, sem alterar o comportamento.';
  assert.equal(isClassDocumentationRequest(request), true);
  assert.equal(isFileCreationTask(request), false);
});

test('classifica documentação local como tarefa simples de um arquivo', () => {
  const request = 'No arquivo aberto, adicione um comentário JSDoc à classe explicando sua responsabilidade, sem alterar o comportamento.';
  const estimate = estimateTaskComplexity({ request, estimatedFiles: 1, createsFiles: isFileCreationTask(request) });
  assert.deepEqual(estimate, { complexity: 'simple', estimatedFiles: 1, reason: 'tarefa simples' });
});

test('adiciona JSDoc acima dos decorators sem alterar o corpo', async () => {
  const workspace = await workspaceWithSource(source);
  let executed;

  const result = await tryPrepareDocumentationFastPath({
    request: 'No arquivo aberto, adicione um comentário JSDoc à classe explicando sua responsabilidade, sem alterar o comportamento.',
    workspaceRoot: workspace.root,
    priority: [workspace.relativePath],
    async execute(call) {
      executed = call;
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 1 };
    }
  });

  assert.ok(result);
  assert.equal(executed.name, 'apply_edit');
  assert.equal(executed.arguments.filePath, workspace.relativePath);
  assert.match(executed.arguments.newText, /^\/\*\*[\s\S]*Responsável por carregar e exibir a listagem de Order\.[\s\S]*@Component/);
  assert.equal(executed.arguments.newText.includes('items: unknown[] = []'), false);
});

test('é idempotente quando a classe já possui JSDoc', async () => {
  const workspace = await workspaceWithSource(source.replace('@Component', '/**\n * Lista pedidos.\n */\n@Component'));
  let calls = 0;

  const result = await tryPrepareDocumentationFastPath({
    request: 'Adicione um JSDoc à classe.',
    workspaceRoot: workspace.root,
    priority: [workspace.relativePath],
    async execute() {
      calls += 1;
      throw new Error('não deveria executar');
    }
  });

  assert.ok(result);
  assert.equal(calls, 0);
  assert.match(result.text, /Nenhuma alteração foi necessária/);
});

test('implementação não contém nomes do projeto de exemplo', async () => {
  const implementation = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'agent', 'DocumentationFastPath.ts'),
    'utf8'
  );
  assert.doesNotMatch(implementation, /Reserva|Cliente|Carro|locadora/i);
});
