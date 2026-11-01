'use strict';
const { errors: { ValidationError } } = require('@strapi/utils');
const FIELDS = ['monthlySalary', 'restDay', 'payGroup', 'consumptions', 'extraPay', 'cash'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100) throw new ValidationError('Los importes deben ser números válidos no negativos.');
  return value;
}

function fieldValue(field, value) {
  if (field === 'monthlySalary') return value === null ? null : money(value);
  if (field === 'restDay') {
    if (value !== null && (!Number.isInteger(value) || value < 0 || value > 6)) throw new ValidationError('El descanso debe ser un día de lunes a domingo.');
    return value;
  }
  if (field === 'payGroup') {
    if (value !== null && !['fixed', 'auxiliary'].includes(value)) throw new ValidationError('El grupo de reparto debe ser fijo o auxiliar.');
    return value;
  }
  if (field === 'consumptions') {
    if (!Array.isArray(value)) throw new ValidationError('Los consumos deben ser una lista de conceptos e importes.');
    return value.map(item => {
      if (!object(item) || !exactKeys(item, ['concept', 'amount']) || typeof item.concept !== 'string' || !item.concept.trim() || item.concept.trim().length > 180) throw new ValidationError('Cada consumo necesita un concepto de hasta 180 caracteres y un importe.');
      return { concept: item.concept.trim(), amount: money(item.amount) };
    });
  }
  return money(value);
}

function revision(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2147483646) throw new ValidationError('La revisión de la cuenta no es válida.');
  return value;
}

function paymentAccount(value) {
  if (value == null) return { revision: 0, monthlySalary: null, restDay: null, payGroup: null, consumptions: [], extraPay: 0, cash: 0 };
  if (!object(value) || !exactKeys(value, ['revision', ...FIELDS])) throw new ValidationError('Los datos guardados de la cuenta requieren revisión.');
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

module.exports = { paymentAccount, paymentChange, paymentDto };
