'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { createContentType } = require(path.join(path.dirname(require.resolve('@strapi/core/package.json')), 'dist/domain/content-type'));
const entityValidator = require(path.join(path.dirname(require.resolve('@strapi/core/package.json')), 'dist/services/entity-validator'));
const schema = require('../src/api/team-employee/content-types/team-employee/schema.json');
const createService = require('../src/api/team-employee/services/team-employee');
const { validateEmployeeDetails, employeeProfile } = require('../src/api/team-employee/utils/employee-details');

const UID = 'api::team-employee.team-employee';
const valid = { fullName: '  María   Pérez López ', startDate: '2024-02-29', phone: '(55) 1234-5678', position: ' Barista ' };
const expected = { fullName: 'María Pérez López', startDate: '2024-02-29', phone: '+525512345678', position: 'Barista' };

function harness() {
  const entries = new Map();
  const accounts = new Map([[1, { email: 'uno@example.test' }], [2, { email: 'dos@example.test' }]]);
  const calls = { create: [], update: [], lock: 0, transactions: 0 };
  let queue = Promise.resolve();
  const documents = {
    async findFirst(query) {
      assert.deepEqual(query.populate, { account: { fields: ['email'] } });
      return entries.get(query.filters.account.id) ?? null;
    },
    async create(query) {
      calls.create.push(query);
      const accountId = query.data.account;
      const entry = { ...query.data, documentId: `employee-${accountId}`, account: accounts.get(accountId) };
      entries.set(accountId, entry);
      return entry;
    },
    async update(query) {
      calls.update.push(query);
      const pair = [...entries].find(([, entry]) => entry.documentId === query.documentId);
      assert.ok(pair, 'updates address the existing document');
      const [accountId, current] = pair;
      const entry = { ...current, ...query.data };
      entries.set(accountId, entry);
      return entry;
    },
  };
  const strapi = {
    documents(uid) { assert.equal(uid, UID); return documents; },
    db: {
      metadata: { get(uid) { assert.equal(uid, 'plugin::users-permissions.user'); return { tableName: 'up_users' }; } },
      async transaction(operation) {
        calls.transactions++;
        const previous = queue;
        let release;
        queue = new Promise((resolve) => { release = resolve; });
        await previous;
        try { return await operation({ trx: 'test-transaction' }); } finally { release(); }
      },
      connection(table) {
        assert.equal(table, 'up_users');
        let accountId;
        let locked = false;
        return {
          transacting(trx) { assert.equal(trx, 'test-transaction'); return this; },
          select(field) { assert.equal(field, 'id'); return this; },
          where(where) { accountId = where.id; return this; },
          forUpdate() { locked = true; calls.lock++; return this; },
          async first() { assert.ok(locked); return accounts.has(accountId) ? { id: accountId } : null; },
        };
      },
    },
  };
  return { service: createService({ strapi }), entries, accounts, calls };
}

test('normalizes editable fields without altering names or duplicating email', () => {
  assert.deepEqual(validateEmployeeDetails(valid), expected);
  assert.equal(validateEmployeeDetails({ ...valid, phone: '+34 612 345 678' }).phone, '+34612345678');
  assert.deepEqual(validateEmployeeDetails({ position: 'Encargada' }, { partial: true }), { position: 'Encargada' });
});

test('rejects missing details, impossible dates and malformed phone numbers', () => {
  for (const input of [null, [], {}, { ...valid, fullName: ' ' }, { ...valid, position: null },
    { ...valid, startDate: '2025-02-29' }, { ...valid, startDate: '2024-02-30' },
    { ...valid, startDate: '2026-10-27T00:00:00Z' }, { ...valid, phone: '55123' },
    { ...valid, phone: '++525512345678' }, { ...valid, phone: '55AB12345678' }]) {
    assert.throws(() => validateEmployeeDetails(input), { name: 'ValidationError' });
  }
  assert.throws(() => validateEmployeeDetails({}, { partial: true }), { name: 'ValidationError' });
  assert.throws(() => validateEmployeeDetails({ phone: '' }, { partial: true }), { name: 'ValidationError' });
});

test('profile edits cannot overwrite account credentials, association or activation state', () => {
  for (const key of ['account', 'email', 'password', 'confirmed', 'blocked', 'role', 'status', 'documentId']) {
    assert.throws(() => validateEmployeeDetails({ [key]: 'anything' }, { partial: true }), { name: 'ValidationError' });
  }
  assert.throws(() => validateEmployeeDetails({ ...valid, teamRole: 'backstageadmin' }), { name: 'ValidationError' });
});

