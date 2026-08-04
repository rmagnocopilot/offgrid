const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const {
  analyzeBackendServiceIntent,
  isBackendServiceIntent,
  serviceTaskGuidance
} = require('../out/agent/BackendServiceIntent');
const {
  isBackendEndpointIntent
} = require('../out/agent/BackendEndpointIntent');
const {
  tryPrepareBackendServiceFastPath
} = require('../out/agent/BackendServiceFastPath');

async function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, content, 'utf8');
}

async function createWorkspace({ equivalentService = false, secondUpdate = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-service-fastpath-'));
  await write(root, 'server-web/src/main/java/example/rest/OrderResource.java', `package example.rest;

import example.model.Order;
import example.service.OrderService;
import jakarta.inject.Inject;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;

@Path("/orders")
public class OrderResource {
    @Inject
    private OrderService service;

    @PUT
    @Path("/{id}")
    public Response editar(@PathParam("id") Long id, Order order) {
        ${equivalentService ? '' : 'order.setId(id);'}
        return Response.ok(service.${equivalentService ? 'editar(id, order)' : 'save(order)'}).build();
    }
}
`);
  await write(root, 'server-core/src/main/java/example/service/OrderService.java', `package example.service;
import example.model.Order;
public class OrderService {
    public Order save(Order order) { return order; }
    ${equivalentService ? 'public Order editar(Long id, Order order) { order.setId(id); return save(order); }' : ''}
}
`);
  await write(root, 'server-core/src/main/java/example/model/Order.java', `package example.model;
public class Order {
    private Long id;
    public void setId(Long id) { this.id = id; }
}
`);
  await write(root, 'server-web/src/main/java/example/rest/VehicleResource.java', `package example.rest;
import example.model.Vehicle;
import example.service.VehicleService;
import jakarta.inject.Inject;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;
@Path("/vehicles")
public class VehicleResource {
    @Inject private VehicleService service;
    ${secondUpdate ? '@PUT @Path("/{id}") public Response editar(@PathParam("id") Long id, Vehicle vehicle) { vehicle.setId(id); return Response.ok(service.save(vehicle)).build(); }' : '@GET public Response list() { return Response.ok().build(); }'}
}
`);
  await write(root, 'server-core/src/main/java/example/service/VehicleService.java', `package example.service;
import example.model.Vehicle;
public class VehicleService { public Vehicle save(Vehicle vehicle) { return vehicle; } }
`);
  await write(root, 'server-core/src/main/java/example/model/Vehicle.java', `package example.model;
public class Vehicle { public void setId(Long id) { } }
`);
  return root;
}

async function analyze(root, priority = []) {
  return analyzeBackendServiceIntent({
    request: 'Para o endpoint editar criado, crie o service equivalente.',
    workspaceRoot: root,
    priority
  });
}

test('classifica criação de Service como Service mesmo quando o texto menciona endpoint', () => {
  const request = 'Para o endpoint editar criado, crie o service equivalente.';
  assert.equal(isBackendServiceIntent(request), true);
  assert.equal(isBackendEndpointIntent(request), false);
  assert.match(serviceTaskGuidance(request), /Não crie outro endpoint/);
});

test('mantém pedido de criação de endpoint na política de endpoint', () => {
  const request = 'Crie um endpoint para editar Order usando o OrderService.';
  assert.equal(isBackendServiceIntent(request), false);
  assert.equal(isBackendEndpointIntent(request), true);
});

test('encontra o único endpoint PUT criado mesmo com outro Resource na prioridade', async () => {
  const root = await createWorkspace();
  const analysis = await analyze(root, ['server-web/src/main/java/example/rest/VehicleResource.java']);

  assert.ok(analysis);
  assert.equal(analysis.resourceFile, 'server-web/src/main/java/example/rest/OrderResource.java');
  assert.equal(analysis.serviceFile, 'server-core/src/main/java/example/service/OrderService.java');
  assert.equal(analysis.endpointMethod, 'editar');
  assert.equal(analysis.entityType, 'Order');
  assert.equal(analysis.priority[0], 'server-web/src/main/java/example/rest/OrderResource.java');
});

test('adiciona método equivalente no Service e atualiza a chamada do endpoint', async () => {
  const root = await createWorkspace();
  const analysis = await analyze(root);
  const calls = [];
  const result = await tryPrepareBackendServiceFastPath({
    request: 'Para o endpoint editar criado, crie o service equivalente.',
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
  assert.equal(calls[0].arguments.filePath, 'server-core/src/main/java/example/service/OrderService.java');
  assert.match(calls[0].arguments.newText, /public Order editar\(Long id, Order order\)/);
  assert.match(calls[0].arguments.newText, /order\.setId\(id\);/);
  assert.match(calls[0].arguments.newText, /return save\(order\);/);
  assert.equal(calls[1].arguments.filePath, 'server-web/src/main/java/example/rest/OrderResource.java');
  assert.match(calls[1].arguments.newText, /service\.editar\(id, order\)/);
  assert.doesNotMatch(calls[1].arguments.newText, /order\.setId\(id\);/);
  assert.match(result.text, /Service equivalente preparado para revisão/);
});

test('não gera alteração quando Service equivalente já existe e já é usado', async () => {
  const root = await createWorkspace({ equivalentService: true });
  const analysis = await analyze(root);
  let called = false;
  const result = await tryPrepareBackendServiceFastPath({
    request: 'Para o endpoint editar criado, crie o service equivalente.',
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

test('não escolhe Resource arbitrário quando existem múltiplos endpoints de atualização sem alvo', async () => {
  const root = await createWorkspace({ secondUpdate: true });
  const analysis = await analyze(root, []);
  assert.ok(analysis);
  assert.equal(analysis.resourceFile, undefined);
  assert.equal(analysis.serviceFile, undefined);
});

test('implementação do Service FastPath é genérica', async () => {
  const files = [
    'src/agent/BackendServiceIntent.ts',
    'src/agent/BackendServiceFastPath.ts'
  ];
  for (const file of files) {
    const implementation = await fsp.readFile(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(implementation, /ClienteResource|ClienteService|locadora|cliente-vip/i);
  }
});

test('extension executa Service FastPath antes do Endpoint FastPath', async () => {
  const extension = await fsp.readFile(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const serviceIndex = extension.indexOf('tryPrepareBackendServiceFastPath({');
  const endpointIndex = extension.indexOf('tryPrepareBackendEndpointFastPath({');
  assert.ok(serviceIndex >= 0 && endpointIndex >= 0 && serviceIndex < endpointIndex);
  assert.match(extension, /backendEndpointAnalysis = mode === 'agent' && !frontendCrudAnalysis && !backendServiceAnalysis/);
  assert.match(extension, /serviceTaskGuidance\(prompt\) \?\? endpointTaskGuidance\(prompt\)/);
});

async function createAngularServiceWorkspace({ existingUpdate = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-ts-service-fastpath-'));
  await write(root, 'server-web/src/main/java/example/rest/OrderResource.java', `package example.rest;
import example.model.Order;
import example.service.OrderService;
import jakarta.inject.Inject;
import jakarta.ws.rs.*;
import jakarta.ws.rs.core.Response;
@Path("/orders")
public class OrderResource {
    @Inject private OrderService service;
    @PUT
    @Path("/{id}")
    public Response editar(@PathParam("id") Long id, Order order) {
        order.setId(id);
        return Response.ok(service.save(order)).build();
    }
}
`);
  await write(root, 'server-core/src/main/java/example/service/OrderService.java', `package example.service;
import example.model.Order;
public class OrderService { public Order save(Order order) { return order; } }
`);
  await write(root, 'server-core/src/main/java/example/model/Order.java', `package example.model;
public class Order { public void setId(Long id) { } }
`);
  await write(root, 'client/src/app/models/order.model.ts', `export interface Order { id?: number; name: string; }
`);
  await write(root, 'client/src/app/services/order.service.ts', `import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Order } from '../models/order.model';
@Injectable({ providedIn: 'root' })
export class OrderService {
  private apiUrl = 'http://localhost:8080/api/orders';
  constructor(private http: HttpClient) {}
  save(order: Order): Observable<Order> { return this.http.post<Order>(this.apiUrl, order); }
  delete(id: number): Observable<void> { return this.http.delete<void>(\`${'${this.apiUrl}'}/${'${id}'}\`); }
  ${existingUpdate ? `editar(id: number, order: Order): Observable<Order> { return this.http.put<Order>(\`${'${this.apiUrl}'}/${'${id}'}\`, order); }` : ''}
}
`);
  await write(root, 'client/src/app/services/vehicle.service.ts', `import { Injectable } from '@angular/core';
@Injectable({ providedIn: 'root' })
export class VehicleService {}
`);
  return root;
}

test('service.ts explícito usa endpoint Java apenas como referência', async () => {
  const root = await createAngularServiceWorkspace();
  const request = 'Para o endpoint editar criado, adicione o método equivalente em order.service.ts.';
  const analysis = await analyzeBackendServiceIntent({
    request,
    workspaceRoot: root,
    priority: ['client/src/app/services/vehicle.service.ts']
  });

  assert.ok(analysis);
  assert.equal(analysis.language, 'typescript');
  assert.equal(analysis.resourceFile, 'server-web/src/main/java/example/rest/OrderResource.java');
  assert.equal(analysis.serviceFile, 'client/src/app/services/order.service.ts');
  assert.equal(analysis.entityType, 'Order');
  assert.equal(analysis.framework, 'angular-http');
});

test('adiciona método Angular HttpClient com PUT sem alterar o endpoint', async () => {
  const root = await createAngularServiceWorkspace();
  const request = 'Para o endpoint editar criado, adicione o método equivalente em order.service.ts.';
  const analysis = await analyzeBackendServiceIntent({ request, workspaceRoot: root });
  const calls = [];
  const result = await tryPrepareBackendServiceFastPath({
    request,
    workspaceRoot: root,
    analysis,
    execute: async call => {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 1 };
    }
  });

  assert.ok(result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'apply_edit');
  assert.equal(calls[0].arguments.filePath, 'client/src/app/services/order.service.ts');
  assert.match(calls[0].arguments.newText, /editar\(id: number, order: Order\): Observable<Order>/);
  assert.match(calls[0].arguments.newText, /this\.http\.put<Order>\(`\$\{this\.apiUrl\}\/\$\{id\}`, order\)/);
  assert.doesNotMatch(result.text, /Endpoint atualizado/);
  assert.match(result.text, /endpoint foi usado apenas como referência/i);
});

test('não duplica método existente em service.ts', async () => {
  const root = await createAngularServiceWorkspace({ existingUpdate: true });
  const request = 'Para o endpoint editar criado, adicione o método equivalente em order.service.ts.';
  const analysis = await analyzeBackendServiceIntent({ request, workspaceRoot: root });
  let called = false;
  const result = await tryPrepareBackendServiceFastPath({
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

test('Service TypeScript sem padrão estrutural comprovado não inventa implementação', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-nest-service-'));
  await write(root, 'server/src/orders/orders.controller.ts', `import { Controller, Put } from '@nestjs/common';
@Controller('orders')
export class OrdersController { @Put(':id') editar() {} }
`);
  await write(root, 'server/src/orders/orders.service.ts', `import { Injectable } from '@nestjs/common';
@Injectable()
export class OrdersService {}
`);
  const request = 'Baseado no endpoint editar, crie o service equivalente em orders.service.ts.';
  const analysis = await analyzeBackendServiceIntent({ request, workspaceRoot: root });
  const result = await tryPrepareBackendServiceFastPath({
    request,
    workspaceRoot: root,
    analysis,
    execute: async () => { throw new Error('não deveria executar'); }
  });

  assert.ok(analysis);
  assert.equal(analysis.language, 'typescript');
  assert.equal(analysis.serviceFile, 'server/src/orders/orders.service.ts');
  assert.equal(result, undefined);
});

test('extension prioriza catálogos de Service/Endpoint sobre criação genérica', async () => {
  const extension = await fsp.readFile(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const frontendBranch = extension.indexOf('const schemas = frontendCrudAnalysis');
  const serviceBranch = extension.indexOf(': backendServiceAnalysis', frontendBranch);
  const endpointBranch = extension.indexOf(': backendEndpointAnalysis', serviceBranch);
  const genericBranch = extension.indexOf(': genericFileCreationTask', endpointBranch);
  assert.ok(frontendBranch >= 0 && serviceBranch > frontendBranch && endpointBranch > serviceBranch && genericBranch > endpointBranch);
  assert.match(extension, /const genericFileCreationTask = fileCreationTask && !frontendCrudAnalysis && !backendServiceAnalysis && !backendEndpointAnalysis/);
  assert.match(extension, /\[TaskIntent\] Pedido interpretado/);
});
