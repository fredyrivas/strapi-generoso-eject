'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const paymentFactory = require('../src/api/team-employee/services/team-payment');
const summaryFactory = require('../src/api/team-employee/services/team-payment-summary');
const router = require('../src/api/team-employee/routes/payment-summary');
const { LOCK } = require('../src/api/team-employee/utils/attendance');
const E = 'api::team-employee.team-employee', A = 'api::team-checkin.team-checkin', B = 'api::team-salary-week.team-salary-week';
const baseDays = () => Array.from({ length: 7 }, (_, dayIndex) => ({ dayIndex, input: { cardTips: 100, cashTips: 20, fixedMembers: 1, auxiliaryMembers: 1, bonuses: 100 } }));
const normal = day => ({ employee: 'employee-2', date: `2026-10-${19 + day}`, timestamp: `2026-10-${19 + day}T14:00:00Z` });
const close = (actual, expected) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const P = 'api::team-payment-week.team-payment-week';
const adjustments = () => ({ consumptions: [{ date: '2026-10-20', concept: 'Café', amount: 20 }], extraPayments: [{ date: '2026-10-21', concept: 'Turno extra', amount: 50 }], cash: 100, cancellations: { tips: null, shiftBonus: null, punctualityBonus: null } });
function harness() {
  const state = {
    accounts: [{ id: 1, confirmed: true, blocked: false, provider: 'local', role: { type: (process.env.TEAM_BOOTSTRAP_ADMIN_ROLE || 'backstageadmin').trim().toLowerCase() } }, { id: 2, confirmed: true, blocked: false, provider: 'local' }, { id: 3, confirmed: true, blocked: false, provider: 'local' }],
    employees: [{ documentId: 'employee-2', accountId: 2, status: 'active', teamRole: 'employee', paymentAccount: { revision: 3, monthlySalary: 8000, restDay: 0, payGroup: 'fixed' } }, { documentId: 'employee-3', accountId: 3, status: 'active', teamRole: 'employee', paymentAccount: { revision: 1, monthlySalary: 6000, restDay: 0, payGroup: 'auxiliary' } }],
    bases: [{ weekStart: '2026-10-19', weekStatus: 'published', revision: 4, days: baseDays() }],
    weeks: [{ documentId: 'week-1', weekKey: 'employee-2:2026-10-19', weekStart: '2026-10-19', revision: 2, adjustments: adjustments(), configuration: null }],
    records: [1, 2, 3, 4, 5, 6].map(normal), locks: [], queries: [],
  };
  const populated = entry => entry ? structuredClone({ ...entry, account: state.accounts.find(account => account.id === entry.accountId) }) : null;
  let payment;
  const strapi = {
    documents(uid) {
      if (uid === E) return {
        findMany: async ({ filters }) => structuredClone(state.employees.filter(entry => filters.documentId.$in.includes(entry.documentId))),
        findFirst: async ({ filters }) => populated(state.employees.find(entry => entry.accountId === filters.account.id)),
        findOne: async ({ documentId }) => populated(state.employees.find(entry => entry.documentId === documentId)),
      };
      if (uid === B) return {
        findMany: async ({ filters, sort }) => { assert.deepEqual(filters, { weekStatus: 'published' }); assert.deepEqual(sort, ['weekStart:desc']); return structuredClone(state.bases.filter(row => row.weekStatus === 'published').sort((a, b) => b.weekStart.localeCompare(a.weekStart))); },
        findFirst: async ({ filters, fields }) => { assert.deepEqual(fields, ['weekStart', 'weekStatus', 'revision', 'days', 'manualFixedDays']); return structuredClone(state.bases.find(row => row.weekStart === filters.weekStart) ?? null); },
      };
      if (uid === P) return { findFirst: async ({ filters }) => structuredClone(state.weeks.find(row => row.weekKey === filters.weekKey) ?? null) };
      assert.equal(uid, A);
      return { findMany: async query => {
        assert.deepEqual(state.locks.slice(-2), [LOCK, 'generoso:team:base-salaries']);
        if (query.filters.employee.teamRole === 'employee') {
          assert.deepEqual(query.fields, ['date', 'kind']);
          return state.records.filter(row => row.date >= query.filters.date.$gte && row.date < query.filters.date.$lt && row.date <= query.filters.date.$lte)
            .map(row => ({ ...row, employee: { documentId: row.employee } }));
        }
        assert.deepEqual(query.fields, ['date', 'timestamp', 'kind']); assert.equal(query.limit, 8);
        state.queries.push(structuredClone(query));
        return structuredClone(state.records.filter(row => row.employee === query.filters.employee.documentId && row.date >= query.filters.date.$gte && row.date < query.filters.date.$lt).slice(0, query.limit));
      } };
    },
    service(uid) { assert.equal(uid, 'api::team-employee.team-payment'); return payment; },
    db: {
      query: () => ({ findOne: async ({ where }) => state.accounts.find(account => account.id === where.id) }),
      transaction: async operation => operation({ trx: { raw: async (sql, args) => { assert.match(sql, /pg_advisory_xact_lock/); state.locks.push(args[0]); } } }),
    },
  };
  payment = paymentFactory({ strapi });
  return { state, service: summaryFactory({ strapi, clock: () => new Date('2026-11-03T18:00:00Z') }) };
}

