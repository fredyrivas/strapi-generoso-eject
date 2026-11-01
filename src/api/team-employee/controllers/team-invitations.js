'use strict';

module.exports = {
  async validate(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Referrer-Policy', 'no-referrer');
    ctx.body = await strapi.service('api::team-employee.team-invitation').validate(ctx.request.body?.token);
  },
  async accept(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Referrer-Policy', 'no-referrer');
    try {
      ctx.body = await strapi.service('api::team-employee.team-invitation').accept(ctx.request.body);
    } catch (error) {
      if (error.details?.code !== 'TEAM_CONFLICT') throw error;
      ctx.status = 409;
      ctx.body = { error: { message: error.message } };
    }
  },
};
