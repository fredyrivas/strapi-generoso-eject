'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const factory = require('../src/api/team-salary-week/services/team-salary-week');
const { snapshotInput, emptySnapshot, currentWeekStart } = require('../src/api/team-salary-week/utils/input');
const router = require('../src/api/team-salary-week/routes/team-salary-week');
const schema = require('../src/api/team-salary-week/content-types/team-salary-week/schema.json');
const weekSchema = require('../src/api/team-payment-week/content-types/team-payment-week/schema.json');
const adminPolicy = require('../src/api/team-employee/policies/team-admin');
const { LOCK } = require('../src/api/team-employee/utils/attendance');
const UID = 'api::team-salary-week.team-salary-week', LOG = 'api::team-payment-log.team-payment-log', E = 'api::team-employee.team-employee', P = 'api::team-payment-week.team-payment-week';
const admin = { id: 1, username: 'fredy', email: 'fredy@example.test' };
const config = { revision: 2, monthlySalary: 8000, restDay: 0, payGroup: 'fixed' };

function harness({ failCreate = false, failUpdate = false, clock = () => new Date('2026-11-03T18:00:00Z') } = {}) {
  const state = { rows: [], logs: [], weeks: [], locks: [], employees: [
    { documentId: 'employee-1', teamRole: 'employee', paymentAccount: config },
    { documentId: 'employee-2', teamRole: 'operative', paymentAccount: null },
  ] };
  let queue = Promise.resolve(), sequence = 0;
  const table = uid => ({ [UID]: 'rows', [LOG]: 'logs', [P]: 'weeks' })[uid];
  const matches = (row, filters = {}) => Object.entries(filters).every(([key, value]) => row[key] === value);
  const docs = uid => ({
    async findFirst({ filters }) { return structuredClone(state[table(uid)].find(row => matches(row, filters)) ?? null); },
    async findMany({ filters }) {
      if (uid === E) { assert.deepEqual(filters, { teamRole: { $ne: 'operative' } }); return structuredClone(state.employees.filter(row => row.teamRole !== 'operative')); }
      return structuredClone(state[table(uid)].filter(row => matches(row, filters)).reverse());
    },
    async create({ data }) {
      const row = { documentId: `${table(uid)}-${++sequence}`, ...structuredClone(data), ...(uid === LOG ? { createdAt: new Date(Date.UTC(2026, 10, 3, 18, 0, sequence)).toISOString() } : {}) };
      state[table(uid)].push(row);
      if (failCreate && uid === UID) throw new Error('create-failed');
      return structuredClone(row);
    },
    async update({ documentId, data }) {
      const row = state[table(uid)].find(row => row.documentId === documentId);
      Object.assign(row, structuredClone(data));
      if (failUpdate && uid === UID) throw new Error('update-failed');
      return structuredClone(row);
    },
  });
  const strapi = {
    documents: uid => { assert.ok([UID, LOG, E, P].includes(uid)); return docs(uid); },
    db: { async transaction(operation) {
      const previous = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      const before = structuredClone({ rows: state.rows, logs: state.logs, weeks: state.weeks });
      try {
        return await operation({ trx: { raw: async (sql, bindings) => {
          assert.equal(sql, 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))');
          state.locks.push(bindings[0]);
        } } });
      } catch (error) { Object.assign(state, before); throw error; }
      finally { release(); }
    } },
  };
  return { service: factory({ strapi, clock }), state };
}
const week = (weekStart = '2026-10-26') => emptySnapshot(weekStart);
const strip = ({ weekStatus, releasedAt, history, ...snapshot }) => snapshot;

test('an unsaved week reads as an empty draft of the current Mexico City week, without writing', async () => {
  const h = harness();
  const value = await h.service.read();
  assert.deepEqual(value, { ...emptySnapshot('2026-11-02'), weekStatus: 'draft', releasedAt: null, history: [] });
  assert.deepEqual(await h.service.read('2026-10-26'), { ...emptySnapshot('2026-10-26'), weekStatus: 'draft', releasedAt: null, history: [] });
  assert.equal(h.state.rows.length, 0);
  assert.equal(h.state.locks.length, 0);
  for (const value of ['2026-10-27', '2026-02-30', '', '31/10/2026']) await assert.rejects(h.service.read(value), { name: 'ValidationError' });
});

test('the current week follows Mexico City across the UTC day boundary', () => {
  assert.equal(currentWeekStart(new Date('2026-11-02T05:59:59Z')), '2026-10-26');
  assert.equal(currentWeekStart(new Date('2026-11-02T06:00:00Z')), '2026-11-02');
});

