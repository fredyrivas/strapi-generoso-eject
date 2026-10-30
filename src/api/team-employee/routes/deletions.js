'use strict';
module.exports = ({ strapi }) => ({ routes: [
  ['GET', '/team-admin/employees/:documentId/deletion', 'deletionPreview'],
  ['DELETE', '/team-admin/employees/:documentId', 'remove'],
].map(([method, path, action]) => ({ method, path,
  handler: ctx => strapi.controller('api::team-employee.team-admin')[action](ctx),
  config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] },
})) });
