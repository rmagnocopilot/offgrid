const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const {
  analyzeFrontendCrudIntent,
  isFrontendCrudIntent
} = require('../out/agent/FrontendCrudIntent');
const {
  tryPrepareFrontendCrudFastPath
} = require('../out/agent/FrontendCrudFastPath');
const { interpretLayeredTask } = require('../out/agent/LayeredTaskIntent');
const { isBackendEndpointIntent } = require('../out/agent/BackendEndpointIntent');

const REQUEST = 'Faça o formulário de Order editar pelo endpoint PUT quando o Order tiver id e continuar cadastrando com POST quando não tiver.';

async function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, content, 'utf8');
}

async function createWorkspace({ existingUpdate = false, componentAlreadyBranches = false, includeDelete = true } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-frontend-crud-'));
  await write(root, 'client/src/app/models/order.model.ts', `export interface Order {
  id?: number;
  name: string;
}
`);
  await write(root, 'client/src/app/services/order.service.ts', `import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Order } from '../models/order.model';
@Injectable({ providedIn: 'root' })
export class OrderService {
  private apiUrl = '/api/orders';
  constructor(private http: HttpClient) {}
  list(): Observable<Order[]> { return this.http.get<Order[]>(this.apiUrl); }
  save(order: Order): Observable<Order> { return this.http.post<Order>(this.apiUrl, order); }
  ${includeDelete ? `delete(id: number): Observable<void> { return this.http.delete<void>(\`${'${this.apiUrl}'}/${'${id}'}\`); }` : ''}
  ${existingUpdate ? `edit(id: number, order: Order): Observable<Order> { return this.http.put<Order>(\`${'${this.apiUrl}'}/${'${id}'}\`, order); }` : ''}
}
`);
  await write(root, 'client/src/app/components/order/order-list.component.ts', `import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Order } from '../../models/order.model';
import { OrderService } from '../../services/order.service';
@Component({
  selector: 'app-order-list',
  standalone: true,
  imports: [FormsModule],
  template: \`<form><input [(ngModel)]="order.name"><button (click)="saveOrder()">Save</button></form>\`
})
export class OrderListComponent {
  order: Order = { name: '' };
  constructor(private service: OrderService) {}
  saveOrder(): void {
    ${componentAlreadyBranches
      ? `(this.order.id != null ? this.service.edit(this.order.id, this.order) : this.service.save(this.order)).subscribe();`
      : `this.service.save(this.order).subscribe();`}
  }
  editOrder(order: Order): void { this.order = { ...order }; }
}
`);
  await write(root, 'client/src/app/components/order-summary/order-summary.component.ts', `import { Component } from '@angular/core';
import { OrderService } from '../../services/order.service';
@Component({ selector: 'app-order-summary', standalone: true, templateUrl: './order-summary.component.html' })
export class OrderSummaryComponent { constructor(private service: OrderService) {} }
`);
  await write(root, 'client/src/app/components/order-summary/order-summary.component.html', `<h2>Order summary</h2>`);
  return root;
}

test('interpreta formulário como alvo frontend e endpoint como referência', () => {
  const intent = interpretLayeredTask(REQUEST);
  assert.equal(intent.targetLayer, 'component');
  assert.deepEqual(intent.referenceLayers, ['endpoint']);
  assert.equal(intent.operation, 'update');
  assert.deepEqual(intent.entityTerms, ['order']);
  assert.equal(isFrontendCrudIntent(REQUEST), true);
  assert.equal(isBackendEndpointIntent(REQUEST), false);
});

test('arquivo ativo sem formulário não substitui o componente estrutural correto', async () => {
  const root = await createWorkspace();
  const analysis = await analyzeFrontendCrudIntent({
    request: REQUEST,
    workspaceRoot: root,
    priority: ['client/src/app/components/order-summary/order-summary.component.html']
  });
  assert.ok(analysis);
  assert.equal(analysis.componentFile, 'client/src/app/components/order/order-list.component.ts');
  assert.equal(analysis.serviceFile, 'client/src/app/services/order.service.ts');
  assert.equal(analysis.modelFile, 'client/src/app/models/order.model.ts');
  assert.equal(analysis.entityType, 'Order');
  assert.equal(analysis.priority[0], 'client/src/app/components/order/order-list.component.ts');
});

test('adiciona PUT no service.ts e condiciona o formulário pelo id', async () => {
  const root = await createWorkspace();
  const analysis = await analyzeFrontendCrudIntent({ request: REQUEST, workspaceRoot: root });
  const calls = [];
  const result = await tryPrepareFrontendCrudFastPath({
    request: REQUEST,
    workspaceRoot: root,
    analysis,
    execute: async call => {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 1 };
    }
  });

  assert.ok(result);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'apply_edit');
  assert.equal(calls[0].arguments.filePath, 'client/src/app/services/order.service.ts');
  assert.match(calls[0].arguments.newText, /editar\(id: number, order: Order\): Observable<Order>/);
  assert.match(calls[0].arguments.newText, /this\.http\.put<Order>\(`\$\{this\.apiUrl\}\/\$\{id\}`, order\)/);
  assert.equal(calls[1].arguments.filePath, 'client/src/app/components/order/order-list.component.ts');
  assert.match(calls[1].arguments.newText, /this\.order\.id != null/);
  assert.match(calls[1].arguments.newText, /this\.service\.editar\(this\.order\.id, this\.order\)/);
  assert.match(calls[1].arguments.newText, /this\.service\.save\(this\.order\)/);
  assert.match(result.text, /PUT quando houver id/);
  assert.doesNotMatch(calls[0].arguments.newText, /Resource|Controller|@PUT/);
});

