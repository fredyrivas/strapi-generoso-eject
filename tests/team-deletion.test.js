'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const factory = require('../src/api/team-employee/services/team-deletion');
const router = require('../src/api/team-employee/routes/deletions');
const { LOCK } = require('../src/api/team-employee/utils/attendance');
const { Readable } = require('node:stream');
const Koa = require('koa');
const { koaBody } = require('koa-body');
const middlewares = require('../config/middlewares');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user', A = 'api::team-checkin.team-checkin', OLD = 'api::checkin.checkin';
const confirmation = { confirmed: true, confirmationEmail: 'person@example.test', legacyDocumentIds: [] };

test('configured body parser preserves the deletion confirmation and existing write methods', async () => {
  const bodyConfig = middlewares.find(entry => entry === 'strapi::body' || entry.name === 'strapi::body');
  const parse = koaBody(typeof bodyConfig === 'string' ? {} : bodyConfig.config);
  const app = new Koa();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const payload = Buffer.from(JSON.stringify(confirmation));
    const req = Readable.from([payload]);
    req.method = method; req.url = '/api/team-admin/employees/person-2';
    req.headers = { 'content-type': 'application/json', 'content-length': String(payload.length) };
    const ctx = app.createContext(req, {});
    await parse(ctx, async () => {
      assert.deepEqual(ctx.request.body, confirmation, `${method} confirmation must reach the service`);
      assert.deepEqual(factory.deletionInput(ctx.request.body), { confirmationEmail: confirmation.confirmationEmail, legacyDocumentIds: [] });
    });
  }
});

function harness(options = {}) {
  const state = {
    accounts: [
      { id: 1, username: 'admin', email: 'admin@example.test', confirmed: true, blocked: false, role: { type: 'backstageadmin' } },
      { id: 2, username: 'person', email: 'person@example.test', confirmed: true, blocked: false, password: 'private-hash', role: { type: 'backstageadmin' } },
      { id: 3, username: 'other', email: 'other@example.test', confirmed: true, blocked: false, role: { type: 'teamemployee' } },
    ],
    employees: [
      { documentId: 'person-2', accountId: 2, fullName: 'Persona de prueba', status: 'active', teamRole: 'admin', invitationTokenHash: 'private', activationTokenHash: 'private', personalTokenHash: 'private' },
      { documentId: 'person-3', accountId: 3, fullName: 'Otra persona', status: 'active', teamRole: 'employee' },
    ],
    checkins: [{ documentId: 'arrival-1', employee: 'person-2', date: '2026-10-28' }, { documentId: 'arrival-old', employee: 'person-2', date: '2026-10-01' }, { documentId: 'arrival-other', employee: 'person-3', date: '2026-10-28' }],
    legacy: [{ documentId: 'legacy-own', empleado: 'Persona de prueba', fecha_dia: '2026-10-28', timestamp: '2026-10-28T14:03:00Z' }, { documentId: 'legacy-own', empleado: 'Persona de prueba', fecha_dia: '2026-10-28', timestamp: '2026-10-28T14:03:00Z' }, { documentId: 'same-name', empleado: 'Persona de prueba', fecha_dia: '2026-10-27', timestamp: null }, { documentId: 'unrelated', empleado: 'Otra persona', fecha_dia: '2026-10-28', timestamp: null }],
  };
  let queue = Promise.resolve();
  const populated = entry => entry ? { ...entry, account: state.accounts.find(account => account.id === entry.accountId) } : null;
  const strapi = {
    documents(uid) {
      if (uid === E) return {
        findOne: async ({ documentId }) => populated(state.employees.find(entry => entry.documentId === documentId)),
        findFirst: async ({ filters }) => state.employees.find(entry => entry.accountId === filters.account.id),
        delete: async ({ documentId }) => { state.employees = state.employees.filter(entry => entry.documentId !== documentId); },
      };
      if (uid === A) return {
        count: async ({ filters }) => state.checkins.filter(row => row.employee === filters.employee.documentId).length,
        findMany: async ({ filters, limit }) => structuredClone(state.checkins.filter(row => row.employee === filters.employee.documentId).slice(0, limit)),
        delete: async ({ documentId }) => { state.checkins = state.checkins.filter(row => row.documentId !== documentId); },
      };
      assert.equal(uid, OLD);
      return { delete: async ({ documentId }) => { state.legacy = state.legacy.filter(row => row.documentId !== documentId); } };
    },
    db: {
      metadata: { get: uid => ({ tableName: uid === E ? 'employees' : 'accounts' }) },
      connection: table => ({ transacting() { return this; }, select() { return this; }, where(input) { this.key = table === 'employees' ? input.document_id : input.id; return this; }, forUpdate() { return this; }, async first() { return table === 'employees' ? state.employees.find(entry => entry.documentId === this.key) : state.accounts.find(account => account.id === this.key); } }),
      query(uid) {
        if (uid === U) return { findOne: async ({ where }) => state.accounts.find(account => account.id === where.id) };
        assert.equal(uid, OLD);
        return { findMany: async ({ where, limit }) => structuredClone(state.legacy.filter(row => where.$or.some(filter => row.empleado.toLowerCase() === filter.empleado.$eqi.toLowerCase())).slice(0, limit)) };
      },
      transaction: async operation => {
        const previous = queue; let release; queue = new Promise(resolve => { release = resolve; }); await previous;
        const before = structuredClone(state);
        try { return await operation({ trx: { raw: async (sql, bindings) => { assert.match(sql, /pg_advisory_xact_lock/); assert.deepEqual(bindings, [LOCK]); } } }); }
        catch (error) { Object.assign(state, before); throw error; }
        finally { release(); }
      },
    },
    plugin: name => { assert.equal(name, 'users-permissions'); return { service: service => { assert.equal(service, 'user'); return { remove: async ({ id }) => {
      const account = state.accounts.find(account => account.id === id);
      state.accounts = state.accounts.filter(account => account.id !== id);
      if (options.failAccountRemoval) throw new Error('controlled-account-delete-failure');
      return account;
    } }; } }; },
  };
  return { state, service: factory({ strapi }) };
}

