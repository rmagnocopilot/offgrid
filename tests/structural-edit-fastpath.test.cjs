const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const {
  parseMethodRequest,
  tryPrepareStructuralEditFastPath
} = require('../out/agent/StructuralEditFastPath');

async function workspaceWithSource(source) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-structural-edit-'));
  const relativePath = 'src/app/products/product-list.component.ts';
  const absolutePath = path.join(root, ...relativePath.split('/'));
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, source, 'utf8');
  return { root, relativePath };
}

const source = `import { Product } from '../models/product';

interface ProductView extends Product {
  label: string;
}

export class ProductListComponent {
  items: ProductView[] = [];

  private toView(product: Product, index: number): ProductView {
    return { ...product, label: String(index) };
  }
}
`;

test('interpreta pedido curto de insercao estrutural sem nome de arquivo', () => {
  const parsed = parseMethodRequest(
    'Adicione um método público adicionarProduto(produto: Product) que converta o produto com toView e o adicione ao final de items.'
  );

  assert.deepEqual(parsed, {
    methodName: 'adicionarProduto',
    parameterName: 'produto',
    parameterType: 'Product',
    returnType: 'void',
    helperName: 'toView',
    collectionName: 'items'
  });
});

test('prepara apply_edit generico para transformar e anexar item', async () => {
  const workspace = await workspaceWithSource(source);
  let executed;

  const result = await tryPrepareStructuralEditFastPath({
    request: 'Adicione um método público adicionarProduto(produto: Product) que converta o produto com toView e o adicione ao final de items.',
    workspaceRoot: workspace.root,
    priority: [workspace.relativePath],
    async execute(call) {
      executed = call;
      return {
        callId: call.id,
        name: call.name,
        ok: true,
        content: { staged: true },
        durationMs: 1
      };
    }
  });

  assert.ok(result);
  assert.equal(executed.name, 'apply_edit');
  assert.equal(executed.arguments.filePath, workspace.relativePath);
  assert.match(executed.arguments.newText, /public adicionarProduto\(produto: Product\): void/);
  assert.match(executed.arguments.newText, /this\.toView\(produto, this\.items\.length\)/);
  assert.match(executed.arguments.newText, /this\.items = \[\.\.\.this\.items, valorConvertido\]/);
});

test('nao aplica quando helper ou colecao nao podem ser comprovados', async () => {
  const workspace = await workspaceWithSource(source);

  const result = await tryPrepareStructuralEditFastPath({
    request: 'Adicione um método público adicionarProduto(produto: Product) que converta o produto com helperInexistente e o adicione ao final de items.',
    workspaceRoot: workspace.root,
    priority: [workspace.relativePath],
    async execute() {
      throw new Error('nao deveria executar');
    }
  });

  assert.equal(result, undefined);
});

test('implementacao do fast path nao contem nomes do projeto de exemplo', async () => {
  const implementation = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'agent', 'StructuralEditFastPath.ts'),
    'utf8'
  );

  assert.doesNotMatch(implementation, /ClienteVip|ClienteService|clientesVip|criarVisaoVip|locadora/i);
});

test('mensagem de modelo carregado usa barra de status por dois segundos', async () => {
  const extension = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );

  assert.match(extension, /setStatusBarMessage\([\s\S]*carregado em[\s\S]*2000\)/);
});
