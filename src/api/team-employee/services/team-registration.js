'use strict';

const { randomUUID } = require('node:crypto');
const { errors: { ApplicationError, ValidationError } } = require('@strapi/utils');
const { validateEmployeeDetails, normalizeEmail } = require('../utils/employee-details');
const { newInvitation, adminEmployee } = require('../utils/invitations');
const EMPLOYEE = 'api::team-employee.team-employee';
const ACCOUNT = 'plugin::users-permissions.user';
const FIELDS = ['documentId', 'fullName', 'startDate', 'phone', 'position', 'status', 'teamRole', 'invitationExpiresAt', 'invitationCancelled', 'invitationAccepted', 'activationTokenHash', 'activationExpiresAt', 'personalTokenHash'];
const POPULATE = { account: { fields: ['email', 'blocked', 'confirmed', 'provider'] } };
const conflict = (message) => new ApplicationError(message, { code: 'TEAM_CONFLICT' });

function registrationDetails(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Completa los datos de la persona.');
  const { email: rawEmail, ...details } = input;
  const email = normalizeEmail(rawEmail);
  return { email, details: validateEmployeeDetails(details) };
}

module.exports = ({ strapi }) => ({
  async list(rawPage = '1', rawStatus) {
    if (rawStatus !== undefined && rawStatus !== 'invited') throw new ValidationError('El filtro de invitaciones no es válido.');
    const filters = rawStatus === 'invited' ? { status: 'invited' } : {};
    if (!/^[1-9]\d{0,4}$/.test(String(rawPage))) throw new ValidationError('La página solicitada no es válida.');
    const page = Number(rawPage);
    const pageSize = 25;
    const docs = strapi.documents(EMPLOYEE);
    const [entries, total] = await Promise.all([
      docs.findMany({ filters, fields: FIELDS, populate: POPULATE, sort: ['createdAt:desc', 'documentId:asc'], start: (page - 1) * pageSize, limit: pageSize }),
      docs.count({ filters }),
    ]);
    return { employees: entries.map(adminEmployee), pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) } };
  },

  async prepareInvitation(input) {
    const { email, details } = registrationDetails(input);
    return strapi.db.transaction(async ({ trx }) => {
      // Also serializes requests when the email does not have an account yet.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`generoso:team:email:${email}`]);
      const accounts = await strapi.db.query(ACCOUNT).findMany({ where: { email: { $eqi: email } }, limit: 2 });
      if (accounts.length > 1) throw conflict('Hay varias cuentas con ese email. Revisa la vinculación antes de invitar.');
      let account = accounts[0];
      if (account && (account.blocked || account.provider !== 'local')) throw conflict('Esta cuenta requiere revisión antes de vincularla a Team.');
      const employeeService = strapi.service(EMPLOYEE);
      if (account && await employeeService.findForAccount(account.id)) throw conflict('Este email ya tiene una persona registrada en Team.');
      if (!account) {
        const role = await strapi.db.query('plugin::users-permissions.role').findOne({ where: { type: 'teamemployee' } });
        if (!role) throw new ApplicationError('Falta configurar el rol base de empleados.');
        account = await strapi.plugin('users-permissions').service('user').add({
          username: `team_${randomUUID().replaceAll('-', '')}`, email, provider: 'local', role: role.id, confirmed: false, blocked: false,
        });
      }
      const profile = await employeeService.createForAccount(account.id, details);
      const invitation = newInvitation();
      const entry = await strapi.documents(EMPLOYEE).update({
        documentId: profile.documentId,
        data: invitation.data,
        fields: FIELDS, populate: POPULATE,
      });
      return { employee: adminEmployee(entry), invitation: { token: invitation.token, expiresAt: invitation.expiresAt } };
    });
  },
});

module.exports.registrationDetails = registrationDetails;