test('operative payment summaries are denied before reading attendance or calculating payment', async () => {
  const h = harness();
  h.state.employees[0].teamRole = 'operative';
  await assert.rejects(h.service.readForAccount(2), { name: 'ForbiddenError' });
  await assert.rejects(h.service.readForEmployee('employee-2', 1), { name: 'ForbiddenError' });
  assert.equal(h.state.queries.length, 0);
});

test('employees see the latest published week with its own attendance, not the current calendar week', async () => {
  const h = harness(), before = structuredClone({ bases: h.state.bases, employees: h.state.employees, records: h.state.records, weeks: h.state.weeks });
  const result = await h.service.readForAccount(2);
  assert.equal(result.weekStart, '2026-10-19'); assert.equal(result.weekStatus, 'published'); assert.deepEqual(result.weeks, ['2026-10-19']);
  assert.equal(result.baseRevision, 4); assert.equal(result.paymentRevision, 3); assert.equal(result.adjustmentsRevision, 2); assert.equal(result.status, 'ready');
  assert.deepEqual(h.state.queries[0].filters, { employee: { documentId: 'employee-2' }, date: { $gte: '2026-10-19', $lt: '2026-10-26' } });
  assert.equal(result.calculation.attendance.paidDays, 7); close(result.calculation.salary, 2000); close(result.calculation.tips, 349.5); close(result.calculation.shiftBonus, 420); close(result.calculation.punctualityBonus, 100); close(result.calculation.subtotal, 2869.5);
  close(result.adjustments.total, 2899.5); close(result.adjustments.deposit, 2799.5); close(result.adjustments.consumptionTotal, 20); close(result.adjustments.extraPayTotal, 50);
  assert.deepEqual(result.adjustments.extraPayments, [{ date: '2026-10-21', concept: 'Turno extra', amount: 50 }]);
  assert.deepEqual({ bases: h.state.bases, employees: h.state.employees, records: h.state.records, weeks: h.state.weeks }, before);
  const json = JSON.stringify(result);
  for (const privateField of ['cardTips', 'cashTips', 'fixedMembers', 'auxiliaryMembers', 'accountId', 'employee-3', 'timestamp', 'configuration']) assert.equal(json.includes(`"${privateField}"`), false, privateField);
});

