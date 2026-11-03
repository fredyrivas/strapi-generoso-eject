'use strict';
const LOG = 'api::team-payment-log.team-payment-log';

const actorLabel = user => String(user?.username || user?.email || 'Administración').slice(0, 300);

// Before/after values stay in the log for audits; screens only receive who, when and what.
async function recordChange(strapi, entry) {
  await strapi.documents(LOG).create({ data: { employeeDocumentId: null, before: null, after: null, ...entry } });
}

async function weekHistory(strapi, weekStart) {
  const rows = await strapi.documents(LOG).findMany({ filters: { weekStart }, fields: ['createdAt', 'actor', 'summary'], sort: ['createdAt:desc'], limit: 50 });
  return rows.map(row => ({ at: new Date(row.createdAt).toISOString(), actor: row.actor, summary: row.summary }));
}

module.exports = { actorLabel, recordChange, weekHistory };
