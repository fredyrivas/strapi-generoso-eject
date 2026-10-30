'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const policy = require('../src/api/team-employee/policies/team-member');
const routerFactory = require('../src/api/team-employee/routes/members');
const maintenance = require('../src/api/team-employee/services/team-maintenance');

const employee = { documentId: 'employee-2', fullName: 'Persona de prueba', startDate: '2026-10-27', phone: '+525512345678', position: 'Barista', teamRole: 'employee', status: 'active', account: { id: 2, email: 'two@example.invalid' } };
const user = { id: 2, username: 'two', email: 'two@example.invalid', blocked: false, confirmed: true, role: { type: 'teamemployee' } };

test('member sessions authorize only the current active account and project the private profile safely', async () => {
  let query;
  const context = { state: { user } };
  assert.equal(await policy(context, {}, { strapi: { documents: () => ({ findFirst: async input => { query = input; return { ...employee, password: 'private', invitationTokenHash: 'private' }; } }) } }), true);
  assert.deepEqual(query.filters, { account: { id: 2 } });
  assert.deepEqual(context.state.teamSession.user, { username: 'two', email: 'two@example.invalid' });
  assert.equal(context.state.teamSession.canAdmin, false);
  assert.deepEqual(Object.keys(context.state.teamSession.profile).sort(), ['documentId', 'email', 'fullName', 'phone', 'position', 'startDate', 'status', 'teamRole']);
});

test('pending, inactive, blocked, unconfirmed and unrelated accounts cannot read a member profile', async () => {
  for (const [account, profile] of [[null, null], [{ ...user, blocked: true }, employee], [{ ...user, confirmed: false }, employee], [user, { ...employee, status: 'invited' }], [user, { ...employee, status: 'inactive' }], [user, null]]) {
    const context = { state: { user: account } };
    assert.equal(await policy(context, {}, { strapi: { documents: () => ({ findFirst: async () => profile }) } }), false);
    assert.equal(context.state.teamSession, undefined);
  }
});

test('bootstrap administration works without an active employee profile and Team admin status follows current data', async () => {
  for (const [account, profile, allowed, admin] of [[{ ...user, role: { type: 'backstageadmin' } }, null, true, true], [{ ...user, role: { type: 'backstageadmin' } }, { ...employee, status: 'invited' }, true, true], [{ ...user, role: { type: 'backstageadmin' } }, { ...employee, status: 'inactive' }, false, false], [user, { ...employee, teamRole: 'admin' }, true, true], [user, employee, true, false]]) {
    const context = { state: { user: account } };
    assert.equal(await policy(context, {}, { strapi: { documents: () => ({ findFirst: async () => profile }) } }), allowed);
    if (allowed) { assert.equal(context.state.teamSession.canAdmin, admin); if (profile?.status !== 'active') assert.equal(context.state.teamSession.profile, null); }
  }
});

function harness({ failUpdate = false } = {}) {
  const state = {
    accounts: [1, 2, 3].map(id => ({ id, username: 'user-' + id, email: id === 2 ? 'two@example.invalid' : 'user-' + id + '@example.invalid', password: 'unchanged-hash', role: 8, confirmed: true, provider: 'local', blocked: false })),
    entries: [2, 3].map(id => ({ ...employee, documentId: 'employee-' + id, accountId: id, invitationAccepted: true })),
    writes: [],
  };
  const populated = entry => entry ? { ...entry, account: { ...state.accounts.find(account => account.id === entry.accountId) } } : null;
  let queue = Promise.resolve();
  const strapi = {
    documents: () => ({
      findOne: async ({ documentId }) => populated(state.entries.find(entry => entry.documentId === documentId)),
      update: async ({ documentId, data }) => { if (failUpdate) throw new Error('controlled-update-failure'); const entry = state.entries.find(entry => entry.documentId === documentId); Object.assign(entry, data); state.writes.push(data); return populated(entry); },
    }),
    db: {
      metadata: { get: uid => ({ tableName: uid.startsWith('plugin::') ? 'accounts' : 'employees' }) },
      connection: table => ({ transacting() { return this; }, select() { return this; }, where(input) { this.id = table === 'accounts' ? input.id : input.document_id; return this; }, forUpdate() { return this; }, async first() { return table === 'accounts' ? state.accounts.find(account => account.id === this.id) : state.entries.find(entry => entry.documentId === this.id); } }),
      query: () => ({ findOne: async ({ where }) => where.$or ? state.accounts.find(account => account.id !== where.id.$ne && (account.email.toLowerCase() === where.$or[0].email.$eqi || account.username.toLowerCase() === where.$or[1].username.$eqi)) : state.accounts.find(account => account.id === where.id) }),
      transaction: async operation => {
        const previous = queue; let release; queue = new Promise(resolve => { release = resolve; }); await previous;
        const before = structuredClone(state);
        try { return await operation({ trx: { raw: async (sql, args) => { assert.match(sql, /pg_advisory_xact_lock/); assert.match(args[0], /^generoso:team:email:/); } } }); }
        catch (error) { Object.assign(state, before); throw error; }
        finally { release(); }
      },
    },
    plugin: () => ({ service: () => ({ edit: async (id, data) => { assert.deepEqual(Object.keys(data), ['email']); Object.assign(state.accounts.find(account => account.id === id), data); } }) }),
  };
  return { state, service: maintenance({ strapi }) };
}

