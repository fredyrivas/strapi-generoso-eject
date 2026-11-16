'use strict';

const { errors: { ValidationError, ApplicationError, NotFoundError, ForbiddenError } } = require('@strapi/utils');
const adminPolicy = require('../policies/team-admin');
const { LOCK } = require('../utils/attendance');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user', A = 'api::team-checkin.team-checkin', P = 'api::team-payment-week.team-payment-week';
const L = 'api::team-payment-log.team-payment-log', S = 'api::team-settlement-archive.team-settlement-archive';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const conflict = message => new ApplicationError(message, { code: 'TEAM_CONFLICT' });

function deletionInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['confirmed', 'confirmationEmail', 'legacyDocumentIds', 'scope'].includes(key)) || input.scope !== 'all' || input.confirmed !== true || typeof input.confirmationEmail !== 'string' || input.confirmationEmail.length > 254 || !input.confirmationEmail.trim() || !Array.isArray(input.legacyDocumentIds) || input.legacyDocumentIds.length !== 0 || !input.legacyDocumentIds.every(validId) || new Set(input.legacyDocumentIds).size !== input.legacyDocumentIds.length) throw new ValidationError('Confirma la eliminación completa escribiendo el email de la cuenta.');
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

  async function removeDocuments(uid, filters) {
    let count = 0;
    while (true) {
      const rows = await strapi.documents(uid).findMany({ filters, fields: ['documentId'], limit: 100 });
      if (!rows.length) return count;
      for (const row of rows) { await strapi.documents(uid).delete({ documentId: row.documentId }); count++; }
    }
  }

  async function anonymizeContributions(account) {
    const labels = new Set([account.username, account.email].filter(Boolean).map(value => String(value).slice(0, 300)));
    const anonymous = 'Cuenta eliminada';
    // These records belong to other people. Remove only the departing administrator's attribution.
    async function visit(uid, filters, fields, change) {
      for (let start = 0; ; start += 100) {
        const rows = await strapi.documents(uid).findMany({ filters, fields: ['documentId', ...fields], sort: ['id:asc'], start, limit: 100 });
        for (const row of rows) {
          const data = change(row);
          if (data) await strapi.documents(uid).update({ documentId: row.documentId, data });
        }
        if (rows.length < 100) break;
      }
    }
    await visit(L, {}, ['actor', 'after'], row => {
      if (!labels.has(row.actor)) return null;
      return { actor: anonymous, ...(row.after && labels.has(row.after.actor) ? { after: { ...row.after, actor: anonymous } } : {}) };
    });
    await visit(P, {}, ['paymentConfirmations'], row => {
      const saved = row.paymentConfirmations;
      if (!saved?.events?.some(event => labels.has(event.actor))) return null;
      return { paymentConfirmations: { ...saved, events: saved.events.map(event => labels.has(event.actor) ? { ...event, actor: anonymous } : event) } };
    });
    await visit(S, {}, ['actorAccountId'], row => row.actorAccountId === account.id ? { actorAccountId: 0 } : null);
  }

  return {
    async preview(documentId, actorId) {
      await authorize(actorId);
      const entry = await employee(documentId);
      const self = entry.account.id === actorId;
      return {
        scope: 'all', documentId: entry.documentId, fullName: entry.fullName, email: entry.account.email,
        canDelete: !self, reason: self ? 'No puedes eliminar la cuenta con la que estás administrando.' : null,
        checkins: await strapi.documents(A).count({ filters: { employee: { documentId } } }),
        paymentWeeks: await strapi.documents(P).count({ filters: { employee: { documentId } } }),
        paymentLogs: await strapi.documents(L).count({ filters: { employeeDocumentId: documentId } }),
        settlementArchives: await strapi.documents(S).count({ filters: { employeeDocumentId: documentId } }),
        // Empty fields preserve compatibility with clients using the deletion contract.
        legacyCandidates: [],
      };
    },

    async remove(documentId, input, actorId) {
      if (!validId(documentId)) throw new ValidationError('La persona seleccionada no es válida.');
      const confirmation = deletionInput(input);
      return strapi.db.transaction(async ({ trx }) => {
        // Same order as recording attendance: shared advisory lock,
        // employee row, then account row. All deletes roll back together.
        for (const lock of [LOCK, 'generoso:team:base-salaries']) await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [lock]);
        const row = await strapi.db.connection(strapi.db.metadata.get(E).tableName).transacting(trx).select('id').where({ document_id: documentId }).forUpdate().first();
        if (!row) throw new NotFoundError('La persona seleccionada ya no existe.');
        const entry = await employee(documentId);
        if (entry.account.id === actorId) throw conflict('No puedes eliminar la cuenta con la que estás administrando.');
        const accountRow = await strapi.db.connection(strapi.db.metadata.get(U).tableName).transacting(trx).select('id').where({ id: entry.account.id }).forUpdate().first();
        if (!accountRow) throw conflict('La cuenta ya no está disponible. Actualiza el listado.');
        await authorize(actorId);
        const account = await strapi.db.query(U).findOne({ where: { id: entry.account.id }, select: ['id', 'email', 'username'] });
        if (!account || confirmation.confirmationEmail !== account.email.trim().toLowerCase()) throw conflict('El email no coincide con la cuenta actual. Vuelve a comprobar la eliminación.');
        const checkinsDeleted = await removeDocuments(A, { employee: { documentId } });
        const paymentWeeksDeleted = await removeDocuments(P, { employee: { documentId } });
        const paymentLogsDeleted = await removeDocuments(L, { employeeDocumentId: documentId });
        const settlementArchivesDeleted = await removeDocuments(S, { employeeDocumentId: documentId });
        await anonymizeContributions(account);
        await strapi.documents(E).delete({ documentId });
        const removed = await strapi.plugin('users-permissions').service('user').remove({ id: account.id });
        if (!removed) throw conflict('No se pudo eliminar la cuenta. No se guardó ningún cambio.');
        return { status: 'deleted', scope: 'all', documentId, accountDeleted: true, checkinsDeleted, paymentWeeksDeleted, paymentLogsDeleted, settlementArchivesDeleted, legacyDeleted: 0 };
      });
    },
  };
};
module.exports.deletionInput = deletionInput;
