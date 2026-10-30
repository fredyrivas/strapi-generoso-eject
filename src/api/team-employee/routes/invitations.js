'use strict';

module.exports = ({ strapi }) => ({ routes: [{
  method: 'POST', path: '/team-invitations/validate',
  handler: (ctx) => strapi.controller('api::team-employee.team-invitations').validate(ctx),
  config: {
    auth: false,
    middlewares: [
      // The plugin limiter uses body.email in its key. Strip it so arbitrary emails cannot reset the bucket.
      (ctx, next) => { ctx.request.body = { token: ctx.request.body?.token }; return next(); },
      { name: 'plugin::users-permissions.rateLimit', config: { interval: { min: 1 }, max: 60 } },
    ],
  },
}, {
  method: 'POST', path: '/team-invitations/accept',
  handler: (ctx) => strapi.controller('api::team-employee.team-invitations').accept(ctx),
  config: {
    auth: false,
    middlewares: [
      (ctx, next) => {
        const body = ctx.request.body;
        ctx.request.body = Object.fromEntries(['token', 'mode', 'password', 'passwordConfirmation', 'currentPassword', 'reviewConfirmed'].filter(key => Object.hasOwn(body ?? {}, key)).map(key => [key, body[key]]));
        return next();
      },
      { name: 'plugin::users-permissions.rateLimit', config: { interval: { min: 5 }, max: 10 } },
    ],
  },
}] });
