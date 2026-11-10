'use strict';

module.exports = ({ strapi }) => {
  const base = '/team-admin/recruitment';
  const route = (method, path, action) => ({
    method, path,
    handler: ctx => strapi.controller('api::team-candidate.team-candidate')[action](ctx),
    config: {
      auth: { strategies: ['users-permissions'], scope: [] },
      policies: ['api::team-employee.team-admin'],
    },
  });
  return { routes: [
    route('GET', base, 'list'),
    route('POST', base, 'create'),
    route('GET', `${base}/:documentId`, 'read'),
    route('PATCH', `${base}/:documentId`, 'update'),
  ] };
};
