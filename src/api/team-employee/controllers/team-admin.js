'use strict';

module.exports = {
  async deletionPreview(ctx) { return deletion(ctx, 'preview'); },
  async remove(ctx) { return deletion(ctx, 'remove'); },
  async update(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Referrer-Policy', 'no-referrer');
    try { ctx.body = await strapi.service('api::team-employee.team-maintenance').update(ctx.params.documentId, ctx.request.body, ctx.state.user.id); }
    catch (error) {
      if (error.details?.code !== 'TEAM_CONFLICT') throw error;
      ctx.status = 409;
      ctx.body = { error: { message: error.message } };
    }
  },
  async session(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.body = { user: ctx.state.teamAdmin };
  },
  async list(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.body = await strapi.service('api::team-employee.team-registration').list(ctx.query.page ?? '1', ctx.query.status);
  },
  async create(ctx) {
    ctx.set('Cache-Control', 'no-store');
    try {
      ctx.body = await strapi.service('api::team-employee.team-registration').prepareInvitation(ctx.request.body);
      ctx.status = 201;
    } catch (error) {
      if (error.details?.code !== 'TEAM_CONFLICT') throw error;
      ctx.status = 409;
      ctx.body = { error: { message: error.message } };
    }
  },
  async regenerate(ctx) {
    return manage(ctx, 'regenerate');
  },
  async cancel(ctx) {
    return manage(ctx, 'cancel');
  },
};

async function deletion(ctx, action) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  try {
    const service = strapi.service('api::team-employee.team-deletion');
    ctx.body = action === 'preview' ? await service.preview(ctx.params.documentId, ctx.state.user.id) : await service.remove(ctx.params.documentId, ctx.request.body, ctx.state.user.id);
  } catch (error) {
    if (error.details?.code !== 'TEAM_CONFLICT') throw error;
    ctx.status = 409; ctx.body = { error: { message: error.message } };
  }
}

async function manage(ctx, action) {
  ctx.set('Cache-Control', 'no-store');
  try {
    ctx.body = await strapi.service('api::team-employee.team-invitation')[action](ctx.params.documentId);
  } catch (error) {
    if (error.details?.code !== 'TEAM_CONFLICT') throw error;
    ctx.status = 409;
    ctx.body = { error: { message: error.message } };
  }
}
