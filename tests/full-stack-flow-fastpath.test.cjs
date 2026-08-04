const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const {
  analyzeFullStackFlowIntent,
  isFullStackFlowIntent,
  fullStackFlowTaskGuidance
} = require('../out/agent/FullStackFlowIntent');
const { tryPrepareFullStackFlowFastPath } = require('../out/agent/FullStackFlowFastPath');

const REQUEST = 'Crie um fluxo completo para listar reservations, com componente Angular separado em HTML, TS e SCSS, integração pelo service.ts, endpoint GET e service Java, seguindo o padrão existente do projeto.';

async function write(root, relative, content) {
  const absolute = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(absolute), { recursive: true });
  await fsp.writeFile(absolute, content, 'utf8');
}

async function createWorkspace({ includeDataAccess = true, existingLayers = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-full-stack-'));
  await write(root, 'client/package.json', JSON.stringify({ dependencies: { '@angular/core': '^19.0.0' } }));
  await write(root, 'client/src/app/models/product.model.ts', 'export interface Product { id?: number; name: string; }\n');
  await write(root, 'client/src/app/services/product.service.ts', `import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Product } from '../models/product.model';
@Injectable({ providedIn: 'root' })
export class ProductService {
  private apiUrl = 'http://localhost:8080/api/products';
  constructor(private http: HttpClient) {}
  list(): Observable<Product[]> { return this.http.get<Product[]>(this.apiUrl); }
}
`);
  await write(root, 'client/src/app/components/product/product-list.component.ts', `import { Component } from '@angular/core';
@Component({
  selector: 'app-product-list',
  standalone: true,
  templateUrl: './product-list.component.html',
  styleUrls: ['./product-list.component.scss']
})
export class ProductListComponent {}
`);
  await write(root, 'client/src/app/components/product/product-list.component.html', '<p>products</p>\n');
  await write(root, 'client/src/app/components/product/product-list.component.scss', '.page {}\n');

  await write(root, 'server-core/src/main/java/example/model/Reservation.java', `package example.model;
public class Reservation {
    private Long id;
    private String guestName;
    private String startDate;
}
`);
  if (includeDataAccess) {
    await write(root, 'server-core/src/main/java/example/repository/ReservationRepository.java', `package example.repository;
import example.model.Reservation;
import java.util.List;
public class ReservationRepository {
    public List<Reservation> findAll() { return List.of(); }
}
`);
  }
  await write(root, 'server-core/src/main/java/example/model/Product.java', `package example.model;
public class Product { private Long id; private String name; }
`);
  await write(root, 'server-core/src/main/java/example/repository/ProductRepository.java', `package example.repository;
import example.model.Product;
import java.util.List;
public class ProductRepository { public List<Product> findAll() { return List.of(); } }
`);
  await write(root, 'server-core/src/main/java/example/service/ProductService.java', `package example.service;
import example.model.Product;
import example.repository.ProductRepository;
import jakarta.ejb.Stateless;
import jakarta.inject.Inject;
import java.util.List;
@Stateless
public class ProductService {
    @Inject private ProductRepository repository;
    public List<Product> list() { return repository.findAll(); }
}
`);
  await write(root, 'server-web/src/main/java/example/rest/ProductResource.java', `package example.rest;
import example.model.Product;
import example.service.ProductService;
import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import java.util.List;
@Path("/products")
public class ProductResource {
    @Inject private ProductService service;
    @GET public List<Product> list() { return service.list(); }
}
`);

  if (existingLayers) {
    await write(root, 'client/src/app/models/reservation.model.ts', `export interface Reservation { id?: number; guestName: string; startDate: string; }\n`);
    await write(root, 'client/src/app/services/reservation.service.ts', `import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Reservation } from '../models/reservation.model';
@Injectable({ providedIn: 'root' })
export class ReservationService {
  private apiUrl = 'http://localhost:8080/api/reservations';
  constructor(private http: HttpClient) {}
  list(): Observable<Reservation[]> { return this.http.get<Reservation[]>(this.apiUrl); }
}
`);
    await write(root, 'server-core/src/main/java/example/service/ReservationService.java', `package example.service;
import example.model.Reservation;
import example.repository.ReservationRepository;
import jakarta.ejb.Stateless;
import jakarta.inject.Inject;
import java.util.List;
@Stateless
public class ReservationService {
    @Inject private ReservationRepository repository;
    public List<Reservation> list() { return repository.findAll(); }
}
`);
    await write(root, 'server-web/src/main/java/example/rest/ReservationResource.java', `package example.rest;
import example.model.Reservation;
import example.service.ReservationService;
import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import java.util.List;
@Path("/reservations")
public class ReservationResource {
    @Inject private ReservationService service;
    @GET public List<Reservation> list() { return service.list(); }
}
`);
  }
  return root;
}

test('reconhece pedido full-stack de listagem como um único fluxo', () => {
  assert.equal(isFullStackFlowIntent(REQUEST), true);
  assert.match(fullStackFlowTaskGuidance(REQUEST), /único plano coordenado/);
});

test('descobre caminhos de frontend e backend sem depender do arquivo ativo', async () => {
  const root = await createWorkspace();
  const analysis = await analyzeFullStackFlowIntent({
    request: REQUEST,
    workspaceRoot: root,
    priority: ['client/src/app/components/product/product-list.component.html']
  });
  assert.ok(analysis);
  assert.equal(analysis.entityType, 'Reservation');
  assert.equal(analysis.componentFile, 'client/src/app/components/reservation/reservation-list.component.ts');
  assert.equal(analysis.frontendServiceFile, 'client/src/app/services/reservation.service.ts');
  assert.equal(analysis.frontendModelFile, 'client/src/app/models/reservation.model.ts');
  assert.equal(analysis.backendServiceFile, 'server-core/src/main/java/example/service/ReservationService.java');
  assert.equal(analysis.backendResourceFile, 'server-web/src/main/java/example/rest/ReservationResource.java');
  assert.equal(analysis.dataAccessFile, 'server-core/src/main/java/example/repository/ReservationRepository.java');
  assert.equal(analysis.javaFramework, 'jax-rs');
  assert.deepEqual(analysis.modelFields.map(field => field.name), ['id', 'guestName', 'startDate']);
});

test('cria sete arquivos coordenados para o fluxo de listagem comprovado', async () => {
  const root = await createWorkspace();
  const analysis = await analyzeFullStackFlowIntent({ request: REQUEST, workspaceRoot: root });
  const calls = [];
  const result = await tryPrepareFullStackFlowFastPath({
    request: REQUEST,
    workspaceRoot: root,
    analysis,
    execute: async call => {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: { staged: true }, durationMs: 1 };
    }
  });
  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(calls.length, 7);
  assert.ok(calls.every(call => call.name === 'create_file'));
  const byPath = new Map(calls.map(call => [call.arguments.filePath, call.arguments.content]));
  assert.match(byPath.get('server-core/src/main/java/example/service/ReservationService.java'), /public List<Reservation> list\(\)/);
  assert.match(byPath.get('server-core/src/main/java/example/service/ReservationService.java'), /repository\.findAll\(\)/);
  assert.match(byPath.get('server-web/src/main/java/example/rest/ReservationResource.java'), /@Path\("\/reservations"\)/);
  assert.match(byPath.get('server-web/src/main/java/example/rest/ReservationResource.java'), /@GET/);
  assert.match(byPath.get('client/src/app/models/reservation.model.ts'), /export interface Reservation/);
  assert.match(byPath.get('client/src/app/services/reservation.service.ts'), /http:\/\/localhost:8080\/api\/reservations/);
  assert.match(byPath.get('client/src/app/components/reservation/reservation-list.component.ts'), /templateUrl: '\.\/reservation-list\.component\.html'/);
  assert.match(byPath.get('client/src/app/components/reservation/reservation-list.component.html'), /item\.guestName/);
  assert.ok(byPath.has('client/src/app/components/reservation/reservation-list.component.scss'));
  assert.match(result.text, /Fluxo full-stack de listagem preparado/);
});

