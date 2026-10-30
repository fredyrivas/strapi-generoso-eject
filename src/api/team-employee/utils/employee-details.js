'use strict';

const { errors: { ValidationError } } = require('@strapi/utils');

const DETAIL_FIELDS = ['fullName', 'startDate', 'phone', 'position'];
const WRITABLE_FIELDS = new Set([...DETAIL_FIELDS, 'teamRole']);

function normalizeEmail(value) {
  if (typeof value !== 'string') throw new ValidationError('Escribe un email válido.');
  const email = value.trim().toLowerCase();
  if (email.length < 6 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError('Escribe un email válido.');
  return email;
}

function normalizeText(value, field, maxLength) {
  if (typeof value !== 'string') throw new ValidationError(`El campo ${field} es obligatorio.`);
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (normalized.length < 2 || normalized.length > maxLength) {
    throw new ValidationError(`El campo ${field} debe tener entre 2 y ${maxLength} caracteres.`);
  }
  return normalized;
}

function normalizeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError('La fecha de ingreso debe usar el formato AAAA-MM-DD.');
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value.startsWith('0000')) {
    throw new ValidationError('La fecha de ingreso no es válida.');
  }
  return value;
}

function normalizePhone(value) {
  if (typeof value !== 'string' || !/^[+\d\s().-]+$/.test(value)) {
    throw new ValidationError('Escribe un teléfono válido.');
  }
  let phone = value.replace(/[\s().-]/g, '');
  // Local Mexican numbers use ten digits. Other countries must include their + prefix.
  if (/^\d{10}$/.test(phone)) phone = `+52${phone}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new ValidationError('Usa diez dígitos para México o un teléfono con prefijo internacional +.');
  }
  return phone;
}

function validateEmployeeDetails(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Los datos del empleado no son válidos.');
  }
  if (Object.keys(input).some((key) => !WRITABLE_FIELDS.has(key))) {
    throw new ValidationError('Solo se pueden modificar los datos laborales y el rol de Team.');
  }
  const result = {};
  for (const field of DETAIL_FIELDS) {
    if (partial && !Object.hasOwn(input, field)) continue;
    switch (field) {
      case 'fullName': result.fullName = normalizeText(input.fullName, 'nombre completo', 180); break;
      case 'position': result.position = normalizeText(input.position, 'puesto', 100); break;
      case 'startDate': result.startDate = normalizeDate(input.startDate); break;
      case 'phone': result.phone = normalizePhone(input.phone); break;
    }
  }
  if (Object.hasOwn(input, 'teamRole')) {
    if (!['employee', 'admin'].includes(input.teamRole)) throw new ValidationError('El rol de Team no es válido.');
    result.teamRole = input.teamRole;
  }
  if (partial && Object.keys(result).length === 0) throw new ValidationError('No hay datos para actualizar.');
  return result;
}

function employeeProfile(entry) {
  if (!entry) return null;
  if (!entry.account?.email) throw new Error('El perfil requiere su cuenta vinculada.');
  return {
    documentId: entry.documentId,
    fullName: entry.fullName,
    startDate: entry.startDate,
    phone: entry.phone,
    position: entry.position,
    email: entry.account.email,
    status: entry.status,
    teamRole: entry.teamRole,
  };
}

module.exports = { validateEmployeeDetails, employeeProfile, normalizeEmail };