test('reutiliza método PUT existente sem duplicá-lo', async () => {
  const root = await createWorkspace({ existingUpdate: true });
  const request = REQUEST.replace('editar', 'edit');
  const analysis = await analyzeFrontendCrudIntent({ request, workspaceRoot: root });
  const calls = [];
  const result = await tryPrepareFrontendCrudFastPath({
    request,
    workspaceRoot: root,
    analysis,
    execute: async call => {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 1 };
    }
  });

  assert.ok(result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.filePath, 'client/src/app/components/order/order-list.component.ts');
  assert.match(calls[0].arguments.newText, /service\.edit\(this\.order\.id, this\.order\)/);
});

test('não altera arquivos quando o service e o formulário já implementam o fluxo', async () => {
  const root = await createWorkspace({ existingUpdate: true, componentAlreadyBranches: true });
  const request = REQUEST.replace('editar', 'edit');
  const analysis = await analyzeFrontendCrudIntent({ request, workspaceRoot: root });
  let called = false;
  const result = await tryPrepareFrontendCrudFastPath({
    request,
    workspaceRoot: root,
    analysis,
    execute: async () => {
      called = true;
      throw new Error('não deveria executar');
    }
  });

  assert.ok(result);
  assert.equal(called, false);
  assert.match(result.text, /Nenhuma alteração foi necessária/);
});

test('não inventa URL PUT quando não existe padrão de rota por id', async () => {
  const root = await createWorkspace({ includeDelete: false });
  const analysis = await analyzeFrontendCrudIntent({ request: REQUEST, workspaceRoot: root });
  const result = await tryPrepareFrontendCrudFastPath({
    request: REQUEST,
    workspaceRoot: root,
    analysis,
    execute: async () => { throw new Error('não deveria executar'); }
  });
  assert.equal(result, undefined);
});

test('implementação do fluxo frontend é genérica', async () => {
  for (const file of ['src/agent/FrontendCrudIntent.ts', 'src/agent/FrontendCrudFastPath.ts']) {
    const implementation = await fsp.readFile(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(implementation, /ClienteResource|ClienteService|locadora|cliente-vip|OrderService|OrderList/i);
  }
});

test('extension prioriza FrontendCrud antes das políticas de backend', async () => {
  const extension = await fsp.readFile(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const frontendAnalysis = extension.indexOf('analyzeFrontendCrudIntent({');
  const serviceAnalysis = extension.indexOf('analyzeBackendServiceIntent({');
  const endpointAnalysis = extension.indexOf('analyzeBackendEndpointIntent({');
  const frontendFastPath = extension.indexOf('tryPrepareFrontendCrudFastPath({');
  const serviceFastPath = extension.indexOf('tryPrepareBackendServiceFastPath({');
  assert.ok(frontendAnalysis >= 0 && frontendAnalysis < serviceAnalysis && serviceAnalysis < endpointAnalysis);
  assert.ok(frontendFastPath >= 0 && frontendFastPath < serviceFastPath);
  assert.match(extension, /backendEndpointAnalysis = mode === 'agent' && !frontendCrudAnalysis && !backendServiceAnalysis/);
  assert.match(extension, /frontendCrudTaskGuidance\(prompt\) \?\? serviceTaskGuidance\(prompt\)/);
});
