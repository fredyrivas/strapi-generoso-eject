'use strict';

module.exports = ({ strapi }) => ({ routes: [
  {
    method: 'POST', path: '/team/session/renew',
    handler: ctx => strapi.controller('api::team-employee.team-member').renew(ctx),
    config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-member'] },
  },
  ...['session', 'profile'].map(action => ({
    method: 'GET', path: '/team/' + action,
    handler: ctx => strapi.controller('api::team-employee.team-member')[action](ctx),
    config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-member'] },
  })),
  {
    method: 'PATCH', path: '/team-admin/employees/:documentId',
    handler: ctx => strapi.controller('api::team-employee.team-admin').update(ctx),
    config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] },
  },
] });
