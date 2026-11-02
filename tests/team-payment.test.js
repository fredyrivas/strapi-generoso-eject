'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const factory = require('../src/api/team-employee/services/team-payment');
const { paymentAccount, paymentChange } = require('../src/api/team-employee/utils/payment-account');
const { attendanceKind } = require('../src/api/team-employee/utils/attendance-kind');
const { employeeProfile, validateEmployeeDetails } = require('../src/api/team-employee/utils/employee-details');
const employeeSchema = require('../src/api/team-employee/content-types/team-employee/schema.json');
const checkinSchema = require('../src/api/team-checkin/content-types/team-checkin/schema.json');
const { createContentType } = require(path.join(path.dirname(require.resolve('@strapi/core/package.json')), 'dist/domain/content-type'));
const entityValidator = require(path.join(path.dirname(require.resolve('@strapi/core/package.json')), 'dist/services/entity-validator'));
const { LOCK } = require('../src/api/team-employee/utils/attendance');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user';

function harness(options = {}) {
  const state = {
    accounts: [
      { id: 1, confirmed: true, blocked: false, provider: 'local', role: { type: (process.env.TEAM_BOOTSTRAP_ADMIN_ROLE || 'backstageadmin').trim().toLowerCase() } },
      { id: 2, confirmed: true, blocked: false, provider: 'local', role: { type: 'teamemployee' } },
      { id: 3, confirmed: true, blocked: false, provider: 'local', role: { type: 'teamemployee' } },
    ],
    employees: [
      { documentId: 'employee-2', accountId: 2, status: 'active', teamRole: 'employee', fullName: 'Persona', startDate: '2026-10-01', phone: '+525512345678', position: 'Barista' },
      { documentId: 'employee-3', accountId: 3, status: 'active', teamRole: 'employee', fullName: 'Otra persona' },
    ],
    updates: [], locks: [],
  };
  const populated = entry => entry ? structuredClone({ ...entry, account: state.accounts.find(account => account.id === entry.accountId) }) : null;
  let queue = Promise.resolve();
  const strapi = {
    documents(uid) {
      assert.equal(uid, E);
      return {
        findFirst: async ({ filters }) => populated(state.employees.find(entry => entry.accountId === filters.account.id)),
        findOne: async ({ documentId }) => populated(state.employees.find(entry => entry.documentId === documentId)),
        update: async ({ documentId, data }) => {
          assert.deepEqual(Object.keys(data), ['paymentAccount']);
          state.updates.push(structuredClone({ documentId, data }));
          const entry = state.employees.find(entry => entry.documentId === documentId);
          Object.assign(entry, structuredClone(data));
          if (options.failUpdate) throw new Error('controlled-update-failure');
          return populated(entry);
        },
      };
    },
    db: {
      metadata: { get: uid => ({ tableName: uid === E ? 'employees' : 'accounts' }) },
      connection: table => ({ transacting() { return this; }, select() { return this; }, where(key) { this.key = key; return this; }, forUpdate() { state.locks.push(table); return this; }, async first() {
        return table === 'employees' ? state.employees.find(entry => entry.documentId === this.key.document_id) : state.accounts.find(account => account.id === this.key.id);
      } }),
      query: uid => { assert.equal(uid, U); return { findOne: async ({ where }) => state.accounts.find(account => account.id === where.id) }; },
      async transaction(operation) {
        const previous = queue; let release; queue = new Promise(resolve => { release = resolve; }); await previous;
        if (options.revokeBeforeLock) state.accounts[0].blocked = true;
        const before = structuredClone(state.employees);
        try { return await operation({ trx: { raw: async (sql, bindings) => {
          assert.match(sql, /pg_advisory_xact_lock/); assert.deepEqual(bindings, [LOCK]); state.locks.push('shared');
        } } }); }
        catch (error) { state.employees = before; throw error; }
        finally { release(); }
      },
    },
  };
  return { service: factory({ strapi }), state };
}

