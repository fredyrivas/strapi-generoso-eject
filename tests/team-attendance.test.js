'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const factory = require('../src/api/team-employee/services/team-attendance');
const { createHash } = require('node:crypto');
const binding = (id, documentId) => createHash('sha256').update('team-account:' + id + ':' + documentId).digest('hex');
const { SITE, LOCK, localClock, punctualAt, openAt, locationInput, validateLocation, challengeFor, validChallenge } = require('../src/api/team-employee/utils/attendance');
const configure = require('../src/team-attendance-config');
const router = require('../src/api/team-employee/routes/attendance');
const schema = require('../src/api/team-checkin/content-types/team-checkin/schema.json');
const E = 'api::team-employee.team-employee';
const secret = 'unit-test-signing-key-only';
function harness(options = {}) {
  const account = { id: 7, confirmed: true, blocked: false, provider: 'local' };
  const entry = { documentId: 'employee-1', fullName: 'Persona de prueba', status: 'active', account };
  const state = { records: [] }, h = { now: new Date('2026-10-28T14:00:00Z') }; let queue = Promise.resolve();
  const strapi = {
    config: { get: () => secret },
    documents: uid => uid === E ? {
      findFirst: async ({ filters }) => entry.account.id === filters.account.id ? structuredClone(entry) : null,
      findOne: async ({ documentId }) => entry.documentId === documentId ? structuredClone(entry) : null,
    } : {
      findFirst: async ({ filters }) => state.records.find(row => row.dayKey === filters.dayKey),
      findMany: async ({ filters }) => state.records.filter(row => row.employee === filters.employee.documentId && row.date >= filters.date.$gte && row.date < filters.date.$lt),
      create: async ({ data }) => { assert.deepEqual(Object.keys(data).sort(), ['date', 'dayKey', 'employee', 'punctual', 'timestamp']); const row = { ...data, documentId: 'arrival-' + state.records.length }; state.records.push(row); if (options.failCreate) throw new Error('controlled-create-failure'); return row; },
    },
    db: {
      metadata: { get: uid => ({ tableName: uid === E ? 'employees' : 'accounts' }) }, query: () => ({ findOne: async () => structuredClone(account) }),
      connection: table => ({ transacting() { return this; }, select() { return this; }, where(input) { this.id = table === 'employees' ? input.document_id : input.id; return this; }, forUpdate() { return this; }, async first() { return (table === 'employees' ? this.id === entry.documentId : this.id === account.id) ? { id: 1 } : null; } }),
      transaction: async operation => { const previous = queue; let release; queue = new Promise(resolve => { release = resolve; }); await previous; const before = structuredClone(state); if (options.replaceBeforeLock) entry.account.id = 8; try { return await operation({ trx: { raw: async (sql, args) => { assert.match(sql, /pg_advisory_xact_lock/); assert.deepEqual(args, [LOCK]); } } }); } catch (error) { Object.assign(state, before); throw error; } finally { release(); } },
    },
  };
  h.service = factory({ strapi, clock: () => new Date(h.now) });
  h.input = () => ({ latitude: SITE.latitude, longitude: SITE.longitude, accuracy: 5, challenge: challengeFor(secret, binding(account.id, entry.documentId), h.now) });
  return Object.assign(h, { entry, account, state });
}

