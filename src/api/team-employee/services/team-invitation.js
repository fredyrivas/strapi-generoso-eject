'use strict';

const { createHash, timingSafeEqual } = require('node:crypto');
const { errors: { ApplicationError, NotFoundError, ValidationError } } = require('@strapi/utils');
const { newInvitation, invitationStatus, adminEmployee } = require('../utils/invitations');
const { acceptanceInput } = require('../utils/invitation-acceptance');
const UID = 'api::team-employee.team-employee';
const ACCOUNT = 'plugin::users-permissions.user';
const FIELDS = ['documentId', 'fullName', 'startDate', 'phone', 'position', 'status', 'teamRole', 'invitationExpiresAt', 'invitationCancelled', 'invitationAccepted', 'invitationTokenHash', 'activationTokenHash', 'activationExpiresAt', 'personalTokenHash'];
const POPULATE = { account: { fields: ['id', 'email', 'blocked', 'provider', 'confirmed'] } };
const conflict = (message) => new ApplicationError(message, { code: 'TEAM_CONFLICT' });

module.exports = ({ strapi }) => {
  async function withLockedEmployee(documentId, operation, allowAccepted = false) {
    if (typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(documentId)) throw new ValidationError('La persona seleccionada no es válida.');
    return strapi.db.transaction(async ({ trx }) => {
      const table = strapi.db.metadata.get(UID).tableName;
      const row = await strapi.db.connection(table).transacting(trx).select('id').where({ document_id: documentId }).forUpdate().first();
      if (!row) throw new NotFoundError('La persona seleccionada no existe.');
      const entry = await strapi.documents(UID).findOne({ documentId, fields: FIELDS, populate: POPULATE });
      if (!entry || entry.status !== 'invited' || !entry.account || entry.account.blocked || entry.account.provider !== 'local') {
        throw conflict('Solo se pueden gestionar invitaciones de cuentas pendientes y disponibles.');
      }
      if (entry.invitationAccepted === true && !allowAccepted) throw conflict('Esta invitación ya fue utilizada.');
      return operation(entry, trx);
    });
  }

  return {
    async validate(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: 'invalid' };
      const entry = await strapi.documents(UID).findFirst({
        filters: { invitationTokenHash: createHash('sha256').update(token).digest('hex') },
        fields: ['fullName', 'startDate', 'phone', 'position', 'status', 'invitationExpiresAt', 'invitationCancelled', 'invitationAccepted'],
        populate: POPULATE,
      });
      if (!entry) return { status: 'invalid' };
      const status = invitationStatus(entry);
      if (status === 'cancelled') return { status: 'cancelled' };
      if (status === 'expired') return { status: 'expired', expiresAt: entry.invitationExpiresAt };
      if (status === 'accepted') return { status: 'accepted' };
      if (status !== 'pending') return { status: 'invalid' };
      const account = await strapi.db.query(ACCOUNT).findOne({ where: { id: entry.account.id }, select: ['password', 'blocked', 'provider', 'confirmed'] });
      if (!account || account.blocked || account.provider !== 'local') return { status: 'invalid' };
      return {
        status: 'pending', name: entry.fullName,
        profile: { fullName: entry.fullName, startDate: entry.startDate, phone: entry.phone, position: entry.position, email: entry.account.email },
        passwordMode: account.password ? 'existing' : 'create',
        expiresAt: entry.invitationExpiresAt, expiresInSeconds: Math.max(1, Math.ceil((Date.parse(entry.invitationExpiresAt) - Date.now()) / 1000)),
      };
    },

    async accept(input) {
      const data = acceptanceInput(input);
      const hash = createHash('sha256').update(data.token).digest('hex');
      const initial = await strapi.documents(UID).findFirst({ filters: { invitationTokenHash: hash }, fields: ['documentId'] });
      if (!initial) throw conflict('La invitación no es válida. Solicita el enlace más reciente.');
      return withLockedEmployee(initial.documentId, async (entry, trx) => {
        // The code can have been replaced while this request waited for the row lock.
        if (!/^[a-f0-9]{64}$/.test(entry.invitationTokenHash ?? '') || !timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(entry.invitationTokenHash, 'hex')) || invitationStatus(entry) !== 'pending') throw conflict('La invitación venció, fue cancelada o ya no es válida.');
        const table = strapi.db.metadata.get(ACCOUNT).tableName;
        const row = await strapi.db.connection(table).transacting(trx).select('id').where({ id: entry.account.id }).forUpdate().first();
        if (!row) throw conflict('La cuenta de esta invitación no está disponible.');
        const account = await strapi.db.query(ACCOUNT).findOne({ where: { id: entry.account.id }, select: ['id', 'password', 'provider', 'blocked', 'confirmed', 'provider'] });
        if (!account || account.blocked || account.provider !== 'local') throw conflict('La cuenta de esta invitación no está disponible.');
        const mode = account.password ? 'existing' : 'create';
        if (mode !== data.mode) throw conflict('La cuenta cambió. Vuelve a comprobar la invitación antes de continuar.');
        const users = strapi.plugin('users-permissions').service('user');
        if (mode === 'existing') {
          if (!await users.validatePassword(data.currentPassword, account.password)) throw new ValidationError('La contraseña actual no es correcta.');
          if (!account.confirmed) await users.edit(account.id, { confirmed: true });
        } else {
          // Hash once with Strapi's existing bcrypt service, then save the hash
          // directly: Document Service otherwise imposes its global plaintext
          // minimum of six characters. This invitation flow allows any nonempty
          // password without changing other account-management policies.
          const hashed = await users.ensureHashedPasswords({ password: data.password });
          const saved = await strapi.db.query(ACCOUNT).update({ where: { id: account.id }, data: { password: hashed.password, confirmed: true } });
          if (!saved) throw conflict('La cuenta de esta invitación ya no está disponible.');
        }
        // A password operation may have crossed the expiry boundary; roll it back too.
        if (invitationStatus(entry) !== 'pending') throw conflict('La invitación ya no está vigente. Solicita una nueva.');
        await strapi.documents(UID).update({ documentId: entry.documentId, data: { status: 'active', invitationAccepted: true, invitationTokenHash: null, invitationExpiresAt: null, invitationCancelled: false, activationTokenHash: null, activationExpiresAt: null }, fields: ['documentId'] });
        return { status: 'activated' };
      });
    },

    // Transition only accounts that already completed the previous acceptance/password step.
    async completeAccepted(documentId) {
      return withLockedEmployee(documentId, async (entry, trx) => {
        if (entry.invitationAccepted !== true) return false;
        const row = await strapi.db.connection(strapi.db.metadata.get(ACCOUNT).tableName).transacting(trx).select('id').where({ id: entry.account.id }).forUpdate().first();
        if (!row) throw conflict('La cuenta ya no está disponible.');
        const account = await strapi.db.query(ACCOUNT).findOne({ where: { id: entry.account.id }, select: ['id', 'password', 'confirmed', 'blocked', 'provider'] });
        if (!account?.password || account.blocked || account.provider !== 'local') throw conflict('La cuenta no completó sus credenciales o no está disponible.');
        if (!account.confirmed) await strapi.plugin('users-permissions').service('user').edit(account.id, { confirmed: true });
        await strapi.documents(UID).update({ documentId: entry.documentId, data: { status: 'active', invitationAccepted: true, invitationTokenHash: null, invitationExpiresAt: null, invitationCancelled: false, activationTokenHash: null, activationExpiresAt: null }, fields: ['documentId'] });
        return true;
      }, true);
    },

    async regenerate(documentId) {
      return withLockedEmployee(documentId, async (entry) => {
        const invitation = newInvitation();
        const updated = await strapi.documents(UID).update({ documentId: entry.documentId, data: invitation.data, fields: FIELDS, populate: POPULATE });
        return { employee: adminEmployee(updated), invitation: { token: invitation.token, expiresAt: invitation.expiresAt } };
      });
    },

    async cancel(documentId) {
      return withLockedEmployee(documentId, async (entry) => {
        const updated = entry.invitationCancelled === true ? entry : await strapi.documents(UID).update({
          documentId: entry.documentId, data: { invitationCancelled: true }, fields: FIELDS, populate: POPULATE,
        });
        return { employee: adminEmployee(updated) };
      });
    },
  };
};
