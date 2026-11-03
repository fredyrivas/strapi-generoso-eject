'use strict';
const { errors: { ValidationError } } = require('@strapi/utils');
const { emptyPaymentAdjustments, paymentCancellations, paymentEntries, paymentMoney } = require('./payment-calculation/employee-payment-adjustments');
const { baseSalariesWeek } = require('./payment-calculation/base-salaries');
// Fixed configuration only; lists, cash and cancellations are saved per week in team-payment-week.
const FIELDS = ['monthlySalary', 'restDay', 'payGroup'];
// Accounts saved before weekly records kept these keys; they are moved out once and ignored here.
const LEGACY = ['consumptions', 'extraPay', 'cash', 'cancellations'];
const ADJUSTMENTS = ['consumptions', 'extraPayments', 'cash', 'cancellations'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function money(value) {
  try { return paymentMoney(value); } catch { throw new ValidationError('Los importes deben ser números válidos no negativos.'); }
}

function fieldValue(field, value) {
  if (field === 'monthlySalary') return value === null ? null : money(value);
  if (field === 'restDay') {
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 6)) throw new ValidationError('El descanso debe ser un día de lunes a domingo.');
    return value;
  }
  if (value !== null && !['fixed', 'auxiliary'].includes(value)) throw new ValidationError('El grupo de reparto debe ser fijo o auxiliar.');
  return value;
}

function revision(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2147483646) throw new ValidationError('La revisión de la cuenta no es válida.');
  return value;
}

function paymentAccount(value) {
  if (value == null) return { revision: 0, monthlySalary: null, restDay: null, payGroup: null };
  if (!object(value) || !Object.keys(value).every(key => key === 'revision' || FIELDS.includes(key) || LEGACY.includes(key)) || !['revision', ...FIELDS].every(key => Object.hasOwn(value, key))) throw new ValidationError('Los datos guardados de la cuenta requieren revisión.');
  return { revision: revision(value.revision), ...Object.fromEntries(FIELDS.map(field => [field, fieldValue(field, value[field])])) };
}

function paymentChange(value) {
  if (!object(value) || !exactKeys(value, ['revision', 'changes']) || !object(value.changes)
    || !Object.keys(value.changes).length || Object.keys(value.changes).some(field => !FIELDS.includes(field))) throw new ValidationError('Solo se pueden modificar los datos vigentes de la cuenta.');
  return { revision: revision(value.revision), changes: Object.fromEntries(Object.entries(value.changes).map(([field, entry]) => [field, fieldValue(field, entry)])) };
}

function paymentDto(entry) {
  const payment = paymentAccount(entry.paymentAccount);
  return { employeeDocumentId: entry.documentId, configured: payment.monthlySalary !== null && payment.restDay !== null && payment.payGroup !== null, payment };
}

/** Weekly lists must be dated inside their Monday-to-Sunday week. */
function paymentAdjustments(value, weekStart) {
  if (value == null) return emptyPaymentAdjustments();
  if (!object(value) || !exactKeys(value, ADJUSTMENTS)) throw new ValidationError('Revisa consumos, pagos extra, efectivo y cancelaciones.');
  try {
    const week = baseSalariesWeek(weekStart);
    return { consumptions: paymentEntries(value.consumptions, 'consumos', week), extraPayments: paymentEntries(value.extraPayments, 'pagos extra', week), cash: paymentMoney(value.cash), cancellations: paymentCancellations(value.cancellations) };
  } catch (error) { throw new ValidationError(error instanceof RangeError ? error.message : 'Revisa los ajustes de la semana.'); }
}

module.exports = { paymentAccount, paymentChange, paymentDto, paymentAdjustments, LEGACY };
