'use strict';

// There are no generic REST routes. Both custom routes require a real admin session.
module.exports = ({ strapi }) => ({ routes: [
  ['GET', '/team-admin/base-salaries', 'read'],
  ['PUT', '/team-admin/base-salaries', 'save'],
].map(([method, path, action]) => ({
  method, path,
  handler: ctx => strapi.controller('api::team-salary-week.team-salary-week')[action](ctx),
  config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] },
})) });
