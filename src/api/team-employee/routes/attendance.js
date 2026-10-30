'use strict';
module.exports = ({ strapi }) => ({ routes: [
  ...[
    ['GET', '/team/welcome', 'welcome'],
    ['POST', '/team/checkin', 'record'],
  ].map(([method, path, action]) => ({ method, path,
    handler: ctx => strapi.controller('api::team-employee.team-attendance')[action](ctx),
    config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-member'],
      ...(action === 'record' ? { middlewares: [{ name: 'plugin::users-permissions.rateLimit', config: { interval: { min: 1 }, max: 10 } }] } : {}),
    },
  })),
  ...[
    ['GET', '/team-admin/checkins', 'adminWeek'],
    ['POST', '/team-admin/checkins/legacy/:documentId/link', 'linkLegacy'],
  ].map(([method, path, action]) => ({ method, path, handler: ctx => strapi.controller('api::team-employee.team-attendance')[action](ctx), config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-admin'] } })),
] });
