const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const {
  analyzeBackendEndpointIntent
} = require('../out/agent/BackendEndpointIntent');
const {
  tryPrepareBackendEndpointFastPath
} = require('../out/agent/BackendEndpointFastPath');

async function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, content, 'utf8');
}

async function createJaxRsWorkspace({ withSetter = true, withUpdate = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-endpoint-fastpath-jax-'));
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

    @POST
    public Response save(Order order) {
        return Response.ok(service.save(order)).build();
    }

    @DELETE
    @Path("/{id}")
    public Response delete(@PathParam("id") Long id) {
        service.delete(id);
        return Response.noContent().build();
    }
}
`);
  await write(root, 'server-core/src/main/java/example/service/OrderService.java', `package example.service;
import example.model.Order;
public class OrderService {
    public Order save(Order order) { return order; }
    ${withUpdate ? 'public Order update(Long id, Order order) { return order; }' : ''}
    public void delete(Long id) { }
}
`);
  await write(root, 'server-core/src/main/java/example/model/Order.java', `package example.model;
public class Order {
    private Long id;
    ${withSetter ? 'public void setId(Long id) { this.id = id; }' : ''}
}
`);
  return root;
}

async function createSpringWorkspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-endpoint-fastpath-spring-'));
  await write(root, 'server/src/main/java/example/web/OrderController.java', `package example.web;

import example.model.Order;
import example.service.OrderService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/orders")
public class OrderController {
    private final OrderService service;

    public OrderController(OrderService service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<Order> save(@RequestBody Order order) {
        return ResponseEntity.ok(service.save(order));
    }
}
`);
  await write(root, 'server/src/main/java/example/service/OrderService.java', `package example.service;
import example.model.Order;
public class OrderService {
    public Order save(Order order) { return order; }
}
`);
  await write(root, 'server/src/main/java/example/model/Order.java', `package example.model;
public class Order {
    private Long id;
    public void setId(Long id) { this.id = id; }
}
`);
  return root;
}

async function prepare(root, request) {
  const analysis = await analyzeBackendEndpointIntent({
    request,
    workspaceRoot: root
  });
  assert.ok(analysis);

  let captured;
  const result = await tryPrepareBackendEndpointFastPath({
    request,
    workspaceRoot: root,
    analysis,
    execute: async call => {
      captured = call;
      return {
        callId: call.id,
        name: call.name,
        ok: true,
        content: { staged: true },
        durationMs: 1
      };
    }
  });
  return { analysis, captured, result };
}

test('cria endpoint JAX-RS PUT com apply_edit e reutiliza service injetado', async () => {
  const root = await createJaxRsWorkspace();
  const { captured, result } = await prepare(
    root,
    'Crie um endpoint para editar Order, seguindo o padrão existente do backend.'
  );

  assert.ok(result);
  assert.equal(captured.name, 'apply_edit');
  assert.equal(captured.arguments.filePath, 'server-web/src/main/java/example/rest/OrderResource.java');
  const generated = captured.arguments.newText;
  assert.match(generated, /@PUT\s+@Path\("\/\{id\}"\)/s);
  assert.match(generated, /public Response editar\(@PathParam\("id"\) Long id, Order order\)/);
  assert.match(generated, /order\.setId\(id\);/);
  assert.match(generated, /Response\.ok\(service\.save\(order\)\)\.build\(\)/);
  assert.doesNotMatch(generated, /new OrderService\(/);
  assert.doesNotMatch(generated, /@GET|@DELETE[\s\S]*@DELETE/);
  assert.match(result.text, /Endpoint preparado para revisão/);
});

test('prefere método de atualização existente no Service e não exige setter', async () => {
  const root = await createJaxRsWorkspace({ withSetter: false, withUpdate: true });
  const { captured, result } = await prepare(
    root,
    'Adicione uma rota para atualizar Order no backend Java.'
  );

  assert.ok(result);
  const generated = captured.arguments.newText;
  assert.match(generated, /service\.update\(id, order\)/);
  assert.doesNotMatch(generated, /order\.setId\(id\)/);
});

test('não aplica FastPath quando não há método de atualização nem setter comprovado', async () => {
  const root = await createJaxRsWorkspace({ withSetter: false, withUpdate: false });
  const request = 'Crie um endpoint para editar Order seguindo o padrão existente.';
  const analysis = await analyzeBackendEndpointIntent({ request, workspaceRoot: root });
  assert.ok(analysis);

  let called = false;
  const result = await tryPrepareBackendEndpointFastPath({
    request,
    workspaceRoot: root,
    analysis,
    execute: async () => {
      called = true;
      throw new Error('não deveria executar');
    }
  });

  assert.equal(result, undefined);
  assert.equal(called, false);
});

test('cria endpoint Spring PUT seguindo o framework já detectado', async () => {
  const root = await createSpringWorkspace();
  const { captured, result } = await prepare(
    root,
    'Crie um endpoint para editar Order seguindo o padrão existente do backend.'
  );

  assert.ok(result);
  const generated = captured.arguments.newText;
  assert.match(generated, /@PutMapping\("\/\{id\}"\)/);
  assert.match(generated, /ResponseEntity<Order> editar\(@PathVariable Long id, @RequestBody Order order\)/);
  assert.match(generated, /order\.setId\(id\);/);
  assert.match(generated, /ResponseEntity\.ok\(service\.save\(order\)\)/);
  assert.doesNotMatch(generated, /jakarta\.ws\.rs|javax\.ws\.rs/);
});

test('implementação é genérica e não contém nomes do projeto funcional', async () => {
  const implementation = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'agent', 'BackendEndpointFastPath.ts'),
    'utf8'
  );
  assert.doesNotMatch(implementation, /ClienteResource|ClienteService|locadora|cliente-vip/i);
});

test('extension executa o FastPath antes dos demais caminhos e remove create_file quando Resource existe', async () => {
  const extension = await fsp.readFile(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const backendIndex = extension.indexOf('tryPrepareBackendEndpointFastPath({');
  const testIndex = extension.indexOf('tryPrepareTestGenerationFastPath({');
  assert.ok(backendIndex >= 0 && testIndex >= 0 && backendIndex < testIndex);
  assert.match(extension, /if \(!backendEndpointAnalysis\?\.resourceFile\) backendEndpointTools\.add\('create_file'\)/);
});
