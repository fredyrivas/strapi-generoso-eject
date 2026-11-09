'use strict';

const { createHash } = require('node:crypto');
const { errors: { ValidationError, ApplicationError } } = require('@strapi/utils');
const { weekStartInput } = require('../../team-salary-week/utils/input');
const { baseSalariesWeek } = require('./payment-calculation/base-salaries');
const methods = ['transfer', 'cash', 'other'];
const amount = value => Number.isSafeInteger(value) && value >= 0;
const conflict = message => new ApplicationError(message, { code: 'TEAM_CONFLICT' });

function confirmationInput(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.requestId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(value.requestId) || !amount(value.version) || !amount(value.depositCents) ||
      !amount(value.cashCents) || !amount(value.amountCents) || value.amountCents === 0 || !methods.includes(value.method) ||
      typeof value.reference !== 'string' || value.reference.length > 120 ||
      typeof value.paidOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.paidOn)) throw new ValidationError('Revisa los datos del pago realizado.');
  const paid = new Date(value.paidOn + 'T00:00:00Z');
  const today = baseSalariesWeek(undefined, now).today;
  if (!Number.isFinite(paid.getTime()) || paid.toISOString().slice(0, 10) !== value.paidOn || value.paidOn > today) {
    throw new ValidationError('Indica una fecha de pago válida, sin usar fechas futuras.');
  }
  return {
    weekStart: weekStartInput(value.weekStart), requestId: value.requestId, version: value.version,
    depositCents: value.depositCents, cashCents: value.cashCents, amountCents: value.amountCents,
    paidOn: value.paidOn, method: value.method, reference: value.reference.trim(),
  };
}

function attendanceKey(rows) {
  const entries = rows.map(row => JSON.stringify([row.date, row.timestamp, row.kind ?? null])).sort();
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function confirmationMatches(saved, baseRevision, adjustmentsRevision, attendance) {
  return Boolean(saved && saved.baseRevision === baseRevision && saved.adjustmentsRevision === adjustmentsRevision &&
    saved.attendanceKey === attendanceKey(attendance));
}

function toCents(value) {
  const cents = Math.sign(value) * Math.round(Math.abs(value) * 100 * (1 + Number.EPSILON));
  if (!Number.isSafeInteger(cents)) throw new ValidationError('El importe semanal excede el límite permitido.');
  return cents;
}

function paymentView(summary, events) {
  const ready = summary.weekStatus === 'published' && summary.status === 'ready' && summary.adjustments.deposit !== null;
  const depositCents = ready ? toCents(summary.adjustments.deposit) : null;
  const cashCents = toCents(summary.adjustments.cash);
  const confirmedCents = events.reduce((sum, event) => sum + (event.kind === 'payment' ? event.amountCents : 0), 0);
  const pendingCents = depositCents === null ? null : Math.max(0, depositCents - confirmedCents);
  const cashOnly = depositCents === 0 && cashCents > 0 && events.length === 0;
  const status = events.length === 0 ? null : depositCents === null || depositCents < confirmedCents ? 'review' : pendingCents > 0 ? 'partial' : 'paid';
  const calculation = ready ? summary.calculation : null;
  const salaryCents = calculation ? toCents(calculation.salary) : 0;
  const payroll = calculation ? {
    salaryCents, tipsCents: toCents(calculation.tips), shiftBonusCents: toCents(calculation.shiftBonus),
    punctualityCents: toCents(calculation.punctualityBonus), extrasCents: toCents(summary.adjustments.extraPayTotal),
    consumptionsCents: toCents(summary.adjustments.consumptionTotal), cancelledCents: toCents(summary.adjustments.cancelledTotal),
    totalCents: toCents(summary.adjustments.total),
    salaryDates: salaryCents > 0
      ? calculation.days.filter(day => day.countsForSalary || (day.status === 'rest' && calculation.attendance.paidRestDays > 0)).map(day => day.date)
      : [],
  } : null;
  return { employeeDocumentId: summary.employeeDocumentId, weekStart: summary.weekStart, version: events.length, status,
    depositCents, cashCents, confirmedCents, pendingCents, cashOnly, events, ...(payroll ? { payroll } : {}) };
}

module.exports = { attendanceKey, confirmationMatches, confirmationInput, conflict, paymentView };
