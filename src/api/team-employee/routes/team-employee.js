'use strict';

// Function handlers avoid Strapi's defaultsDeep adding action scopes to an empty scope array.
// Authentication remains mandatory; the Team policy authorizes every operation.
module.exports = ({ strapi }) => {
  const route = (method, path, action) => ({
    method, path,
    handler: (ctx) => strapi.controller('api::team-employee.team-admin')[action](ctx),
    config: {
      auth: { strategies: ['users-permissions'], scope: [] },
      policies: ['api::team-employee.team-admin'],
    },
  });
  return { routes: [
    route('GET', '/team-admin/session', 'session'),
    route('GET', '/team-admin/employees', 'list'),
    route('POST', '/team-admin/employees', 'create'),
    route('POST', '/team-admin/employees/:documentId/invitation/regenerate', 'regenerate'),
    route('POST', '/team-admin/employees/:documentId/invitation/cancel', 'cancel'),
  ] };
};
