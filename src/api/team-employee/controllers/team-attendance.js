'use strict';
module.exports = {
  async welcome(ctx) {
    if (!ctx.state.teamSession?.profile) return ctx.notFound('Esta cuenta no tiene un perfil de empleado activo.');
    return run(ctx, () => strapi.service('api::team-employee.team-attendance').welcomeForAccount(ctx.state.user.id));
  },
  async record(ctx) { return run(ctx, () => strapi.service('api::team-employee.team-attendance').record(ctx.state.user.id, ctx.request.body)); },
  async adminWeek(ctx) { return run(ctx, () => strapi.service('api::team-employee.team-attendance').adminWeek(ctx.query.page ?? '1', ctx.query.legacyPage ?? '1')); },
  async linkLegacy(ctx) { return run(ctx, () => strapi.service('api::team-employee.team-attendance').linkLegacy(ctx.params.documentId, ctx.request.body?.employeeDocumentId)); },
};
async function run(ctx, operation) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  try { ctx.body = await operation(); }
  catch (error) { if (error.details?.code !== 'TEAM_CONFLICT') throw error; ctx.status = 409; ctx.body = { error: { message: error.message } }; }
}
