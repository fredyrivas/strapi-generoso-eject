'use strict';
const { baseSalariesWeek, usesFixedAttendance } = require('../../team-employee/utils/payment-calculation/base-salaries');
const { attendanceKind } = require('../../team-employee/utils/attendance-kind');
const ATTENDANCE = 'api::team-checkin.team-checkin';
const EMPLOYEE = 'api::team-employee.team-employee';

function fixedAttendanceDays(days, week, records, manualFixedDays = []) {
  const people = new Map(week.days.map(({ date }) => [date, new Set()]));
  for (const { date, kind, employee } of records) {
    const present = people.get(date);
    if (!present || employee?.teamRole !== 'employee' || employee.paymentAccount?.payGroup !== 'fixed' || attendanceKind(kind) !== 'normal') continue;
    const dayIndex = week.days.findIndex(day => day.date === date);
    if (employee.paymentAccount.restDay !== dayIndex) present.add(employee.documentId);
  }
  return days.map(day => {
    if (manualFixedDays?.includes(day.dayIndex)) return day;
    const { date } = week.days[day.dayIndex];
    return { ...day, input: { ...day.input, fixedMembers: date <= week.today ? people.get(date).size : null } };
  });
}

async function withFixedAttendance(strapi, snapshot, now, manualFixedDays) {
  if (!usesFixedAttendance(snapshot.weekStart)) return snapshot;
  const week = baseSalariesWeek(snapshot.weekStart, now);
  const records = [];
  if (week.start <= week.today) {
    const limit = 250;
    for (let start = 0; ; start += limit) {
      const rows = await strapi.documents(ATTENDANCE).findMany({
        filters: { date: { $gte: week.start, $lt: week.endExclusive, $lte: week.today }, employee: { teamRole: 'employee' } },
        fields: ['date', 'kind'],
        populate: { employee: { fields: ['documentId'] } },
        sort: ['id:asc'], start, limit,
      });
      const ids = [...new Set(rows.flatMap(row => row.employee ? [row.employee.documentId] : []))];
      // Strapi restricts private fields in nested population. Load payment accounts through the employee service.
      const employees = ids.length ? await strapi.documents(EMPLOYEE).findMany({
        filters: { documentId: { $in: ids } },
        fields: ['documentId', 'teamRole', 'paymentAccount'], limit: ids.length,
      }) : [];
      const byId = new Map(employees.map(employee => [employee.documentId, employee]));
      records.push(...rows.map(row => ({ ...row, employee: byId.get(row.employee?.documentId) })));
      if (rows.length < limit) break;
    }
  }
  return { ...snapshot, days: fixedAttendanceDays(snapshot.days, week, records, manualFixedDays) };
}

module.exports = { fixedAttendanceDays, withFixedAttendance };
