'use strict';
module.exports = {
  async welcome(ctx) {
    if (!ctx.state.teamSession?.profile) return ctx.notFound('Esta cuenta no tiene un perfil de empleado activo.');
    return run(ctx, () => strapi.service('api::team-employee.team-attendance').welcomeForAccount(ctx.state.user.id));
  },
  async record(ctx) { return run(ctx, () => strapi.service('api::team-employee.team-attendance').record(ctx.state.user.id, ctx.request.body)); },
  async reportSick(ctx) { return run(ctx, () => strapi.service('api::team-employee.team-attendance').reportSick(ctx.state.user.id, ctx.request.body)); },
  async adminRecord(ctx) { return run(ctx, () => strapi.service('api::team-employee.team-attendance').adminRecord(ctx.params.documentId, ctx.params.date, ctx.request.body)); },
  async adminWeek(ctx) {
    const query = ctx.query ?? {};
    if (Object.keys(query).some(key => key !== 'page' && key !== 'week') || (Object.hasOwn(query, 'week') && typeof query.week !== 'string')) return ctx.badRequest('La asistencia solo se consulta por página y semana.');
    return run(ctx, () => strapi.service('api::team-employee.team-attendance').adminWeek(query.page ?? '1', query.week ?? null));
  },
};
async function run(ctx, operation) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  try { ctx.body = await operation(); }
  catch (error) { if (error.details?.code !== 'TEAM_CONFLICT') throw error; ctx.status = 409; ctx.body = { error: { message: error.message } }; }
}