test('each week is saved in its own record and earlier weeks keep their inputs', async () => {
  const h = harness();
  const october = week('2026-10-26');
  october.days[0].input = { cardTips: 167.25, cashTips: 0, fixedMembers: 2, auxiliaryMembers: 0, bonuses: 100 };
  october.days.reverse();
  const first = await h.service.save(october, admin);
  assert.equal(first.revision, 1);
  assert.equal(first.weekStatus, 'draft');
  assert.deepEqual(first.days[0].input, { cardTips: 167.25, cashTips: 0, fixedMembers: 2, auxiliaryMembers: 0, bonuses: 100 });
  const november = await h.service.save(week('2026-11-02'), admin);
  assert.equal(h.state.rows.length, 2);
  assert.equal(november.days[0].input.cardTips, null);
  assert.deepEqual(strip(await h.service.read('2026-10-26')), strip(first));
  assert.deepEqual(Object.keys(h.state.rows[0]).sort(), ['days', 'documentId', 'releasedAt', 'revision', 'weekStart', 'weekStatus']);
  assert.equal(h.state.locks[0], 'generoso:team:base-salaries');
  const next = await h.service.save({ ...strip(first), days: first.days.map(day => ({ ...day, input: { ...day.input, bonuses: 0 } })) }, admin);
  assert.equal(next.revision, 2);
  assert.deepEqual(next.history.map(entry => [entry.actor, entry.summary]), [['fredy', 'Guardó Base sueldos'], ['fredy', 'Guardó Base sueldos']]);
  assert.equal(h.state.logs.filter(entry => entry.weekStart === '2026-10-26').length, 2);
  assert.equal(h.state.logs[2].before[0].input.bonuses, 100);
});

test('concurrent or stale edits of a week cannot create a second record or overwrite it', async () => {
  const h = harness();
  const first = week(), second = week();
  first.days[0].input.cardTips = 100; second.days[1].input.cardTips = 200;
  const results = await Promise.allSettled([h.service.save(first, admin), h.service.save(second, admin)]);
  assert.equal(results.find(result => result.status === 'rejected').reason.details.code, 'TEAM_CONFLICT');
  assert.equal(h.state.rows.length, 1);
  const old = strip(await h.service.read('2026-10-26'));
  await h.service.save(old, admin);
  await assert.rejects(h.service.save(old, admin), error => error.details.code === 'TEAM_CONFLICT');
  assert.equal((await h.service.read('2026-10-26')).revision, 2);
});

test('failed persistence rolls back the week, its revision and its history', async () => {
  const first = harness({ failCreate: true });
  await assert.rejects(first.service.save(week(), admin), /create-failed/);
  assert.equal(first.state.rows.length, 0);
  assert.equal(first.state.logs.length, 0);
  const update = harness({ failUpdate: true });
  const previous = await update.service.save(week(), admin);
  await assert.rejects(update.service.save({ ...strip(previous), days: previous.days.map(day => ({ ...day, input: { ...day.input, bonuses: 200 } })) }, admin), /update-failed/);
  assert.deepEqual(await update.service.read('2026-10-26'), previous);
});

test('direct CMS writes reject weeks that do not start on Monday, extra fields, duplicate rows and invalid inputs', async () => {
  const inputs = [];
  for (const weekStart of [null, '', '2026-10-27', '2026-02-30', '2026-13-01', '26/10/2026']) { const input = week(); input.weekStart = weekStart; inputs.push(input); }
  let input = week(); input.results = {}; inputs.push(input);
  input = week(); input.weekStatus = 'published'; inputs.push(input);
  input = week(); input.days[0].values = {}; inputs.push(input);
  input = week(); input.days[0].input.formula = 'anything'; inputs.push(input);
  input = week(); input.days.pop(); inputs.push(input);
  input = week(); input.days[0] = input.days[1]; inputs.push(input);
  input = week(); input.days[0].dayIndex = 7; inputs.push(input);
  input = week(); delete input.days[0].input.bonuses; inputs.push(input);
  for (const [field, value] of [['cardTips', '100'], ['cashTips', NaN], ['bonuses', -1], ['fixedMembers', 1.5], ['auxiliaryMembers', Infinity], ['fixedMembers', Number.MAX_SAFE_INTEGER], ['bonuses', Number.MAX_VALUE]]) {
    input = week(); input.days[0].input[field] = value; inputs.push(input);
  }
  input = week(); input.revision = -1; inputs.push(input);
  input = week(); input.revision = '0'; inputs.push(input);
  input = week(); input.referenceDate = '2026-10-31'; inputs.push(input);
  input = week(); input.days[0].date = '2026-10-26'; inputs.push(input);
  const h = harness();
  for (const input of inputs) await assert.rejects(h.service.save(input, admin), { name: 'ValidationError' });
  assert.equal(h.state.rows.length, 0);
  assert.equal(h.state.locks.length, 0);
  // Zero members can be retained as draft input; calculation warnings belong to the motor.
  input = week(); input.days[0].input = { cardTips: 0, cashTips: 0, fixedMembers: 0, auxiliaryMembers: 0, bonuses: 0 };
  assert.equal(snapshotInput(input).days[0].input.fixedMembers, 0);
});

