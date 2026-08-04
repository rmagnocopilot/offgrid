const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const {
  analyzeAngularComponent,
  tryPrepareTestGenerationFastPath
} = require('../out/agent/TestGenerationFastPath');

async function createWorkspace({ packageJson, files }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-test-fastpath-'));
  await fsp.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify(packageJson ?? {}, null, 2),
    'utf8'
  );
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, content, 'utf8');
  }
  return root;
}

async function runFastPath({ root, request, priority }) {
  const calls = [];
  const logs = [];
  const result = await tryPrepareTestGenerationFastPath({
    request,
    workspaceRoot: root,
    priority,
    info(message) { logs.push(message); },
    warn(message) { logs.push(message); },
    async execute(call) {
      calls.push(call);
      return {
        callId: call.id,
        name: call.name,
        ok: true,
        content: { staged: true },
        durationMs: 1
      };
    }
  });
  return { result, calls, logs };
}

test('gera spec Jasmine genérico para componente standalone de produtos', async t => {
  const componentPath = 'apps/store/src/app/products/product-list.component.ts';
  const root = await createWorkspace({
    packageJson: {
      devDependencies: {
        '@types/jasmine': '5.1.0',
        'jasmine-core': '5.1.0'
      }
    },
    files: {
      [componentPath]: `
import { Component, OnInit } from '@angular/core';
import { ProductApi } from '../shared/product-api.service';

@Component({ standalone: true, selector: 'app-product-list', template: '' })
export class ProductListComponent implements OnInit {
  products: Array<{ title: string }> = [];
  query = '';
  loading = true;

  constructor(private readonly api: ProductApi) {}

  ngOnInit(): void {
    this.api.fetchAll().subscribe(items => {
      this.products = items;
      this.loading = false;
    });
  }

  get visibleProducts(): Array<{ title: string }> {
    const term = this.query.trim().toLowerCase();
    if (!term) return this.products;
    return this.products.filter(product => product.title.toLowerCase().includes(term));
  }
}
`,
      'apps/store/src/app/shared/product-api.service.ts': 'export class ProductApi { fetchAll() { throw new Error(); } }'
    }
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const { result, calls, logs } = await runFastPath({
    root,
    request: 'Crie 2 testes para product-list.component.ts: carregue os dados ao inicializar com mock do serviço e filtre pelo campo query.',
    priority: [componentPath]
  });

  assert.ok(result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'create_file');
  assert.equal(calls[0].arguments.filePath, 'apps/store/src/app/products/product-list.component.spec.ts');
  const content = calls[0].arguments.content;
  assert.match(content, /imports: \[ProductListComponent\]/);
  assert.doesNotMatch(content, /declarations: \[ProductListComponent\]/);
  assert.match(content, /jasmine\.createSpyObj<ProductApi>/);
  assert.match(content, /api\.fetchAll\.and\.returnValue\(of\(/);
  assert.match(content, /\(component as any\)\.query = 'alpha'/);
  assert.match(content, /\(component as any\)\.visibleProducts/);
  assert.equal((content.match(/\bit\s*\(/g) || []).length, 2);
  assert.ok(logs.some(message => /modelo não será chamado/.test(message)));
  assert.doesNotMatch(content, /Cliente|cliente|VIP|cpf|categoria/);
});

test('detecta Jest e componente Angular baseado em módulo para pedidos em inglês', async t => {
  const componentPath = 'src/app/orders/order-list.component.ts';
  const root = await createWorkspace({
    packageJson: {
      devDependencies: {
        jest: '30.0.0',
        'jest-preset-angular': '15.0.0'
      }
    },
    files: {
      [componentPath]: `
import { Component, OnInit } from '@angular/core';
import { OrderRepository } from '../data/order-repository';

@Component({ selector: 'app-order-list', template: '' })
export class OrderListComponent implements OnInit {
  rows: any[] = [];
  searchText: string = '';

  constructor(private repository: OrderRepository) {}

  ngOnInit(): void {
    this.repository.load().pipe().subscribe(result => {
      this.rows = result.data;
    });
  }

  filteredRows(): any[] {
    const normalized = this.searchText.toLowerCase();
    return this.rows.filter(row => row.code.toLowerCase().includes(normalized));
  }
}
`,
      'src/app/data/order-repository.ts': 'export class OrderRepository { load() { throw new Error(); } }'
    }
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const { result, calls } = await runFastPath({
    root,
    request: 'Generate 2 tests for order-list.component.ts: load records on initialization and filter by search text.',
    priority: [componentPath]
  });

  assert.ok(result);
  const content = calls[0].arguments.content;
  assert.match(content, /declarations: \[OrderListComponent\]/);
  assert.doesNotMatch(content, /imports: \[OrderListComponent\]/);
  assert.match(content, /repository = \{ load: jest\.fn\(\) \}/);
  assert.match(content, /repository\.load\.mockReturnValue\(of\(\{ data: \[\] \} as any\)\)/);
  assert.match(content, /\(component as any\)\.filteredRows\(\)/);
  assert.match(content, /code: 'Alpha'/);
});

test('detecta Vitest e gera apenas o cenário de filtro comprovado', async t => {
  const componentPath = 'frontend/src/app/users/user-search.component.ts';
  const root = await createWorkspace({
    packageJson: { devDependencies: { vitest: '3.0.0' } },
    files: {
      [componentPath]: `
import { Component, inject } from '@angular/core';
import { UserGateway } from '../core/user-gateway';

@Component({ standalone: true, selector: 'app-user-search', template: '' })
export class UserSearchComponent {
  private gateway = inject(UserGateway);
  users: any[] = [];
  term = '';

  get results(): any[] {
    const value = this.term.trim().toLowerCase();
    return this.users.filter(user => user.email.toLowerCase().includes(value));
  }
}
`,
      'frontend/src/app/core/user-gateway.ts': 'export class UserGateway {}'
    }
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const { result, calls } = await runFastPath({
    root,
    request: 'Generate a filter test for user-search.component.ts using the term field.',
    priority: [componentPath]
  });

  assert.ok(result);
  const content = calls[0].arguments.content;
  assert.match(content, /import \{ beforeEach, describe, expect, it, vi \} from 'vitest'/);
  assert.match(content, /gateway = \{  \}/);
  assert.match(content, /\(component as any\)\.term = 'alpha'/);
  assert.equal((content.match(/\bit\s*\(/g) || []).length, 1);
  assert.doesNotMatch(content, /from 'rxjs'/);
});

test('não ativa o caminho rápido quando uma dependência exige propriedades não simuladas', () => {
  const analysis = analyzeAngularComponent('src/app/report/report.component.ts', `
import { Component } from '@angular/core';
import { ActivatedRoute } from './activated-route';
@Component({ standalone: true, template: '' })
export class ReportComponent {
  rows: any[] = [];
  term = '';
  constructor(private route: ActivatedRoute) {
    const id = this.route.snapshot.id;
  }
  get filtered(): any[] {
    return this.rows.filter(row => row.name.includes(this.term));
  }
}
`);

  assert.equal(analysis, undefined);
});

test('implementação não contém nomes do projeto usado como exemplo', async () => {
  const source = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'agent', 'TestGenerationFastPath.ts'),
    'utf8'
  );
  assert.doesNotMatch(source, /ClienteVip|clientesVip|ClienteService|locadora|cpf|categoria/);
});


test('segue chamada auxiliar do ngOnInit e aceita transformação map sem acoplamento de domínio', async t => {
  const componentPath = 'src/app/inventory/inventory-list.component.ts';
  const root = await createWorkspace({
    packageJson: {
      dependencies: { '@angular/core': '^18.2.0' },
      devDependencies: { 'jasmine-core': '5.1.0' }
    },
    files: {
      [componentPath]: `
import { Component, OnInit } from '@angular/core';
import { InventorySource } from '../data/inventory-source';

@Component({ standalone: true, selector: 'app-inventory-list', template: '' })
export class InventoryListComponent implements OnInit {
  entries: Array<{ code: string; label: string }> = [];
  search = '';
  pending = true;

  constructor(private readonly source: InventorySource) {}

  ngOnInit(): void {
    this.refresh();
  }

  get visibleEntries(): Array<{ code: string; label: string }> {
    const value = this.search.trim().toLowerCase();
    return this.entries.filter(entry => entry.label.toLowerCase().includes(value));
  }

  private refresh(): void {
    this.source.read().subscribe({
      next: records => {
        this.entries = records.map(record => ({ ...record, label: record.code }));
        this.pending = false;
      }
    });
  }
}
`,
      'src/app/data/inventory-source.ts': 'export class InventorySource { read() { throw new Error(); } }'
    }
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const { result, calls } = await runFastPath({
    root,
    request: 'Crie testes para inventory-list.component.ts: carregue os registros ao inicializar e filtre pelo campo search.',
    priority: [componentPath]
  });

  assert.ok(result);
  const content = calls[0].arguments.content;
  assert.match(content, /source\.read\.and\.returnValue\(of\(\[\] as any\)\)/);
  assert.match(content, /\(component as any\)\.entries = \[\{ marcador: true \}\]/);
  assert.match(content, /expect\(\(component as any\)\.entries\)\.toEqual\(\[\]\)/);
  assert.match(content, /\(component as any\)\.search = 'alpha'/);
});

test('usa o padrão standalone do Angular 19 quando a propriedade é omitida', async t => {
  const componentPath = 'projects/portal/src/app/tags/tag-filter.component.ts';
  const root = await createWorkspace({
    packageJson: {
      dependencies: { '@angular/core': '^19.0.0' },
      devDependencies: { 'jasmine-core': '5.1.0' }
    },
    files: {
      [componentPath]: `
import { Component } from '@angular/core';

@Component({ selector: 'app-tag-filter', template: '' })
export class TagFilterComponent {
  tags = ['Alpha', 'Beta'];
  query = '';

  get visibleTags(): string[] {
    const value = this.query.trim().toLowerCase();
    return this.tags.filter(tag => tag.toLowerCase().includes(value));
  }
}
`
    }
  });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const { result, calls } = await runFastPath({
    root,
    request: 'Crie um teste de filtro para tag-filter.component.ts usando o campo query.',
    priority: [componentPath]
  });

  assert.ok(result);
  const content = calls[0].arguments.content;
  assert.match(content, /imports: \[TagFilterComponent\]/);
  assert.doesNotMatch(content, /declarations: \[TagFilterComponent\]/);
  assert.doesNotMatch(content, /providers:/);
});

test('recusa filtro arbitrário que não representa busca textual', () => {
  const analysis = analyzeAngularComponent('src/app/score/score.component.ts', `
import { Component } from '@angular/core';
@Component({ standalone: true, template: '' })
export class ScoreComponent {
  scores = [{ value: 10 }, { value: 20 }];
  query = '';
  get visible() {
    return this.scores.filter(score => score.value > Number(this.query));
  }
}
`);

  assert.equal(analysis, undefined);
});

test('integra o gerador estrutural antes da chamada ao AgentLoop', async () => {
  const extension = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'extension.ts'),
    'utf8'
  );
  const fastPathIndex = extension.indexOf('tryPrepareTestGenerationFastPath({');
  const agentIndex = extension.indexOf('s.engine.runAgent({');
  assert.ok(fastPathIndex >= 0);
  assert.ok(agentIndex > fastPathIndex);
});
