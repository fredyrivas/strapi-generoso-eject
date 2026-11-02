'use strict';
const { errors: { ApplicationError } } = require('@strapi/utils');
const { LOCK } = require('../utils/attendance');
const { attendanceKind } = require('../utils/attendance-kind');
const { storedSnapshot } = require('../../team-salary-week/utils/input');
const { baseSalariesWeek } = require('../utils/payment-calculation/base-salaries');
const { calculateEmployeePaymentRules } = require('../utils/payment-calculation/employee-payment-rules');
const { calculateEmployeePaymentAdjustments } = require('../utils/payment-calculation/employee-payment-adjustments');
const BASE = 'api::team-salary-week.team-salary-week', ATTENDANCE = 'api::team-checkin.team-checkin';
const CONFIGURATION = ['monthlySalary', 'restDay', 'payGroup'];

module.exports = ({ strapi }) => {
  async function summary(loadAccount) {
    return strapi.db.transaction(async ({ trx }) => {
      // Attendance/payment changes and base changes stay stable for this entire read.
      // Always acquire attendance before base; base writes never acquire attendance.
      for (const key of [LOCK, 'generoso:team:base-salaries']) await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
      const account = await loadAccount();
      const row = await strapi.documents(BASE).findFirst({ filters: { recordKey: 'base-sueldos' }, fields: ['referenceDate', 'revision', 'days'] });
      // Only Base sueldos initializes its date. Reading a payment must not create a base.
      const base = row?.referenceDate == null ? null : storedSnapshot(row);
      const missingConfiguration = CONFIGURATION.filter(field => account.payment[field] === null);
      const metadata = {
        employeeDocumentId: account.employeeDocumentId,
        paymentRevision: account.payment.revision,
        referenceDate: base?.referenceDate ?? null,
        baseRevision: base?.revision ?? null,
        missingConfiguration,
        adjustments: calculateEmployeePaymentAdjustments(null, account.payment),
      };
      if (missingConfiguration.length || !base) return { ...metadata, status: missingConfiguration.length ? 'unconfigured' : 'base_pending', calculation: null };
      const week = baseSalariesWeek(base.referenceDate);
      const rows = await strapi.documents(ATTENDANCE).findMany({
        filters: { employee: { documentId: account.employeeDocumentId }, date: { $gte: week.start, $lt: week.endExclusive } },
        fields: ['date', 'timestamp', 'kind'], sort: ['date:asc'], limit: 8,
      });
      // A week has at most seven daily records; don't silently truncate duplicates.
      if (rows.length > 7) throw new ApplicationError('Revisa los registros de asistencia del empleado.');
      let calculation;
      try {
        calculation = calculateEmployeePaymentRules({
          referenceDate: base.referenceDate,
          monthlySalary: account.payment.monthlySalary,
          restDay: account.payment.restDay,
          payGroup: account.payment.payGroup,
          baseDays: base.days,
          checkins: rows.map(row => ({ date: row.date, timestamp: row.timestamp, kind: attendanceKind(row.kind) })),
        });
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        throw new ApplicationError('Revisa los datos de asistencia y de la cuenta del empleado.');
      }
      // Only this employee's calculated shares leave the service, never the base inputs.
      return { ...metadata, status: calculation.status, calculation, adjustments: calculateEmployeePaymentAdjustments(calculation.subtotal, account.payment, calculation) };
    });
  }
  return {
    async readForAccount(accountId) {
      return summary(() => strapi.service('api::team-employee.team-payment').readForAccount(accountId));
    },
    async readForEmployee(documentId, actorId) {
      return summary(() => strapi.service('api::team-employee.team-payment').readForEmployee(documentId, actorId));
    },
  };
};
