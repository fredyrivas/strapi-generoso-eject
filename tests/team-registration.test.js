'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const registration = require('../src/api/team-employee/services/team-registration');
const policy = require('../src/api/team-employee/policies/team-admin');
const configureTeam = require('../src/team-config');
const path = require('node:path');
const registerAllRoutes = require(path.join(path.dirname(require.resolve('@strapi/core/package.json')), 'dist/services/server/register-routes'));
const teamRouter = require('../src/api/team-employee/routes/team-employee');

const input = { fullName: 'María Pérez', startDate: '2026-10-27', phone: '5512345678', position: 'Barista', email: ' PERSONA@example.test ', teamRole: 'employee' };

function harness({ existingAccounts = [], failUpdate = false } = {}) {
  const state = { accounts: structuredClone(existingAccounts), employees: [], calls: [], locks: 0 };
  let queue = Promise.resolve();
  const docs = {
    async update(query) {
      if (failUpdate) throw new Error('simulated persistence failure');
      const entry = state.employees.find((entry) => entry.documentId === query.documentId);
      Object.assign(entry, query.data);
      return entry;
    },
    async findMany(query) { state.calls.push(query); return state.employees; },
    async count() { return state.employees.length; },
  };
  const strapi = {
    documents: () => docs,
    db: {
      async transaction(operation) {
        const previous = queue;
        let release;
        queue = new Promise((resolve) => { release = resolve; });
        await previous;
        const before = structuredClone({ accounts: state.accounts, employees: state.employees });
        try {
          return await operation({ trx: { raw: async (sql, bindings) => {
            assert.match(sql, /pg_advisory_xact_lock/); assert.equal(bindings[0], 'generoso:team:email:persona@example.test'); state.locks++;
          } } });
        } catch (error) { state.accounts = before.accounts; state.employees = before.employees; throw error; }
        finally { release(); }
      },
      query(uid) {
        return uid.endsWith('.role') ? { findOne: async ({ where }) => { assert.equal(where.type, 'teamemployee'); return { id: 2, type: 'teamemployee' }; } } : {
          findMany: async ({ where }) => state.accounts.filter((account) => account.email.toLowerCase() === where.email.$eqi),
        };
      },
    },
    plugin: () => ({ service: () => ({ add: async (values) => {
      const account = { ...values, id: state.accounts.length + 1 };
      state.accounts.push(account);
      return account;
    } }) }),
    service: () => ({
      findForAccount: async (id) => state.employees.find((entry) => entry.account.id === id),
      createForAccount: async (id, details) => {
        const entry = { ...details, documentId: `employee-${id}`, status: 'invited', account: state.accounts.find((account) => account.id === id) };
        state.employees.push(entry);
        return entry;
      },
    }),
  };
  return { service: registration({ strapi }), state };
}

test('registration normalizes email and rejects credential or activation injection', () => {
  assert.equal(registration.registrationDetails(input).email, 'persona@example.test');
  for (const extra of [{ email: 'invalid' }, { password: 'not-allowed' }, { confirmed: true }, { status: 'active' }, { role: 'backstageadmin' }, { invitationTokenHash: 'chosen' }]) {
    assert.throws(() => registration.registrationDetails({ ...input, ...extra }), { name: 'ValidationError' });
  }
});

