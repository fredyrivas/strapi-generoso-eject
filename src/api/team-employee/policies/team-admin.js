'use strict';

module.exports = async (context, _config, { strapi }) => {
  const user = context.state.user;
  if (!user || !Number.isSafeInteger(user.id) || user.confirmed !== true || user.blocked) return false;
  const profile = await strapi.documents('api::team-employee.team-employee').findFirst({
    filters: { account: { id: user.id } }, fields: ['teamRole', 'status'],
  });
  if (profile?.status === 'inactive') return false;
  const bootstrapRole = (process.env.TEAM_BOOTSTRAP_ADMIN_ROLE || 'backstageadmin').trim().toLowerCase();
  const isBootstrap = [user.role?.type, user.role?.name].some((role) => typeof role === 'string' && role.toLowerCase() === bootstrapRole);
  if (!isBootstrap && !(profile?.status === 'active' && profile.teamRole === 'admin')) return false;
  context.state.teamAdmin = { username: user.username ?? '', email: user.email ?? '' };
  return true;
};
