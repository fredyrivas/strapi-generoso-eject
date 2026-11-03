'use strict';
const { LOCK } = require('./api/team-employee/utils/attendance');
const { paymentAccount, paymentAdjustments, LEGACY } = require('./api/team-employee/utils/payment-account');
const { noPaymentCancellations } = require('./api/team-employee/utils/payment-calculation/employee-payment-adjustments');
const { storedSnapshot, weekStartOf, currentWeekStart } = require('./api/team-salary-week/utils/input');
const { recordChange } = require('./api/team-salary-week/utils/history');
const BASE = 'api::team-salary-week.team-salary-week', E = 'api::team-employee.team-employee', P = 'api::team-payment-week.team-payment-week';
const ACTOR = 'Sistema';

// One-time move from the single Base sueldos record and per-account adjustments to weekly rows.
// Legacy data is recognized by its shape (a base with referenceDate, accounts with weekly keys), so reruns do nothing.
module.exports = async function configurePaymentWeeks(strapi) {
  await strapi.db.transaction(async ({ trx }) => {
    for (const key of [LOCK, 'generoso:team:base-salaries']) await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
    const legacy = await strapi.documents(BASE).findFirst({ filters: { referenceDate: { $notNull: true } }, fields: ['documentId', 'referenceDate', 'revision', 'days'] });
    const employees = await strapi.documents(E).findMany({ filters: { teamRole: { $ne: 'operative' } }, fields: ['documentId', 'fullName', 'paymentAccount'], limit: 500 });
    const pending = employees.filter(entry => entry.paymentAccount && LEGACY.some(key => Object.hasOwn(entry.paymentAccount, key)));
    if (!legacy && !pending.length) return;
    // Employees could already see the saved week, so it stays visible as a published week.
    const weekStart = legacy ? weekStartOf(legacy.referenceDate) : currentWeekStart();
    const published = Boolean(legacy);
    if (legacy) {
      const { days } = storedSnapshot({ weekStart, revision: legacy.revision, days: legacy.days });
      await strapi.documents(BASE).update({ documentId: legacy.documentId, data: { weekStart, referenceDate: null, weekStatus: 'published', releasedAt: new Date().toISOString(), revision: legacy.revision + 1, days } });
      await recordChange(strapi, { weekStart, area: 'publication', actor: ACTOR, summary: 'Pasó Base sueldos al historial semanal y la dejó publicada' });
    }
    for (const entry of employees) {
      const stored = entry.paymentAccount ?? {};
      const moving = LEGACY.some(key => Object.hasOwn(stored, key));
      const weekKey = entry.documentId + ':' + weekStart;
      const existing = await strapi.documents(P).findFirst({ filters: { weekKey }, fields: ['documentId'] });
      if (!moving && (existing || !published)) continue;
      let account, adjustments;
      try {
        account = paymentAccount(entry.paymentAccount);
        adjustments = paymentAdjustments(moving ? {
          consumptions: (stored.consumptions ?? []).map(item => ({ date: weekStart, concept: item.concept, amount: item.amount })),
          extraPayments: stored.extraPay > 0 ? [{ date: weekStart, concept: 'Pago extra', amount: stored.extraPay }] : [],
          cash: stored.cash ?? 0, cancellations: stored.cancellations ?? noPaymentCancellations(),
        } : null, weekStart);
      } catch (error) {
        // Keep the legacy values in place for manual review instead of losing them.
        strapi.log.error(`[team-payment-weeks] No se pudieron mover los ajustes de ${entry.documentId}: ${error.message}`);
        continue;
      }
      const configuration = published ? { monthlySalary: account.monthlySalary, restDay: account.restDay, payGroup: account.payGroup } : null;
      if (!existing) await strapi.documents(P).create({ data: { employee: entry.documentId, weekKey, weekStart, revision: 1, adjustments, configuration } });
      if (moving) {
        await strapi.documents(E).update({ documentId: entry.documentId, data: { paymentAccount: { revision: account.revision + 1, monthlySalary: account.monthlySalary, restDay: account.restDay, payGroup: account.payGroup } } });
        await recordChange(strapi, { weekStart, area: 'employee', employeeDocumentId: entry.documentId, actor: ACTOR, summary: ('Pasó los ajustes de ' + (entry.fullName || 'un empleado') + ' al historial semanal').slice(0, 300), before: stored, after: adjustments });
      }
    }
  });
};
