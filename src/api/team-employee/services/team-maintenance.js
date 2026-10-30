'use strict';

const { errors: { ValidationError, ApplicationError, NotFoundError } } = require('@strapi/utils');
const { validateEmployeeDetails, normalizeEmail } = require('../utils/employee-details');
const { adminEmployee } = require('../utils/invitations');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user';
const FIELDS = ['documentId', 'fullName', 'startDate', 'phone', 'position', 'status', 'teamRole', 'invitationExpiresAt', 'invitationCancelled', 'invitationAccepted', 'activationTokenHash', 'activationExpiresAt', 'personalTokenHash'];
const POPULATE = { account: { fields: ['id', 'email', 'blocked', 'provider', 'confirmed'] } };
const conflict = message => new ApplicationError(message, { code: 'TEAM_CONFLICT' });

function maintenanceInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => !['fullName', 'startDate', 'phone', 'position', 'teamRole', 'email', 'status'].includes(key))) throw new ValidationError('Solo puedes modificar los datos laborales, email, rol y estado de Team.');
  const { email, status, ...fields } = input;
  const data = Object.keys(fields).length ? validateEmployeeDetails(fields, { partial: true }) : {};
  if (Object.hasOwn(input, 'email')) data.email = normalizeEmail(email);
  if (Object.hasOwn(input, 'status')) {
    if (!['active', 'inactive'].includes(status)) throw new ValidationError('El estado debe ser activo o inactivo.');
    data.status = status;
  }
  return data;
}

module.exports = ({ strapi }) => ({
  async update(documentId, input, actorId) {
    if (typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(documentId) || !Number.isSafeInteger(actorId) || actorId <= 0) throw new ValidationError('La operación no es válida.');
    const data = maintenanceInput(input);
    return strapi.db.transaction(async ({ trx }) => {
      // Same email lock as registration, including when the destination address is unused.
      if (data.email) await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['generoso:team:email:' + data.email]);
      const row = await strapi.db.connection(strapi.db.metadata.get(E).tableName).transacting(trx).select('id').where({ document_id: documentId }).forUpdate().first();
      if (!row) throw new NotFoundError('La persona seleccionada no existe.');
      const entry = await strapi.documents(E).findOne({ documentId, fields: FIELDS, populate: POPULATE });
      if (!entry?.account) throw conflict('El perfil no tiene una cuenta disponible.');
      const accountRow = await strapi.db.connection(strapi.db.metadata.get(U).tableName).transacting(trx).select('id').where({ id: entry.account.id }).forUpdate().first();
      if (!accountRow) throw conflict('La cuenta no está disponible.');
      const account = await strapi.db.query(U).findOne({ where: { id: entry.account.id }, select: ['id', 'email', 'password', 'confirmed', 'blocked', 'provider', 'confirmed'] });
      if (!account || account.provider !== 'local') throw conflict('Esta cuenta requiere revisión antes de editarla.');
      if (data.status && (entry.status === 'invited' || !account.confirmed || !account.password)) throw conflict('Primero debe completarse la invitación y la activación de la cuenta.');
      if (data.status === 'active' && account.blocked) throw conflict('La cuenta está bloqueada y requiere revisión.');
      if (actorId === account.id && (data.status === 'inactive' || (data.teamRole && data.teamRole !== entry.teamRole))) throw conflict('Otro administrador debe cambiar tu rol o desactivar tu cuenta.');
      if (data.email && data.email !== account.email) {
        const duplicate = await strapi.db.query(U).findOne({ where: { id: { $ne: account.id }, $or: [{ email: { $eqi: data.email } }, { username: { $eqi: data.email } }] }, select: ['id'] });
        if (duplicate) throw conflict('Ese email ya está asociado a otra cuenta.');
        await strapi.plugin('users-permissions').service('user').edit(account.id, { email: data.email });
      }
      const employeeData = Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'email'));
      if (data.status === 'inactive') employeeData.personalTokenHash = null;
      if (Object.keys(employeeData).length) await strapi.documents(E).update({ documentId, data: employeeData, fields: ['documentId'] });
      const updated = await strapi.documents(E).findOne({ documentId, fields: FIELDS, populate: POPULATE });
      return { employee: adminEmployee(updated) };
    });
  },
});
module.exports.maintenanceInput = maintenanceInput;
