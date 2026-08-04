const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  isFullStackRelationRefactorIntent,
  analyzeFullStackRelationRefactorIntent
} = require('../out/agent/FullStackRelationRefactorIntent.js');
const {
  tryPrepareFullStackRelationRefactorFastPath
} = require('../out/agent/FullStackRelationRefactorFastPath.js');

const REQUEST = 'Refatore o fluxo de bookings para que a entidade Booking tenha Customer, Vehicle e bookedOn. Remova os campos duplicados de customer e vehicle, atualize o model TypeScript e a listagem existente, sem criar outro componente e mantendo o endpoint GET atual.';
const PORTUGUESE_REQUEST = 'Refatore o fluxo de reservas para que a entidade Reserva tenha Cliente, Carro e dataReserva. Remova os campos duplicados de cliente e carro, atualize o model TypeScript e a listagem existente, sem criar outro componente e mantendo o endpoint GET atual.';

async function write(root, relative, content) {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content);
}

async function createWorkspace({ businessMethod = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'offgrid-relation-refactor-'));
  await write(root, 'core/src/main/java/example/model/Customer.java', `package example.model;
public class Customer {
    private Long id;
    private String name;
    public Long getId() { return id; }
    public String getName() { return name; }
}
`);
  await write(root, 'core/src/main/java/example/model/Vehicle.java', `package example.model;
public class Vehicle {
    private Long id;
    private String model;
    private String plate;
    public Long getId() { return id; }
    public String getModel() { return model; }
    public String getPlate() { return plate; }
}
`);
  await write(root, 'core/src/main/java/example/model/Booking.java', `package example.model;

import java.io.Serializable;
import java.time.LocalDate;

public class Booking implements Serializable {
    private Long customerId;
    private String customerName;
    private Long vehicleId;
    private String vehicleModel;
    private String vehiclePlate;
    private LocalDate bookedOn;

    public Booking() {}

    public Booking(Long customerId, String customerName, Long vehicleId, String vehicleModel, String vehiclePlate, LocalDate bookedOn) {
        this.customerId = customerId;
        this.customerName = customerName;
        this.vehicleId = vehicleId;
        this.vehicleModel = vehicleModel;
        this.vehiclePlate = vehiclePlate;
        this.bookedOn = bookedOn;
    }

    public Long getCustomerId() { return customerId; }
    public void setCustomerId(Long customerId) { this.customerId = customerId; }
    public String getCustomerName() { return customerName; }
    public void setCustomerName(String customerName) { this.customerName = customerName; }
    public Long getVehicleId() { return vehicleId; }
    public void setVehicleId(Long vehicleId) { this.vehicleId = vehicleId; }
    public String getVehicleModel() { return vehicleModel; }
    public void setVehicleModel(String vehicleModel) { this.vehicleModel = vehicleModel; }
    public String getVehiclePlate() { return vehiclePlate; }
    public void setVehiclePlate(String vehiclePlate) { this.vehiclePlate = vehiclePlate; }
    public LocalDate getBookedOn() { return bookedOn; }
    public void setBookedOn(LocalDate bookedOn) { this.bookedOn = bookedOn; }
${businessMethod ? '    public boolean overlaps(Booking other) { return other != null; }\n' : ''}}
`);

  await write(root, 'ui/src/app/models/customer.model.ts', `export interface Customer {
  id: number;
  name: string;
}
`);
  await write(root, 'ui/src/app/models/vehicle.model.ts', `export interface Vehicle {
  id: number;
  model: string;
  plate: string;
}
`);
  await write(root, 'ui/src/app/models/booking.model.ts', `export interface Booking {
  customerId: number;
  customerName: string;
  vehicleId: number;
  vehicleModel: string;
  vehiclePlate: string;
  bookedOn: string;
}
`);
  await write(root, 'ui/src/app/components/booking/booking-list.component.html', `<table>
  <tr *ngFor="let item of items">
    <td>{{ item.customerId }}</td>
    <td>{{ item.customerName }}</td>
    <td>{{ item.vehicleId }}</td>
    <td>{{ item.vehicleModel }}</td>
    <td>{{ item.vehiclePlate }}</td>
    <td>{{ item.bookedOn }}</td>
  </tr>
</table>
`);
  return root;
}

test('reconhece refatoração de relacionamentos e não confunde GET atual com entidade', async () => {
  assert.equal(isFullStackRelationRefactorIntent(PORTUGUESE_REQUEST), true);
  const root = await createWorkspace();
  const analysis = await analyzeFullStackRelationRefactorIntent({ request: REQUEST, workspaceRoot: root });
  assert.ok(analysis);
  assert.equal(analysis.entityType, 'Booking');
  assert.notEqual(analysis.entityType, 'Atual');
  assert.deepEqual(analysis.desiredFields.map(field => field.name), ['customer', 'vehicle', 'bookedOn']);
  assert.deepEqual(analysis.errors, []);
});

