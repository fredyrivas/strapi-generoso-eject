'use strict';

const { weekStartInput } = require('../../team-salary-week/utils/input');
const { baseSalariesWeek } = require('../utils/payment-calculation/base-salaries');
const { confirmationMatches } = require('../utils/payment-confirmations');
const employeeId = /^[A-Za-z0-9_-]{1,128}$/;

module.exports = {
  async list(ctx) {
    ctx.set('Cache-Control', 'no-store');
    const { week, employees } = ctx.query;
    const ids = typeof employees === 'string' ? employees.split(',') : [];
    if (Object.keys(ctx.query).length !== 2 || !ids.length || ids.length > 25 ||
        new Set(ids).size !== ids.length || !ids.every(id => employeeId.test(id))) {
      return ctx.badRequest('Revisa las personas seleccionadas.');
    }
    const weekStart = weekStartInput(week);
    const weekKeys = ids.map(id => `${id}:${weekStart}`);
    const rows = await strapi.documents('api::team-payment-week.team-payment-week').findMany({
      filters: { weekKey: { $in: weekKeys } }, fields: ['weekKey', 'paymentStatus', 'revision', 'paymentConfirmations'], limit: ids.length,
    });
    const confirmed = rows.filter(row => weekKeys.includes(row.weekKey) && ['partial', 'paid'].includes(row.paymentStatus));
    if (!confirmed.length) { ctx.body = { weekStart, statuses: {} }; return; }
    const confirmedIds = confirmed.map(row => row.weekKey.split(':')[0]);
    const { start, endExclusive } = baseSalariesWeek(weekStart);
    const [base, attendance] = await Promise.all([
      strapi.documents('api::team-salary-week.team-salary-week').findFirst({ filters: { weekStart }, fields: ['revision', 'weekStatus'] }),
      strapi.documents('api::team-checkin.team-checkin').findMany({
        filters: { employee: { documentId: { $in: confirmedIds } }, date: { $gte: start, $lt: endExclusive } },
        fields: ['date', 'timestamp', 'kind'], populate: { employee: { fields: ['documentId'] } }, limit: confirmedIds.length * 7,
      }),
    ]);
    const statuses = Object.fromEntries(confirmed.map((row, index) => {
      const id = confirmedIds[index];
      const current = base?.weekStatus === 'published' && confirmationMatches(
        row.paymentConfirmations, base.revision, row.revision, attendance.filter(entry => entry.employee?.documentId === id),
      );
      return [id, current ? row.paymentStatus : 'review'];
    }));
    ctx.body = { weekStart, statuses };
  },
};