test('employees cannot open weeks in capture; admins can, and the default admin week is the current one', async () => {
  const h = harness(); h.state.bases.push({ weekStart: '2026-11-02', weekStatus: 'draft', revision: 1, days: baseDays() });
  await assert.rejects(h.service.readForAccount(2, '2026-11-02'), { name: 'NotFoundError' });
  await assert.rejects(h.service.readForAccount(2, '2026-10-26'), { name: 'NotFoundError' });
  await assert.rejects(h.service.readForAccount(2, '2026-11-03'), { name: 'ValidationError' });
  h.state.records.push({ employee: 'employee-2', date: '2026-11-03', timestamp: '2026-11-03T14:00:00Z', kind: 'normal' });
  const admin = await h.service.readForEmployee('employee-2', 1);
  close(admin.calculation.days[1].tips, 58.25);
  assert.equal(admin.weekStart, '2026-11-02'); assert.equal(admin.weekStatus, 'draft'); assert.deepEqual(admin.weeks, ['2026-10-19']);
  assert.equal(admin.adjustmentsRevision, 0); assert.deepEqual(admin.adjustments.consumptions, []);
  const empty = await h.service.readForEmployee('employee-2', 1, '2026-10-26');
  assert.equal(empty.status, 'base_pending'); assert.equal(empty.weekStatus, 'draft'); assert.equal(empty.baseRevision, null);
  assert.equal((await h.service.readForEmployee('employee-2', 1, '2026-10-19')).weekStatus, 'published');
});

test('illness pays salary only with a proportional punctuality bonus; a late day cancels the whole bonus', async () => {
  for (const kind of ['sick', 'normal']) {
    const h = harness(); h.state.records[5] = { ...normal(6), kind, timestamp: '2026-10-26T05:59:59Z', punctual: true };
    const { calculation } = await h.service.readForAccount(2);
    assert.equal(calculation.attendance.paidDays, 7); close(calculation.salary, 2000); close(calculation.punctualityBonus, kind === 'sick' ? 100 * 5 / 6 : 0);
    close(calculation.tips, kind === 'sick' ? 291.25 : 349.5);
    assert.equal(calculation.days[6].status, kind === 'sick' ? 'sick' : 'late');
  }
});

test('normal attendance at the exact cutoff is late regardless of its old punctual boolean', async () => {
  const h = harness(); h.state.records[0].timestamp = '2026-10-20T14:05:59Z'; h.state.records[0].punctual = true;
  const result = await h.service.readForAccount(2);
  assert.equal(result.calculation.days[1].status, 'late'); assert.equal(result.calculation.punctualityBonus, 0);
});

test('excludes other employees and other weeks and allows an admin to calculate the selected employee', async () => {
  const h = harness(); h.state.records.push({ ...normal(1), employee: 'employee-3' }, { ...normal(1), date: '2026-10-27', timestamp: '2026-10-27T14:00:00Z' });
  const mine = await h.service.readForAccount(2), other = await h.service.readForEmployee('employee-3', 1, '2026-10-19');
  assert.equal(mine.calculation.attendance.normalDays, 6); assert.equal(other.employeeDocumentId, 'employee-3'); assert.equal(other.calculation.attendance.normalDays, 1);
  close(other.calculation.shiftBonus, 30); close(other.calculation.salary, 6000 / 28 * 2);
});

test('no attendance pays zero including rest; records on rest do not add a paid day or allocation', async () => {
  const h = harness(); h.state.records = [normal(0)];
  const result = await h.service.readForAccount(2);
  assert.equal(result.calculation.attendance.paidDays, 0); assert.equal(result.calculation.subtotal, 0); assert.equal(result.calculation.days[0].status, 'rest');
});

test('missing manual configuration is explicit and does not invent a zero salary or write a default account', async () => {
  const h = harness(); delete h.state.employees[0].paymentAccount;
  const result = await h.service.readForAccount(2);
  assert.equal(result.status, 'unconfigured'); assert.equal(result.calculation, null); assert.deepEqual(result.missingConfiguration, ['monthlySalary', 'restDay', 'payGroup']);
  assert.equal(result.weekStart, '2026-10-19'); assert.equal(h.state.queries.length, 0); assert.equal(h.state.employees[0].paymentAccount, undefined);
  h.state.employees[0].paymentAccount = { ...h.state.employees[1].paymentAccount, monthlySalary: 0 };
  assert.equal((await h.service.readForAccount(2)).status, 'ready');
});

