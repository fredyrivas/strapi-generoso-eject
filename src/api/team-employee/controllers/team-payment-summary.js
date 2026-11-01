'use strict';
module.exports = {
  async mine(ctx) {
    return run(ctx, () => strapi.service('api::team-employee.team-payment-summary').readForAccount(ctx.state.user.id));
  },
  async employee(ctx) {
    return run(ctx, () => strapi.service('api::team-employee.team-payment-summary').readForEmployee(ctx.params.documentId, ctx.state.user.id));
  },
};
async function run(ctx, operation) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  if (Object.keys(ctx.query ?? {}).length) return ctx.badRequest('El pago usa únicamente la referencia guardada en Base sueldos.');
  ctx.body = await operation();
}
