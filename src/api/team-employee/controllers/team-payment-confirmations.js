'use strict';

const { weekStartInput } = require('../../team-salary-week/utils/input');
const service = () => strapi.service('api::team-employee.team-payment-confirmations');

module.exports = {
  async read(ctx) {
    ctx.set('Cache-Control', 'no-store');
    if (Object.keys(ctx.query).length !== 1) return ctx.badRequest('Selecciona la semana del pago.');
    ctx.body = await service().read(ctx.params.documentId, ctx.state.user.id, weekStartInput(ctx.query.week));
  },

  async register(ctx) {
    ctx.set('Cache-Control', 'no-store');
    if (Object.keys(ctx.query).length) return ctx.badRequest('Envía la semana en los datos del pago.');
    try {
      ctx.body = await service().register(ctx.params.documentId, ctx.state.user, ctx.request.body);
    } catch (error) {
      if (error.details?.code !== 'TEAM_CONFLICT') throw error;
      ctx.status = 409;
      ctx.body = { error: { message: error.message } };
    }
  },
};