test('without a published week the payment stays pending and reading never creates a base', async () => {
  const h = harness(); h.state.bases[0].weekStatus = 'draft';
  const result = await h.service.readForAccount(2);
  assert.equal(result.status, 'base_pending'); assert.equal(result.weekStart, null); assert.equal(result.weekStatus, null); assert.deepEqual(result.weeks, []);
  assert.equal(result.baseRevision, null); assert.equal(result.calculation, null); assert.equal(h.state.bases.length, 1);
});

test('missing eligible allocations stay unknown, while sick and rest days remain zero', async () => {
  const h = harness(); h.state.bases[0].days[1].input.cardTips = null;
  const first = await h.service.readForAccount(2);
  assert.equal(first.status, 'pending'); assert.equal(first.calculation.tips, null); assert.equal(first.calculation.subtotal, null); close(first.calculation.salary, 2000);
  h.state.records[0].kind = 'sick';
  const second = await h.service.readForAccount(2);
  assert.equal(second.status, 'ready'); assert.equal(second.calculation.days[1].tips, 0);
});

test('each week reads its own base and attendance; a published week keeps its frozen salary', async () => {
  const h = harness(); const first = await h.service.readForAccount(2);
  h.state.bases[0].days[1].input.cashTips += 20; h.state.bases[0].revision++;
  close((await h.service.readForAccount(2)).calculation.tips, first.calculation.tips + 10);
  h.state.bases.push({ weekStart: '2026-11-02', weekStatus: 'published', revision: 1, days: baseDays() });
  h.state.records.push({ employee: 'employee-2', date: '2026-11-03', timestamp: '2026-11-03T14:00:00Z', kind: 'normal' });
  const latest = await h.service.readForAccount(2);
  assert.equal(latest.weekStart, '2026-11-02'); assert.deepEqual(latest.weeks, ['2026-11-02', '2026-10-19']);
  assert.equal(latest.calculation.attendance.normalDays, 1); assert.equal(latest.adjustments.consumptionTotal, 0);
  h.state.weeks[0].configuration = { monthlySalary: 8000, restDay: 0, payGroup: 'fixed' };
  h.state.employees[0].paymentAccount.monthlySalary = 9000;
  close((await h.service.readForAccount(2, '2026-10-19')).calculation.salary, 2000);
  close((await h.service.readForAccount(2, '2026-11-02')).calculation.salary, 9000 / 28 * 2);
});

test('requires the linked active account or an actual administrator and never accepts a caller-selected identity for own reads', async () => {
  const h = harness();
  for (const id of [undefined, '2', 0, 999]) await assert.rejects(h.service.readForAccount(id));
  for (const id of [undefined, 2, 3, 999]) await assert.rejects(h.service.readForEmployee('employee-3', id));
  for (const change of [{ blocked: true }, { confirmed: false }, { provider: 'google' }]) {
    const h = harness(); Object.assign(h.state.accounts[1], change); await assert.rejects(h.service.readForAccount(2));
  }
  h.state.employees[0].status = 'inactive'; await assert.rejects(h.service.readForAccount(2));
  await assert.rejects(h.service.readForEmployee('missing', 1));
});

test('rejects duplicate, excessive, malformed or unknown attendance instead of silently producing a total', async () => {
  for (const extra of [[normal(1)], [normal(1), normal(2)], [{ ...normal(1), kind: 'unknown' }], [{ ...normal(1), timestamp: 'bad' }]]) {
    const h = harness(); h.state.records = extra.length > 1 ? [...h.state.records, ...extra] : [extra[0], ...h.state.records];
    await assert.rejects(h.service.readForAccount(2));
  }
  const h = harness(); h.state.bases[0].days[0].dayIndex = 7;
  await assert.rejects(h.service.readForAccount(2));
});

