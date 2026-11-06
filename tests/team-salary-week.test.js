'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const factory = require('../src/api/team-salary-week/services/team-salary-week');
const { snapshotInput, emptySnapshot, currentWeekStart, closingBonus } = require('../src/api/team-salary-week/utils/input');
const router = require('../src/api/team-salary-week/routes/team-salary-week');
const schema = require('../src/api/team-salary-week/content-types/team-salary-week/schema.json');
const weekSchema = require('../src/api/team-payment-week/content-types/team-payment-week/schema.json');
const adminPolicy = require('../src/api/team-employee/policies/team-admin');
const { validate } = require('@strapi/utils');
const attendanceSchema = require('../src/api/team-checkin/content-types/team-checkin/schema.json');
const employeeSchema = require('../src/api/team-employee/content-types/team-employee/schema.json');
const { LOCK } = require('../src/api/team-employee/utils/attendance');
const UID = 'api::team-salary-week.team-salary-week', LOG = 'api::team-payment-log.team-payment-log', E = 'api::team-employee.team-employee', P = 'api::team-payment-week.team-payment-week';
const ATTENDANCE = 'api::team-checkin.team-checkin';
const admin = { id: 1, username: 'fredy', email: 'fredy@example.test' };
const config = { revision: 2, monthlySalary: 8000, restDay: 0, payGroup: 'fixed' };