test('old attendance reads as normal without rewriting its date, time or punctuality', () => {
  const previous = { date: '2026-10-30', timestamp: '2026-10-30T14:00:00Z', punctual: true };
  const before = structuredClone(previous);
  assert.equal(attendanceKind(previous.kind), 'normal');
  assert.equal(attendanceKind(null), 'normal');
  assert.equal(attendanceKind('normal'), 'normal');
  assert.equal(attendanceKind('sick'), 'sick');
  assert.deepEqual(previous, before);
  for (const kind of ['late', '', true, {}]) assert.throws(() => attendanceKind(kind), { name: 'ValidationError' });
});

test('Strapi accepts the new kind and applies normal by default while preserving the unique day key', async () => {
  assert.equal(checkinSchema.attributes.kind.private, true);
  assert.equal(checkinSchema.attributes.kind.default, 'normal');
  assert.equal(checkinSchema.attributes.dayKey.unique, true);
  assert.equal(checkinSchema.options.draftAndPublish, false);
  const previous = global.strapi;
  let model;
  global.strapi = { config: { get: () => false }, getModel: () => model, db: { query: () => ({ count: async () => 1, findOne: async () => null }) } };
  try {
    model = createContentType('api::team-checkin.team-checkin', { schema: checkinSchema });
    const values = { employee: 2, dayKey: 'employee-2:2026-10-30', date: '2026-10-30', timestamp: '2026-10-30T14:00:00Z', punctual: true };
    assert.equal((await entityValidator.validateEntityCreation(model, values, { strictRelations: true })).kind, 'normal');
    assert.equal((await entityValidator.validateEntityCreation(model, { ...values, kind: 'sick', punctual: false }, { strictRelations: true })).kind, 'sick');
    await assert.rejects(entityValidator.validateEntityCreation(model, { ...values, kind: 'other' }, { strictRelations: true }), { name: 'ValidationError' });
  } finally { if (previous === undefined) delete global.strapi; else global.strapi = previous; }
});

test('an unconfigured payment account has no invented salary, rest day or group and reads do not write', async () => {
  const h = harness();
  const data = await h.service.readForEmployee('employee-2', 1);
  assert.equal(data.configured, false);
  assert.deepEqual(data.payment, { revision: 0, monthlySalary: null, restDay: null, payGroup: null, consumptions: [], extraPay: 0, cash: 0, cancellations: { tips: null, shiftBonus: null, punctualityBonus: null } });
  assert.equal(h.state.employees[0].paymentAccount, undefined);
  assert.equal(h.state.updates.length, 0);
});

test('partial updates preserve other profile and payment fields on the same employee', async () => {
  const h = harness();
  const original = structuredClone(h.state.employees[0]);
  const first = await h.service.saveForEmployee('employee-2', { revision: 0, changes: { monthlySalary: 8000 } }, 1);
  assert.equal(first.payment.revision, 1);
  assert.equal(first.configured, false);
  const second = await h.service.saveForEmployee('employee-2', { revision: 1, changes: { restDay: 0, payGroup: 'fixed', extraPay: 25, cash: 100 } }, 1);
  assert.equal(second.configured, true);
  assert.equal(second.payment.monthlySalary, 8000);
  assert.equal(h.state.employees.length, 2);
  for (const [key, value] of Object.entries(original)) assert.deepEqual(h.state.employees[0][key], value);
  assert.equal(h.state.employees[1].paymentAccount, undefined);
  assert.equal(h.state.updates.every(update => Object.keys(update.data).length === 1), true);
  assert.deepEqual(h.state.locks.slice(0, 3), ['shared', 'employees', 'accounts']);
});

