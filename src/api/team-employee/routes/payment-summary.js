'use strict';
module.exports = ({ strapi }) => ({ routes: [
  { method: 'GET', path: '/team/payment', handler: ctx => strapi.controller('api::team-employee.team-payment-summary').mine(ctx), config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-member'] } },
  { method: 'GET', path: '/team-admin/employees/:documentId/payment', handler: ctx => strapi.controller('api::team-employee.team-payment-summary').employee(ctx), config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] } },
] });
