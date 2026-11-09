'use strict';
module.exports = ({ strapi }) => ({ routes: [
  {
    method: 'GET', path: '/team-admin/payment-statuses',
    handler: ctx => strapi.controller('api::team-employee.team-payment-statuses').list(ctx),
    config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] },
  },
  ...[['GET', 'read'], ['POST', 'register']].map(([method, action]) => ({
    method, path: '/team-admin/employees/:documentId/payment/confirmations',
    handler: ctx => strapi.controller('api::team-employee.team-payment-confirmations')[action](ctx),
    config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] },
  })),
  ...[['GET', 'read'], ['PATCH', 'save']].map(([method, action]) => ({
    method, path: '/team-admin/employees/:documentId/payment/settings',
    handler: ctx => strapi.controller('api::team-employee.team-payment-settings')[action](ctx),
    config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] },
  })),
  ...[['GET', 'read'], ['PUT', 'save']].map(([method, action]) => ({
    method, path: '/team-admin/employees/:documentId/payment/week',
    handler: ctx => strapi.controller('api::team-employee.team-payment-week')[action](ctx),
    config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] },
  })),
] });