test('reutiliza camadas existentes e cria somente o componente externo', async () => {
  const root = await createWorkspace({ existingLayers: true });
  const analysis = await analyzeFullStackFlowIntent({ request: REQUEST, workspaceRoot: root });
  const calls = [];
  const result = await tryPrepareFullStackFlowFastPath({
    request: REQUEST,
    workspaceRoot: root,
    analysis,
    execute: async call => {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 1 };
    }
  });
  assert.ok(result);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.arguments.filePath), [
    'client/src/app/components/reservation/reservation-list.component.ts',
    'client/src/app/components/reservation/reservation-list.component.html',
    'client/src/app/components/reservation/reservation-list.component.scss'
  ]);
});

test('não cria fluxo parcial quando a persistência de listagem não é comprovada', async () => {
  const root = await createWorkspace({ includeDataAccess: false });
  const analysis = await analyzeFullStackFlowIntent({ request: REQUEST, workspaceRoot: root });
  let called = false;
  const result = await tryPrepareFullStackFlowFastPath({
    request: REQUEST,
    workspaceRoot: root,
    analysis,
    execute: async () => { called = true; throw new Error('não deveria executar'); }
  });
  assert.ok(result);
  assert.equal(result.complete, true);
  assert.match(result.text, /padrão seguro de Repository\/DAO\/Database/);
  assert.match(result.text, /Nenhum arquivo foi criado ou alterado/);
  assert.equal(called, false);
});