test('consumptions and adjustments replace current values without weekly records or history', async () => {
  const h = harness();
  await h.service.saveForEmployee('employee-2', { revision: 0, changes: { consumptions: [{ concept: ' Comida ', amount: 50 }, { concept: 'Comida', amount: 0 }], extraPay: 100 } }, 1);
  const saved = await h.service.saveForEmployee('employee-2', { revision: 1, changes: { consumptions: [{ concept: 'Café', amount: 20 }], extraPay: 0 } }, 1);
  assert.deepEqual(saved.payment.consumptions, [{ concept: 'Café', amount: 20 }]);
  assert.equal(saved.payment.extraPay, 0);
  assert.equal(saved.payment.revision, 2);
  assert.deepEqual(Object.keys(h.state.employees[0].paymentAccount).sort(), ['cancellations', 'cash', 'consumptions', 'extraPay', 'monthlySalary', 'payGroup', 'restDay', 'revision']);
});

test('each active account can read only its linked current settings', async () => {
  const h = harness();
  await h.service.saveForEmployee('employee-2', { revision: 0, changes: { monthlySalary: 8000 } }, 1);
  await h.service.saveForEmployee('employee-3', { revision: 0, changes: { monthlySalary: 6000 } }, 1);
  const first = await h.service.readForAccount(2), second = await h.service.readForAccount(3);
  assert.equal(first.employeeDocumentId, 'employee-2');
  assert.equal(first.payment.monthlySalary, 8000);
  assert.equal(second.employeeDocumentId, 'employee-3');
  assert.equal(second.payment.monthlySalary, 6000);
  assert.deepEqual(Object.keys(first).sort(), ['configured', 'employeeDocumentId', 'payment']);
});

test('employees cannot administer salary and blocked, inactive or unconfirmed users cannot read their account', async () => {
  const h = harness();
  for (const actor of [undefined, 'token', 0, 2, 3, 999]) {
    await assert.rejects(h.service.readForEmployee('employee-2', actor), { name: 'ForbiddenError' });
    await assert.rejects(h.service.saveForEmployee('employee-2', { revision: 0, changes: { monthlySalary: 1 } }, actor), { name: 'ForbiddenError' });
  }
  for (const field of ['blocked', 'confirmed', 'provider']) {
    const current = harness(); current.state.accounts[1][field] = field === 'blocked' ? true : field === 'confirmed' ? false : 'google';
    await assert.rejects(current.service.readForAccount(2), { name: 'ForbiddenError' });
  }
  const inactive = harness(); inactive.state.employees[0].status = 'inactive';
  await assert.rejects(inactive.service.readForAccount(2), { name: 'ForbiddenError' });
  await assert.rejects(h.service.readForAccount(1), { name: 'NotFoundError' });
  assert.equal(h.state.updates.length, 0);
});

test('administrative permission is revalidated inside the transaction before saving', async () => {
  const h = harness({ revokeBeforeLock: true });
  await assert.rejects(h.service.saveForEmployee('employee-2', { revision: 0, changes: { monthlySalary: 8000 } }, 1), { name: 'ForbiddenError' });
  assert.equal(h.state.employees[0].paymentAccount, undefined);
  assert.equal(h.state.updates.length, 0);
});

