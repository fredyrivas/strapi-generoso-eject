'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const routes = require('../src/api/team-employee/routes/settlement-archive');
const controller = require('../src/api/team-employee/controllers/team-settlement-archive');

const identity = { fullName: 'Persona de prueba', position: 'Barista' };
const snapshot = {
  version: 1, employee: identity, basis: { startDate: '2026-01-01', lastWorkDate: '2026-07-01', monthlySalary: 15000 },
  revisions: [], balance: null, receipt: null,
  documents: {
    employer: 'Parte empleadora de prueba', address: 'Domicilio de prueba', issuedOn: '2026-07-01',
    workplace: { name: 'Negocio de prueba', address: 'Dirección del centro de trabajo de prueba' },
  },
};

function context(documentId, value) {
  const id = createHash('sha256').update(documentId).update('\0').update(JSON.stringify(value)).digest('hex');
  return {
    params: { documentId }, query: {}, request: { body: { id, snapshot: value } }, state: { user: { id: 7 } }, status: 200,
    set() {}, badRequest() { this.status = 400; }, notFound() { this.status = 404; },
  };
}

test('all archive routes are protected by the Team administrator policy', () => {
  const registered = routes({ strapi: {} }).routes;
  assert.deepEqual(registered.map(route => route.method), ['GET', 'POST', 'POST']);
  for (const route of registered) {
    assert.deepEqual(route.config.auth.strategies, ['users-permissions']);
    assert.deepEqual(route.config.policies, ['api::team-employee.team-admin']);
  }
});

test('combined transfer rolls back every allocation on error, replays a retry and rejects stale balances', async () => {
  const firstWeek = '2026-06-22', secondWeek = '2026-06-29';
  const source = weekStart => ({ weekStart, version: 0, depositCents: 40000, cashCents: 0, pendingCents: 40000,
    amountCents: 30000, salaryDates: [weekStart] });
  const input = {
    ...snapshot.basis, unpaidSalaryDays: 0, annualBonusDays: 15, bonusEligibleDays: 182, bonusAlreadyPaid: 0,
    annualVacationDays: 12, vacationDaysUsed: 0, pastVacationDaysDue: 0, vacationPremiumPercent: 25,
    vacationPremiumAlreadyPaid: 0, seniorityDailyMinimumWage: null, otherAmount: 0, otherDescription: "",
    salaryEntries: [{ date: firstWeek, days: 1 }],
  };
  const combined = {
    ...snapshot, revisions: [{ input, result: { total: 100000,
      lines: { salary: 0, bonus: 100000, currentVacation: 0, pastVacation: 0, vacationPremium: 0, seniority: 0, other: 0 },
      dailySalary: 500, vacationDaysEarned: 0, currentVacationDaysDue: 0, otherDescription: "" } }],
    balance: { gross: 100000, retained: 0, paid: 70000 },
    receipt: { amount: 70000, paidOn: '2026-07-01', method: 'Transferencia bancaria', reference: 'BANCO-1' },
    combinedPayment: { reference: 'BANCO-1', paidOn: '2026-07-01', settlementCents: 70000, priorPaidCents: 0,
      totalCents: 130000, weeks: [source(firstWeek), source(secondWeek)] },
  };
  const rows = [], writes = [];
  let failSecond = true, stale = true;
  global.strapi = {
    db: { async transaction(run) {
      const savedRows = rows.length, savedWrites = writes.length;
      try { return await run({ trx: { raw: async () => {} } }); }
      catch (error) { rows.length = savedRows; writes.length = savedWrites; throw error; }
    } },
    documents(uid) {
      if (uid === 'api::team-employee.team-employee') return { findOne: async () => ({ ...identity, startDate: snapshot.basis.startDate }) };
      return {
        findFirst: async ({ filters }) => filters.archiveKey
          ? rows.find(row => row.archiveKey === filters.archiveKey) : rows.at(-1),
        create: async ({ data }) => {
          const entry = { ...structuredClone(data), createdAt: '2026-07-01T18:00:00Z' };
          rows.push(entry);
          return entry;
        },
      };
    },
    service() {
      return {
        read: async (_person, _actor, week) => ({ ...source(week), version: stale && week === secondWeek ? 1 : 0, status: null, events: [],
          payroll: { salaryDates: [week] } }),
        register: async (_person, _actor, change) => {
          if (failSecond && change.weekStart === secondWeek) throw new Error('Failed weekly write');
          writes.push(change);
        },
      };
    },
  };
  const request = (value = combined) => {
    const ctx = context('person-a', value);
    ctx.request.body.id = createHash('sha256').update('combined\0').update('person-a').update('\0')
      .update(value.combinedPayment.reference.toUpperCase()).digest('hex');
    return ctx;
  };
  try {
    const staleRequest = request();
    await controller.registerCombined(staleRequest);
    assert.equal(staleRequest.status, 409);
    assert.equal(writes.length, 0);
    stale = false;
    await assert.rejects(controller.registerCombined(request()), /Failed weekly write/);
    assert.equal(writes.length, 0);
    assert.equal(rows.length, 0);
    failSecond = false;
    const saved = request();
    await controller.registerCombined(saved);
    assert.equal(saved.status, 201);
    assert.deepEqual(writes.map(change => [change.weekStart, change.amountCents, change.reference]),
      [[firstWeek, 30000, 'BANCO-1'], [secondWeek, 30000, 'BANCO-1']]);
    assert.equal(saved.body.snapshot.receipt.amount, 70000);
    const replay = request();
    await controller.registerCombined(replay);
    assert.equal(replay.status, 200);
    assert.equal(rows.length, 1);
    assert.equal(writes.length, 2);
    const sameReference = request({ ...combined, receipt: { ...combined.receipt, amount: 60000 },
      balance: { ...combined.balance, paid: 60000 },
      combinedPayment: { ...combined.combinedPayment, settlementCents: 60000, totalCents: 120000 } });
    await controller.registerCombined(sameReference);
    assert.equal(sameReference.status, 409);
  } finally {
    delete global.strapi;
  }
});