test('maintenance accepts only editable current values and rejects credentials, linkage, activation and malformed data', () => {
  assert.deepEqual(maintenance.maintenanceInput({ fullName: '  Otra   persona ', phone: '5512345678', email: ' NEW@EXAMPLE.INVALID ', status: 'inactive' }), { fullName: 'Otra persona', phone: '+525512345678', email: 'new@example.invalid', status: 'inactive' });
  for (const input of [{}, [], null, { password: 'x' }, { confirmed: true }, { account: 3 }, { role: 'backstageadmin' }, { invitationAccepted: true }, { status: 'invited' }, { email: 'bad' }, { startDate: '2026-02-30' }, { teamRole: 'superadmin' }]) assert.throws(() => maintenance.maintenanceInput(input), { name: 'ValidationError' });
});

test('editing updates one profile and its current account without changing credentials, confirmation or Backstage role', async () => {
  const { state, service } = harness(); const before = structuredClone(state.accounts[1]);
  const result = await service.update('employee-2', { fullName: 'Nombre corregido', phone: '5598765432', email: ' NEW@example.invalid ', teamRole: 'admin' }, 1);
  assert.equal(result.employee.documentId, 'employee-2'); assert.equal(result.employee.fullName, 'Nombre corregido'); assert.equal(result.employee.email, 'new@example.invalid'); assert.equal(result.employee.teamRole, 'admin');
  assert.deepEqual(state.accounts[1], { ...before, email: 'new@example.invalid' }); assert.equal(state.entries.length, 2);
  assert.equal(result.employee.account, undefined); assert.equal(result.employee.password, undefined); assert.equal(result.employee.activationTokenHash, undefined);
});

test('duplicate email and username collisions are rejected without modifying either account', async () => {
  const { state, service } = harness(); state.accounts[2].username = 'alias@example.invalid'; const before = structuredClone(state);
  for (const email of ['USER-3@EXAMPLE.INVALID', 'alias@example.invalid']) await assert.rejects(service.update('employee-2', { email, fullName: 'Should not save' }, 1), error => error.details.code === 'TEAM_CONFLICT');
  assert.deepEqual(state, before);
});

test('two concurrent edits cannot assign the same normalized email to different people', async () => {
  const { state, service } = harness();
  const results = await Promise.allSettled([service.update('employee-2', { email: 'shared@example.invalid' }, 1), service.update('employee-3', { email: ' SHARED@example.invalid ' }, 1)]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']); assert.equal(state.accounts.filter(account => account.email === 'shared@example.invalid').length, 1);
});

test('failed profile changes roll back email updates on the same transaction', async () => {
  const { state, service } = harness({ failUpdate: true }); const before = structuredClone(state);
  await assert.rejects(service.update('employee-2', { email: 'new@example.invalid', position: 'Cocina' }, 1), /controlled-update-failure/); assert.deepEqual(state, before);
});

test('deactivation and reactivation update current state without bypassing onboarding or unblocking the account', async () => {
  const { state, service } = harness();
  state.entries[0].personalTokenHash = 'old-current-code';
  assert.equal((await service.update('employee-2', { status: 'inactive' }, 1)).employee.status, 'inactive');
  assert.equal(state.entries[0].personalTokenHash, null);
  assert.equal((await service.update('employee-2', { status: 'active' }, 1)).employee.status, 'active');
  assert.equal(state.entries[0].personalTokenHash, null);
  state.entries[0].status = 'invited'; await assert.rejects(service.update('employee-2', { status: 'active' }, 1)); await assert.rejects(service.update('employee-2', { status: 'inactive' }, 1));
  state.entries[0].status = 'inactive'; state.accounts[1].blocked = true; await assert.rejects(service.update('employee-2', { status: 'active' }, 1)); assert.equal(state.accounts[1].blocked, true);
});

test('administrators cannot deactivate themselves or change their own Team role', async () => {
  const { state, service } = harness(); const before = structuredClone(state);
  for (const data of [{ status: 'inactive' }, { teamRole: 'admin' }]) await assert.rejects(service.update('employee-2', data, 2)); assert.deepEqual(state, before);
  assert.equal((await service.update('employee-2', { position: 'Encargada' }, 2)).employee.position, 'Encargada');
});

test('unknown or malformed identifiers never update another employee', async () => {
  const { service } = harness(); for (const id of [null, '', 'x/y', 'a'.repeat(129), 'unknown']) await assert.rejects(service.update(id, { position: 'Cocina' }, 1));
  await assert.rejects(service.update('employee-2', { position: 'Cocina' }, null));
});

test('profile routes and admin maintenance use separate policies with function handlers and mandatory authentication', () => {
  const routes = routerFactory({ strapi: {} }).routes;
  assert.deepEqual(routes.map(route => route.path), ['/team/session/renew', '/team/session', '/team/profile', '/team-admin/employees/:documentId']);
  for (const route of routes) { assert.equal(typeof route.handler, 'function'); assert.deepEqual(route.config.auth, { strategies: ['users-permissions'], scope: [] }); assert.deepEqual(route.config.policies, [route.path.startsWith('/team/') ? 'api::team-employee.team-member' : 'api::team-employee.team-admin']); }
});

test('renewal issues a Team-only 400-day JWT using the existing authenticated account', async () => {
  const controller = require('../src/api/team-employee/controllers/team-member');
  const calls = []; global.strapi = { plugin: name => { assert.equal(name, 'users-permissions'); return { service: () => ({ issue: (payload, options) => { calls.push({ payload, options }); return 'renewed'; } }) }; } };
  try {
    const ctx = { state: { user: { id: 7 }, teamSession: { canAdmin: false, profile: employee } }, set() {} };
    await controller.renew(ctx);
    assert.deepEqual(calls, [{ payload: { id: 7 }, options: { expiresIn: '400d' } }]);
    assert.equal(ctx.body.jwt, 'renewed');
  } finally { delete global.strapi; }
});
