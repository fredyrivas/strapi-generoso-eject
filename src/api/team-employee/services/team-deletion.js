'use strict';

const { errors: { ValidationError, ApplicationError, NotFoundError, ForbiddenError } } = require('@strapi/utils');
const adminPolicy = require('../policies/team-admin');
const { LOCK } = require('../utils/attendance');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user', A = 'api::team-checkin.team-checkin', OLD = 'api::checkin.checkin';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const conflict = message => new ApplicationError(message, { code: 'TEAM_CONFLICT' });

function deletionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['confirmed', 'confirmationEmail', 'legacyDocumentIds'].includes(key)) || input.confirmed !== true || typeof input.confirmationEmail !== 'string' || input.confirmationEmail.length > 254 || !input.confirmationEmail.trim() || !Array.isArray(input.legacyDocumentIds) || input.legacyDocumentIds.length > 1000 || !input.legacyDocumentIds.every(validId) || new Set(input.legacyDocumentIds).size !== input.legacyDocumentIds.length) throw new ValidationError('Confirma la eliminación escribiendo el email de la cuenta y revisa los registros seleccionados.');
  return { confirmationEmail: input.confirmationEmail.trim().toLowerCase(), legacyDocumentIds: input.legacyDocumentIds };
}

module.exports = ({ strapi }) => {
  async function authorize(actorId) {
    if (!Number.isSafeInteger(actorId) || actorId <= 0) throw new ForbiddenError('Inicia sesión con una cuenta administrativa.');
    const user = await strapi.db.query(U).findOne({ where: { id: actorId }, select: ['id', 'username', 'email', 'confirmed', 'blocked'], populate: { role: { select: ['type', 'name'] } } });
    if (!await adminPolicy({ state: { user } }, {}, { strapi })) throw new ForbiddenError('Tu cuenta ya no tiene acceso a administrar Team.');
  }

  async function employee(documentId) {
    if (!validId(documentId)) throw new ValidationError('La persona seleccionada no es válida.');
    const entry = await strapi.documents(E).findOne({ documentId, fields: ['documentId', 'fullName'], populate: { account: { fields: ['id', 'email', 'username'] } } });
    if (!entry) throw new NotFoundError('La persona seleccionada ya no existe.');
    if (!entry.account) throw conflict('El perfil no tiene una cuenta vinculada disponible. Actualiza el listado.');
    return entry;
  }

  // Old arrivals have no account ID. Show exact-name candidates for the
  // administrator to identify explicitly rather than deleting by name alone.
  async function legacyCandidates(entry) {
    const names = [...new Set([entry.fullName, entry.account.username, entry.account.email].filter(Boolean))];
    const rows = await strapi.db.query(OLD).findMany({ where: { $or: names.map(name => ({ empleado: { $eqi: name } })) }, select: ['documentId', 'empleado', 'fecha_dia', 'timestamp'], orderBy: { id: 'desc' }, limit: 1001 });
    const unique = new Map();
    for (const row of rows) if (!unique.has(row.documentId)) unique.set(row.documentId, { documentId: row.documentId, name: row.empleado, date: row.fecha_dia, timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : null });
    if (unique.size > 1000) throw conflict('Hay demasiados registros antiguos para revisar de una vez.');
    return [...unique.values()];
  }

  return {
    async preview(documentId, actorId) {
      await authorize(actorId);
      const entry = await employee(documentId);
      const self = entry.account.id === actorId;
      return {
        documentId: entry.documentId, fullName: entry.fullName, email: entry.account.email,
        canDelete: !self, reason: self ? 'No puedes eliminar la cuenta con la que estás administrando.' : null,
        checkins: await strapi.documents(A).count({ filters: { employee: { documentId } } }),
        legacyCandidates: self ? [] : await legacyCandidates(entry),
      };
    },

    async remove(documentId, input, actorId) {
      if (!validId(documentId)) throw new ValidationError('La persona seleccionada no es válida.');
      const confirmation = deletionInput(input);
      return strapi.db.transaction(async ({ trx }) => {
        // Same order as recording/linking attendance: shared advisory lock,
        // employee row, then account row. All deletes roll back together.
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [LOCK]);
        const row = await strapi.db.connection(strapi.db.metadata.get(E).tableName).transacting(trx).select('id').where({ document_id: documentId }).forUpdate().first();
        if (!row) throw new NotFoundError('La persona seleccionada ya no existe.');
        const entry = await employee(documentId);
        if (entry.account.id === actorId) throw conflict('No puedes eliminar la cuenta con la que estás administrando.');
        const accountRow = await strapi.db.connection(strapi.db.metadata.get(U).tableName).transacting(trx).select('id').where({ id: entry.account.id }).forUpdate().first();
        if (!accountRow) throw conflict('La cuenta ya no está disponible. Actualiza el listado.');
        await authorize(actorId);
        const account = await strapi.db.query(U).findOne({ where: { id: entry.account.id }, select: ['id', 'email'] });
        if (!account || confirmation.confirmationEmail !== account.email.trim().toLowerCase()) throw conflict('El email no coincide con la cuenta actual. Vuelve a comprobar la eliminación.');
        const candidates = await legacyCandidates(entry);
        const allowed = new Set(candidates.map(item => item.documentId));
        if (confirmation.legacyDocumentIds.some(id => !allowed.has(id))) throw conflict('Los registros antiguos cambiaron o no corresponden a esta revisión. Vuelve a comprobar la eliminación.');
        let checkinsDeleted = 0;
        while (true) {
          const rows = await strapi.documents(A).findMany({ filters: { employee: { documentId } }, fields: ['documentId'], limit: 100 });
          if (!rows.length) break;
          for (const arrival of rows) { await strapi.documents(A).delete({ documentId: arrival.documentId }); checkinsDeleted++; }
        }
        for (const id of confirmation.legacyDocumentIds) await strapi.documents(OLD).delete({ documentId: id });
        await strapi.documents(E).delete({ documentId });
        const removed = await strapi.plugin('users-permissions').service('user').remove({ id: account.id });
        if (!removed) throw conflict('No se pudo eliminar la cuenta. No se guardó ningún cambio.');
        return { status: 'deleted', documentId, accountDeleted: true, checkinsDeleted, legacyDeleted: confirmation.legacyDocumentIds.length };
      });
    },
  };
};
module.exports.deletionInput = deletionInput;
