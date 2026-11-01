'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const createService = require('../src/api/team-employee/services/team-invitation');
const { newInvitation, invitationStatus } = require('../src/api/team-employee/utils/invitations');
const publicRouter = require('../src/api/team-employee/routes/invitations');
const { acceptanceInput } = require('../src/api/team-employee/utils/invitation-acceptance');

function harness(options = {}) {
  const account = { id: 7, email: 'test@example.invalid', blocked: false, provider: 'local', confirmed: false, ...(options.password ? { password: `hash:${options.password}` } : {}) };
  const invitation = newInvitation();
  let entry = { documentId: 'employee-1', fullName: 'Persona de prueba', startDate: '2026-10-27', phone: '+525512345678', position: 'Barista', teamRole: 'employee', status: 'invited', account, ...invitation.data };
  const calls = { reads: 0, writes: 0, locks: 0, passwordWrites: 0, confirmationWrites: 0, hashes: 0 };
  let queue = Promise.resolve();
  const strapi = {
    documents: () => ({
      findFirst: async ({ filters }) => { calls.reads++; return entry && entry.invitationTokenHash === filters.invitationTokenHash ? structuredClone(entry) : null; },
      findOne: async ({ documentId }) => entry?.documentId === documentId ? structuredClone(entry) : null,
      update: async ({ documentId, data }) => { assert.equal(documentId, entry.documentId); if (options.failConsume && data.invitationAccepted) throw new Error('consume failed'); calls.writes++; Object.assign(entry, data); return structuredClone(entry); },
    }),
    db: {
      metadata: { get: (uid) => ({ tableName: uid.startsWith('plugin::') ? 'up_users' : 'team_employees' }) },
      query: () => ({
        findOne: async () => structuredClone(account),
        update: async ({ where, data }) => {
          assert.equal(where.id, account.id);
          assert.deepEqual(Object.keys(data).sort(), ['confirmed', 'password']);
          assert.match(data.password, /^hash:/);
          calls.passwordWrites++; account.password = data.password; options.afterPasswordSaved?.(entry);
          calls.confirmationWrites++; account.confirmed = data.confirmed; options.afterConfirmed?.(entry);
          return structuredClone(account);
        },
      }),
      transaction: async (operation) => {
        const previous = queue;
        let release;
        queue = new Promise(resolve => { release = resolve; });
        await previous;
        const beforeEntry = structuredClone(entry);
        const beforeAccount = structuredClone(account);
        if (options.replaceBeforeLock) entry.invitationTokenHash = 'a'.repeat(64);
        try { return await operation({ trx: 'transaction' }); }
        catch (error) {
          for (const key of Object.keys(account)) delete account[key];
          Object.assign(account, beforeAccount);
          for (const key of Object.keys(entry)) delete entry[key];
          Object.assign(entry, beforeEntry);
          if (entry.account?.id === account.id) entry.account = account;
          throw error;
        } finally { release(); }
      },
      connection: (table) => {
        let id;
        let locked = false;
        return {
          transacting(trx) { assert.equal(trx, 'transaction'); return this; },
          select() { return this; },
          where(where) { id = table === 'up_users' ? where.id : where.document_id; return this; },
          forUpdate() { calls.locks++; locked = true; return this; },
          async first() { assert.ok(locked); return (table === 'up_users' ? account.id === id : entry?.documentId === id) ? { id: 1 } : null; },
        };
      },
    },
  };
  strapi.plugin = () => ({ service: () => ({
    validatePassword: async (password, hash) => hash === `hash:${password}`,
    ensureHashedPasswords: async data => { calls.hashes++; return { ...data, password: `hash:${data.password}` }; },
    edit: async (_id, data) => { if (data.password !== undefined) { calls.passwordWrites++; account.password = `hash:${data.password}`; options.afterPasswordSaved?.(entry); } if (data.confirmed !== undefined) { calls.confirmationWrites++; account.confirmed = data.confirmed; options.afterConfirmed?.(entry); } },
  }) });
  return { account, service: createService({ strapi }), calls, invitation, entry, remove: () => { entry = null; } };
}

