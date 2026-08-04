const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const {
  analyzeBackendEndpointIntent,
  endpointTaskGuidance,
  existingEndpointResponse,
  isBackendEndpointIntent,
  requestedHttpVerb
} = require('../out/agent/BackendEndpointIntent');

async function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, content, 'utf8');
}

async function javaWorkspace({ existingPost = true, spring = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-endpoint-'));
  await write(root, 'frontend/src/app/order-list.component.ts', 'export class OrderListComponent {}\n');

  if (spring) {
    await write(root, 'server/src/main/java/example/web/OrderController.java', `package example.web;
import example.model.Order;
import example.service.OrderService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/orders")
public class OrderController {
  private final OrderService service;
  public OrderController(OrderService service) { this.service = service; }
${existingPost ? `
  @PostMapping
  public Order save(@RequestBody Order order) {
    return service.save(order);
  }
` : ''}}
`);
  } else {
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
${existingPost ? `
  @POST
  public Response save(Order order) {
    return Response.ok(service.save(order)).build();
  }
` : ''}}
`);
  }

  await write(root, 'server-core/src/main/java/example/service/OrderService.java', `package example.service;
import example.model.Order;
public class OrderService {
  public Order save(Order order) { return order; }
}
`);
  await write(root, 'server-core/src/main/java/example/model/Order.java', `package example.model;
public class Order { }
`);
  await write(root, 'server-web/src/main/java/example/rest/ProductResource.java', `package example.rest;
import jakarta.ws.rs.*;
@Path("/products")
public class ProductResource {
  @GET
  public String list() { return "ok"; }
}
`);
  return root;
}

test('detecta intenção de endpoint e verbo HTTP pelo pedido curto', () => {
  const request = 'Crie no backend Java um endpoint para cadastrar Order seguindo o padrão existente.';
  assert.equal(isBackendEndpointIntent(request), true);
  assert.equal(requestedHttpVerb(request), 'POST');
  assert.match(endpointTaskGuidance(request), /Service ou Repository não cria endpoint/);
});

test('prioriza Resource, Service, modelo e padrão do backend antes do arquivo frontend ativo', async () => {
  const root = await javaWorkspace({ existingPost: false });
  const analysis = await analyzeBackendEndpointIntent({
    request: 'Crie no backend Java um endpoint para cadastrar Order seguindo o padrão existente.',
    workspaceRoot: root,
    priority: ['frontend/src/app/order-list.component.ts']
  });

  assert.ok(analysis);
  assert.equal(analysis.requestedVerb, 'POST');
  assert.equal(analysis.priority[0], 'server-web/src/main/java/example/rest/OrderResource.java');
  assert.equal(analysis.priority[1], 'server-core/src/main/java/example/service/OrderService.java');
  assert.equal(analysis.priority[2], 'server-core/src/main/java/example/model/Order.java');
  assert.ok(analysis.priority.indexOf('frontend/src/app/order-list.component.ts') > 2);
  assert.equal(analysis.existingEndpoint, undefined);
});

test('reconhece endpoint JAX-RS POST equivalente e evita rota duplicada', async () => {
  const root = await javaWorkspace({ existingPost: true });
  const analysis = await analyzeBackendEndpointIntent({
    request: 'Crie um endpoint para cadastrar Order.',
    workspaceRoot: root,
    priority: ['frontend/src/app/order-list.component.ts']
  });

  assert.deepEqual(analysis.existingEndpoint, {
    filePath: 'server-web/src/main/java/example/rest/OrderResource.java',
    methodName: 'save',
    verb: 'POST',
    framework: 'jax-rs'
  });
  assert.match(existingEndpointResponse(analysis.existingEndpoint), /Nenhuma alteração foi necessária/);
});

test('reconhece endpoint Spring PostMapping equivalente', async () => {
  const root = await javaWorkspace({ existingPost: true, spring: true });
  const analysis = await analyzeBackendEndpointIntent({
    request: 'Adicione uma rota para cadastrar Order no backend Spring.',
    workspaceRoot: root
  });

  assert.deepEqual(analysis.existingEndpoint, {
    filePath: 'server/src/main/java/example/web/OrderController.java',
    methodName: 'save',
    verb: 'POST',
    framework: 'spring'
  });
});

test('implementação da política não contém nomes do projeto usado no teste funcional', async () => {
  const implementation = await fsp.readFile(
    path.join(__dirname, '..', 'src', 'agent', 'BackendEndpointIntent.ts'),
    'utf8'
  );
  assert.doesNotMatch(implementation, /ClienteResource|ClienteService|locadora|cliente-vip/i);
});

test('extension usa prioridade descoberta e encerra quando endpoint equivalente existe', async () => {
  const extension = await fsp.readFile(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  assert.match(extension, /analyzeBackendEndpointIntent/);
  assert.match(extension, /backendEndpointAnalysis\?\.existingEndpoint/);
  assert.match(extension, /existingEndpointResponse/);
  assert.match(extension, /priorityOverride/);
});
