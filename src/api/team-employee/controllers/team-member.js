'use strict';

module.exports = {
  async renew(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Referrer-Policy', 'no-referrer');
    // Extend Team only; preserve the global Users & Permissions/Backstage lifetime.
    const jwt = await strapi.plugin('users-permissions').service('jwt').issue({ id: ctx.state.user.id }, { expiresIn: '400d' });
    ctx.body = { ...ctx.state.teamSession, jwt };
  },
  async session(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Referrer-Policy', 'no-referrer');
    ctx.body = ctx.state.teamSession;
  },
  async profile(ctx) {
    ctx.set('Cache-Control', 'no-store');
    ctx.set('Referrer-Policy', 'no-referrer');
    if (!ctx.state.teamSession.profile) return ctx.notFound('Esta cuenta administrativa no tiene un perfil de empleado vinculado.');
    ctx.body = { profile: ctx.state.teamSession.profile };
  },
};