test('preview projects exact identity and all linked arrivals without exposing credentials or assigning name-only records', async () => {
  const h = harness(), before = structuredClone(h.state);
  const preview = await h.service.preview('person-2', 1);
  assert.deepEqual(Object.keys(preview).sort(), ['documentId', 'fullName', 'email', 'canDelete', 'reason', 'checkins', 'legacyCandidates'].sort());
  assert.equal(preview.checkins, 2); assert.equal(preview.canDelete, true);
  assert.deepEqual(preview.legacyCandidates.map(row => row.documentId), ['legacy-own', 'same-name']);
  assert.doesNotMatch(JSON.stringify(preview), /private|password|accountId/);
  assert.deepEqual(h.state, before);
});

test('deletion removes the entire account, current profile, onboarding secrets and all linked attendance atomically', async () => {
  const h = harness();
  const others = { account: structuredClone(h.state.accounts[2]), employee: structuredClone(h.state.employees[1]), checkin: structuredClone(h.state.checkins[2]) };
  const result = await h.service.remove('person-2', { ...confirmation, confirmationEmail: ' PERSON@example.test ', legacyDocumentIds: ['legacy-own'] }, 1);
  assert.deepEqual(result, { status: 'deleted', documentId: 'person-2', accountDeleted: true, checkinsDeleted: 2, legacyDeleted: 1 });
  assert.equal(h.state.accounts.some(account => account.id === 2), false);
  assert.equal(h.state.employees.some(employee => employee.documentId === 'person-2'), false);
  assert.deepEqual(h.state.checkins, [others.checkin]);
  assert.deepEqual(h.state.accounts.find(account => account.id === 3), others.account);
  assert.deepEqual(h.state.employees[0], others.employee);
  assert.deepEqual(h.state.legacy.map(row => row.documentId), ['same-name', 'unrelated']);
});

test('name-only candidates are never deleted without explicit selection', async () => {
  const h = harness(), before = structuredClone(h.state.legacy);
  await h.service.remove('person-2', confirmation, 1);
  assert.deepEqual(h.state.legacy, before);
});

test('a failure after account removal rolls back the account, profile, attendance, invitation data and legacy copies', async () => {
  const h = harness({ failAccountRemoval: true }), before = structuredClone(h.state);
  await assert.rejects(h.service.remove('person-2', { ...confirmation, legacyDocumentIds: ['legacy-own'] }, 1), /controlled-account-delete-failure/);
  assert.deepEqual(h.state, before);
});

test('self-deletion is refused and administrator authorization is checked against current data', async () => {
  const self = harness(), before = structuredClone(self.state);
  assert.equal((await self.service.preview('person-2', 2)).canDelete, false);
  await assert.rejects(self.service.remove('person-2', confirmation, 2), /No puedes eliminar/);
  assert.deepEqual(self.state, before);
  for (const change of [{ blocked: true }, { confirmed: false }, { role: { type: 'teamemployee' } }]) {
    const h = harness(); Object.assign(h.state.accounts[0], change); const original = structuredClone(h.state);
    await assert.rejects(h.service.preview('person-2', 1), { name: 'ForbiddenError' });
    await assert.rejects(h.service.remove('person-2', confirmation, 1), { name: 'ForbiddenError' });
    assert.deepEqual(h.state, original);
  }
});

test('wrong email, forged account selectors and unrelated legacy identifiers never delete anything', async () => {
  for (const change of [{ confirmationEmail: 'other@example.test' }, { accountId: 3 }, { actorId: 1 }, { confirmed: false }, { legacyDocumentIds: ['unrelated'] }, { legacyDocumentIds: ['legacy-own', 'legacy-own'] }, { legacyDocumentIds: ['x/y'] }, { legacyDocumentIds: 'all' }]) {
    const h = harness(), before = structuredClone(h.state);
    await assert.rejects(h.service.remove('person-2', { ...confirmation, ...change }, 1));
    assert.deepEqual(h.state, before);
  }
});

test('concurrent deletion requests remove one account once; unknown or malformed identities never affect another account', async () => {
  const h = harness();
  const results = await Promise.allSettled([h.service.remove('person-2', confirmation, 1), h.service.remove('person-2', confirmation, 1)]);
  assert.deepEqual(results.map(row => row.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(h.state.accounts.length, 2);
  for (const documentId of [null, '', 'x/y', 'a'.repeat(129), 'unknown']) await assert.rejects(h.service.remove(documentId, confirmation, 1));
});

test('preview and deletion routes require authenticated administrative policy and function handlers', async () => {
  const called = [];
  const routes = router({ strapi: { controller: () => ({ deletionPreview: ctx => called.push(['preview', ctx]), remove: ctx => called.push(['remove', ctx]) }) } }).routes;
  assert.deepEqual(routes.map(route => [route.method, route.path]), [['GET', '/team-admin/employees/:documentId/deletion'], ['DELETE', '/team-admin/employees/:documentId']]);
  for (const route of routes) {
    assert.deepEqual(route.config.auth, { strategies: ['users-permissions'], scope: [] });
    assert.deepEqual(route.config.policies, ['api::team-employee.team-admin']);
    await route.handler('context');
  }
  assert.deepEqual(called, [['preview', 'context'], ['remove', 'context']]);
});
