'use strict';
const { errors: { ApplicationError, NotFoundError } } = require('@strapi/utils');
const { LOCK } = require('../utils/attendance');
const { attendanceKind } = require('../utils/attendance-kind');
const { paymentAccount, paymentAdjustments } = require('../utils/payment-account');
const { storedSnapshot, weekStartInput, currentWeekStart } = require('../../team-salary-week/utils/input');
const { withFixedAttendance } = require('../../team-salary-week/utils/fixed-attendance');
const { calculateEmployeePaymentRules } = require('../utils/payment-calculation/employee-payment-rules');
const { calculateEmployeePaymentAdjustments, emptyPaymentAdjustments } = require('../utils/payment-calculation/employee-payment-adjustments');
const { baseSalariesWeek } = require('../utils/payment-calculation/base-salaries');
const BASE = 'api::team-salary-week.team-salary-week', ATTENDANCE = 'api::team-checkin.team-checkin';
const CONFIGURATION = ['monthlySalary', 'restDay', 'payGroup'];

module.exports = ({ strapi, clock = () => new Date() }) => {
  // Employees only see published weeks; admins can open any week, published or in capture.
  async function summary(loadAccount, requested, member) {
    return strapi.db.transaction(async ({ trx }) => {
      // Attendance/payment changes and base changes stay stable for this entire read.
      // Always acquire attendance before base; base writes never acquire attendance.
      for (const key of [LOCK, 'generoso:team:base-salaries']) await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
      const account = await loadAccount();
      const weeks = (await strapi.documents(BASE).findMany({ filters: { weekStatus: 'published' }, fields: ['weekStart'], sort: ['weekStart:desc'], limit: 520 })).map(row => row.weekStart);
      const weekStart = requested !== undefined ? weekStartInput(requested) : member ? weeks[0] ?? null : currentWeekStart(clock());
      const row = weekStart ? await strapi.documents(BASE).findFirst({ filters: { weekStart }, fields: ['weekStart', 'weekStatus', 'revision', 'days', 'manualFixedDays'] }) : null;
      if (member && weekStart && row?.weekStatus !== 'published') throw new NotFoundError('Esa semana todavía no está publicada.');
      const week = weekStart ? await strapi.service('api::team-employee.team-payment').findWeek(account.employeeDocumentId, weekStart) : null;
      // A published week keeps the salary configuration it was published with.
      const configuration = week?.configuration ? paymentAccount({ revision: 0, ...week.configuration }) : account.payment;
      const adjustments = weekStart ? paymentAdjustments(week?.adjustments ?? null, weekStart) : emptyPaymentAdjustments();
      const missingConfiguration = CONFIGURATION.filter(field => configuration[field] === null);
      const metadata = {
        employeeDocumentId: account.employeeDocumentId,
        weekStart,
        weekStatus: weekStart ? (row?.weekStatus === 'published' ? 'published' : 'draft') : null,
        weeks,
        paymentRevision: account.payment.revision,
        adjustmentsRevision: week?.revision ?? 0,
        baseRevision: row?.revision ?? null,
        missingConfiguration,
        adjustments: calculateEmployeePaymentAdjustments(null, adjustments),
      };
      if (missingConfiguration.length || !row) return { ...metadata, status: missingConfiguration.length ? 'unconfigured' : 'base_pending', calculation: null };
      const snapshot = storedSnapshot(row);
      const base = row.weekStatus === 'published' ? snapshot : await withFixedAttendance(strapi, snapshot, clock(), row.manualFixedDays);
      const range = baseSalariesWeek(weekStart);
      const rows = await strapi.documents(ATTENDANCE).findMany({
        filters: { employee: { documentId: account.employeeDocumentId }, date: { $gte: range.start, $lt: range.endExclusive } },
        fields: ['date', 'timestamp', 'kind'], sort: ['date:asc'], limit: 8,
      });
      // A week has at most seven daily records; don't silently truncate duplicates.
      if (rows.length > 7) throw new ApplicationError('Revisa los registros de asistencia del empleado.');
      let calculation;
      try {
        calculation = calculateEmployeePaymentRules({
          referenceDate: weekStart,
          monthlySalary: configuration.monthlySalary,
          restDay: configuration.restDay,
          payGroup: configuration.payGroup,
          baseDays: base.days,
          checkins: rows.map(row => ({ date: row.date, timestamp: row.timestamp, kind: attendanceKind(row.kind) })),
        });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        throw new ApplicationError('Revisa los datos de asistencia y de la cuenta del empleado.');
      }
      // Only this employee's calculated shares leave the service, never the base inputs.
      return { ...metadata, status: calculation.status, calculation, adjustments: calculateEmployeePaymentAdjustments(calculation.subtotal, adjustments, calculation) };
    });
  }
  return {
    async readForAccount(accountId, week) {
      return summary(() => strapi.service('api::team-employee.team-payment').readForAccount(accountId), week, true);
    },
    async readForEmployee(documentId, actorId, week) {
      return summary(() => strapi.service('api::team-employee.team-payment').readForEmployee(documentId, actorId), week, false);
    },
  };
};
