'use strict';
const { errors: { ValidationError } } = require('@strapi/utils');

module.exports = {
  async read(ctx) {
    return run(ctx, () => {
      if (Object.keys(ctx.query).length) throw new ValidationError('La base no se consulta por fecha.');
      return strapi.service('api::team-salary-week.team-salary-week').read();
    });
  },
  async save(ctx) { return run(ctx, () => strapi.service('api::team-salary-week.team-salary-week').save(ctx.request.body)); },
};

async function run(ctx, operation) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  try { ctx.body = await operation(); }
  catch (error) {
    if (error.details?.code !== 'TEAM_CONFLICT') throw error;
    ctx.status = 409; ctx.body = { error: { message: error.message } };
  }
}
