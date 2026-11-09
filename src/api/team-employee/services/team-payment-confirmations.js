'use strict';

const { errors: { ValidationError } } = require('@strapi/utils');
const { actorLabel, recordChange } = require('../../team-salary-week/utils/history');
const { attendanceKey, confirmationMatches, confirmationInput, conflict, paymentView } = require('../utils/payment-confirmations');
const { emptyPaymentAdjustments } = require('../utils/payment-calculation/employee-payment-adjustments');
const P = 'api::team-payment-week.team-payment-week';
const SUMMARY = 'api::team-employee.team-payment-summary';

module.exports = ({ strapi, clock = () => new Date() }) => ({
  read(documentId, actorId, weekStart) {
    return strapi.service(SUMMARY).readForEmployee(documentId, actorId, weekStart, (summary, week, attendance) => {
      const saved = week?.paymentConfirmations;
      const view = paymentView(summary, saved?.events ?? []);
      if (view.status && !confirmationMatches(saved, summary.baseRevision, summary.adjustmentsRevision, attendance)) {
        return { ...view, status: 'review' };
      }
      return view;
    });
  },

  register(documentId, actor, input, combinedArchiveKey) {
    const now = clock();
    const change = confirmationInput(input, now);
    return strapi.service(SUMMARY).readForEmployee(documentId, actor.id, change.weekStart, async (summary, week, attendance, configuration) => {
      // The summary holds the attendance and payroll locks through this write.
      const events = week?.paymentConfirmations?.events ?? [];
      const view = paymentView(summary, events);
      const existing = events.find(event => event.requestId === change.requestId);
      if (existing) {
        if (['amountCents', 'paidOn', 'method', 'reference'].some(key => existing[key] !== change[key])) throw conflict('Esta confirmación ya se registró con otros datos.');
        return view;
      }
      if (change.method === 'transfer' && change.reference && events.some(event =>
        event.combinedArchiveKey && event.method === 'transfer' && event.reference.toUpperCase() === change.reference.toUpperCase())) {
        throw conflict('Esa referencia bancaria ya se registró en esta semana.');
      }
      if (view.version !== change.version || view.depositCents !== change.depositCents || view.cashCents !== change.cashCents) {
        throw conflict('Cambió el saldo de esta semana. Revisa los datos vigentes antes de confirmar otro pago.');
      }
      if (view.depositCents === null || view.depositCents < 0 || events.length >= 50) throw new ValidationError('La semana debe estar publicada, completa y con saldo válido para registrar el pago.');
      if (view.cashOnly ? change.method !== 'cash' || change.amountCents !== view.cashCents : change.amountCents > view.pendingCents) {
        throw new ValidationError('El importe debe corresponder al efectivo ya capturado o al saldo pendiente de la semana.');
      }
      const event = {
        requestId: change.requestId, kind: view.cashOnly ? 'included_cash' : 'payment', amountCents: change.amountCents,
        paidOn: change.paidOn, method: change.method, reference: change.reference, recordedAt: now.toISOString(), actor: actorLabel(actor),
        ...(combinedArchiveKey ? { combinedArchiveKey } : {}),
      };
      const next = paymentView(summary, [...events, event]);
      const data = {
        paymentStatus: next.status,
        paymentConfirmations: { events: next.events, baseRevision: summary.baseRevision, adjustmentsRevision: week?.revision ?? 1, attendanceKey: attendanceKey(attendance) },
      };
      const weeks = strapi.documents(P);
      if (week) await weeks.update({ documentId: week.documentId, data });
      else {
        const { monthlySalary, restDay, payGroup } = configuration;
        await weeks.create({ data: { ...data, employee: documentId, weekKey: documentId + ':' + change.weekStart,
          weekStart: change.weekStart, revision: 1, adjustments: emptyPaymentAdjustments(), configuration: { monthlySalary, restDay, payGroup } } });
      }
      await recordChange(strapi, { weekStart: change.weekStart, area: 'employee', employeeDocumentId: documentId,
        actor: event.actor, summary: 'Confirmó un pago semanal', after: event });
      return next;
    });
  },
});
