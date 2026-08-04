const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const {
  tryPrepareJavaUnitTestFastPath
} = require('../out/agent/JavaUnitTestFastPath');

async function createWorkspace({ existingTest } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-java-test-fastpath-'));
  const servicePath = 'billing-ejb/src/main/java/com/example/billing/service/OrderService.java';
  const files = {
    [servicePath]: `package com.example.billing.service;

import com.example.billing.model.Order;
import com.example.billing.repository.OrderRepository;
import java.util.List;

public class OrderService {
    private OrderRepository repository;

    public List<Order> listarTodos() {
        return repository.getOrders();
    }
}
`,
    'billing-ejb/src/main/java/com/example/billing/model/Order.java': `package com.example.billing.model;\npublic class Order {}\n`,
    'billing-ejb/src/main/java/com/example/billing/repository/OrderRepository.java': `package com.example.billing.repository;\nimport java.util.List;\nimport com.example.billing.model.Order;\npublic class OrderRepository { public List<Order> getOrders() { return null; } }\n`,
    'billing-ejb/pom.xml': `<?xml version="1.0"?>
<project>
    <dependencies>
        <dependency><groupId>jakarta.platform</groupId><artifactId>jakarta.jakartaee-api</artifactId></dependency>
    </dependencies>
</project>
`
  };
  if (existingTest !== undefined) {
    files['billing-ejb/src/test/java/com/example/billing/service/OrderServiceTest.java'] = existingTest;
  }

  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, content, 'utf8');
  }
  return { root, servicePath };
}

