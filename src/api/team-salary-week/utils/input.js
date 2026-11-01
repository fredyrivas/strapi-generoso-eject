'use strict';
const { errors: { ValidationError } } = require('@strapi/utils');
const FIELDS = ['cardTips', 'cashTips', 'fixedMembers', 'auxiliaryMembers', 'bonuses'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function snapshotInput(value) {
  if (!object(value) || !exactKeys(value, ['referenceDate', 'revision', 'days'])) throw new ValidationError('Revisa los datos de Base sueldos.');
  referenceDateInput(value.referenceDate);
  if (!Number.isInteger(value.revision) || value.revision < 0 || value.revision > 2147483646) throw new ValidationError('La revisión de la base no es válida.');
  if (!Array.isArray(value.days) || value.days.length !== 7) throw new ValidationError('Envía las siete filas de lunes a domingo.');
  const days = new Map();
  for (const day of value.days) {
    if (!object(day) || !exactKeys(day, ['dayIndex', 'input']) || !Number.isInteger(day.dayIndex) || day.dayIndex < 0 || day.dayIndex > 6 || days.has(day.dayIndex) || !object(day.input) || !exactKeys(day.input, FIELDS)) throw new ValidationError('Revisa las siete filas y los cinco campos de cada día.');
    const input = {};
    for (const field of FIELDS) {
      const amount = day.input[field];
      const members = field === 'fixedMembers' || field === 'auxiliaryMembers';
      if (amount !== null && (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0
        || (members ? !Number.isSafeInteger(amount) || amount > Number.MAX_SAFE_INTEGER / 2 : amount > Number.MAX_SAFE_INTEGER / 100))) throw new ValidationError('Los importes deben ser números válidos no negativos y los integrantes deben ser cantidades enteras.');
      input[field] = amount;
    }
    days.set(day.dayIndex, { dayIndex: day.dayIndex, input });
  }
  return { referenceDate: value.referenceDate, revision: value.revision, days: Array.from({ length: 7 }, (_, dayIndex) => days.get(dayIndex)) };
}

function referenceDateInput(value) {
  const date = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + 'T12:00:00Z') : null;
  if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ValidationError('Selecciona una fecha de referencia válida.');
  return value;
}

function currentReferenceDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return value('year') + '-' + value('month') + '-' + value('day');
}

function emptySnapshot(referenceDate = currentReferenceDate()) {
  return { referenceDate, revision: 0, days: Array.from({ length: 7 }, (_, dayIndex) => ({ dayIndex, input: Object.fromEntries(FIELDS.map(field => [field, null])) })) };
}

// Preserve already captured inputs from the former date-keyed representation on read.
// Rows stay independent of dates; only the base's reference date is saved separately.
function storedSnapshot(row) {
  let days = row.days;
  if (Array.isArray(days) && days.every(day => object(day) && exactKeys(day, ['date', 'input']))) {
    days = days.map(day => {
      const date = typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date) ? new Date(day.date + 'T12:00:00Z') : null;
      if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day.date) throw new ValidationError('Revisa las filas guardadas de Base sueldos.');
      return { dayIndex: (date.getUTCDay() + 6) % 7, input: day.input };
    });
  }
  return snapshotInput({ referenceDate: row.referenceDate, revision: row.revision, days });
}

module.exports = { snapshotInput, emptySnapshot, storedSnapshot, currentReferenceDate };
