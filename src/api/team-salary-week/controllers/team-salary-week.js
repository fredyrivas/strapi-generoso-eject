'use strict';
const { errors: { ValidationError } } = require('@strapi/utils');

module.exports = {
  async readDailyTips(ctx) {
    return dailyTips(ctx, 'readDailyTips');
  },
  async saveDailyTips(ctx) {
    return dailyTips(ctx, 'saveDailyTips');
  },
  async read(ctx) {
    return run(ctx, () => {
      const keys = Object.keys(ctx.query);
      if (keys.some(key => key !== 'week') || (keys.length && typeof ctx.query.week !== 'string')) throw new ValidationError('La base solo se consulta por semana.');
      return strapi.service('api::team-salary-week.team-salary-week').read(ctx.query.week);
    });
  },
  async readDefaultWeek(ctx) {
    return run(ctx, () => strapi.service('api::team-salary-week.team-salary-week').readDefaultWeek());
  },
  async save(ctx) { return run(ctx, () => strapi.service('api::team-salary-week.team-salary-week').save(ctx.request.body, ctx.state.user)); },
  async publish(ctx) { return run(ctx, () => strapi.service('api::team-salary-week.team-salary-week').publish(ctx.request.body, ctx.state.user)); },
};

async function dailyTips(ctx, action) {
  const session = ctx.state.teamSession;
  const role = session?.profile?.teamRole;
  if (!session?.canAdmin && role !== 'employee' && role !== 'operative') return ctx.forbidden();
  return run(ctx, () => {
    if (Object.keys(ctx.query).length) throw new ValidationError('Consulta los cierres de la semana en curso.');
    return strapi.service('api::team-salary-week.team-salary-week')[action](ctx.request.body, ctx.state.user);
  });
}

async function run(ctx, operation) {
  ctx.set('Cache-Control', 'no-store'); ctx.set('Referrer-Policy', 'no-referrer');
  try {
    const result = await operation();
    if ((result?.automaticBonusDays || result?.manualFixedDays) && ctx.get('X-Generoso-Closing') !== '1') {
      const { automaticBonusDays, manualFixedDays, ...snapshot } = result;
      ctx.body = snapshot;
    } else ctx.body = result;
  }
  catch (error) {
    if (error.details?.code !== 'TEAM_CONFLICT') throw error;
    ctx.status = 409; ctx.body = { error: { message: error.message } };
  }
}
