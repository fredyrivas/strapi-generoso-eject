'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const createService = require('../src/api/team-employee/services/team-payment-confirmations');
const { attendanceKey, paymentView } = require('../src/api/team-employee/utils/payment-confirmations');

const weekStart = '2026-11-02';
const actor = { id: 5, username: 'Administración de prueba' };
const operation = (id, changes = {}) => ({
  weekStart, requestId: id.repeat(32), version: 0, depositCents: 80000, cashCents: 20000, amountCents: 30000,
  paidOn: '2026-11-09', method: 'transfer', reference: 'Prueba ' + id, ...changes,
});

function fixture(deposit = 800, cash = 200) {
  const summary = { employeeDocumentId: 'person', weekStart, weekStatus: 'published', status: 'ready',
    baseRevision: 4, adjustmentsRevision: 2, adjustments: { deposit, cash } };
  const week = { documentId: 'week-row', revision: 2 };
  const logs = [];
  let attendance = [];
  let pending = Promise.resolve();
  const strapi = {
    service: () => ({
      readForEmployee(id, actorId, selectedWeek, consume) {
        assert.equal(id, 'person'); assert.equal(actorId, actor.id); assert.equal(selectedWeek, weekStart);
        const run = pending.then(() => consume(summary, week, attendance));
        pending = run.catch(() => {});
        return run;
      },
    }),
    documents(uid) {
      if (uid === 'api::team-payment-week.team-payment-week') return {
        update: async ({ documentId, data }) => { assert.equal(documentId, week.documentId); Object.assign(week, structuredClone(data)); },
      };
      assert.equal(uid, 'api::team-payment-log.team-payment-log');
      return { create: async ({ data }) => { logs.push(data); } };
    },
  };
  return { week, logs, setAttendance: rows => { attendance = rows; },
    service: createService({ strapi, clock: () => new Date('2026-11-09T18:00:00Z') }) };
}

test('partial and full confirmations exclude existing cash and reject concurrent writes against a stale balance', async () => {
  const { service, week, logs } = fixture();
  const [first, stale] = await Promise.allSettled([
    service.register('person', actor, operation('a')),
    service.register('person', actor, operation('b')),
  ]);
  assert.equal(first.value.status, 'partial');
  assert.equal(first.value.pendingCents, 50000);
  assert.equal(stale.reason.details.code, 'TEAM_CONFLICT');
  const replay = await service.register('person', actor, operation('a'));
  assert.equal(replay.version, 1);
  assert.equal(logs.length, 1);
  const paid = await service.register('person', actor, operation('c', { version: 1, amountCents: 50000 }));
  assert.equal(paid.status, 'paid');
  assert.equal(paid.pendingCents, 0);
  assert.equal(paid.confirmedCents, 80000);
  assert.equal(week.paymentConfirmations.attendanceKey, attendanceKey([]));
  assert.equal(logs.length, 2);
});

test('an all-cash week confirms the amount already included without counting it again', async () => {
  const { service, logs } = fixture(0, 200);
  await assert.rejects(service.register('person', actor, operation('a', { depositCents: 0, amountCents: 20000 })), /importe/);
  const paid = await service.register('person', actor, operation('a', { depositCents: 0, amountCents: 20000, method: 'cash' }));
  assert.equal(paid.status, 'paid');
  assert.equal(paid.confirmedCents, 0);
  assert.equal(paid.events[0].kind, 'included_cash');
  assert.equal(paid.events[0].amountCents, 20000);
  assert.equal(logs.length, 1);
});

test('directory and weekly detail show a recorded payment as under review when attendance changes', async () => {
  const { service, week, setAttendance } = fixture();
  await service.register('person', actor, operation('a', { amountCents: 80000 }));
  const { list } = require('../src/api/team-employee/controllers/team-payment-statuses');
  const previous = global.strapi;
  let attendance = [];
  global.strapi = { documents(uid) {
    if (uid === 'api::team-payment-week.team-payment-week') return { findMany: async () => [{ ...week, weekKey: 'person:' + weekStart }] };
    if (uid === 'api::team-salary-week.team-salary-week') return { findFirst: async () => ({ revision: 4, weekStatus: 'published' }) };
    assert.equal(uid, 'api::team-checkin.team-checkin');
    return { findMany: async () => attendance };
  } };
  try {
    const ctx = { query: { week: weekStart, employees: 'person' }, set() {} };
    await list(ctx);
    assert.deepEqual(ctx.body.statuses, { person: 'paid' });
    assert.equal((await service.read('person', actor.id, weekStart)).status, 'paid');
    attendance = [{ date: weekStart, timestamp: '2026-11-02T15:00:00Z', kind: 'normal', employee: { documentId: 'person' } }];
    setAttendance(attendance);
    await list(ctx);
    assert.deepEqual(ctx.body.statuses, { person: 'review' });
    assert.equal((await service.read('person', actor.id, weekStart)).status, 'review');
  } finally {
    if (previous === undefined) delete global.strapi;
    else global.strapi = previous;
  }
});

test('weekly payroll breakdown identifies covered workdays and the paid rest day', () => {
  const summary = {
    employeeDocumentId: 'person', weekStart, weekStatus: 'published', status: 'ready',
    calculation: {
      salary: 600, tips: 100, shiftBonus: 20, punctualityBonus: 80, attendance: { paidRestDays: 1 },
      days: [{ date: '2026-11-02', countsForSalary: true, status: 'on_time' },
        { date: '2026-11-03', countsForSalary: false, status: 'rest' },
        { date: '2026-11-04', countsForSalary: false, status: 'no_record' }],
    },
    adjustments: { deposit: 600, cash: 200, extraPayTotal: 0, consumptionTotal: 0, cancelledTotal: 0, total: 800 },
  };
  const result = paymentView(summary, []);
  assert.deepEqual(result.payroll.salaryDates, ['2026-11-02', '2026-11-03']);
  assert.equal(result.payroll.salaryCents, 60000);
  assert.equal(result.pendingCents, 60000);
  summary.calculation.salary = 0;
  assert.deepEqual(paymentView(summary, []).payroll.salaryDates, []);
});