test('entidade nova sem campos interrompe o fluxo antes do modelo e não cria arquivo parcial', async () => {
  const root = await createWorkspace();
  await fsp.rm(path.join(root, 'server-core/src/main/java/example/model/Reservation.java'));
  await fsp.rm(path.join(root, 'server-core/src/main/java/example/repository/ReservationRepository.java'));

  const analysis = await analyzeFullStackFlowIntent({ request: REQUEST, workspaceRoot: root });
  assert.ok(analysis);
  assert.equal(analysis.entityType, 'Reservation');
  assert.equal(analysis.backendModelFile, 'server-core/src/main/java/example/model/Reservation.java');
  assert.equal(analysis.modelFieldsSource, 'none');
  assert.deepEqual(analysis.modelFields, []);

  let called = false;
  const result = await tryPrepareFullStackFlowFastPath({
    request: REQUEST,
    workspaceRoot: root,
    analysis,
    execute: async () => { called = true; throw new Error('não deveria executar'); }
  });

  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(result.calls.length, 0);
  assert.equal(result.results.length, 0);
  assert.match(result.text, /Informe os campos da entidade e seus tipos/);
  assert.match(result.text, /Nenhum arquivo foi criado ou alterado/);
  assert.equal(called, false);
});


async function createSharedStoreWorkspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-full-stack-new-entity-'));
  await write(root, 'ui/package.json', JSON.stringify({ dependencies: { '@angular/core': '^19.0.0' } }));
  await write(root, 'ui/src/app/models/product.model.ts', 'export interface Product { id?: number; name: string; }\n');
  await write(root, 'ui/src/app/services/product.service.ts', `import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Product } from '../models/product.model';
@Injectable({ providedIn: 'root' })
export class ProductService {
  private apiUrl = 'http://localhost:8080/api/products';
  constructor(private http: HttpClient) {}
  list(): Observable<Product[]> { return this.http.get<Product[]>(this.apiUrl); }
}
`);
  await write(root, 'ui/src/app/components/product/product-list.component.ts', `import { Component } from '@angular/core';
@Component({ selector: 'app-product-list', standalone: true, templateUrl: './product-list.component.html', styleUrls: ['./product-list.component.css'] })
export class ProductListComponent {}
`);
  await write(root, 'ui/src/app/components/product/product-list.component.html', '<p>products</p>\n');
  await write(root, 'ui/src/app/components/product/product-list.component.css', '.page {}\n');

  await write(root, 'core/src/main/java/demo/model/Product.java', `package demo.model;
import java.io.Serializable;
public class Product implements Serializable {
    private Long id;
    private String name;
    public Product() {}
    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }
    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
}
`);
  await write(root, 'core/src/main/java/demo/repository/MemoryStore.java', `package demo.repository;
import demo.model.Product;
import java.util.ArrayList;
import java.util.List;
public class MemoryStore {
    private List<Product> products = new ArrayList<>();
    public List<Product> getProducts() { return products; }
}
`);
  await write(root, 'core/src/main/java/demo/service/ProductService.java', `package demo.service;
import demo.model.Product;
import demo.repository.MemoryStore;
import jakarta.ejb.Stateless;
import jakarta.inject.Inject;
import java.util.List;
@Stateless
public class ProductService {
    @Inject private MemoryStore store;
    public List<Product> list() { return store.getProducts(); }
}
`);
  await write(root, 'web/src/main/java/demo/rest/ProductResource.java', `package demo.rest;
import demo.model.Product;
import demo.service.ProductService;
import jakarta.inject.Inject;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import java.util.List;
@Path("/products")
public class ProductResource {
    @Inject private ProductService service;
    @GET public List<Product> list() { return service.list(); }
}
`);
  return root;
}