test('creates an unconfirmed account without a password and stores only a hash of the 72-hour invitation', async () => {
  const { service, state } = harness();
  const before = Date.now();
  const result = await service.prepareInvitation(input);
  assert.equal(state.accounts[0].email, 'persona@example.test');
  assert.equal(state.accounts[0].confirmed, false);
  assert.equal(state.accounts[0].role, 2);
  assert.equal(state.accounts[0].password, undefined);
  assert.equal(state.accounts[0].confirmationToken, undefined);
  assert.match(result.invitation.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(state.employees[0].invitationTokenHash, createHash('sha256').update(result.invitation.token).digest('hex'));
  assert.ok(new Date(result.invitation.expiresAt).getTime() >= before + 72 * 3600000);
  assert.ok(new Date(result.invitation.expiresAt).getTime() <= Date.now() + 72 * 3600000);
  assert.equal(result.employee.status, 'invited');
  assert.equal(result.employee.account, undefined);
  assert.equal(result.employee.invitationTokenHash, undefined);
});

test('reusing an existing local account preserves its password, confirmation and role', async () => {
  const account = { id: 1, email: 'persona@example.test', provider: 'local', password: 'unchanged', confirmed: true, role: 9, blocked: false };
  const { service, state } = harness({ existingAccounts: [account] });
  await service.prepareInvitation(input);
  assert.deepEqual(state.accounts, [account]);
});

test('concurrent duplicate registrations produce one account, profile and invitation', async () => {
  const { service, state } = harness();
  const results = await Promise.allSettled([service.prepareInvitation(input), service.prepareInvitation(input)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.details.code, 'TEAM_CONFLICT');
  assert.equal(state.accounts.length, 1);
  assert.equal(state.employees.length, 1);
  assert.equal(state.locks, 2);
});

test('a failed invitation write rolls back account and employee creation', async () => {
  const { service, state } = harness({ failUpdate: true });
  await assert.rejects(service.prepareInvitation(input), /persistence failure/);
  assert.equal(state.accounts.length, 0);
  assert.equal(state.employees.length, 0);
});

test('ambiguous emails, blocked accounts and non-local accounts cannot be linked', async () => {
  for (const existingAccounts of [
    [{ id: 1, email: 'persona@example.test', provider: 'local', blocked: true }],
    [{ id: 1, email: 'persona@example.test', provider: 'google' }],
    [{ id: 1, email: 'persona@example.test' }, { id: 2, email: 'PERSONA@example.test' }],
  ]) {
    const { service, state } = harness({ existingAccounts });
    await assert.rejects(service.prepareInvitation(input), (error) => error.details.code === 'TEAM_CONFLICT');
    assert.equal(state.employees.length, 0);
  }
});

test('admin list paginates and never returns stored token hashes', async () => {
  const { service, state } = harness();
  await service.prepareInvitation(input);
  const result = await service.list('1');
  assert.equal(result.pagination.total, 1);
  assert.equal(result.employees[0].invitationTokenHash, undefined);
  assert.equal(state.calls[0].limit, 25);
  assert.equal(state.calls[0].fields.includes('invitationTokenHash'), false);
  for (const page of ['0', '-1', '1.5', '100000', 'x']) await assert.rejects(service.list(page), { name: 'ValidationError' });
});

test('business policy accepts the initial administrator or an active Team administrator only', async () => {
  const base = { id: 1, confirmed: true, blocked: false, username: 'admin', email: 'admin@example.test', role: { type: 'backstageadmin' } };
  for (const [user, profile, allowed] of [
    [null, null, false], [base, null, true], [{ ...base, confirmed: false }, null, false],
    [{ ...base, blocked: true }, null, false], [base, { status: 'inactive', teamRole: 'admin' }, false],
    [{ ...base, role: { type: 'authenticated' } }, null, false],
    [{ ...base, role: { type: 'authenticated' } }, { status: 'invited', teamRole: 'admin' }, false],
    [{ ...base, role: { type: 'authenticated' } }, { status: 'active', teamRole: 'employee' }, false],
    [{ ...base, role: { type: 'authenticated' } }, { status: 'active', teamRole: 'admin' }, true],
  ]) {
    const context = { state: { user } };
    const strapi = { documents: () => ({ findFirst: async () => profile }) };
    assert.equal(await policy(context, {}, { strapi }), allowed);
    assert.equal(Boolean(context.state.teamAdmin), allowed);
  }
});

test('Team setup disables public signup without altering other auth settings or existing permissions', async () => {
  let role = null;
  let creates = 0;
  let saves = 0;
  let settings = { allow_register: true, email_confirmation: false, unique_email: true, default_role: 'authenticated' };
  const strapi = {
    db: {
      transaction: async (operation) => operation({ trx: { raw: async () => {} } }),
      query: () => ({ findOne: async () => role, create: async ({ data }) => { creates++; role = { ...data, permissions: [] }; } }),
    },
    store: () => ({ get: async () => settings, set: async ({ value }) => { saves++; settings = value; } }),
  };
  await configureTeam(strapi);
  assert.deepEqual(settings, { allow_register: false, email_confirmation: false, unique_email: true, default_role: 'authenticated' });
  assert.equal(role.type, 'teamemployee');
  role.permissions.push('existing-custom-permission');
  await configureTeam(strapi);
  assert.equal(creates, 1);
  assert.equal(saves, 1);
  assert.deepEqual(role.permissions, ['existing-custom-permission']);
});

test('real Strapi route registration preserves Team policy authorization without injecting action scopes', async () => {
  const registered = [];
  const calls = [];
  const api = { routes: { team: teamRouter } };
  const strapi = {
    admin: { routes: {} }, plugins: {}, apis: { 'team-employee': api },
    api: () => api,
    dirs: { app: { root: '/private/tmp' } },
    config: { get: (key, fallback) => key === 'server.openapi' ? { 'content-api': { access: 'disabled' }, admin: { access: 'disabled' } } : fallback },
    contentAPI: { applyExtraParamsToRoutes: () => {} },
    server: { routes: (router) => registered.push(router) },
    controller: (uid) => { assert.equal(uid, 'api::team-employee.team-admin'); return {
      session: (ctx) => { calls.push(['session', ctx]); },
      list: (ctx) => { calls.push(['list', ctx]); },
      create: (ctx) => { calls.push(['create', ctx]); },
      regenerate: (ctx) => { calls.push(['regenerate', ctx]); },
      cancel: (ctx) => { calls.push(['cancel', ctx]); },
    }; },
  };
  registerAllRoutes(strapi);
  assert.equal(registered.length, 1);
  const routes = registered[0].routes;
  assert.equal(routes.length, 5);
  for (const route of routes) {
    assert.deepEqual(route.config.auth.scope, []);
    assert.deepEqual(route.config.auth.strategies, ['users-permissions']);
    assert.deepEqual(route.config.policies, ['api::team-employee.team-admin']);
    await route.handler('test-context');
  }
  assert.deepEqual(calls.map(([action]) => action), ['session', 'list', 'create', 'regenerate', 'cancel']);
  assert.notEqual(routes[0].config, routes[1].config);
});

test('invitation listing filters rows and totals before pagination and rejects arbitrary status filters', async () => {
  const calls=[];
  const service=registration({ strapi: { documents: () => ({ findMany: async query => { calls.push(query); return []; }, count: async query => { calls.push(query); return 3; } }) } });
  const result=await service.list('2','invited');
  assert.deepEqual(calls.map(query=>query.filters),[{status:'invited'},{status:'invited'}]);
  assert.equal(calls[0].start,25); assert.equal(calls[0].limit,25); assert.equal(result.pagination.total,3);
  for (const value of ['active','inactive',{},['invited'],'']) await assert.rejects(service.list('1',value),{name:'ValidationError'});
});