test('validating a pending invitation returns only the review fields and password mode without credentials', async () => {
  const { service, invitation, calls } = harness();
  for (let index = 0; index < 2; index++) {
    const result = await service.validate(invitation.token);
    assert.equal(result.status, 'pending');
    assert.equal(result.name, 'Persona de prueba');
    assert.ok(result.expiresInSeconds > 0 && result.expiresInSeconds <= 72 * 3600);
    assert.equal(result.passwordMode, 'create');
    assert.deepEqual(Object.keys(result.profile).sort(), ['email', 'fullName', 'phone', 'position', 'startDate']);
    assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'expiresInSeconds', 'name', 'passwordMode', 'profile', 'status']);
  }
  assert.equal(calls.writes, 0);
});

test('malformed codes avoid database access; unknown and changed codes fail closed', async () => {
  const { service, calls } = harness();
  for (const token of [null, undefined, '', 'short', 'a'.repeat(44), '/'.repeat(43)]) assert.deepEqual(await service.validate(token), { status: 'invalid' });
  assert.equal(calls.reads, 0);
  assert.deepEqual(await service.validate('a'.repeat(43)), { status: 'invalid' });
});

test('expiration uses server time and rejects the exact expiration boundary', async () => {
  const { service, invitation, entry } = harness();
  entry.invitationExpiresAt = new Date(Date.now() - 1000).toISOString();
  assert.deepEqual(await service.validate(invitation.token), { status: 'expired', expiresAt: entry.invitationExpiresAt });
  assert.equal(invitationStatus(entry, Date.parse(entry.invitationExpiresAt)), 'expired');
  entry.invitationExpiresAt = 'invalid-date';
  assert.deepEqual(await service.validate(invitation.token), { status: 'invalid' });
});

test('cancel immediately invalidates authorization and is idempotent on the same record', async () => {
  const { service, invitation, entry, calls } = harness();
  const before = structuredClone(entry);
  const first = await service.cancel(entry.documentId);
  assert.equal(first.employee.invitationStatus, 'cancelled');
  assert.deepEqual(await service.validate(invitation.token), { status: 'cancelled' });
  await service.cancel(entry.documentId);
  assert.equal(calls.writes, 1);
  assert.deepEqual(entry, { ...before, invitationCancelled: true });
  assert.equal(first.employee.invitationTokenHash, undefined);
  assert.equal(first.employee.invitationCancelled, undefined);
});

test('regeneration replaces the current code without changing the profile, account or role', async () => {
  const { service, invitation, entry, calls } = harness();
  await service.cancel(entry.documentId);
  const result = await service.regenerate(entry.documentId);
  assert.notEqual(result.invitation.token, invitation.token);
  assert.equal(result.employee.documentId, entry.documentId);
  assert.equal(result.employee.status, 'invited');
  assert.equal(result.employee.teamRole, 'employee');
  assert.equal(result.employee.invitationStatus, 'pending');
  assert.equal(entry.invitationCancelled, false);
  assert.deepEqual(await service.validate(invitation.token), { status: 'invalid' });
  assert.equal((await service.validate(result.invitation.token)).status, 'pending');
  assert.equal(calls.writes, 2);
  assert.equal(entry.account.email, 'test@example.invalid');
});

test('an expired invitation can be regenerated and only the final concurrent code remains current', async () => {
  const { service, entry, invitation } = harness();
  entry.invitationExpiresAt = new Date(Date.now() - 1000).toISOString();
  const [first, last] = await Promise.all([service.regenerate(entry.documentId), service.regenerate(entry.documentId)]);
  assert.deepEqual(await service.validate(invitation.token), { status: 'invalid' });
  assert.deepEqual(await service.validate(first.invitation.token), { status: 'invalid' });
  assert.equal((await service.validate(last.invitation.token)).status, 'pending');
});

test('active, inactive, blocked and disconnected accounts cannot validate or regenerate their invitations', async () => {
  for (const update of [{ status: 'active' }, { status: 'inactive' }, { account: null }, { account: { blocked: true } }]) {
    const { service, invitation, entry, calls } = harness();
    Object.assign(entry, update);
    assert.deepEqual(await service.validate(invitation.token), { status: 'invalid' });
    for (const action of ['cancel', 'regenerate']) await assert.rejects(service[action](entry.documentId), error => error.details.code === 'TEAM_CONFLICT');
    assert.equal(calls.writes, 0);
  }
});

