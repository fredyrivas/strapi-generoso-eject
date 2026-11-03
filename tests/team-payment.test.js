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
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user', P = 'api::team-payment-week.team-payment-week', LOG = 'api::team-payment-log.team-payment-log', BASE = 'api::team-salary-week.team-salary-week';
const noCancellations = { tips: null, shiftBonus: null, punctualityBonus: null };
const weekly = (changes = {}) => ({ consumptions: [], extraPayments: [], cash: 0, cancellations: noCancellations, ...changes });

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
    updates: [], locks: [], weeks: [], logs: [], bases: [],
  };
  const populated = entry => entry ? structuredClone({ ...entry, account: state.accounts.find(account => account.id === entry.accountId) }) : null;
  let queue = Promise.resolve();
  const strapi = {
    documents(uid) {
      if (uid === P) return {
        findFirst: async ({ filters }) => structuredClone(state.weeks.find(row => row.weekKey === filters.weekKey) ?? null),
        create: async ({ data }) => { const row = { documentId: `week-${state.weeks.length + 1}`, ...structuredClone(data) }; state.weeks.push(row); return structuredClone(row); },
        update: async ({ documentId, data }) => { const row = state.weeks.find(row => row.documentId === documentId); Object.assign(row, structuredClone(data)); if (options.failUpdate) throw new Error('controlled-update-failure'); return structuredClone(row); },
      };
      if (uid === LOG) return { create: async ({ data }) => { state.logs.push(structuredClone(data)); } };
      if (uid === BASE) return { findFirst: async ({ filters }) => structuredClone(state.bases.find(row => row.weekStart === filters.weekStart) ?? null) };
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
        const before = structuredClone({ employees: state.employees, weeks: state.weeks, logs: state.logs });
        try { return await operation({ trx: { raw: async (sql, bindings) => {
          assert.match(sql, /pg_advisory_xact_lock/); assert.deepEqual(bindings, [LOCK]); state.locks.push('shared');
        } } }); }
        catch (error) { Object.assign(state, before); throw error; }
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
  assert.deepEqual(data.payment, { revision: 0, monthlySalary: null, restDay: null, payGroup: null });
  assert.deepEqual(await h.service.readWeekForEmployee('employee-2', '2026-10-26', 1), { employeeDocumentId: 'employee-2', weekStart: '2026-10-26', revision: 0, adjustments: weekly() });
  assert.equal(h.state.weeks.length, 0);
  assert.equal(h.state.employees[0].paymentAccount, undefined);
  assert.equal(h.state.updates.length, 0);
});

test('partial updates preserve other profile and payment fields on the same employee', async () => {
  const h = harness();
  const original = structuredClone(h.state.employees[0]);
  const first = await h.service.saveForEmployee('employee-2', { revision: 0, changes: { monthlySalary: 8000 } }, 1);
  assert.equal(first.payment.revision, 1);
  assert.equal(first.configured, false);
  const second = await h.service.saveForEmployee('employee-2', { revision: 1, changes: { restDay: 0, payGroup: 'fixed' } }, 1);
  assert.equal(second.configured, true);
  assert.equal(second.payment.monthlySalary, 8000);
  assert.equal(h.state.employees.length, 2);
  for (const [key, value] of Object.entries(original)) assert.deepEqual(h.state.employees[0][key], value);
  assert.equal(h.state.employees[1].paymentAccount, undefined);
  assert.equal(h.state.updates.every(update => Object.keys(update.data).length === 1), true);
  assert.deepEqual(h.state.locks.slice(0, 3), ['shared', 'employees', 'accounts']);
});

