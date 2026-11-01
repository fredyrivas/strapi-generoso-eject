'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const factory = require('../src/api/team-salary-week/services/team-salary-week');
const { snapshotInput, emptySnapshot, currentReferenceDate } = require('../src/api/team-salary-week/utils/input');
const router = require('../src/api/team-salary-week/routes/team-salary-week');
const schema = require('../src/api/team-salary-week/content-types/team-salary-week/schema.json');
const adminPolicy = require('../src/api/team-employee/policies/team-admin');
const UID = 'api::team-salary-week.team-salary-week';

function harness({ failCreate = false, failUpdate = false, clock = () => new Date("2026-10-31T18:00:00Z") } = {}) {
  const state = { rows: [], locks: [] };
  let queue = Promise.resolve();
  const docs = {
    async findFirst({ filters }) { return structuredClone(state.rows.find(row => row.recordKey === filters.recordKey) ?? null); },
    async create({ data }) {
      const row = { documentId: 'base-record', ...structuredClone(data) };
      state.rows.push(row);
      if (failCreate) throw new Error('create-failed');
      return structuredClone(row);
    },
    async update({ documentId, data }) {
      const row = state.rows.find(row => row.documentId === documentId);
      Object.assign(row, structuredClone(data));
      if (failUpdate) throw new Error('update-failed');
      return structuredClone(row);
    },
  };
  const strapi = {
    documents: uid => { assert.equal(uid, UID); return docs; },
    db: { async transaction(operation) {
      const previous = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      const before = structuredClone(state.rows);
      try {
        return await operation({ trx: { raw: async (sql, bindings) => {
          assert.equal(sql, 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))');
          state.locks.push(bindings[0]);
        } } });
      } catch (error) { state.rows = before; throw error; }
      finally { release(); }
    } },
  };
  return { service: factory({ strapi, clock }), state };
}

test('the first admin read saves the current Mexico City date exactly once', async () => {
  let now = new Date('2026-10-31T18:00:00Z');
  const h = harness({ clock: () => now });
  const value = await h.service.read();
  assert.deepEqual(value, { ...emptySnapshot('2026-10-31'), revision: 1 });
  assert.equal(h.state.rows.length, 1);
  assert.equal(h.state.rows[0].referenceDate, '2026-10-31');
  now = new Date('2026-11-10T18:00:00Z');
  assert.deepEqual(await h.service.read(), value);
  assert.equal(h.state.rows.length, 1);
  assert.equal(h.state.locks.length, 1);
});

test('current reference date follows Mexico City across the UTC day boundary', () => {
  assert.equal(currentReferenceDate(new Date('2026-11-02T05:59:59Z')), '2026-11-01');
  assert.equal(currentReferenceDate(new Date('2026-11-02T06:00:00Z')), '2026-11-02');
});

test('concurrent initial reads persist only one reference date in one document', async () => {
  const h = harness();
  const [first, second] = await Promise.all([h.service.read(), h.service.read()]);
  assert.deepEqual(first, second);
  assert.equal(first.referenceDate, '2026-10-31');
  assert.equal(first.revision, 1);
  assert.equal(h.state.rows.length, 1);
});

test('changing the reference date updates one field in the same document and preserves every input', async () => {
  const h = harness();
  const input = emptySnapshot('2026-10-31');
  input.days[0].input.cardTips = 167;
  const first = await h.service.save(input);
  const originalId = h.state.rows[0].documentId;
  const saved = await h.service.save({ ...first, referenceDate: '2027-01-01' });
  assert.equal(h.state.rows.length, 1);
  assert.equal(h.state.rows[0].documentId, originalId);
  assert.equal(saved.referenceDate, '2027-01-01');
  assert.deepEqual(saved.days, first.days);
  assert.equal(saved.revision, 2);
  assert.deepEqual(await h.service.read(), saved);
});

test('save/read preserves five inputs, nulls and zeros, with no calculated or account data', async () => {
  const h = harness();
  const input = emptySnapshot("2026-10-31");
  input.days[0].input = { cardTips: 167.25, cashTips: 0, fixedMembers: 2, auxiliaryMembers: 0, bonuses: 100 };
  input.days.reverse();
  const saved = await h.service.save(input);
  assert.equal(saved.revision, 1);
  assert.equal(saved.days[0].dayIndex, 0);
  assert.deepEqual(saved.days[0].input, { cardTips: 167.25, cashTips: 0, fixedMembers: 2, auxiliaryMembers: 0, bonuses: 100 });
  assert.equal(saved.days[1].input.cardTips, null);
  assert.deepEqual(await h.service.read(), saved);
  assert.deepEqual(Object.keys(h.state.rows[0]).sort(), ['days', 'documentId', 'recordKey', 'referenceDate', 'revision']);
  assert.equal(h.state.locks[0], 'generoso:team:base-salaries');
  assert.equal(input.revision, 0);
  const next = await h.service.save({ ...saved, days: saved.days.map(day => ({ ...day, input: { ...day.input, bonuses: 0 } })) });
  assert.equal(next.revision, 2);
  assert.equal(h.state.rows.length, 1);
});

