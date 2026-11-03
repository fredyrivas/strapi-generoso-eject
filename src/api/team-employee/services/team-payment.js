'use strict';
const { errors: { ApplicationError, ValidationError, NotFoundError, ForbiddenError } } = require('@strapi/utils');
const adminPolicy = require('../policies/team-admin');
const { LOCK } = require('../utils/attendance');
const { paymentAccount, paymentChange, paymentDto, paymentAdjustments } = require('../utils/payment-account');
const { weekStartInput } = require('../../team-salary-week/utils/input');
const { actorLabel, recordChange } = require('../../team-salary-week/utils/history');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user', P = 'api::team-payment-week.team-payment-week', BASE = 'api::team-salary-week.team-salary-week';
const FIELDS = ['documentId', 'fullName', 'status', 'teamRole', 'paymentAccount'];
const WEEK_FIELDS = ['documentId', 'weekStart', 'revision', 'adjustments', 'configuration'];
const POPULATE = { account: { fields: ['id', 'confirmed', 'blocked', 'provider'] } };

function accountId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ForbiddenError('Inicia sesión con una cuenta válida.');
}
function employeeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new ValidationError('Selecciona un empleado válido.');
}
function weekChange(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'adjustments,revision,weekStart') throw new ValidationError('Revisa la semana y los ajustes.');
  const weekStart = weekStartInput(value.weekStart);
  if (!Number.isInteger(value.revision) || value.revision < 0 || value.revision > 2147483646) throw new ValidationError('La revisión de los ajustes no es válida.');
  return { weekStart, revision: value.revision, adjustments: paymentAdjustments(value.adjustments, weekStart) };
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
  const findWeek = (documentId, weekStart) => strapi.documents(P).findFirst({ filters: { weekKey: documentId + ':' + weekStart }, fields: WEEK_FIELDS });
  const weekDto = (documentId, weekStart, row) => ({ employeeDocumentId: documentId, weekStart, revision: row?.revision ?? 0, adjustments: paymentAdjustments(row?.adjustments ?? null, weekStart) });
  return {
    findWeek,
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

    async readWeekForEmployee(documentId, weekStart, actorId) {
      await authorizeAdmin(actorId);
      weekStartInput(weekStart);
      await findEmployee(documentId);
      return weekDto(documentId, weekStart, await findWeek(documentId, weekStart));
    },

    // Corrections stay possible after publishing; each save raises the revision and is logged.
    async saveWeekForEmployee(documentId, input, actorId, user) {
      await authorizeAdmin(actorId);
      employeeId(documentId);
      const change = weekChange(input);
      return strapi.db.transaction(async ({ trx }) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [LOCK]);
        await lock(E, { document_id: documentId }, trx);
        const entry = await findEmployee(documentId);
        await lock(U, { id: entry.account.id }, trx);
        await authorizeAdmin(actorId);
        const current = await findWeek(documentId, change.weekStart);
        if ((current?.revision ?? 0) !== change.revision) throw new ApplicationError('Los ajustes de la semana cambiaron. Vuelve a consultarlos antes de guardar.', { code: 'TEAM_CONFLICT' });
        let saved;
        if (current) saved = await strapi.documents(P).update({ documentId: current.documentId, data: { adjustments: change.adjustments, revision: current.revision + 1 }, fields: WEEK_FIELDS });
        else {
          // A week published before this employee had a row keeps the configuration they have now.
          const base = await strapi.documents(BASE).findFirst({ filters: { weekStart: change.weekStart }, fields: ['weekStatus'] });
          const { monthlySalary, restDay, payGroup } = paymentAccount(entry.paymentAccount);
          const configuration = base?.weekStatus === 'published' ? { monthlySalary, restDay, payGroup } : null;
          saved = await strapi.documents(P).create({ data: { employee: documentId, weekKey: documentId + ':' + change.weekStart, weekStart: change.weekStart, revision: 1, adjustments: change.adjustments, configuration }, fields: WEEK_FIELDS });
        }
        await recordChange(strapi, { weekStart: change.weekStart, area: 'employee', employeeDocumentId: documentId, actor: actorLabel(user), summary: ('Guardó ajustes de ' + (entry.fullName || 'un empleado')).slice(0, 300), before: current?.adjustments ?? null, after: change.adjustments });
        return weekDto(documentId, change.weekStart, saved);
      });
    },
  };
};
