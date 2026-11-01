'use strict';
const { errors: { ApplicationError, ValidationError, NotFoundError, ForbiddenError } } = require('@strapi/utils');
const adminPolicy = require('../policies/team-admin');
const { LOCK } = require('../utils/attendance');
const { paymentAccount, paymentChange, paymentDto } = require('../utils/payment-account');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user';
const FIELDS = ['documentId', 'status', 'teamRole', 'paymentAccount'];
const POPULATE = { account: { fields: ['id', 'confirmed', 'blocked', 'provider'] } };

function accountId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ForbiddenError('Inicia sesión con una cuenta válida.');
}
function employeeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ValidationError('Selecciona un empleado válido.');
}
function requirePayment(entry) {
  if (entry.teamRole === 'operative') throw new ForbiddenError('El rol Operativo no tiene cuenta de pago.');
}

// Internal service: account/actor IDs must come from the authenticated session, never request data.
// No new HTTP routes are exposed in the data-preparation step.
module.exports = ({ strapi }) => {
  async function authorizeAdmin(actorId) {
    accountId(actorId);
    const user = await strapi.db.query(U).findOne({ where: { id: actorId }, select: ['id', 'confirmed', 'blocked', 'username', 'email'], populate: { role: { select: ['type', 'name'] } } });
    if (!await adminPolicy({ state: { user } }, {}, { strapi })) throw new ForbiddenError('Tu cuenta no tiene acceso a administrar pagos.');
  }
  async function findEmployee(documentId) {
    employeeId(documentId);
    const entry = await strapi.documents(E).findOne({ documentId, fields: FIELDS, populate: POPULATE });
    if (!entry) throw new NotFoundError('El empleado ya no existe.');
    if (!entry.account) throw new ApplicationError('La cuenta del empleado no está disponible.');
    requirePayment(entry);
    return entry;
  }
  async function lock(uid, key, trx) {
    const table = strapi.db.metadata.get(uid).tableName;
    const row = await strapi.db.connection(table).transacting(trx).select('id').where(key).forUpdate().first();
    if (!row) throw new NotFoundError('El empleado o su cuenta ya no están disponibles.');
  }
  return {
    async readForAccount(id) {
      accountId(id);
      const entry = await strapi.documents(E).findFirst({ filters: { account: { id } }, fields: FIELDS, populate: POPULATE });
      if (!entry) throw new NotFoundError('Esta cuenta no tiene un perfil de empleado.');
      if (entry.account?.id !== id || entry.status !== 'active' || entry.account.confirmed !== true || entry.account.blocked || entry.account.provider !== 'local') throw new ForbiddenError('Esta cuenta no tiene acceso a consultar su pago.');
      requirePayment(entry);
      return paymentDto(entry);
    },

    async readForEmployee(documentId, actorId) {
      await authorizeAdmin(actorId);
      return paymentDto(await findEmployee(documentId));
    },

    async saveForEmployee(documentId, input, actorId) {
      await authorizeAdmin(actorId);
      employeeId(documentId);
      const change = paymentChange(input);
      return strapi.db.transaction(async ({ trx }) => {
        // Same lock order as attendance/deletion: global lock, employee row, account row.
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [LOCK]);
        await lock(E, { document_id: documentId }, trx);
        const entry = await findEmployee(documentId);
        await lock(U, { id: entry.account.id }, trx);
        await authorizeAdmin(actorId);
        const current = paymentAccount(entry.paymentAccount);
        if (current.revision !== change.revision) throw new ApplicationError('La cuenta cambió. Vuelve a consultarla antes de guardar.', { code: 'TEAM_CONFLICT' });
        const next = paymentAccount({ ...current, ...change.changes, revision: current.revision + 1 });
        const saved = await strapi.documents(E).update({ documentId, data: { paymentAccount: next }, fields: FIELDS });
        return paymentDto(saved);
      });
    },
  };
};