test('weekly lists are saved per employee and week, dated inside the week, and every save is logged', async () => {
  const h = harness();
  const first = await h.service.saveWeekForEmployee('employee-2', { weekStart: '2026-10-26', revision: 0, adjustments: weekly({ consumptions: [{ date: '2026-10-27', concept: ' Comida ', amount: 50 }], extraPayments: [{ date: '2026-11-01', concept: 'Turno extra', amount: 100 }] }) }, 1, { username: 'fredy' });
  assert.equal(first.revision, 1);
  assert.deepEqual(first.adjustments.consumptions, [{ date: '2026-10-27', concept: 'Comida', amount: 50 }]);
  assert.equal(h.state.weeks[0].weekKey, 'employee-2:2026-10-26');
  assert.equal(h.state.weeks[0].configuration, null);
  const other = await h.service.saveWeekForEmployee('employee-2', { weekStart: '2026-11-02', revision: 0, adjustments: weekly({ cash: 300 }) }, 1, { username: 'fredy' });
  assert.equal(other.revision, 1);
  const saved = await h.service.saveWeekForEmployee('employee-2', { weekStart: '2026-10-26', revision: 1, adjustments: weekly({ consumptions: [{ date: '2026-10-28', concept: 'Café', amount: 20 }] }) }, 1, { username: 'fredy' });
  assert.deepEqual(saved.adjustments.consumptions, [{ date: '2026-10-28', concept: 'Café', amount: 20 }]);
  assert.deepEqual(saved.adjustments.extraPayments, []);
  assert.equal(saved.revision, 2);
  assert.equal(h.state.weeks.length, 2);
  assert.equal(h.state.employees[0].paymentAccount, undefined);
  assert.deepEqual(h.state.logs.map(entry => [entry.weekStart, entry.actor, entry.summary]), [['2026-10-26', 'fredy', 'Guardó ajustes de Persona'], ['2026-11-02', 'fredy', 'Guardó ajustes de Persona'], ['2026-10-26', 'fredy', 'Guardó ajustes de Persona']]);
  assert.equal(h.state.logs[2].before.consumptions[0].concept, 'Comida');
  await assert.rejects(h.service.saveWeekForEmployee('employee-2', { weekStart: '2026-10-26', revision: 1, adjustments: weekly() }, 1, {}), error => error.details.code === 'TEAM_CONFLICT');
  for (const input of [
    { weekStart: '2026-10-27', revision: 0, adjustments: weekly() },
    { weekStart: '2026-11-09', revision: 0, adjustments: weekly({ consumptions: [{ date: '2026-11-16', concept: 'Comida', amount: 1 }] }) },
    { weekStart: '2026-11-09', revision: 0, adjustments: weekly({ extraPayments: [{ date: '2026-11-08', concept: 'Extra', amount: 1 }] }) },
    { weekStart: '2026-11-09', revision: 0, adjustments: weekly({ extraPayments: [{ concept: 'Extra', amount: 1 }] }) },
    { weekStart: '2026-11-09', revision: 0, adjustments: { ...weekly(), extraPay: 10 } },
  ]) await assert.rejects(h.service.saveWeekForEmployee('employee-2', input, 1, {}), { name: 'ValidationError' });
});

test('a week published before the employee had adjustments keeps their current configuration', async () => {
  const h = harness();
  h.state.employees[0].paymentAccount = { revision: 1, monthlySalary: 8000, restDay: 0, payGroup: 'fixed' };
  h.state.bases.push({ weekStart: '2026-10-26', weekStatus: 'published' });
  await h.service.saveWeekForEmployee('employee-2', { weekStart: '2026-10-26', revision: 0, adjustments: weekly() }, 1, {});
  assert.deepEqual(h.state.weeks[0].configuration, { monthlySalary: 8000, restDay: 0, payGroup: 'fixed' });
});