test('keeps prior snapshots, scopes listing by person and replays a save after an employee update', async () => {
  const rows = [];
  let fullName = identity.fullName;
  global.strapi = { documents(uid) {
    if (uid === 'api::team-employee.team-employee') return { findOne: async () => ({ ...identity, fullName, startDate: snapshot.basis.startDate }) };
    assert.equal(uid, 'api::team-settlement-archive.team-settlement-archive');
    return {
      findFirst: async ({ filters }) => rows.find(row => row.archiveKey === filters.archiveKey),
      findMany: async ({ filters, start, limit }) => rows.filter(row => row.employeeDocumentId === filters.employeeDocumentId).slice(start, start + limit),
      create: async ({ data }) => {
        if (rows.some(row => row.archiveKey === data.archiveKey)) throw new Error('Unique archive key');
        const entry = { ...structuredClone(data), createdAt: '2026-11-09T18:00:00.000Z' };
        rows.push(entry);
        return entry;
      },
    };
  } };
  try {
    const first = context('person-a', snapshot);
    const concurrent = context('person-a', snapshot);
    await Promise.all([controller.save(first), controller.save(concurrent)]);
    assert.deepEqual([first.status, concurrent.status].sort(), [200, 201]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actorAccountId, 7);
    const second = context('person-b', snapshot);
    await controller.save(second);
    assert.equal(second.status, 201);

    fullName = 'Nombre corregido';
    const retry = context('person-a', snapshot);
    await controller.save(retry);
    assert.equal(retry.status, 200);
    const stale = context('person-a', { ...snapshot, documents: { ...snapshot.documents, issuedOn: '2026-07-02' } });
    await controller.save(stale);
    assert.equal(stale.status, 409);

    const list = context('person-a', null);
    await controller.list(list);
    assert.equal(list.body.entries.length, 1);
    assert.equal(list.body.entries[0].snapshot.employee.fullName, identity.fullName);
    assert.deepEqual(list.body.entries[0].snapshot.documents.workplace, snapshot.documents.workplace);
    assert.equal(list.body.entries[0].id, first.body.id);
  } finally {
    delete global.strapi;
  }
});
