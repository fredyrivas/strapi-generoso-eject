'use strict';
module.exports = {
  async read(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Referrer-Policy', 'no-referrer');
    if (Object.keys(ctx.query || {}).length) return ctx.badRequest('La foto se consulta desde tu cuenta.');
    ctx.body = await strapi.service('api::team-employee.team-profile-photo').readForAccount(ctx.state.user.id);
  },
  async save(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Referrer-Policy', 'no-referrer');
    if (Object.keys(ctx.query || {}).length) return ctx.badRequest('La foto se guarda desde tu cuenta.');
    ctx.body = await strapi.service('api::team-employee.team-profile-photo').saveForAccount(ctx.state.user.id, ctx.request.body);
  },
};
