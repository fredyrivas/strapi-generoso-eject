'use strict';
const { errors: { ValidationError } } = require('@strapi/utils');
module.exports = {
  async mine(ctx) {
    return run(ctx, week => strapi.service('api::team-employee.team-payment-summary').readForAccount(ctx.state.user.id, week));
  },
  async employee(ctx) {
    return run(ctx, week => strapi.service('api::team-employee.team-payment-summary').readForEmployee(ctx.params.documentId, ctx.state.user.id, week));
  },
};
async function run(ctx, operation) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  const query = ctx.query ?? {};
  if (Object.keys(query).some(key => key !== 'week') || (Object.hasOwn(query, 'week') && typeof query.week !== 'string')) throw new ValidationError('El pago solo se consulta por semana.');
  ctx.body = await operation(query.week);
}