test('legacy accounts that still hold weekly keys read only their fixed configuration', () => {
  assert.deepEqual(paymentAccount({ revision: 2, monthlySalary: 8000, restDay: 0, payGroup: 'fixed', consumptions: [{ concept: 'Café', amount: 20 }], extraPay: 50, cash: 100 }), { revision: 2, monthlySalary: 8000, restDay: 0, payGroup: 'fixed' });
  assert.throws(() => paymentAccount({ revision: 2, monthlySalary: 8000, restDay: 0, payGroup: 'fixed', other: 1 }), { name: 'ValidationError' });
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

test('operative accounts have no personal or administrative payment access and keep stored history intact', async () => {
  const h = harness();
  h.state.employees[0].teamRole = 'operative';
  h.state.employees[0].paymentAccount = { ...paymentAccount(null), revision: 3, monthlySalary: 8000, restDay: 0, payGroup: 'fixed' };
  await assert.rejects(h.service.saveWeekForEmployee('employee-2', { weekStart: '2026-10-26', revision: 0, adjustments: weekly() }, 1, {}), { name: 'ForbiddenError' });
  const before = structuredClone(h.state.employees);
  await assert.rejects(h.service.readForAccount(2), { name: 'ForbiddenError' });
  await assert.rejects(h.service.readForEmployee('employee-2', 1), { name: 'ForbiddenError' });
  await assert.rejects(h.service.saveForEmployee('employee-2', { revision: 3, changes: { monthlySalary: 9000 } }, 1), { name: 'ForbiddenError' });
  assert.deepEqual(h.state.employees, before);
  assert.equal(h.state.updates.length, 0);
  for (const teamRole of ['employee', 'production', 'admin']) {
    h.state.employees[0].teamRole = teamRole;
    assert.equal((await h.service.readForAccount(2)).payment.monthlySalary, 8000);
  }
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

test('only the fixed configuration is writable here; weekly lists, dates, totals and roles are rejected', () => {
  for (const field of ['date', 'weekStart', 'referenceDate', 'paidDays', 'punctuality', 'punctualityBonus', 'total', 'employee', 'account', 'teamRole', 'history', 'revision', 'consumptions', 'extraPay', 'extraPayments', 'cash', 'cancellations']) {
    assert.throws(() => paymentChange({ revision: 0, changes: { [field]: 1 } }), { name: 'ValidationError' });
  }
  for (const changes of [{ monthlySalary: '8000' }, { monthlySalary: -1 }, { monthlySalary: Infinity }, { restDay: 7 }, { restDay: 1.5 }, { payGroup: 'admin' }, {}]) {
    assert.throws(() => paymentChange({ revision: 0, changes }), { name: 'ValidationError' });
  }
  assert.throws(() => paymentChange({ revision: '0', changes: { restDay: 0 } }), { name: 'ValidationError' });
  assert.equal(paymentChange({ revision: 0, changes: { monthlySalary: 0, restDay: 0 } }).changes.monthlySalary, 0);
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
  assert.deepEqual(routes.map(route => [route.method, route.path]), [['GET', '/team-admin/employees/:documentId/payment/settings'], ['PATCH', '/team-admin/employees/:documentId/payment/settings'], ['GET', '/team-admin/employees/:documentId/payment/week'], ['PUT', '/team-admin/employees/:documentId/payment/week']]);
  for (const route of routes) { assert.deepEqual(route.config.policies, ['api::team-employee.team-admin']); assert.deepEqual(route.config.auth, { strategies: ['users-permissions'], scope: [] }); }
  const h = harness(), previous = global.strapi, controller = require('../src/api/team-employee/controllers/team-payment-settings');
  global.strapi = { service: () => h.service };
  try {
    const ctx = { state: { user: { id: 1 } }, params: { documentId: 'employee-2' }, request: { body: { revision: 0, changes: { monthlySalary: 8000, restDay: 0, payGroup: 'fixed' } } }, query: {}, set() {}, badRequest: () => 'rejected' };
    await controller.save(ctx); assert.equal(ctx.body.payment.revision, 1); assert.equal(ctx.body.payment.monthlySalary, 8000);
    await controller.read(ctx); assert.equal(ctx.body.payment.payGroup, 'fixed');
    await controller.save(ctx); assert.equal(ctx.status, 409); assert.match(ctx.body.error.message, /cambió/);
    ctx.query = { week: '2026-10-26' }; assert.equal(await controller.save(ctx), 'rejected'); assert.equal(h.state.updates.length, 1);
    ctx.query = {}; ctx.state.user.id = 2; await assert.rejects(controller.save(ctx), { name: 'ForbiddenError' });
    const week = require('../src/api/team-employee/controllers/team-payment-week');
    const weekCtx = { state: { user: { id: 1, username: 'fredy' } }, params: { documentId: 'employee-2' }, request: { body: { weekStart: '2026-10-26', revision: 0, adjustments: weekly({ cash: 200 }) } }, query: {}, set() {} };
    await week.save(weekCtx); assert.equal(weekCtx.body.revision, 1); assert.equal(h.state.logs[0].actor, 'fredy');
    weekCtx.query = { week: '2026-10-26' }; await week.read(weekCtx); assert.equal(weekCtx.body.adjustments.cash, 200);
    await assert.rejects(week.save(weekCtx), { name: 'ValidationError' });
    weekCtx.query = {}; await assert.rejects(week.read(weekCtx), { name: 'ValidationError' });
    weekCtx.query = {}; await week.save(weekCtx); assert.equal(weekCtx.status, 409);
  } finally { global.strapi = previous; }
});
