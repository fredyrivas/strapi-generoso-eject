'use strict';

const { employeeProfile } = require('../utils/employee-details');

module.exports = async (context, _config, { strapi }) => {
  const user = context.state.user;
  if (!user || !Number.isSafeInteger(user.id) || user.confirmed !== true || user.blocked) return false;
  const entry = await strapi.documents('api::team-employee.team-employee').findFirst({
    filters: { account: { id: user.id } },
    fields: ['documentId', 'fullName', 'startDate', 'phone', 'position', 'status', 'teamRole'],
    populate: { account: { fields: ['email'] } },
  });
  if (entry?.status === 'inactive') return false;
  const role = (process.env.TEAM_BOOTSTRAP_ADMIN_ROLE || 'backstageadmin').trim().toLowerCase();
  const bootstrap = [user.role?.type, user.role?.name].some(value => typeof value === 'string' && value.toLowerCase() === role);
  if (entry?.status !== 'active' && !bootstrap) return false;
  context.state.teamSession = {
    user: { username: user.username ?? '', email: user.email ?? '' },
    canAdmin: bootstrap || entry?.teamRole === 'admin',
    profile: entry?.status === 'active' ? employeeProfile(entry) : null,
  };
  return true;
};