async function runFastPath(root, servicePath, priority = [servicePath]) {
  const calls = [];
  const logs = [];
  const result = await tryPrepareJavaUnitTestFastPath({
    request: 'Crie um teste unitário para o método listarTodos() deste service usando JUnit 4 e Mockito. O teste deve ser criado na pasta src/test/java.',
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

test('gera teste Java JUnit 4 com Mockito sem chamar o modelo', async t => {
  const { root, servicePath } = await createWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const { result, calls, logs } = await runFastPath(root, servicePath);

  assert.ok(result);
  assert.equal(calls.length, 2);
  const create = calls.find(call => call.name === 'create_file');
  const pomEdit = calls.find(call => call.name === 'apply_edit' && call.arguments.filePath === 'billing-ejb/pom.xml');
  assert.ok(create);
  assert.ok(pomEdit);
  assert.equal(create.arguments.filePath, 'billing-ejb/src/test/java/com/example/billing/service/OrderServiceTest.java');

  const content = create.arguments.content;
  assert.match(content, /import org\.junit\.Test;/);
  assert.match(content, /import org\.junit\.runner\.RunWith;/);
  assert.match(content, /@RunWith\(MockitoJUnitRunner\.class\)/);
  assert.match(content, /Arrays\.asList\(/);
  assert.match(content, /when\(repository\.getOrders\(\)\)\.thenReturn\(esperado\)/);
  assert.match(content, /verify\(repository\)\.getOrders\(\)/);
  assert.doesNotMatch(content, /org\.junit\.jupiter|BeforeEach|openMocks|List\.of|java\.lang\.String/);
  assert.doesNotMatch(content, /import com\.example\.billing\.service\.OrderService;/);
  assert.match(pomEdit.arguments.newText, /<groupId>junit<\/groupId>/);
  assert.match(pomEdit.arguments.newText, /<artifactId>mockito-core<\/artifactId>/);
  assert.ok(logs.some(message => /modelo não será chamado/.test(message)));
});

test('corrige teste Java existente com conteúdo inválido usando apply_edit', async t => {
  const wrong = '{"@class":"java.lang.String","content":"package errado;"}';
  const { root, servicePath } = await createWorkspace({ existingTest: wrong });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const { result, calls } = await runFastPath(root, servicePath);
  assert.ok(result);
  const testEdit = calls.find(call => call.name === 'apply_edit' && /OrderServiceTest\.java$/.test(call.arguments.filePath));
  assert.ok(testEdit);
  assert.equal(testEdit.arguments.oldText, wrong);
  assert.match(testEdit.arguments.newText, /org\.junit\.Test/);
  assert.doesNotMatch(testEdit.arguments.newText, /@class/);
});

test('não ativa para pedido JUnit 5', async t => {
  const { root, servicePath } = await createWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const result = await tryPrepareJavaUnitTestFastPath({
    request: 'Crie um teste unitário para o método listarTodos() usando JUnit 5 e Mockito.',
    workspaceRoot: root,
    priority: [servicePath],
    async execute(call) {
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 0 };
    }
  });
  assert.equal(result, undefined);
});


test('repete o pedido com pom.xml ativo sem chamar o modelo nem propor alterações', async t => {
  const { root, servicePath } = await createWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const first = await runFastPath(root, servicePath);
  const create = first.calls.find(call => call.name === 'create_file');
  const pomEdit = first.calls.find(call => call.name === 'apply_edit' && call.arguments.filePath === 'billing-ejb/pom.xml');
  assert.ok(create);
  assert.ok(pomEdit);

  const testAbsolute = path.join(root, create.arguments.filePath);
  await fsp.mkdir(path.dirname(testAbsolute), { recursive: true });
  await fsp.writeFile(testAbsolute, create.arguments.content, 'utf8');

  const pomAbsolute = path.join(root, 'billing-ejb/pom.xml');
  const pom = await fsp.readFile(pomAbsolute, 'utf8');
  await fsp.writeFile(
    pomAbsolute,
    pom.replace(pomEdit.arguments.oldText, pomEdit.arguments.newText),
    'utf8'
  );

  const repeated = await runFastPath(root, servicePath, ['billing-ejb/pom.xml']);
  assert.ok(repeated.result);
  assert.equal(repeated.calls.length, 0);
  assert.match(repeated.result.text, /já está atualizado/i);
  assert.ok(repeated.logs.some(message => /alterações=0/.test(message)));
  assert.ok(repeated.logs.some(message => /modelo não será chamado/.test(message)));
});

test('considera teste JUnit 4 semanticamente equivalente mesmo com CRLF', async t => {
  const { root, servicePath } = await createWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const first = await runFastPath(root, servicePath);
  const create = first.calls.find(call => call.name === 'create_file');
  assert.ok(create);
  const testAbsolute = path.join(root, create.arguments.filePath);
  await fsp.mkdir(path.dirname(testAbsolute), { recursive: true });
  await fsp.writeFile(testAbsolute, create.arguments.content.replace(/\n/g, '\r\n'), 'utf8');

  const repeated = await runFastPath(root, servicePath);
  const testChanges = repeated.calls.filter(call => /OrderServiceTest\.java$/.test(call.arguments.filePath));
  assert.equal(testChanges.length, 0);
});

test('bloqueia fallback do modelo quando o service está ambíguo', async t => {
  const { root } = await createWorkspace();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const secondService = path.join(root, 'billing-ejb/src/main/java/com/example/billing/service/CustomerService.java');
  await fsp.mkdir(path.dirname(secondService), { recursive: true });
  await fsp.writeFile(secondService, `package com.example.billing.service;
import com.example.billing.model.Order;
import com.example.billing.repository.OrderRepository;
import java.util.List;
public class CustomerService {
    private OrderRepository repository;
    public List<Order> listarTodos() { return repository.getOrders(); }
}
`, 'utf8');

  const calls = [];
  const logs = [];
  const result = await tryPrepareJavaUnitTestFastPath({
    request: 'Crie um teste unitário para o método listarTodos() deste service usando JUnit 4 e Mockito. O teste deve ser criado na pasta src/test/java.',
    workspaceRoot: root,
    priority: ['billing-ejb/pom.xml'],
    info(message) { logs.push(message); },
    warn(message) { logs.push(message); },
    async execute(call) {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 0 };
    }
  });

  assert.ok(result);
  assert.equal(calls.length, 0);
  assert.match(result.text, /Nenhuma alteração foi preparada/);
  assert.ok(logs.some(message => /modelo não será chamado/.test(message)));
});