test('refatora modelo Java, model TypeScript e HTML sem recriar outras camadas', async () => {
  const root = await createWorkspace();
  const analysis = await analyzeFullStackRelationRefactorIntent({ request: REQUEST, workspaceRoot: root });
  const calls = [];
  const result = await tryPrepareFullStackRelationRefactorFastPath({
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
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.name === 'apply_edit'));
  assert.deepEqual(calls.map(call => call.arguments.filePath), [
    'core/src/main/java/example/model/Booking.java',
    'ui/src/app/models/booking.model.ts',
    'ui/src/app/components/booking/booking-list.component.html'
  ]);

  const byPath = new Map(calls.map(call => [call.arguments.filePath, call.arguments.newText]));
  const java = byPath.get('core/src/main/java/example/model/Booking.java');
  assert.match(java, /private Customer customer;/);
  assert.match(java, /private Vehicle vehicle;/);
  assert.match(java, /private LocalDate bookedOn;/);
  assert.doesNotMatch(java, /customerId|customerName|vehicleId|vehicleModel|vehiclePlate/);

  const ts = byPath.get('ui/src/app/models/booking.model.ts');
  assert.match(ts, /import \{ Customer \} from '\.\/customer\.model';/);
  assert.match(ts, /import \{ Vehicle \} from '\.\/vehicle\.model';/);
  assert.match(ts, /customer: Customer;/);
  assert.match(ts, /vehicle: Vehicle;/);
  assert.match(ts, /bookedOn: string;/);

  const html = byPath.get('ui/src/app/components/booking/booking-list.component.html');
  assert.match(html, /item\.customer\.id/);
  assert.match(html, /item\.customer\.name/);
  assert.match(html, /item\.vehicle\.id/);
  assert.match(html, /item\.vehicle\.model/);
  assert.match(html, /item\.vehicle\.plate/);
  assert.match(html, /item\.bookedOn/);
  assert.match(result.text, /Endpoint, services e componente TypeScript foram preservados/);
});

test('repetir a refatoração já aplicada é idempotente e não prepara revisão', async () => {
  const root = await createWorkspace();
  await write(root, 'core/src/main/java/example/model/Booking.java', `package example.model;

import java.io.Serializable;
import java.time.LocalDate;

public class Booking implements Serializable {
    private Customer customer;
    private Vehicle vehicle;
    private LocalDate bookedOn;

    public Booking() {}

    public Booking(Customer customer, Vehicle vehicle, LocalDate bookedOn) {
        this.customer = customer;
        this.vehicle = vehicle;
        this.bookedOn = bookedOn;
    }

    public Customer getCustomer() { return customer; }
    public void setCustomer(Customer customer) { this.customer = customer; }
    public Vehicle getVehicle() { return vehicle; }
    public void setVehicle(Vehicle vehicle) { this.vehicle = vehicle; }
    public LocalDate getBookedOn() { return bookedOn; }
    public void setBookedOn(LocalDate bookedOn) { this.bookedOn = bookedOn; }
}
`);
  await write(root, 'ui/src/app/models/booking.model.ts', `import { Customer } from './customer.model';
import { Vehicle } from './vehicle.model';

export interface Booking {
  customer: Customer;
  vehicle: Vehicle;
  bookedOn: string;
}
`);
  await write(root, 'ui/src/app/components/booking/booking-list.component.html', `<table>
  <tr *ngFor="let item of items">
    <td>{{ item.customer.id }}</td>
    <td>{{ item.customer.name }}</td>
    <td>{{ item.vehicle.id }}</td>
    <td>{{ item.vehicle.model }}</td>
    <td>{{ item.vehicle.plate }}</td>
    <td>{{ item.bookedOn }}</td>
  </tr>
</table>
`);

  const analysis = await analyzeFullStackRelationRefactorIntent({ request: REQUEST, workspaceRoot: root });
  let called = false;
  const result = await tryPrepareFullStackRelationRefactorFastPath({
    request: REQUEST,
    workspaceRoot: root,
    analysis,
    execute: async () => { called = true; throw new Error('não deveria executar'); }
  });

  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(called, false);
  assert.equal(result.calls.length, 0);
  assert.match(result.text, /Nenhuma alteração foi necessária/);
  assert.match(result.text, /já possui os relacionamentos solicitados/);
  assert.match(result.text, /Nenhum arquivo foi criado ou alterado/);
});

test('bloqueia refatoração automática quando o modelo contém regra de negócio', async () => {
  const root = await createWorkspace({ businessMethod: true });
  const analysis = await analyzeFullStackRelationRefactorIntent({ request: REQUEST, workspaceRoot: root });
  let called = false;
  const result = await tryPrepareFullStackRelationRefactorFastPath({
    request: REQUEST,
    workspaceRoot: root,
    analysis,
    execute: async () => { called = true; throw new Error('não deveria executar'); }
  });
  assert.ok(result);
  assert.equal(result.complete, true);
  assert.equal(called, false);
  assert.match(result.text, /possui lógica além de campos/);
  assert.match(result.text, /Nenhum arquivo foi criado ou alterado/);
});

test('implementação da refatoração é genérica e não contém nomes do projeto funcional', async () => {
  for (const file of [
    'src/agent/FullStackRelationRefactorIntent.ts',
    'src/agent/FullStackRelationRefactorFastPath.ts'
  ]) {
    const implementation = await fsp.readFile(path.join(__dirname, '..', file), 'utf8');
    assert.doesNotMatch(implementation, /\b(?:locadora|Reserva|Cliente|Carro|cliente-vip)\b/i);
  }
});
