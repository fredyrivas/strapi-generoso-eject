'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { currentWeek } = require('../src/api/team-employee/utils/personal-access');
test('calendar week uses Mexico City at the exact Sunday/Monday boundary and across year changes', () => {
  for (const [instant, today, start, end] of [
    ['2026-10-26T05:59:59Z', '2026-10-25', '2026-10-19', '2026-10-26'],
    ['2026-10-26T06:00:00Z', '2026-10-26', '2026-10-26', '2026-11-02'],
    ['2026-11-02T05:59:59Z', '2026-11-01', '2026-10-26', '2026-11-02'],
    ['2026-11-02T06:00:00Z', '2026-11-02', '2026-11-02', '2026-11-09'],
    ['2027-01-01T18:00:00Z', '2027-01-01', '2026-12-28', '2027-01-04'],
  ]) { const week = currentWeek(new Date(instant)); assert.equal(week.today, today); assert.equal(week.start, start); assert.equal(week.endExclusive, end); assert.deepEqual(week.days.map(day => day.label), ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo']); assert.equal(week.days[0].date, start); }
});


test('retired personal endpoints expose no routes or welcome identity', async () => {
  assert.deepEqual(require('../src/api/team-employee/routes/personal-access').routes, []);
  const service = require('../src/api/team-employee/services/team-personal-access')({ strapi: {} });
  assert.deepEqual(await service.welcome('a'.repeat(43)), { status: 'invalid' });
});
