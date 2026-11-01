'use strict';
const { errors: { ValidationError } } = require('@strapi/utils');

// Old records remain normal without rewriting or deleting any attendance.
function attendanceKind(value) {
  if (value == null) return 'normal';
  if (value !== 'normal' && value !== 'sick') throw new ValidationError('El tipo de registro de asistencia no es válido.');
  return value;
}

module.exports = { attendanceKind };