test('server time uses Mexico City, punctuality includes 08:05:59 and closes exactly at 12:00', () => {
  for (const [iso, punctual, open] of [['2026-10-28T14:05:59.999Z', true, true], ['2026-10-28T14:06:00Z', false, true], ['2026-10-28T15:00:00Z', false, true], ['2026-10-28T17:59:59.999Z', false, true], ['2026-10-28T18:00:00Z', false, false]]) { assert.equal(punctualAt(new Date(iso)), punctual); assert.equal(openAt(new Date(iso)), open); }
  assert.equal(localClock(new Date('2026-11-02T05:59:59Z')).date, '2026-11-01'); assert.equal(localClock(new Date('2026-11-02T06:00:00Z')).date, '2026-11-02');
});
test('location requires finite valid coordinates, accuracy within 70m and distance within the restaurant boundary', () => {
  const good = { latitude: SITE.latitude, longitude: SITE.longitude, accuracy: 5, challenge: 'test' }; assert.doesNotThrow(() => validateLocation(locationInput(good)));
  for (const change of [{ latitude: NaN }, { longitude: Infinity }, { latitude: 91 }, { longitude: -181 }, { accuracy: 0 }, { accuracy: '5' }, { skipLocation: true }, { timestamp: 'chosen' }, { punctual: true }, { employee: 8 }]) assert.throws(() => locationInput({ ...good, ...change }));
  for (const change of [{ accuracy: 71 }, { latitude: SITE.latitude + .001 }]) assert.throws(() => validateLocation({ ...good, ...change }));
});
test('short-lived challenge binds the authenticated account, local day and purpose without exposing identity', () => {
  const now = new Date('2026-10-28T14:00:00Z'), hash = 'b'.repeat(64), token = challengeFor(secret, hash, now);
  assert.equal(validChallenge(secret, hash, token, now), true); assert.equal(validChallenge(secret, 'c'.repeat(64), token, now), false); assert.equal(validChallenge(secret, hash, token, new Date(now.getTime() + 121000)), false); assert.equal(validChallenge('other', hash, token, now), false); assert.ok(!token.includes(hash));
  const midnight = new Date('2026-11-02T05:59:30Z'); assert.equal(validChallenge(secret, hash, challengeFor(secret, hash, midnight), new Date('2026-11-02T06:00:00Z')), false);
});
test('record uses account identity and server date, stores no coordinates, and updates the current weekly view', async () => {
  const h = harness(); const before = await h.service.welcomeForAccount(h.account.id); assert.equal(before.checkinAvailable, true);
  const result = await h.service.record(h.account.id, h.input()); assert.equal(result.status, 'recorded'); assert.deepEqual(result.checkin, { date: '2026-10-28', timestamp: h.now.toISOString(), punctual: true }); assert.equal(h.state.records[0].employee, 'employee-1');
  const after = await h.service.welcomeForAccount(h.account.id); assert.equal(after.checkinState, 'registered'); assert.equal(after.challenge, null); assert.equal(after.week.days[2].status, 'on_time'); assert.equal(after.week.days[2].timestamp, h.now.toISOString());
});
test('duplicate requests are idempotent and two concurrent requests store exactly one arrival', async () => {
  const h = harness(); const results = await Promise.all([h.service.record(h.account.id, h.input()), h.service.record(h.account.id, h.input())]); assert.deepEqual(results.map(row => row.status).sort(), ['already_registered', 'recorded']); assert.equal(h.state.records.length, 1);
  h.now = new Date('2026-10-28T19:00:00Z'); assert.equal((await h.service.record(h.account.id, { ...h.input(), latitude: 0 })).status, 'already_registered'); assert.equal(h.state.records.length, 1);
});
test('late but permitted arrivals are classified in server; at closure no new record is written', async () => {
  for (const iso of ['2026-10-28T14:06:00Z', '2026-10-28T15:00:00Z', '2026-10-28T17:59:59.999Z']) {
    const h = harness(); h.now = new Date(iso); assert.equal((await h.service.welcomeForAccount(h.account.id)).checkinAvailable, true); assert.equal((await h.service.record(h.account.id, h.input())).checkin.punctual, false); assert.equal(h.state.records.length, 1);
  }
  const closed = harness(); closed.now = new Date('2026-10-28T18:00:00Z'); await assert.rejects(closed.service.record(closed.account.id, closed.input()), /12:00 p\. m\./); assert.equal(closed.state.records.length, 0); const welcome = await closed.service.welcomeForAccount(closed.account.id); assert.equal(welcome.checkinState, 'closed'); assert.equal(welcome.checkinAvailable, false); assert.equal(welcome.challenge, null);
});
test('invalid, expired, swapped or inactive access never creates an arrival', async () => {
  for (const change of [{ status: 'invited' }, { status: 'inactive' }]) { const h = harness(); Object.assign(h.entry, change); await assert.rejects(h.service.record(h.account.id, h.input())); assert.equal(h.state.records.length, 0); }
  for (const change of [{ blocked: true }, { confirmed: false }, { provider: 'google' }]) { const h = harness(); Object.assign(h.account, change); await assert.rejects(h.service.record(h.account.id, h.input())); }
  const h = harness(); await assert.rejects(h.service.record(999, h.input())); const input = h.input(); h.now = new Date(h.now.getTime() + 121000); await assert.rejects(h.service.record(h.account.id, input));
  const swapped = harness(); await assert.rejects(swapped.service.record(swapped.account.id, { ...swapped.input(), challenge: challengeFor(secret, 'c'.repeat(64), swapped.now) }));
  const changed = harness({ replaceBeforeLock: true }); await assert.rejects(changed.service.record(changed.account.id, changed.input()));
});
test('GPS failures and persistence failures leave no partial records', async () => {
  const h = harness(); for (const change of [{ latitude: 0 }, { accuracy: 100 }]) await assert.rejects(h.service.record(h.account.id, { ...h.input(), ...change })); assert.equal(h.state.records.length, 0);
  const failed = harness({ failCreate: true }); await assert.rejects(failed.service.record(failed.account.id, failed.input()), /controlled-create-failure/); assert.equal(failed.state.records.length, 0);
});
test('weekly reads exclude past/future weeks and other employees and never infer absences', async () => {
  const h = harness(); h.state.records.push({ employee: 'employee-1', date: '2026-10-20', timestamp: h.now.toISOString(), punctual: true }, { employee: 'other', date: '2026-10-28', timestamp: h.now.toISOString(), punctual: false }, { employee: 'employee-1', date: '2026-11-02', timestamp: h.now.toISOString(), punctual: true });
  const result = await h.service.welcomeForAccount(h.account.id); assert.equal(result.week.days[2].status, 'no_record'); assert.equal(result.week.days[3].status, 'upcoming'); assert.ok(result.week.days.every(day => day.timestamp === null));
});
test('retention runs at bootstrap and every minute in the business timezone', async () => {
  let count = 0, tasks; const strapi = { service: () => ({ purge: async () => { count++; } }), cron: { add: input => { tasks = input; } } }; await configure(strapi); assert.equal(count, 1); assert.deepEqual(tasks.teamCurrentWeekAttendance.options, { rule: '0 * * * * *', tz: 'America/Mexico_City' }); await tasks.teamCurrentWeekAttendance.task(); assert.equal(count, 2);
});
test('attendance model has no publication versions or generic routes and enforces one key per employee/day', () => {
  assert.equal(schema.options.draftAndPublish, false); assert.equal(schema.attributes.dayKey.unique, true); assert.equal(schema.attributes.employee.private, true); assert.equal(schema.attributes.employee.required, true);
  assert.deepEqual(require('../src/api/team-checkin/routes/team-checkin').routes, []); assert.deepEqual(require('../src/api/checkin/routes/checkin').routes, []);
});
test('both employee attendance endpoints require a member session and admin endpoints keep their separate policy', () => {
  const routes = router({ strapi: {} }).routes;
  assert.deepEqual(routes.map(route => route.path), ['/team/welcome', '/team/checkin', '/team-admin/checkins', '/team-admin/checkins/legacy/:documentId/link']);
  for (const [index, route] of routes.entries()) {
    assert.equal(typeof route.handler, 'function');
    assert.deepEqual(route.config.auth, { strategies: ['users-permissions'], scope: [] });
    assert.deepEqual(route.config.policies, [index < 2 ? 'api::team-employee.team-member' : 'api::team-employee.team-admin']);
  }
  assert.equal(routes[1].config.middlewares[0].config.max, 10);
});
test('check-in rejects a personal code, missing account, swapped account and chosen identity', async () => {
  const h = harness();
  for (const id of [undefined, null, 'a'.repeat(43), 0, 999]) {
    await assert.rejects(h.service.record(id, h.input()));
    await assert.rejects(h.service.welcomeForAccount(id));
  }
  await assert.rejects(h.service.record(h.account.id, { ...h.input(), accountId: 1 }));
  assert.equal(h.state.records.length, 0);
});
