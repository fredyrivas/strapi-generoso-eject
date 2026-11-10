'use strict';

const uid = 'api::team-candidate.team-candidate';

module.exports = {
  async list(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await strapi.service(uid).list(ctx.query);
  },
  async create(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await strapi.service(uid).create(ctx.request.body, ctx.state.user);
    ctx.status = 201;
  },
  async read(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await strapi.service(uid).read(ctx.params.documentId, ctx.state.user);
  },
  async update(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await strapi.service(uid).update(ctx.params.documentId, ctx.request.body, ctx.state.user);
  },
};