test('publishing freezes each paid employee configuration and returning to capture releases it', async () => {
  const h = harness();
  await assert.rejects(h.service.publish({ weekStart: '2026-10-26', revision: 1, published: true }, admin), { name: 'ValidationError' });
  const saved = await h.service.save(week(), admin);
  await assert.rejects(h.service.publish({ weekStart: '2026-10-26', revision: 5, published: true }, admin), error => error.details.code === 'TEAM_CONFLICT');
  const published = await h.service.publish({ weekStart: '2026-10-26', revision: saved.revision, published: true }, admin);
  assert.equal(published.weekStatus, 'published');
  assert.equal(published.releasedAt, '2026-11-03T18:00:00.000Z');
  assert.equal(published.revision, 2);
  assert.deepEqual(h.state.locks.slice(-2), [LOCK, 'generoso:team:base-salaries']);
  assert.equal(h.state.weeks.length, 1);
  assert.deepEqual(h.state.weeks[0].configuration, { monthlySalary: 8000, restDay: 0, payGroup: 'fixed' });
  assert.equal(h.state.weeks[0].weekKey, 'employee-1:2026-10-26');
  await assert.rejects(h.service.publish({ weekStart: '2026-10-26', revision: 2, published: true }, admin), error => error.details.code === 'TEAM_CONFLICT');
  const draft = await h.service.publish({ weekStart: '2026-10-26', revision: 2, published: false }, admin);
  assert.equal(draft.weekStatus, 'draft');
  assert.equal(draft.releasedAt, null);
  assert.equal(h.state.weeks[0].configuration, null);
  assert.deepEqual(draft.history.map(entry => entry.summary), ['Regresó la semana a captura', 'Publicó la semana', 'Guardó Base sueldos']);
  for (const value of [{ weekStart: '2026-10-26', revision: 3 }, { weekStart: '2026-10-27', revision: 3, published: true }, { weekStart: '2026-10-26', revision: 3, published: 'yes' }]) await assert.rejects(h.service.publish(value, admin), { name: 'ValidationError' });
});

test('the models keep one base per week and the routes stay session-protected', async () => {
  assert.equal(schema.options.draftAndPublish, false);
  assert.equal(schema.attributes.weekStart.unique, true);
  assert.equal(schema.attributes.days.private, true);
  assert.deepEqual(schema.attributes.weekStatus.enum, ['draft', 'published']);
  assert.deepEqual(Object.keys(schema.attributes).sort(), ['days', 'referenceDate', 'releasedAt', 'revision', 'weekStart', 'weekStatus']);
  assert.equal(weekSchema.attributes.weekKey.unique, true);
  assert.equal(weekSchema.attributes.employee.target, 'api::team-employee.team-employee');
  const calls = [];
  const routes = router({ strapi: { controller: uid => {
    assert.equal(uid, UID);
    return { read: ctx => calls.push(['read', ctx]), save: ctx => calls.push(['save', ctx]), publish: ctx => calls.push(['publish', ctx]) };
  } } }).routes;
  assert.deepEqual(routes.map(route => [route.method, route.path]), [['GET', '/team-admin/base-salaries'], ['PUT', '/team-admin/base-salaries'], ['POST', '/team-admin/base-salaries/publish']]);
  for (const route of routes) {
    assert.equal(typeof route.handler, 'function');
    assert.deepEqual(route.config.auth, { strategies: ['users-permissions'], scope: [] });
    assert.deepEqual(route.config.policies, ['api::team-employee.team-admin']);
    await route.handler({ fixture: true });
  }
  assert.deepEqual(calls.map(call => call[0]), ['read', 'save', 'publish']);
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
