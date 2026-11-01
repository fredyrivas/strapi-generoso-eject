'use strict';

const { errors: { ValidationError, ApplicationError, NotFoundError } } = require('@strapi/utils');
const { newPersonalAccess } = require('../utils/personal-access');
const { adminEmployee } = require('../utils/invitations');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user';
const FIELDS = ['documentId', 'fullName', 'startDate', 'phone', 'position', 'teamRole', 'status', 'invitationExpiresAt', 'invitationCancelled', 'invitationAccepted', 'activationExpiresAt', 'activationTokenHash', 'personalTokenHash'];
const POPULATE = { account: { fields: ['id', 'email', 'blocked', 'confirmed', 'provider'] } };
const conflict = () => new ApplicationError('El enlace personal solo está disponible para una cuenta activa y confirmada.', { code: 'TEAM_CONFLICT' });
const available = entry => entry?.status === 'active' && entry.account?.confirmed === true && !entry.account.blocked && entry.account.provider === 'local';

module.exports = ({ strapi }) => {
  async function locked(documentId, operation) {
    if (typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(documentId)) throw new ValidationError('La persona seleccionada no es válida.');
    return strapi.db.transaction(async ({ trx }) => {
      const row = await strapi.db.connection(strapi.db.metadata.get(E).tableName).transacting(trx).select('id').where({ document_id: documentId }).forUpdate().first();
      if (!row) throw new NotFoundError('La persona seleccionada no existe.');
      const entry = await strapi.documents(E).findOne({ documentId, fields: FIELDS, populate: POPULATE });
      if (!available(entry)) throw conflict();
      const accountRow = await strapi.db.connection(strapi.db.metadata.get(U).tableName).transacting(trx).select('id').where({ id: entry.account.id }).forUpdate().first();
      if (!accountRow) throw conflict();
      const account = await strapi.db.query(U).findOne({ where: { id: entry.account.id }, select: ['password', 'blocked', 'confirmed', 'provider'] });
      if (!account || !account.password || account.blocked || account.confirmed !== true || account.provider !== 'local') throw conflict();
      return operation(entry);
    });
  }
  return {
    async generate(documentId) {
      return locked(documentId, async () => {
        const access = newPersonalAccess();
        const updated = await strapi.documents(E).update({ documentId, data: access.data, fields: FIELDS, populate: POPULATE });
        return { employee: adminEmployee(updated), personalLink: { token: access.token } };
      });
    },
    async cancel(documentId) {
      return locked(documentId, async () => {
        const updated = await strapi.documents(E).update({ documentId, data: { personalTokenHash: null }, fields: FIELDS, populate: POPULATE });
        return { employee: adminEmployee(updated) };
      });
    },
    async welcome() { return { status: 'invalid' }; },
  };
};
