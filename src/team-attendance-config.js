'use strict';
module.exports = async function configureAttendance(strapi) {
  await strapi.service('api::team-employee.team-attendance').purge();
  strapi.cron.add({ teamCurrentWeekAttendance: {
    task: async () => { await strapi.service('api::team-employee.team-attendance').purge(); },
    options: { rule: '0 * * * * *', tz: 'America/Mexico_City' },
  } });
};
