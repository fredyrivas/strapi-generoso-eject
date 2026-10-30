'use strict';

module.exports = {
  async welcome(ctx) { return run(ctx, 'welcome', ctx.request.body?.token); },
  async generate(ctx) { return run(ctx, 'generate', ctx.params.documentId); },
  async cancel(ctx) { return run(ctx, 'cancel', ctx.params.documentId); },
};
async function run(ctx, action, input) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  try { ctx.body = await strapi.service('api::team-employee.team-personal-access')[action](input); }
  catch (error) { if (error.details?.code !== 'TEAM_CONFLICT') throw error; ctx.status = 409; ctx.body = { error: { message: error.message } }; }
}