test('unknown or malformed employee IDs never update a different employee', async () => {
  const { service, calls } = harness();
  await assert.rejects(service.cancel('unknown'), { name: 'NotFoundError' });
  for (const value of [undefined, '', 'employee/other', 'a'.repeat(129)]) await assert.rejects(service.regenerate(value), { name: 'ValidationError' });
  assert.equal(calls.writes, 0);
});

test('public validation has a limited response route and strips arbitrary email-based limiter keys', async () => {
  let invoked = false;
  const router = publicRouter({ strapi: { controller: () => ({ validate: () => { invoked = true; } }) } });
  const route = router.routes[0];
  assert.equal(route.config.auth, false);
  assert.equal(route.path, '/team-invitations/validate');
  assert.equal(route.config.middlewares[1].name, 'plugin::users-permissions.rateLimit');
  assert.equal(route.config.middlewares[1].config.max, 60);
  const ctx = { request: { body: { token: 'value', email: 'bypass@example.invalid' } } };
  await route.config.middlewares[0](ctx, async () => {});
  assert.deepEqual(ctx.request.body, { token: 'value' });
  await route.handler(ctx);
  assert.equal(invoked, true);
});

const newPassword = 'Una-frase-segura-para-pruebas';
const accepting = (token, password = newPassword) => ({ token, mode: 'create', password, passwordConfirmation: password, reviewConfirmed: true });

test('acceptance requires a nonempty password, exact confirmation and the technical UTF-8 bcrypt limit without strength rules', () => {
  const valid = accepting('a'.repeat(43));
  assert.equal(acceptanceInput(valid).password, newPassword);
  for (const changes of [{ reviewConfirmed: false }, { reviewConfirmed: 'true' }, { password: '' }, { password: null }, { passwordConfirmation: 'different' }, { password: 'x'.repeat(73), passwordConfirmation: 'x'.repeat(73) }, { password: '🙂'.repeat(20) }, { confirmed: true }, { role: 'admin' }, { fullName: 'Other' }]) {
    assert.throws(() => acceptanceInput({ ...valid, ...changes }), { name: 'ValidationError' });
  }
  for (const password of ['a', '123', '123456', 'passwordpassword', 'aaaaaaaaaaaaaaa', 'x'.repeat(72), '🙂'.repeat(18)]) assert.equal(acceptanceInput(accepting(valid.token, password)).password, password);
  assert.equal(acceptanceInput({ token: valid.token, mode: 'existing', currentPassword: 'legacy-short-password', reviewConfirmed: true }).currentPassword, 'legacy-short-password');
});

test('accepting a new account hashes via Strapi once and activates atomically and discards the onboarding codes without role changes', async () => {
  const { service, invitation, entry, calls, account } = harness();
  const result = await service.accept(accepting(invitation.token));
  assert.deepEqual(result, { status: 'activated' });
  assert.equal(calls.passwordWrites, 1);
  assert.equal(calls.hashes, 1);
  assert.equal(account.password, `hash:${newPassword}`);
  assert.equal(account.confirmed, true);
  assert.equal(entry.status, 'active');
  for (const key of ['invitationTokenHash', 'invitationExpiresAt', 'activationTokenHash', 'activationExpiresAt']) assert.equal(entry[key], null);
  assert.equal(entry.teamRole, 'employee');
  assert.equal(entry.invitationAccepted, true);
  assert.deepEqual(await service.validate(invitation.token), { status: 'invalid' });
  await assert.rejects(service.accept(accepting(invitation.token, 'Otra-frase-segura-de-prueba')), error => error.details.code === 'TEAM_CONFLICT');
  for (const action of ['cancel', 'regenerate']) await assert.rejects(service[action](entry.documentId), error => error.details.code === 'TEAM_CONFLICT');
  assert.equal(calls.passwordWrites, 1);
});

test('short and common new passwords activate the invited account and remain usable for authentication', async () => {
  for (const password of ['a', '123', 'passwordpassword', 'aaaaaaaa']) {
    const h = harness();
    assert.deepEqual(await h.service.accept(accepting(h.invitation.token, password)), { status: 'activated' });
    assert.equal(h.account.password, `hash:${password}`);
    assert.equal(h.account.confirmed, true);
    assert.equal(h.entry.status, 'active');
    assert.equal(h.calls.hashes, 1);
    assert.equal(h.calls.passwordWrites, 1);
  }
});

