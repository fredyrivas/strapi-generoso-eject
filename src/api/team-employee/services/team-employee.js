'use strict';

const { errors: { ApplicationError, NotFoundError, ValidationError } } = require('@strapi/utils');
const { validateEmployeeDetails, employeeProfile } = require('../utils/employee-details');

const EMPLOYEE_UID = 'api::team-employee.team-employee';
const ACCOUNT_UID = 'plugin::users-permissions.user';
const PROFILE_FIELDS = ['documentId', 'fullName', 'startDate', 'phone', 'position', 'status', 'teamRole'];
const ACCOUNT_POPULATE = { account: { fields: ['email'] } };

function validateAccountId(accountId) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) throw new ValidationError('La cuenta vinculada no es válida.');
}

// Internal service only: the caller must authorize administration or ownership before using it.
module.exports = ({ strapi }) => {
  const findEntry = (accountId) => strapi.documents(EMPLOYEE_UID).findFirst({
    filters: { account: { id: accountId } },
    fields: PROFILE_FIELDS,
    populate: ACCOUNT_POPULATE,
  });

  // Serialize all employee writes for the same account, including concurrent invitations.
  async function withAccountLock(accountId, operation) {
    validateAccountId(accountId);
    return strapi.db.transaction(async ({ trx }) => {
      const table = strapi.db.metadata.get(ACCOUNT_UID).tableName;
      const account = await strapi.db.connection(table)
        .transacting(trx).select('id').where({ id: accountId }).forUpdate().first();
      if (!account) throw new NotFoundError('La cuenta vinculada no existe.');
      return operation();
    });
  }

  return {
    async findForAccount(accountId) {
      validateAccountId(accountId);
      return employeeProfile(await findEntry(accountId));
    },

    async createForAccount(accountId, input) {
      const details = validateEmployeeDetails(input);
      return withAccountLock(accountId, async () => {
        if (await findEntry(accountId)) throw new ApplicationError('Esta cuenta ya tiene un empleado vinculado.');
        const entry = await strapi.documents(EMPLOYEE_UID).create({
          data: { ...details, teamRole: details.teamRole ?? 'employee', status: 'invited', account: accountId },
          fields: PROFILE_FIELDS,
          populate: ACCOUNT_POPULATE,
        });
        return employeeProfile(entry);
      });
    },

    async updateForAccount(accountId, input) {
      const details = validateEmployeeDetails(input, { partial: true });
      return withAccountLock(accountId, async () => {
        const current = await findEntry(accountId);
        if (!current) throw new NotFoundError('El empleado no existe.');
        const entry = await strapi.documents(EMPLOYEE_UID).update({
          documentId: current.documentId,
          data: details,
          fields: PROFILE_FIELDS,
          populate: ACCOUNT_POPULATE,
        });
        return employeeProfile(entry);
      });
    },
  };
};