test('Strapi 5 accepts the schema and enforces field and required-account validation', async () => {
  const previousStrapi = global.strapi;
  let model;
  global.strapi = {
    config: { get: () => false },
    getModel: (uid) => { assert.equal(uid, UID); return model; },
    db: { query: () => ({ count: async () => 1 }) },
  };
  try {
    model = createContentType(UID, { schema });
    assert.equal(model.options.draftAndPublish, false);
    assert.equal(model.attributes.account.relation, 'oneToOne');
    const input = { ...expected, account: 1, status: 'invited', teamRole: 'employee' };
    const result = await entityValidator.validateEntityCreation(model, input, { strictRelations: true });
    assert.equal(result.fullName, expected.fullName);
    for (const data of [{ ...input, account: null }, { ...input, phone: 'invalid' }, { ...input, teamRole: 'backstageadmin' }]) {
      await assert.rejects(entityValidator.validateEntityCreation(model, data, { strictRelations: true }), { name: 'ValidationError' });
    }
  } finally {
    if (previousStrapi === undefined) delete global.strapi;
    else global.strapi = previousStrapi;
  }
});

test('new profiles link to an existing account and start invited with a separate Team role', async () => {
  const { service, calls } = harness();
  const profile = await service.createForAccount(1, valid);
  assert.deepEqual(profile, { ...expected, documentId: 'employee-1', email: 'uno@example.test', status: 'invited', teamRole: 'employee' });
  assert.equal(calls.create[0].data.account, 1);
  assert.equal(calls.create[0].data.email, undefined);
  assert.equal(calls.lock, 1);
});

test('two concurrent requests cannot create two employees for the same account', async () => {
  const { service, calls } = harness();
  const results = await Promise.allSettled([service.createForAccount(1, valid), service.createForAccount(1, valid)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.name, 'ApplicationError');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.lock, 2);
});

test('different employees can share their name and position, while reads remain account scoped', async () => {
  const { service } = harness();
  await service.createForAccount(1, valid);
  await service.createForAccount(2, valid);
  assert.equal((await service.findForAccount(1)).email, 'uno@example.test');
  assert.equal((await service.findForAccount(2)).email, 'dos@example.test');
});

test('editing updates the same document and leaves unrelated fields and account email intact', async () => {
  const { service, entries, calls, accounts } = harness();
  const initial = await service.createForAccount(1, valid);
  accounts.get(1).email = 'nuevo@example.test';
  const updated = await service.updateForAccount(1, { position: ' Encargada ', teamRole: 'admin' });
  assert.equal(updated.documentId, initial.documentId);
  assert.equal(updated.fullName, initial.fullName);
  assert.equal(updated.email, 'nuevo@example.test');
  assert.equal(updated.position, 'Encargada');
  assert.equal(updated.teamRole, 'admin');
  assert.equal(updated.status, 'invited');
  assert.deepEqual(calls.update[0].data, { position: 'Encargada', teamRole: 'admin' });
  assert.equal(calls.create.length, 1);
  assert.equal(entries.size, 1);
});

test('missing or malformed accounts never create a disconnected employee', async () => {
  const { service, calls } = harness();
  for (const id of [0, -1, NaN, '1', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(service.createForAccount(id, valid), { name: 'ValidationError' });
  }
  await assert.rejects(service.createForAccount(3, valid), { name: 'NotFoundError' });
  await assert.rejects(service.updateForAccount(2, { position: 'Encargada' }), { name: 'NotFoundError' });
  assert.equal(await service.findForAccount(2), null);
  assert.equal(calls.create.length, 0);
});

test('returned profiles explicitly omit account credentials, tokens and arbitrary fields', () => {
  const profile = employeeProfile({
    ...expected, documentId: 'profile', teamRole: 'employee', status: 'active', secret: 'hidden',
    account: { email: 'uno@example.test', password: 'secret', confirmationToken: 'secret', resetPasswordToken: 'secret', role: { name: 'backstageadmin' } },
  });
  assert.deepEqual(Object.keys(profile).sort(), ['documentId', 'email', 'fullName', 'phone', 'position', 'startDate', 'status', 'teamRole']);
  assert.throws(() => employeeProfile({ ...expected, account: null }), /cuenta vinculada/);
});