test('the installed Strapi password hasher accepts a one-character password and produces a hash its login verifier accepts', async () => {
  const path = require('node:path');
  const usersFactory = require(path.join(path.dirname(require.resolve('@strapi/plugin-users-permissions/package.json')), 'server/src/services/user'));
  const users = usersFactory({ strapi: { getModel: () => ({ attributes: { password: { type: 'password', minLength: 6, encryption: { rounds: 4 } } } }) } });
  for (const password of ['a', '123', 'passwordpassword', '🙂']) {
    const hashed = await users.ensureHashedPasswords({ password });
    assert.notEqual(hashed.password, password);
    assert.match(hashed.password, /^\$2[aby]\$/);
    assert.equal(await users.validatePassword(password, hashed.password), true);
    assert.equal(await users.validatePassword(`${password}-wrong`, hashed.password), false);
  }
});

test('existing accounts require their current password and preserve the existing hash and confirmation', async () => {
  const { service, invitation, account, calls } = harness({ password: 'existing-password' });
  account.confirmed = true;
  assert.equal((await service.validate(invitation.token)).passwordMode, 'existing');
  await assert.rejects(service.accept(accepting(invitation.token)), error => error.details.code === 'TEAM_CONFLICT');
  await assert.rejects(service.accept({ token: invitation.token, mode: 'existing', currentPassword: 'incorrect', reviewConfirmed: true }), { name: 'ValidationError' });
  const result = await service.accept({ token: invitation.token, mode: 'existing', currentPassword: 'existing-password', reviewConfirmed: true });
  assert.equal(result.status, 'activated');
  assert.equal(account.password, 'hash:existing-password');
  assert.equal(account.confirmed, true);
  assert.equal(calls.passwordWrites, 0);
});

test('failed consumption or an expiry crossed during password saving rolls back the password too', async () => {
  for (const options of [{ failConsume: true }, { afterConfirmed: (entry) => { Date.now = () => Date.parse(entry.invitationExpiresAt) + 1; } }, { afterPasswordSaved: (entry) => { Date.now = () => Date.parse(entry.invitationExpiresAt) + 1; } }]) {
    const { service, invitation, account, entry } = harness(options);
    const realNow = Date.now;
    try { await assert.rejects(service.accept(accepting(invitation.token))); } finally { Date.now = realNow; }
    assert.equal(account.password, undefined);
    assert.equal(account.confirmed, false);
    assert.equal(entry.status, 'invited');
    assert.equal(entry.invitationAccepted, false);
    assert.equal((await service.validate(invitation.token)).status, 'pending');
  }
});

