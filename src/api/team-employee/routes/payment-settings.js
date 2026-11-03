'use strict';
module.exports = ({ strapi }) => ({ routes: [
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
