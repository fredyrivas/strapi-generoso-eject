'use strict';
module.exports = ({ strapi }) => ({ routes: [
  { method: 'GET', path: '/team/profile/photo', handler: ctx => strapi.controller('api::team-employee.team-profile-photo').read(ctx), config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-member'] } },
  { method: 'PUT', path: '/team/profile/photo', handler: ctx => strapi.controller('api::team-employee.team-profile-photo').save(ctx), config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: ['api::team-employee.team-member'], middlewares: [{ name: 'plugin::users-permissions.rateLimit', config: { interval: { min: 1 }, max: 10 } }] } },
] });
