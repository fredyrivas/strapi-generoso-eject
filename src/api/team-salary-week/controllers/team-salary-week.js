'use strict';
const { errors: { ValidationError } } = require('@strapi/utils');

module.exports = {
  async read(ctx) {
    return run(ctx, () => {
      const keys = Object.keys(ctx.query);
      if (keys.some(key => key !== 'week') || (keys.length && typeof ctx.query.week !== 'string')) throw new ValidationError('La base solo se consulta por semana.');
      return strapi.service('api::team-salary-week.team-salary-week').read(ctx.query.week);
    });
  },
  async save(ctx) { return run(ctx, () => strapi.service('api::team-salary-week.team-salary-week').save(ctx.request.body, ctx.state.user)); },
  async publish(ctx) { return run(ctx, () => strapi.service('api::team-salary-week.team-salary-week').publish(ctx.request.body, ctx.state.user)); },
};

async function run(ctx, operation) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  try { ctx.body = await operation(); }
  catch (error) {
    if (error.details?.code !== 'TEAM_CONFLICT') throw error;
    ctx.status = 409; ctx.body = { error: { message: error.message } };
  }
}
