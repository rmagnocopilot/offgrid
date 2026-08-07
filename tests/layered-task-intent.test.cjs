const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fsp = require('node:fs/promises');

const { interpretLayeredTask } = require('../out/agent/LayeredTaskIntent');
const { isBackendEndpointIntent } = require('../out/agent/BackendEndpointIntent');
const { isBackendServiceIntent } = require('../out/agent/BackendServiceIntent');

test('separa alvo Service da referência endpoint', () => {
  const request = 'Para o endpoint editar criado, crie o service equivalente.';
  const intent = interpretLayeredTask(request);
  assert.equal(intent.targetLayer, 'service');
  assert.deepEqual(intent.referenceLayers, ['endpoint']);
  assert.equal(intent.operation, 'update');
  assert.equal(intent.ambiguous, false);
  assert.equal(isBackendServiceIntent(request), true);
  assert.equal(isBackendEndpointIntent(request), false);
});

test('separa alvo endpoint da referência Service na ordem inversa', () => {
  const request = 'Baseado no método do service criado, crie o endpoint editar.';
  const intent = interpretLayeredTask(request);
  assert.equal(intent.targetLayer, 'endpoint');
  assert.deepEqual(intent.referenceLayers, ['service']);
  assert.equal(intent.operation, 'update');
  assert.equal(isBackendEndpointIntent(request), true);
  assert.equal(isBackendServiceIntent(request), false);
});

test('reconhece service.ts como alvo TypeScript explícito', () => {
  const intent = interpretLayeredTask('No cliente.service.ts, adicione um método para editar cliente.');
  assert.equal(intent.targetLayer, 'service');
  assert.equal(intent.language, 'typescript');
  assert.deepEqual(intent.explicitFiles, ['cliente.service.ts']);
  assert.deepEqual(intent.entityTerms, ['cliente']);
});

test('mantém endpoint como alvo quando Service é apenas dependência', () => {
  const intent = interpretLayeredTask('Crie um endpoint para editar Order usando o OrderService.');
  assert.equal(intent.targetLayer, 'endpoint');
  assert.deepEqual(intent.referenceLayers, ['service']);
  assert.deepEqual(intent.entityTerms, ['order']);
});

test('recusa FastPath quando o pedido tem dois alvos coordenados', () => {
  const request = 'Crie endpoint e service para editar cliente.';
  const intent = interpretLayeredTask(request);
  assert.equal(intent.ambiguous, true);
  assert.equal(intent.targetLayer, 'unknown');
  assert.deepEqual(intent.targetLayers, ['endpoint', 'service']);
  assert.equal(isBackendEndpointIntent(request), false);
  assert.equal(isBackendServiceIntent(request), false);
});

test('interpretação é genérica para repository, component, model e test', () => {
  const cases = [
    ['Usando o service existente, crie o repository equivalente.', 'repository', ['service']],
    ['Baseado no model criado, altere o component.', 'component', ['model']],
    ['No DTO existente, adicione o campo no model.', 'model', []],
    ['Para o component criado, gere o teste correspondente.', 'test', ['component']]
  ];
  for (const [request, target, references] of cases) {
    const intent = interpretLayeredTask(request);
    assert.equal(intent.targetLayer, target, request);
    assert.deepEqual(intent.referenceLayers, references, request);
  }
});

test('pedido corporativo de teste DTO é alvo Java de teste e não ambíguo', () => {
  const request = [
    'crie os testes unitarios dessa classe seguindo o padrao da aplicação existente.',
    'O teste deve ficar na pasta (br.gov.caixa.siavo.tests.dto).',
    'Pode usar AcompanhamentoObrasHistoricoDTOTest como exemplo'
  ].join(' ');
  const intent = interpretLayeredTask(request);
  assert.equal(intent.targetLayer, 'test');
  assert.deepEqual(intent.targetLayers, ['test']);
  assert.equal(intent.operation, 'test');
  assert.equal(intent.language, 'java');
  assert.equal(intent.ambiguous, false);
  assert.equal(intent.confidence, 'high');
  assert.ok(intent.referenceLayers.includes('test'));
});

test('implementação do interpretador não contém nomes do projeto funcional', async () => {
  const implementation = await fsp.readFile(path.join(__dirname, '..', 'src', 'agent', 'LayeredTaskIntent.ts'), 'utf8');
  assert.doesNotMatch(implementation, /ClienteResource|ClienteService|locadora|cliente-vip/i);
});
