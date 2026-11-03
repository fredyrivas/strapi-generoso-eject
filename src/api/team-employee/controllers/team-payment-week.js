'use strict';
const { errors: { ValidationError } } = require('@strapi/utils');
module.exports = {
  async read(ctx) {
    return run(ctx, () => {
      if (Object.keys(ctx.query ?? {}).some(key => key !== 'week') || typeof ctx.query?.week !== 'string') throw new ValidationError('Selecciona la semana de los ajustes.');
      return strapi.service('api::team-employee.team-payment').readWeekForEmployee(ctx.params.documentId, ctx.query.week, ctx.state.user.id);
    });
  },
  async save(ctx) {
    return run(ctx, () => {
      if (Object.keys(ctx.query ?? {}).length) throw new ValidationError('La semana se envía en los datos.');
      return strapi.service('api::team-employee.team-payment').saveWeekForEmployee(ctx.params.documentId, ctx.request.body, ctx.state.user.id, ctx.state.user);
    });
  },
};
async function run(ctx, operation) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  try { ctx.body = await operation(); }
  catch (error) {
    if (error.details?.code !== 'TEAM_CONFLICT') throw error;
    ctx.status = 409; ctx.body = { error: { message: error.message } };
  }
}
