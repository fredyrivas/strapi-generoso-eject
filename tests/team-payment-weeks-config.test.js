'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const configurePaymentWeeks = require('../src/team-payment-weeks-config');
const { LOCK } = require('../src/api/team-employee/utils/attendance');
const BASE = 'api::team-salary-week.team-salary-week', E = 'api::team-employee.team-employee', P = 'api::team-payment-week.team-payment-week', LOG = 'api::team-payment-log.team-payment-log';
const days = () => Array.from({ length: 7 }, (_, dayIndex) => ({ dayIndex, input: { cardTips: 100, cashTips: 20, fixedMembers: 1, auxiliaryMembers: 1, bonuses: 100 } }));

function harness() {
  const state = {
    bases: [{ documentId: 'base', referenceDate: '2026-10-31', weekStart: '2026-10-19', revision: 4, days: days() }],
    employees: [
      { documentId: 'employee-1', fullName: 'Ana', teamRole: 'employee', paymentAccount: { revision: 3, monthlySalary: 8000, restDay: 0, payGroup: 'fixed', consumptions: [{ concept: 'Café', amount: 20 }], extraPay: 50, cash: 100, cancellations: { tips: 'penalty', shiftBonus: null, punctualityBonus: null } } },
      { documentId: 'employee-2', fullName: 'Luis', teamRole: 'employee', paymentAccount: { revision: 1, monthlySalary: 6000, restDay: 1, payGroup: 'auxiliary' } },
      { documentId: 'employee-3', fullName: 'Operativo', teamRole: 'operative', paymentAccount: null },
    ],
    weeks: [], logs: [], locks: [],
  };
  const strapi = {
    log: { error: message => { throw new Error(message); } },
    documents(uid) {
      if (uid === BASE) return {
        findFirst: async ({ filters }) => { assert.deepEqual(filters, { referenceDate: { $notNull: true } }); return structuredClone(state.bases.find(row => row.referenceDate != null) ?? null); },
        update: async ({ documentId, data }) => Object.assign(state.bases.find(row => row.documentId === documentId), structuredClone(data)),
      };
      if (uid === E) return {
        findMany: async ({ filters }) => { assert.deepEqual(filters, { teamRole: { $ne: 'operative' } }); return structuredClone(state.employees.filter(row => row.teamRole !== 'operative')); },
        update: async ({ documentId, data }) => Object.assign(state.employees.find(row => row.documentId === documentId), structuredClone(data)),
      };
      if (uid === P) return {
        findFirst: async ({ filters }) => structuredClone(state.weeks.find(row => row.weekKey === filters.weekKey) ?? null),
        create: async ({ data }) => { state.weeks.push(structuredClone(data)); },
      };
      assert.equal(uid, LOG);
      return { create: async ({ data }) => { state.logs.push(structuredClone(data)); } };
    },
    db: { transaction: async operation => operation({ trx: { raw: async (sql, bindings) => { assert.match(sql, /pg_advisory_xact_lock/); state.locks.push(bindings[0]); } } }) },
  };
  return { state, run: () => configurePaymentWeeks(strapi) };
}

test('the single saved base becomes its published week and weekly adjustments move into dated rows', async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.state.locks, [LOCK, 'generoso:team:base-salaries']);
  const [base] = h.state.bases;
  assert.equal(base.weekStart, '2026-10-26'); assert.equal(base.referenceDate, null); assert.equal(base.weekStatus, 'published'); assert.equal(base.revision, 5);
  assert.ok(Number.isFinite(Date.parse(base.releasedAt)));
  assert.deepEqual(base.days, days());
  assert.deepEqual(h.state.weeks.map(row => row.weekKey), ['employee-1:2026-10-26', 'employee-2:2026-10-26']);
  assert.deepEqual(h.state.weeks[0].adjustments, {
    consumptions: [{ date: '2026-10-26', concept: 'Café', amount: 20 }], extraPayments: [{ date: '2026-10-26', concept: 'Pago extra', amount: 50 }],
    cash: 100, cancellations: { tips: 'penalty', shiftBonus: null, punctualityBonus: null },
  });
  assert.deepEqual(h.state.weeks[0].configuration, { monthlySalary: 8000, restDay: 0, payGroup: 'fixed' });
  assert.deepEqual(h.state.weeks[1].adjustments.extraPayments, []);
  assert.deepEqual(h.state.weeks[1].configuration, { monthlySalary: 6000, restDay: 1, payGroup: 'auxiliary' });
  assert.deepEqual(h.state.employees[0].paymentAccount, { revision: 4, monthlySalary: 8000, restDay: 0, payGroup: 'fixed' });
  assert.deepEqual(h.state.employees[1].paymentAccount, { revision: 1, monthlySalary: 6000, restDay: 1, payGroup: 'auxiliary' });
  assert.equal(h.state.employees[2].paymentAccount, null);
  assert.equal(h.state.logs.length, 2);
  assert.equal(h.state.logs[1].before.extraPay, 50);
});

test('running the migration again changes nothing', async () => {
  const h = harness();
  await h.run();
  const after = structuredClone(h.state);
  await h.run();
  assert.deepEqual({ ...h.state, locks: [] }, { ...after, locks: [] });
});

test('without a saved base, leftover adjustments move into the current week in capture', async () => {
  const h = harness(); h.state.bases = [];
  await h.run();
  assert.equal(h.state.weeks.length, 1);
  assert.equal(h.state.weeks[0].configuration, null);
  assert.match(h.state.weeks[0].weekStart, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(h.state.weeks[0].adjustments.consumptions[0].date, h.state.weeks[0].weekStart);
});