const NEW_ENTITY_REQUEST = `Crie um fluxo completo para listar bookings, com componente Angular separado em HTML, TS e CSS, integração pelo service.ts, endpoint GET e service Java, seguindo o padrão existente do projeto.

Campos de Booking:
- customerId: Long
- customerName: String
- assetId: Long
- assetCode: String
- bookingDate: LocalDate`;

test('extrai campos tipados quando a lista inteira está em uma única linha', async () => {
  const root = await createSharedStoreWorkspace();
  const request = 'Crie um fluxo completo para listar bookings, com componente Angular separado em HTML, TS e CSS, integração pelo service.ts, endpoint GET e service Java. Campos de Booking: - customerId: Long - customerName: String - assetId: Long - assetCode: String - bookingDate: LocalDate';
  const analysis = await analyzeFullStackFlowIntent({ request, workspaceRoot: root });

  assert.ok(analysis);
  assert.equal(analysis.entityType, 'Booking');
  assert.equal(analysis.modelFieldsSource, 'request');
  assert.deepEqual(analysis.modelFields.map(field => [field.name, field.type, field.javaType]), [
    ['customerId', 'number', 'Long'],
    ['customerName', 'string', 'String'],
    ['assetId', 'number', 'Long'],
    ['assetCode', 'string', 'String'],
    ['bookingDate', 'string', 'LocalDate']
  ]);
});

test('extrai campos tipados do pedido para uma entidade nova', async () => {
  const root = await createSharedStoreWorkspace();
  const analysis = await analyzeFullStackFlowIntent({ request: NEW_ENTITY_REQUEST, workspaceRoot: root });
  assert.ok(analysis);
  assert.equal(analysis.entityType, 'Booking');
  assert.equal(analysis.modelFieldsSource, 'request');
  assert.equal(analysis.backendModelFile, 'core/src/main/java/demo/model/Booking.java');
  assert.equal(analysis.dataAccessFile, 'core/src/main/java/demo/repository/MemoryStore.java');
  assert.deepEqual(analysis.modelFields.map(field => [field.name, field.type, field.javaType]), [
    ['customerId', 'number', 'Long'],
    ['customerName', 'string', 'String'],
    ['assetId', 'number', 'Long'],
    ['assetCode', 'string', 'String'],
    ['bookingDate', 'string', 'LocalDate']
  ]);
});

test('cria fluxo completo de entidade nova e estende armazenamento compartilhado', async () => {
  const root = await createSharedStoreWorkspace();
  const analysis = await analyzeFullStackFlowIntent({ request: NEW_ENTITY_REQUEST, workspaceRoot: root });
  const calls = [];
  const result = await tryPrepareFullStackFlowFastPath({
    request: NEW_ENTITY_REQUEST,
    workspaceRoot: root,
    analysis,
    execute: async call => {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 1 };
    }
  });
  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(calls.length, 9);
  const byPath = new Map(calls.map(call => [call.arguments.filePath, call.arguments.content ?? call.arguments.newText]));
  assert.match(byPath.get('core/src/main/java/demo/model/Booking.java'), /import java\.time\.LocalDate;/);
  assert.match(byPath.get('core/src/main/java/demo/model/Booking.java'), /private LocalDate bookingDate;/);
  assert.match(byPath.get('core/src/main/java/demo/repository/MemoryStore.java'), /private List<Booking> bookings = new ArrayList<>\(\);/);
  assert.match(byPath.get('core/src/main/java/demo/repository/MemoryStore.java'), /getBookings\(\)/);
  assert.match(byPath.get('core/src/main/java/demo/service/BookingService.java'), /store\.getBookings\(\)/);
  assert.match(byPath.get('web/src/main/java/demo/rest/BookingResource.java'), /@Path\("\/bookings"\)/);
  assert.match(byPath.get('ui/src/app/models/booking.model.ts'), /bookingDate: string;/);
  assert.ok(byPath.has('ui/src/app/components/booking/booking-list.component.html'));
  assert.match(result.text, /Modelo Java:/);
  assert.match(result.text, /Acesso a dados:/);
});

