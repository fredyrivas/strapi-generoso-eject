'use strict';

module.exports = ({ strapi }) => ({ routes: [
  ...[['GET', 'list'], ['POST', 'save']].map(([method, action]) => ({
    method,
    path: '/team-admin/employees/:documentId/settlements',
    handler: ctx => strapi.controller('api::team-employee.team-settlement-archive')[action](ctx),
    config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] },
  })),
  {
    method: 'POST', path: '/team-admin/employees/:documentId/settlements/combined',
    handler: ctx => strapi.controller('api::team-employee.team-settlement-archive').registerCombined(ctx),
    config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] },
  },
] });
