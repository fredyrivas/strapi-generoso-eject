'use strict';

const { errors: { ValidationError } } = require('@strapi/utils');
const ALLOWED = new Set(['token', 'mode', 'password', 'passwordConfirmation', 'currentPassword', 'reviewConfirmed']);

function acceptanceInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !ALLOWED.has(key))) throw new ValidationError('Los datos de aceptación no son válidos.');
  if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw new ValidationError('El enlace de invitación no es válido.');
  if (!['create', 'existing'].includes(input.mode)) throw new ValidationError('Vuelve a comprobar la invitación.');
  if (input.reviewConfirmed !== true) throw new ValidationError('Confirma que revisaste tus datos.');
  if (input.mode === 'create') {
    const password = input.password;
    if (typeof password !== 'string' || !password) throw new ValidationError('Escribe una contraseña.');
    // Strapi uses bcrypt. Reject oversized inputs rather than silently truncating them.
    if (Buffer.byteLength(password, 'utf8') > 72) throw new ValidationError('La contraseña es demasiado larga. Usa una más corta.');
    if (password !== input.passwordConfirmation) throw new ValidationError('Las contraseñas no coinciden.');
    if (input.currentPassword !== undefined) throw new ValidationError('Vuelve a comprobar el tipo de cuenta.');
    return { token: input.token, mode: 'create', password };
  }
  if (input.password !== undefined || input.passwordConfirmation !== undefined || typeof input.currentPassword !== 'string' || !input.currentPassword || input.currentPassword.length > 1024) throw new ValidationError('Escribe la contraseña actual de tu cuenta.');
  return { token: input.token, mode: 'existing', currentPassword: input.currentPassword };
}

module.exports = { acceptanceInput };