test('implementação full-stack não contém nomes dos projetos de teste', async () => {
  for (const file of ['src/agent/FullStackFlowIntent.ts', 'src/agent/FullStackFlowFastPath.ts']) {
    const implementation = await fsp.readFile(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(implementation, /ReservationResource|ReservationService|ProductResource|locadora|cliente-vip/i);
  }
});

test('extension prioriza o planejador full-stack antes dos FastPaths de camada', async () => {
  const extension = await fsp.readFile(path.join(__dirname, '..', 'src', 'extension.ts'), 'utf8');
  const fullAnalysis = extension.indexOf('analyzeFullStackFlowIntent({');
  const frontendAnalysis = extension.indexOf('analyzeFrontendCrudIntent({');
  const fullFastPath = extension.indexOf('tryPrepareFullStackFlowFastPath({');
  const frontendFastPath = extension.indexOf('tryPrepareFrontendCrudFastPath({');
  assert.ok(fullAnalysis >= 0 && fullAnalysis < frontendAnalysis);
  assert.ok(fullFastPath >= 0 && fullFastPath < frontendFastPath);
  assert.match(extension, /const genericFileCreationTask = fileCreationTask && !frontendCrudAnalysis && !backendServiceAnalysis && !backendEndpointAnalysis && !fullStackFlowAnalysis/);
  assert.match(extension, /fullStackFlowTaskGuidance\(prompt\) \?\? frontendCrudTaskGuidance\(prompt\)/);
});

test('edita Service, Resource e service.ts existentes sem recriar os arquivos', async () => {
  const root = await createWorkspace();
  await write(root, 'client/src/app/models/reservation.model.ts', `export interface Reservation { id?: number; guestName: string; startDate: string; }\n`);
  await write(root, 'client/src/app/services/reservation.service.ts', `import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Reservation } from '../models/reservation.model';
@Injectable({ providedIn: 'root' })
export class ReservationService {
  private apiUrl = 'http://localhost:8080/api/reservations';
  constructor(private http: HttpClient) {}
}
`);
  await write(root, 'server-core/src/main/java/example/service/ReservationService.java', `package example.service;
import example.model.Reservation;
import example.repository.ReservationRepository;
import jakarta.ejb.Stateless;
import jakarta.inject.Inject;
@Stateless
public class ReservationService {
    @Inject private ReservationRepository repository;
}
`);
  await write(root, 'server-web/src/main/java/example/rest/ReservationResource.java', `package example.rest;
import example.model.Reservation;
import example.service.ReservationService;
import jakarta.inject.Inject;
import jakarta.ws.rs.Path;
@Path("/reservations")
public class ReservationResource {
    @Inject private ReservationService service;
}
`);

  const analysis = await analyzeFullStackFlowIntent({ request: REQUEST, workspaceRoot: root });
  const calls = [];
  const result = await tryPrepareFullStackFlowFastPath({
    request: REQUEST,
    workspaceRoot: root,
    analysis,
    execute: async call => {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 1 };
    }
  });

  assert.ok(result);
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.slice(0, 3).map(call => call.name), ['apply_edit', 'apply_edit', 'apply_edit']);
  assert.match(calls[0].arguments.newText, /public List<Reservation> list\(\)/);
  assert.match(calls[0].arguments.newText, /repository\.findAll\(\)/);
  assert.match(calls[1].arguments.newText, /@GET/);
  assert.match(calls[1].arguments.newText, /service\.list\(\)/);
  assert.match(calls[2].arguments.newText, /list\(\): Observable<Reservation\[\]>/);
  assert.ok(calls.slice(3).every(call => call.name === 'create_file'));
});

