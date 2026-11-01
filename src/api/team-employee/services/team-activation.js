'use strict';

const { timingSafeEqual } = require('node:crypto');
const { errors: { ApplicationError, NotFoundError, ValidationError } } = require('@strapi/utils');
const { validToken, tokenHash, newActivation, activationStatus } = require('../utils/activations');
const { adminEmployee } = require('../utils/invitations');
const EMPLOYEE = 'api::team-employee.team-employee';
const ACCOUNT = 'plugin::users-permissions.user';
const FIELDS = ['documentId', 'fullName', 'startDate', 'phone', 'position', 'status', 'teamRole', 'invitationAccepted', 'invitationExpiresAt', 'invitationCancelled', 'activationTokenHash', 'activationExpiresAt', 'personalTokenHash'];
const POPULATE = { account: { fields: ['id', 'email', 'blocked', 'provider', 'confirmed'] } };
const conflict = () => new ApplicationError('La activación no está disponible. Pide a tu administrador el enlace más reciente.', { code: 'TEAM_CONFLICT' });

module.exports = ({ strapi }) => {
  async function locked(documentId, operation) {
    if (typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(documentId)) throw new ValidationError('La persona seleccionada no es válida.');
    return strapi.db.transaction(async ({ trx }) => {
      const table = strapi.db.metadata.get(EMPLOYEE).tableName;
      const row = await strapi.db.connection(table).transacting(trx).select('id').where({ document_id: documentId }).forUpdate().first();
      if (!row) throw new NotFoundError('La persona seleccionada no existe.');
      const entry = await strapi.documents(EMPLOYEE).findOne({ documentId, fields: FIELDS, populate: POPULATE });
      if (!entry || entry.status !== 'invited' || entry.invitationAccepted !== true || !entry.account || entry.account.blocked || entry.account.provider !== 'local') throw conflict();
      const accounts = strapi.db.metadata.get(ACCOUNT).tableName;
      const accountRow = await strapi.db.connection(accounts).transacting(trx).select('id').where({ id: entry.account.id }).forUpdate().first();
      if (!accountRow) throw conflict();
      const account = await strapi.db.query(ACCOUNT).findOne({ where: { id: entry.account.id }, select: ['id', 'password', 'blocked', 'provider', 'confirmed'] });
      if (!account || !account.password || account.blocked || account.provider !== 'local') throw conflict();
      return operation(entry, account);
    });
  }

  return {
    async generate(documentId) {
      return locked(documentId, async () => {
        const activation = newActivation();
        const updated = await strapi.documents(EMPLOYEE).update({ documentId, data: activation.data, fields: FIELDS, populate: POPULATE });
        return { employee: adminEmployee(updated), activation: { token: activation.token, expiresAt: activation.expiresAt } };
      });
    },
    async cancel(documentId) {
      return locked(documentId, async () => {
        const updated = await strapi.documents(EMPLOYEE).update({ documentId, data: { activationTokenHash: null, activationExpiresAt: null }, fields: FIELDS, populate: POPULATE });
        return { employee: adminEmployee(updated) };
      });
    },
    async validate(token) {
      if (!validToken(token)) return { status: 'invalid' };
      const entry = await strapi.documents(EMPLOYEE).findFirst({ filters: { activationTokenHash: tokenHash(token) }, fields: FIELDS, populate: POPULATE });
      const status = activationStatus(entry);
      if (!['pending', 'expired'].includes(status) || entry.account.provider !== 'local') return { status: 'invalid' };
      const account = await strapi.db.query(ACCOUNT).findOne({ where: { id: entry.account.id }, select: ['password', 'blocked', 'provider', 'confirmed'] });
      if (!account || !account.password || account.blocked || account.provider !== 'local') return { status: 'invalid' };
      if (status === 'expired') return { status, expiresAt: entry.activationExpiresAt };
      return { status, expiresAt: entry.activationExpiresAt, expiresInSeconds: Math.max(1, Math.ceil((Date.parse(entry.activationExpiresAt) - Date.now()) / 1000)) };
    },
    async confirm(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['token', 'confirmed'].includes(key)) || !validToken(input.token) || input.confirmed !== true) throw new ValidationError('Confirma que deseas activar tu cuenta con el enlace completo.');
      const hash = tokenHash(input.token);
      const initial = await strapi.documents(EMPLOYEE).findFirst({ filters: { activationTokenHash: hash }, fields: ['documentId'] });
      if (!initial) throw conflict();
      return locked(initial.documentId, async (entry, account) => {
        if (!/^[a-f0-9]{64}$/.test(entry.activationTokenHash ?? '') || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(entry.activationTokenHash, 'hex')) || activationStatus(entry) !== 'pending') throw conflict();
        if (!account.confirmed) await strapi.plugin('users-permissions').service('user').edit(account.id, { confirmed: true });
        if (activationStatus(entry) !== 'pending') throw conflict();
        // Confirm the account and employee together; discard the current onboarding codes.
        await strapi.documents(EMPLOYEE).update({ documentId: entry.documentId, data: { status: 'active', activationTokenHash: null, activationExpiresAt: null, invitationTokenHash: null, invitationExpiresAt: null }, fields: ['documentId'] });
        return { status: 'activated' };
      });
    },
  };
};
