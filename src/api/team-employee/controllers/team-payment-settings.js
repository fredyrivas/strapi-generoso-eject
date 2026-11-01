'use strict';
module.exports = {
  async read(ctx) {
    return run(ctx, () => strapi.service('api::team-employee.team-payment').readForEmployee(ctx.params.documentId, ctx.state.user.id));
  },
  async save(ctx) {
    return run(ctx, () => strapi.service('api::team-employee.team-payment').saveForEmployee(ctx.params.documentId, ctx.request.body, ctx.state.user.id));
  },
};
async function run(ctx, operation) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  if (Object.keys(ctx.query ?? {}).length) return ctx.badRequest('La cuenta de pago no se guarda por semana.');
  try { ctx.body = await operation(); }
  catch (error) {
    if (error.details?.code !== 'TEAM_CONFLICT') throw error;
    ctx.status = 409; ctx.body = { error: { message: error.message } };
  }
}