test('summary routes are read-only and use distinct member/admin policies; controllers use only session identities and a week selector', async () => {
  const routes = router({ strapi: {} }).routes;
  assert.deepEqual(routes.map(route => [route.method, route.path]), [['GET', '/team/payment'], ['GET', '/team-admin/employees/:documentId/payment']]);
  for (const [index, route] of routes.entries()) { assert.equal(typeof route.handler, 'function'); assert.deepEqual(route.config.auth, { strategies: ['users-permissions'], scope: [] }); assert.deepEqual(route.config.policies, [index ? 'api::team-employee.team-admin' : 'api::team-employee.team-member']); }
  const previous = global.strapi, calls = [], controller = require('../src/api/team-employee/controllers/team-payment-summary');
  global.strapi = { service: () => ({ readForAccount: async (...args) => { calls.push(args); return { status: 'ready' }; }, readForEmployee: async (...args) => { calls.push(args); return { status: 'ready' }; } }) };
  try {
    const headers = {}, ctx = { state: { user: { id: 2 } }, query: {}, params: { documentId: 'employee-3' }, set: (key, value) => { headers[key] = value; } };
    await controller.mine(ctx); assert.deepEqual(calls, [[2, undefined]]); assert.equal(headers['Cache-Control'], 'no-store');
    ctx.query = { week: '2026-10-19' }; await controller.mine(ctx); assert.deepEqual(calls[1], [2, '2026-10-19']);
    ctx.state.user.id = 1; await controller.employee(ctx); assert.deepEqual(calls[2], ['employee-3', 1, '2026-10-19']);
    for (const query of [{ date: '2026-10-26' }, { week: '2026-10-19', employee: 'employee-3' }, { week: ['2026-10-19'] }]) { ctx.query = query; await assert.rejects(controller.mine(ctx), { name: 'ValidationError' }); }
    assert.equal(calls.length, 3);
  } finally { global.strapi = previous; }
});

test('weekly adjustments affect total and deposit, and replacement lists do not retain old rows', async () => {
  const h = harness(), first = await h.service.readForAccount(2);
  assert.equal(first.adjustments.total, first.calculation.subtotal + 50 - 20);
  assert.equal(first.adjustments.deposit, first.adjustments.total - 100);
  h.state.weeks[0].adjustments = { ...adjustments(), consumptions: [{ date: '2026-10-22', concept: 'Comida', amount: 30 }], extraPayments: [], cash: 200 };
  const second = await h.service.readForEmployee('employee-2', 1, '2026-10-19');
  assert.deepEqual(second.adjustments.consumptions, [{ date: '2026-10-22', concept: 'Comida', amount: 30 }]);
  assert.equal(second.adjustments.total, second.calculation.subtotal - 30); assert.equal(second.adjustments.deposit, second.adjustments.total - 200);
  assert.equal(second.calculation.subtotal, first.calculation.subtotal);
  h.state.weeks[0].adjustments.consumptions[0].date = '2026-10-26';
  await assert.rejects(h.service.readForAccount(2), { name: 'ValidationError' });
});
test('missing settings/base or eligible tips keep final totals unknown rather than applying adjustments to zero', async () => {
  for (const missing of ['configuration', 'base', 'tips']) {
    const h = harness();
    if (missing === 'configuration') h.state.employees[0].paymentAccount.monthlySalary = null;
    if (missing === 'tips') h.state.bases[0].days[1].input.cardTips = null;
    const result = missing === 'base' ? await h.service.readForEmployee('employee-2', 1, '2026-10-19').then(() => { h.state.bases = []; return h.service.readForEmployee('employee-2', 1, '2026-10-19'); }) : await h.service.readForAccount(2);
    assert.equal(result.adjustments.total, null); assert.equal(result.adjustments.deposit, null); assert.equal(result.adjustments.extraPayTotal, 50); assert.equal(result.adjustments.consumptionTotal, 20);
  }
});