async function createSpringWorkspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-full-stack-spring-'));
  await write(root, 'ui/package.json', JSON.stringify({ dependencies: { '@angular/core': '^19.0.0' } }));
  await write(root, 'ui/src/app/models/customer.model.ts', 'export interface Customer { id?: number; name: string; }\n');
  await write(root, 'ui/src/app/services/customer.service.ts', `import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { Customer } from '../models/customer.model';
@Injectable({ providedIn: 'root' })
export class CustomerService {
  private apiUrl = 'http://localhost:8080/api/customers';
  constructor(private http: HttpClient) {}
  getAll(): Observable<Customer[]> { return this.http.get<Customer[]>(this.apiUrl); }
}
`);
  await write(root, 'ui/src/app/components/customer/customer-list.component.ts', `import { Component } from '@angular/core';
@Component({ selector: 'app-customer-list', standalone: true, templateUrl: './customer-list.component.html', styleUrls: ['./customer-list.component.css'] })
export class CustomerListComponent {}
`);
  await write(root, 'ui/src/app/components/customer/customer-list.component.html', '<p>customers</p>\n');
  await write(root, 'ui/src/app/components/customer/customer-list.component.css', '.page {}\n');

  await write(root, 'app/src/main/java/demo/model/Invoice.java', `package demo.model;
public class Invoice { private Long id; private String number; private Boolean paid; }
`);
  await write(root, 'app/src/main/java/demo/repository/InvoiceRepository.java', `package demo.repository;
import demo.model.Invoice;
import org.springframework.data.jpa.repository.JpaRepository;
public interface InvoiceRepository extends JpaRepository<Invoice, Long> {}
`);
  await write(root, 'app/src/main/java/demo/model/Customer.java', `package demo.model;
public class Customer { private Long id; private String name; }
`);
  await write(root, 'app/src/main/java/demo/repository/CustomerRepository.java', `package demo.repository;
import demo.model.Customer;
import org.springframework.data.jpa.repository.JpaRepository;
public interface CustomerRepository extends JpaRepository<Customer, Long> {}
`);
  await write(root, 'app/src/main/java/demo/service/CustomerService.java', `package demo.service;
import demo.model.Customer;
import demo.repository.CustomerRepository;
import org.springframework.stereotype.Service;
import java.util.List;
@Service
public class CustomerService {
    private final CustomerRepository repository;
    public CustomerService(CustomerRepository repository) { this.repository = repository; }
    public List<Customer> getAll() { return repository.findAll(); }
}
`);
  await write(root, 'app/src/main/java/demo/web/CustomerController.java', `package demo.web;
import demo.model.Customer;
import demo.service.CustomerService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import java.util.List;
@RestController
@RequestMapping("/customers")
public class CustomerController {
    private final CustomerService service;
    public CustomerController(CustomerService service) { this.service = service; }
    @GetMapping public List<Customer> getAll() { return service.getAll(); }
}
`);
  return root;
}

test('gera fluxo Spring com injeção por construtor e sem dependência Jakarta', async () => {
  const root = await createSpringWorkspace();
  const request = 'Create a full-stack flow to list invoices with an Angular component using separate TS, HTML and CSS files, a service.ts, GET endpoint and Java service.';
  const analysis = await analyzeFullStackFlowIntent({ request, workspaceRoot: root });
  assert.ok(analysis);
  assert.equal(analysis.entityType, 'Invoice');
  assert.equal(analysis.javaFramework, 'spring');
  const calls = [];
  const result = await tryPrepareFullStackFlowFastPath({
    request,
    workspaceRoot: root,
    analysis,
    execute: async call => {
      calls.push(call);
      return { callId: call.id, name: call.name, ok: true, content: null, durationMs: 1 };
    }
  });
  assert.ok(result);
  const service = calls.find(call => call.arguments.filePath === 'app/src/main/java/demo/service/InvoiceService.java').arguments.content;
  const controller = calls.find(call => call.arguments.filePath === 'app/src/main/java/demo/web/InvoiceController.java').arguments.content;
  assert.match(service, /@Service/);
  assert.match(service, /private final InvoiceRepository repository/);
  assert.match(service, /public InvoiceService\(InvoiceRepository repository\)/);
  assert.doesNotMatch(service, /jakarta\.inject|javax\.inject|@Inject/);
  assert.match(controller, /@RestController/);
  assert.match(controller, /@RequestMapping\("\/invoices"\)/);
  assert.match(controller, /@GetMapping/);
});

test('reconhece formulação curta do usuário quando a entidade está explícita', () => {
  const request = 'Crie um novo componente completo para listar reservas com HTML, TS e CSS, endpoint GET e service Java equivalente.';
  assert.equal(isFullStackFlowIntent(request), true);
});