test('two edits with the same revision cannot overwrite one another', async () => {
  const h = harness();
  const results = await Promise.allSettled([8000, 6000].map(monthlySalary => h.service.saveForEmployee('employee-2', { revision: 0, changes: { monthlySalary } }, 1)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.details.code, 'TEAM_CONFLICT');
  assert.equal(h.state.updates.length, 1);
  assert.equal(h.state.employees[0].paymentAccount.revision, 1);
});

test('a failed write rolls back the current values and revision', async () => {
  const h = harness({ failUpdate: true });
  const before = paymentAccount(null);
  await assert.rejects(h.service.saveForEmployee('employee-2', { revision: 0, changes: { monthlySalary: 8000 } }, 1), /controlled-update-failure/);
  assert.deepEqual((await h.service.readForEmployee('employee-2', 1)).payment, before);
  assert.equal(h.state.employees[0].paymentAccount, undefined);
});

test('only current manual fields are writable; dates, totals, roles and attendance-derived fields are rejected', () => {
  for (const field of ['date', 'weekStart', 'referenceDate', 'paidDays', 'punctuality', 'punctualityBonus', 'total', 'employee', 'account', 'teamRole', 'history', 'revision']) {
    assert.throws(() => paymentChange({ revision: 0, changes: { [field]: 1 } }), { name: 'ValidationError' });
  }
  for (const changes of [{ monthlySalary: '8000' }, { monthlySalary: -1 }, { monthlySalary: Infinity }, { restDay: 7 }, { restDay: 1.5 }, { payGroup: 'admin' }, { cash: -1 }, { extraPay: NaN }, { consumptions: [{ concept: '', amount: 10 }] }, { consumptions: [{ concept: 'Comida', amount: -1 }] }, { consumptions: [{ concept: 'Comida', amount: 20, date: '2026-10-31' }] }, {}]) {
    assert.throws(() => paymentChange({ revision: 0, changes }), { name: 'ValidationError' });
  }
  assert.throws(() => paymentChange({ revision: '0', changes: { cash: 0 } }), { name: 'ValidationError' });
  assert.equal(paymentChange({ revision: 0, changes: { monthlySalary: 0, restDay: 0, cash: 0 } }).changes.monthlySalary, 0);
});

test('payment data is private, absent from general profiles and cannot be edited through employee details', () => {
  assert.equal(employeeSchema.attributes.paymentAccount.private, true);
  assert.equal(employeeSchema.attributes.paymentAccount.type, 'json');
  assert.equal(employeeSchema.options.draftAndPublish, false);
  const h = harness();
  const entry = { ...h.state.employees[0], paymentAccount: { salarySecret: 9999 }, account: { email: 'person@example.test' } };
  assert.equal(employeeProfile(entry).paymentAccount, undefined);
  assert.throws(() => validateEmployeeDetails({ paymentAccount: {} }, { partial: true }), { name: 'ValidationError' });
  assert.deepEqual(require('../src/api/team-checkin/routes/team-checkin').routes, []);
});

test('settings routes are admin-only and their controller reads/writes using the authenticated actor', async () => {
  const routes = require('../src/api/team-employee/routes/payment-settings')({ strapi: {} }).routes;
  assert.deepEqual(routes.map(route => route.method), ['GET', 'PATCH']);
  for (const route of routes) { assert.equal(route.path, '/team-admin/employees/:documentId/payment/settings'); assert.deepEqual(route.config.policies, ['api::team-employee.team-admin']); assert.deepEqual(route.config.auth, { strategies: ['users-permissions'], scope: [] }); }
  const h = harness(), previous = global.strapi, controller = require('../src/api/team-employee/controllers/team-payment-settings');
  global.strapi = { service: () => h.service };
  try {
    const ctx = { state: { user: { id: 1 } }, params: { documentId: 'employee-2' }, request: { body: { revision: 0, changes: { monthlySalary: 8000, restDay: 0, payGroup: 'fixed', consumptions: [{ concept: 'Comida', amount: 50 }], extraPay: 100, cash: 200 } } }, query: {}, set() {}, badRequest: () => 'rejected' };
    await controller.save(ctx); assert.equal(ctx.body.payment.revision, 1); assert.equal(ctx.body.payment.cash, 200);
    await controller.read(ctx); assert.equal(ctx.body.payment.extraPay, 100);
    await controller.save(ctx); assert.equal(ctx.status, 409); assert.match(ctx.body.error.message, /cambió/);
    ctx.query = { week: '2026-10-26' }; assert.equal(await controller.save(ctx), 'rejected'); assert.equal(h.state.updates.length, 1);
    ctx.query = {}; ctx.state.user.id = 2; await assert.rejects(controller.save(ctx), { name: 'ForbiddenError' });
  } finally { global.strapi = previous; }
});