function harness({ failCreate = false, failUpdate = false, clock = () => new Date('2026-11-03T18:00:00Z') } = {}) {
  const state = { rows: [], logs: [], weeks: [], locks: [], attendance: [], employees: [
    { documentId: 'employee-1', teamRole: 'employee', paymentAccount: config },
    { documentId: 'employee-2', teamRole: 'operative', paymentAccount: null },
  ] };
  let queue = Promise.resolve(), sequence = 0;
  const table = uid => ({ [UID]: 'rows', [LOG]: 'logs', [P]: 'weeks' })[uid];
  const matches = (row, filters = {}) => Object.entries(filters).every(([key, value]) => row[key] === value);
  const docs = uid => ({
    async findFirst({ filters }) { return structuredClone(state[table(uid)].find(row => matches(row, filters)) ?? null); },
    async findMany({ filters, fields, populate }) {
      if (uid === ATTENDANCE) {
        assert.equal(filters.employee.teamRole, 'employee');
        // Mirror Strapi's validation of populated fields. A private payment account cannot be populated here.
        await validate.validators.validatePopulate({ schema: attendanceSchema, getModel: () => employeeSchema }, populate, { populate: ['nonAttributesOperators'] });
        return structuredClone(state.attendance.filter(row => row.date >= filters.date.$gte && row.date < filters.date.$lt && row.date <= filters.date.$lte)
          .map(row => ({ ...row, employee: { documentId: row.employee.documentId } })));
      }
      if (uid === E && filters.documentId) {
        assert.deepEqual(fields, ['documentId', 'teamRole', 'paymentAccount']);
        return structuredClone([...new Map(state.attendance.map(row => [row.employee.documentId, row.employee])).values()]
          .filter(employee => filters.documentId.$in.includes(employee.documentId)));
      }
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
    documents: uid => { assert.ok([UID, LOG, E, P, ATTENDANCE].includes(uid)); return docs(uid); },
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
const strip = ({ weekStatus, releasedAt, history, automaticBonusDays, manualFixedDays, ...snapshot }) => snapshot;

test('an unsaved week reads as an empty draft of the current Mexico City week, without writing', async () => {
  const h = harness();
  const value = await h.service.read();
  const empty = emptySnapshot('2026-11-02');
  empty.days[0].input.fixedMembers = 0;
  empty.days[1].input.fixedMembers = 0;
  assert.deepEqual(value, { ...empty, weekStatus: 'draft', releasedAt: null, history: [] });
  assert.deepEqual(await h.service.read('2026-10-26'), { ...emptySnapshot('2026-10-26'), weekStatus: 'draft', releasedAt: null, history: [] });
  assert.equal(h.state.rows.length, 0);
  assert.deepEqual(h.state.locks, [LOCK, 'generoso:team:base-salaries']);
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

test('draft fixed members count unique Servicio/Fijo arrivals and freeze on publication', async () => {
  const h = harness();
  const arrival = (documentId, teamRole = 'employee', payGroup = 'fixed', restDay = null) => ({
    date: '2026-11-02', kind: 'normal', employee: { documentId, teamRole, paymentAccount: { payGroup, restDay } },
  });
  const one = arrival('employee-1');
  h.state.attendance.push(one, { ...one }, { ...arrival('employee-2'), kind: null }, { ...arrival('employee-3'), kind: 'sick' },
    arrival('employee-4', 'production'), arrival('employee-5', 'employee', 'auxiliary'), arrival('employee-6', 'employee', 'fixed', 0),
    { ...arrival('employee-7'), date: '2026-11-04' });
  const input = week('2026-11-02');
  input.days[0].input = { cardTips: 100, cashTips: 40, fixedMembers: 99, auxiliaryMembers: 2, bonuses: 15 };
  const saved = await h.service.save(input, admin);
  assert.deepEqual(saved.days.map(day => day.input.fixedMembers), [2, 0, null, null, null, null, null]);
  assert.deepEqual(saved.days[0].input, { ...input.days[0].input, fixedMembers: 2 });
  one.kind = 'sick';
  h.state.attendance[1].kind = 'sick';
  assert.equal((await h.service.read()).days[0].input.fixedMembers, 1);
  const published = await h.service.publish({ weekStart: input.weekStart, revision: saved.revision, published: true }, admin);
  assert.equal(published.days[0].input.fixedMembers, 1);
  h.state.attendance[2].kind = 'sick';
  assert.equal((await h.service.read()).days[0].input.fixedMembers, 1);
  const reopened = await h.service.publish({ weekStart: input.weekStart, revision: published.revision, published: false }, admin);
  assert.equal(reopened.days[0].input.fixedMembers, 0);
});

test('stored null manual fixed days allow reading and publishing with automatic attendance', async () => {
  const h = harness();
  const input = week('2026-11-02');
  input.days[0].input = { cardTips: 100, cashTips: 20, fixedMembers: 99, auxiliaryMembers: 0, bonuses: 100 };
  h.state.rows.push({ ...input, documentId: 'legacy-week', revision: 1, weekStatus: 'draft', releasedAt: null, manualFixedDays: null });
  h.state.attendance.push({ date: '2026-11-02', kind: 'normal', employee: { documentId: 'employee-1', teamRole: 'employee', paymentAccount: { payGroup: 'fixed', restDay: null } } });
  const before = structuredClone(h.state.rows);
  const current = await h.service.read();
  assert.deepEqual(current.days[0].input, { ...input.days[0].input, fixedMembers: 1 });
  assert.deepEqual(current.days.map(day => day.input.fixedMembers), [1, 0, null, null, null, null, null]);
  assert.equal(current.manualFixedDays, undefined);
  assert.deepEqual(h.state.rows, before);
  const published = await h.service.publish({ weekStart: input.weekStart, revision: 1, published: true }, admin);
  assert.equal(published.weekStatus, 'published');
  assert.equal(published.revision, 2);
  assert.deepEqual(published.days[0].input, current.days[0].input);
});

test('manual fixed counts persist while automatic counts refresh for other dates', async () => {
  const h = harness();
  const input = week('2026-11-02');
  input.days[0].input.fixedMembers = 3;
  const saved = await h.service.save({ ...input, fixedMemberEdits: [0] }, admin);
  assert.deepEqual(saved.manualFixedDays, [0]);
  assert.equal(saved.days[0].input.fixedMembers, 3);
  h.state.attendance.push({ date: '2026-11-03', kind: 'normal', employee: { documentId: 'employee-1', teamRole: 'employee', paymentAccount: { payGroup: 'fixed' } } });
  const next = await h.service.read();
  assert.deepEqual(next.days.slice(0, 2).map(day => day.input.fixedMembers), [3, 1]);
  const oldEditor = strip(saved);
  oldEditor.days[0].input.fixedMembers = 2;
  const second = await h.service.save(oldEditor, admin);
  assert.equal(second.days[0].input.fixedMembers, 3);
  const published = await h.service.publish({ weekStart: input.weekStart, revision: second.revision, published: true }, admin);
  assert.equal(published.days[0].input.fixedMembers, 3);
  const reopened = await h.service.publish({ weekStart: input.weekStart, revision: published.revision, published: false }, admin);
  const reset = strip(reopened);
  reset.days[0].input.fixedMembers = null;
  const automatic = await h.service.save({ ...reset, fixedMemberEdits: [0] }, admin);
  assert.equal(automatic.manualFixedDays, undefined);
  assert.equal(automatic.days[0].input.fixedMembers, 0);
});

test('the models keep one base per week and the routes stay session-protected', async () => {
  assert.equal(schema.options.draftAndPublish, false);
  assert.equal(schema.attributes.weekStart.unique, true);
  assert.equal(schema.attributes.days.private, true);
  assert.equal(schema.attributes.closingRevenues.private, true);
  assert.deepEqual(schema.attributes.weekStatus.enum, ['draft', 'published']);
  assert.deepEqual(Object.keys(schema.attributes).sort(), ['closingRevenues', 'days', 'manualFixedDays', 'referenceDate', 'releasedAt', 'revision', 'weekStart', 'weekStatus']);
  assert.equal(weekSchema.attributes.weekKey.unique, true);
  assert.equal(weekSchema.attributes.employee.target, 'api::team-employee.team-employee');
  const calls = [];
  const routes = router({ strapi: { controller: uid => {
    assert.equal(uid, UID);
    return { read: ctx => calls.push(['read', ctx]), save: ctx => calls.push(['save', ctx]), publish: ctx => calls.push(['publish', ctx]), readDailyTips: ctx => calls.push(['readDailyTips', ctx]), saveDailyTips: ctx => calls.push(['saveDailyTips', ctx]) };
  } } }).routes;
  assert.deepEqual(routes.map(route => [route.method, route.path]), [['GET', '/team-admin/base-salaries'], ['PUT', '/team-admin/base-salaries'], ['POST', '/team-admin/base-salaries/publish'], ['GET', '/team/daily-tips'], ['PUT', '/team/daily-tips']]);
  for (const route of routes) {
    assert.equal(typeof route.handler, 'function');
    assert.deepEqual(route.config.auth, { strategies: ['users-permissions'], scope: [] });
    assert.deepEqual(route.config.policies, [route.path === '/team/daily-tips' ? 'api::team-employee.team-member' : 'api::team-employee.team-admin']);
    await route.handler({ fixture: true });
  }
  assert.deepEqual(calls.map(call => call[0]), ['read', 'save', 'publish', 'readDailyTips', 'saveDailyTips']);
});

test('daily bonus uses complete income thresholds and caps at 600 pesos', () => {
  const inputs = [0, 4999.99, 5000, 5999.99, 6000, 7000, 7850, 8000, 9000, 9999.99, 10000, 15000];
  assert.deepEqual(inputs.map(closingBonus), [0, 0, 100, 100, 200, 300, 300, 400, 500, 500, 600, 600]);
});

test('daily closing stores revenue, tips and bonus together in the weekly draft', async () => {
  const h = harness();
  const first = await h.service.readDailyTips();
  assert.deepEqual(first, { weekStart: '2026-11-02', today: '2026-11-03', revision: 0, weekStatus: 'draft', days: [
    { date: '2026-11-02', cardTips: null, cashTips: null, revenue: null },
    { date: '2026-11-03', cardTips: null, cashTips: null, revenue: null },
  ] });
  const input = { date: '2026-11-03', revision: 0, cardTips: 125.50, cashTips: 0, revenue: 7850 };
  await h.service.saveDailyTips(input, { username: 'operativo' });
  const adminDraft = strip(await h.service.read());
  adminDraft.days[1].input.auxiliaryMembers = 2;
  adminDraft.days[1].input.bonuses = 999;
  adminDraft.days[0].input.bonuses = 50;
  adminDraft.days[0].input.cardTips = 50;
  const adminSaved = await h.service.save(adminDraft, admin);
  assert.equal(adminSaved.days[1].input.bonuses, 999);
  assert.deepEqual(h.state.rows[0].closingRevenues, { 1: 7850 });
  assert.deepEqual(Object.keys(h.state.rows[0].days[1]).sort(), ['dayIndex', 'input']);
  assert.equal(adminSaved.days[0].input.bonuses, 50);
  assert.equal(adminSaved.automaticBonusDays, undefined);
  assert.equal((await h.service.readDailyTips()).days[1].revenue, 7850);
  await assert.rejects(h.service.saveDailyTips({ ...input, revision: 1 }, admin), error => error.details.code === 'TEAM_CONFLICT');
  await h.service.saveDailyTips({ ...input, revision: 2, cashTips: 30 }, { username: 'operativo' });
  assert.equal((await h.service.read()).days[1].input.bonuses, 999);
  const result = await h.service.saveDailyTips({ ...input, revision: 3, cashTips: 42, revenue: 4999.99 }, { username: 'operativo' });
  assert.equal(h.state.rows.length, 1);
  assert.equal(result.revision, 4);
  assert.deepEqual(result.days, [{ date: '2026-11-02', cardTips: 50, cashTips: null, revenue: null }, { date: '2026-11-03', cardTips: 125.5, cashTips: 42, revenue: 4999.99 }]);
  const current = await h.service.read();
  assert.deepEqual(current.days[1].input, { cardTips: 125.5, cashTips: 42, fixedMembers: 0, auxiliaryMembers: 2, bonuses: 0 });
  assert.equal(current.history[0].actor, 'operativo');
  assert.match(current.history[0].summary, /cierre del 3 de noviembre/);
  for (const change of [{ date: '2026-11-01' }, { date: '2026-11-04' }, { cashTips: -1 }, { cardTips: null }, { revenue: null }, { revenue: -1 }, { bonuses: 10 }]) {
    await assert.rejects(h.service.saveDailyTips({ ...input, revision: 4, ...change }, admin), { name: 'ValidationError' });
  }
  await h.service.publish({ weekStart: first.weekStart, revision: 4, published: true }, admin);
  await assert.rejects(h.service.saveDailyTips({ ...input, revision: 5 }, admin), error => error.details.code === 'TEAM_CONFLICT');
  const published = await h.service.readDailyTips();
  assert.equal(published.weekStatus, 'published');
  assert.equal(published.days[1].revenue, 4999.99);
  assert.equal((await h.service.read()).days[1].input.bonuses, 0);
});

test('Servicio, Operativo and administrators can read and save daily closing in the CMS', async () => {
  const controller = require('../src/api/team-salary-week/controllers/team-salary-week');
  const previous = global.strapi;
  global.strapi = { service: () => ({
    readDailyTips: async () => ({ read: true }),
    saveDailyTips: async () => ({ saved: true }),
  }) };
  try {
    for (const [teamRole, canAdmin, allowed] of [
      ['employee', false, true], ['operative', false, true], ['production', false, false],
      ['admin', true, true], [undefined, true, true], [undefined, false, false],
    ]) {
      for (const [action, result] of [['readDailyTips', { read: true }], ['saveDailyTips', { saved: true }]]) {
        const ctx = {
          state: { teamSession: { canAdmin, profile: teamRole ? { teamRole } : null } },
          query: {}, request: {}, set() {}, forbidden() { this.status = 403; },
        };
        await controller[action](ctx);
        if (allowed) assert.deepEqual(ctx.body, result);
        else assert.equal(ctx.status, 403);
      }
    }
  } finally { global.strapi = previous; }
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