test('two simultaneous acceptances allow only one password write', async () => {
  const { service, invitation, calls } = harness();
  const results = await Promise.allSettled([service.accept(accepting(invitation.token)), service.accept(accepting(invitation.token, 'Otra-frase-segura-para-pruebas'))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(calls.passwordWrites, 1);
});

test('acceptance cannot use a code replaced while waiting for the employee lock', async () => {
  const { service, invitation, calls } = harness({ replaceBeforeLock: true });
  await assert.rejects(service.accept(accepting(invitation.token)), error => error.details.code === 'TEAM_CONFLICT');
  assert.equal(calls.passwordWrites, 0);
});

test('cancelled and expired invitations never save a password', async () => {
  for (const changes of [{ invitationCancelled: true }, { invitationExpiresAt: new Date(Date.now() - 1000).toISOString() }]) {
    const { service, invitation, entry, calls } = harness();
    Object.assign(entry, changes);
    await assert.rejects(service.accept(accepting(invitation.token)), error => error.details.code === 'TEAM_CONFLICT');
    assert.equal(calls.passwordWrites, 0);
  }
});

test('public acceptance strips limiter aliases and profile injection while preserving only credential inputs', async () => {
  const route = publicRouter({ strapi: {} }).routes[1];
  assert.equal(route.config.auth, false);
  assert.equal(route.path, '/team-invitations/accept');
  assert.equal(route.config.middlewares[1].config.max, 10);
  const data = accepting('a'.repeat(43));
  const ctx = { request: { body: { ...data, email: 'rate-limit-bypass', confirmed: true, role: 'admin' } } };
  await route.config.middlewares[0](ctx, async () => {});
  assert.deepEqual(ctx.request.body, data);
});

test('an existing unconfirmed account activates only after proving its current password and preserves that hash', async () => {
  const { service, invitation, account, entry, calls } = harness({ password: 'existing-password' });
  const result = await service.accept({ token: invitation.token, mode: 'existing', currentPassword: 'existing-password', reviewConfirmed: true });
  assert.equal(result.status, 'activated'); assert.equal(account.confirmed, true); assert.equal(account.password, 'hash:existing-password');
  assert.equal(entry.status, 'active'); assert.equal(calls.passwordWrites, 0); assert.equal(calls.confirmationWrites, 1);
});
test('failure activating an existing account rolls back its confirmation and retains its invitation and password', async () => {
  const { service, invitation, account, entry } = harness({ password: 'existing-password', failConsume: true });
  await assert.rejects(service.accept({ token: invitation.token, mode: 'existing', currentPassword: 'existing-password', reviewConfirmed: true }));
  assert.equal(account.confirmed, false); assert.equal(account.password, 'hash:existing-password'); assert.equal(entry.status, 'invited'); assert.equal(entry.invitationAccepted, false);
  assert.equal((await service.validate(invitation.token)).status, 'pending');
});

test('transition activates previously accepted credentials without changing their password, role or profile', async () => {
  const { service, account, entry, calls } = harness({ password: 'already-saved-password' }); entry.invitationAccepted = true;
  const oldHash = account.password, oldRole = entry.teamRole;
  assert.equal(await service.completeAccepted(entry.documentId), true);
  assert.equal(account.password, oldHash); assert.equal(account.confirmed, true); assert.equal(entry.teamRole, oldRole); assert.equal(entry.status, 'active');
  assert.equal(calls.passwordWrites, 0); assert.equal(calls.confirmationWrites, 1);
  await assert.rejects(service.completeAccepted(entry.documentId)); assert.equal(calls.confirmationWrites, 1);
});
test('transition never activates an unaccepted, passwordless, blocked, inactive or disconnected account', async () => {
  const unaccepted = harness({ password: 'saved-password' }); assert.equal(await unaccepted.service.completeAccepted(unaccepted.entry.documentId), false); assert.equal(unaccepted.entry.status, 'invited');
  for (const change of [{ status: 'inactive' }, { account: null }]) { const h=harness({ password: 'saved-password' }); h.entry.invitationAccepted=true; Object.assign(h.entry,change); await assert.rejects(h.service.completeAccepted(h.entry.documentId)); }
  for (const change of [{ password: undefined }, { blocked: true }, { provider: 'google' }]) { const h=harness({ password: 'saved-password' }); h.entry.invitationAccepted=true; Object.assign(h.account,change); await assert.rejects(h.service.completeAccepted(h.entry.documentId)); assert.equal(h.entry.status,'invited'); assert.equal(h.account.confirmed,false); }
});
test('transition failure rolls back account confirmation together with profile activation', async () => {
  const h = harness({ password: 'saved-password', failConsume: true }); h.entry.invitationAccepted = true;
  await assert.rejects(h.service.completeAccepted(h.entry.documentId)); assert.equal(h.entry.status, 'invited'); assert.equal(h.account.confirmed, false); assert.equal(h.account.password, 'hash:saved-password');
});
test('bootstrap transition only selects accepted pending profiles and is idempotent', async () => {
  const configure = require('../src/team-onboarding-config'); let calls=0, done=false;
  const strapi = { documents: () => ({ findMany: async query => { assert.deepEqual(query.filters,{status:'invited',invitationAccepted:true}); return done ? [] : [{documentId:'legacy'}]; } }), service: () => ({ completeAccepted: async id => { assert.equal(id,'legacy'); calls++; done=true; return true; } }) };
  assert.deepEqual(await configure(strapi), { activated: 1 }); assert.deepEqual(await configure(strapi), { activated: 0 }); assert.equal(calls,1);
});