test('edits replace the same weekday rows without calendar dates or history', async () => {
  const h = harness();
  const first = await h.service.save(emptySnapshot("2026-10-31"));
  const originalId = h.state.rows[0].documentId;
  first.days[0].input.cardTips = 100;
  const saved = await h.service.save(first);
  assert.equal(h.state.rows.length, 1);
  assert.equal(h.state.rows[0].documentId, originalId);
  assert.equal(saved.days[0].input.cardTips, 100);
  assert.equal(saved.days[1].input.cardTips, null);
  assert.doesNotMatch(JSON.stringify(h.state.rows), /weekStart|"date"/);
  assert.deepEqual(await h.service.read(), saved);
});

test('concurrent edits to the single base cannot create a second record', async () => {
  const h = harness();
  const first = emptySnapshot("2026-10-31"), second = emptySnapshot("2026-10-31");
  first.days[0].input.cardTips = 100; second.days[1].input.cardTips = 200;
  const results = await Promise.allSettled([h.service.save(first), h.service.save(second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.details.code, 'TEAM_CONFLICT');
  assert.equal(h.state.rows.length, 1);
});

test('existing captures receive a reference date without replacing their saved inputs', async () => {
  const h = harness();
  const input = emptySnapshot("2026-10-31");
  input.days[0].input.cardTips = 167;
  const legacy = {
    documentId: 'old-base', recordKey: 'base-sueldos', weekStart: '2026-10-26', revision: 4,
    days: input.days.map(day => ({ date: new Date(Date.UTC(2026, 9, 26 + day.dayIndex)).toISOString().slice(0, 10), input: day.input })),
  };
  h.state.rows.push(structuredClone(legacy));
  const read = await h.service.read();
  assert.equal(read.revision, 5);
  assert.equal(read.referenceDate, '2026-10-31');
  assert.equal(read.days[0].input.cardTips, 167);
  assert.doesNotMatch(JSON.stringify(read), /weekStart|"date"/);
  assert.deepEqual(h.state.rows[0].days, legacy.days);
  const saved = await h.service.save(read);
  assert.equal(saved.revision, 6);
  assert.equal(saved.days[0].input.cardTips, 167);
  assert.equal(h.state.rows.length, 1);
  assert.doesNotMatch(JSON.stringify(h.state.rows[0].days), /"date"/);
});

test('concurrent first saves and stale edits cannot duplicate or overwrite the base', async () => {
  const h = harness();
  const results = await Promise.allSettled([h.service.save(emptySnapshot("2026-10-31")), h.service.save(emptySnapshot("2026-10-31"))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.details.code, 'TEAM_CONFLICT');
  assert.equal(h.state.rows.length, 1);
  const old = await h.service.read();
  await h.service.save(old);
  await assert.rejects(h.service.save(old), error => error.details.code === 'TEAM_CONFLICT');
  assert.equal((await h.service.read()).revision, 2);
});

test('failed persistence rolls back the entire base and its revision', async () => {
  const first = harness({ failCreate: true });
  await assert.rejects(first.service.save(emptySnapshot("2026-10-31")), /create-failed/);
  assert.equal(first.state.rows.length, 0);
  const update = harness({ failUpdate: true });
  const previous = await update.service.save(emptySnapshot("2026-10-31"));
  await assert.rejects(update.service.save({ ...previous, days: previous.days.map(day => ({ ...day, input: { ...day.input, bonuses: 200 } })) }), /update-failed/);
  assert.deepEqual(await update.service.read(), previous);
});

test('direct CMS writes reject dates, extra fields, duplicate rows and invalid inputs', async () => {
  const inputs = [];
  for (const referenceDate of [null, '', '2026-02-30', '2026-13-01', '31/10/2026']) { const input = emptySnapshot('2026-10-31'); input.referenceDate = referenceDate; inputs.push(input); }
  let input = emptySnapshot("2026-10-31"); input.results = {}; inputs.push(input);
  input = emptySnapshot("2026-10-31"); input.days[0].values = {}; inputs.push(input);
  input = emptySnapshot("2026-10-31"); input.days[0].input.formula = 'anything'; inputs.push(input);
  input = emptySnapshot("2026-10-31"); input.days.pop(); inputs.push(input);
  input = emptySnapshot("2026-10-31"); input.days[0] = input.days[1]; inputs.push(input);
  input = emptySnapshot("2026-10-31"); input.days[0].dayIndex = 7; inputs.push(input);
  input = emptySnapshot("2026-10-31"); delete input.days[0].input.bonuses; inputs.push(input);
  for (const [field, value] of [['cardTips', '100'], ['cashTips', NaN], ['bonuses', -1], ['fixedMembers', 1.5], ['auxiliaryMembers', Infinity], ['fixedMembers', Number.MAX_SAFE_INTEGER], ['bonuses', Number.MAX_VALUE]]) {
    input = emptySnapshot("2026-10-31"); input.days[0].input[field] = value; inputs.push(input);
  }
  input = emptySnapshot("2026-10-31"); input.revision = -1; inputs.push(input);
  input = emptySnapshot("2026-10-31"); input.revision = '0'; inputs.push(input);
  input = emptySnapshot("2026-10-31"); input.weekStart = '2026-10-26'; inputs.push(input);
  input = emptySnapshot("2026-10-31"); input.days[0].date = '2026-10-26'; inputs.push(input);
  const h = harness();
  for (const input of inputs) await assert.rejects(h.service.save(input), { name: 'ValidationError' });
  assert.equal(h.state.rows.length, 0);
  assert.equal(h.state.locks.length, 0);
  // Zero members can be retained as draft input; calculation warnings belong to the motor.
  input = emptySnapshot("2026-10-31"); input.days[0].input = { cardTips: 0, cashTips: 0, fixedMembers: 0, auxiliaryMembers: 0, bonuses: 0 };
  assert.equal(snapshotInput(input).days[0].input.fixedMembers, 0);
});

test('the model enforces one mutable base and exposes only two session-protected admin routes', async () => {
  assert.equal(schema.options.draftAndPublish, false);
  assert.equal(schema.attributes.weekStart.private, true);
  assert.notEqual(schema.attributes.weekStart.required, true);
  assert.equal(schema.attributes.days.private, true);
  assert.equal(schema.attributes.recordKey.unique, true);
  assert.deepEqual(schema.attributes.recordKey.enum, ['base-sueldos']);
  assert.deepEqual(Object.keys(schema.attributes).sort(), ['days', 'recordKey', 'referenceDate', 'revision', 'weekStart']);
  const calls = [];
  const routes = router({ strapi: { controller: uid => {
    assert.equal(uid, UID);
    return { read: ctx => calls.push(['read', ctx]), save: ctx => calls.push(['save', ctx]) };
  } } }).routes;
  assert.deepEqual(routes.map(route => [route.method, route.path]), [['GET', '/team-admin/base-salaries'], ['PUT', '/team-admin/base-salaries']]);
  for (const route of routes) {
    assert.equal(typeof route.handler, 'function');
    assert.deepEqual(route.config.auth, { strategies: ['users-permissions'], scope: [] });
    assert.deepEqual(route.config.policies, ['api::team-employee.team-admin']);
    await route.handler({ fixture: true });
  }
  assert.deepEqual(calls.map(call => call[0]), ['read', 'save']);
});

test('the actual reused policy rejects anonymous, employee, inactive and blocked accounts', async () => {
  const role = (process.env.TEAM_BOOTSTRAP_ADMIN_ROLE || 'backstageadmin').trim().toLowerCase();
  const user = { id: 1, confirmed: true, blocked: false, role: { type: 'teamemployee' } };
  for (const [account, profile, allowed] of [
    [undefined, null, false], [user, { status: 'active', teamRole: 'employee' }, false],
    [user, { status: 'active', teamRole: 'admin' }, true],
    [{ ...user, role: { type: role } }, null, true],
    [{ ...user, role: { type: role } }, { status: 'inactive', teamRole: 'admin' }, false],
    [{ ...user, blocked: true }, { status: 'active', teamRole: 'admin' }, false],
    [{ ...user, confirmed: false }, { status: 'active', teamRole: 'admin' }, false],
  ]) {
    const context = { state: { user: account } };
    const strapi = { documents: () => ({ findFirst: async () => profile }) };
    assert.equal(await adminPolicy(context, {}, { strapi }), allowed);
    assert.equal(Boolean(context.state.teamAdmin), allowed);
  }
});
