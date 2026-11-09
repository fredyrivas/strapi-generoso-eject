'use strict';

// There are no generic REST routes. The daily capture controller checks for Servicio, Operativo or administrative access.
module.exports = ({ strapi }) => ({ routes: [
  ['GET', '/team-admin/base-salaries', 'read'],
  ['GET', '/team-admin/base-salaries/default-week', 'readDefaultWeek'],
  ['PUT', '/team-admin/base-salaries', 'save'],
  ['POST', '/team-admin/base-salaries/publish', 'publish'],
  ['GET', '/team/daily-tips', 'readDailyTips', 'team-member'],
  ['PUT', '/team/daily-tips', 'saveDailyTips', 'team-member'],
].map(([method, path, action, policy = 'team-admin']) => ({
  method, path,
  handler: ctx => strapi.controller('api::team-salary-week.team-salary-week')[action](ctx),
  config: { auth: { strategies: ['users-permissions'], scope: [] }, policies: [`api::team-employee.${policy}`] },
})) });
