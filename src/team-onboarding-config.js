'use strict';

// Idempotent transition from the former two-step onboarding; never reactivate inactive staff.
module.exports = async function configureOnboarding(strapi) {
  let after, activated = 0;
  while (true) {
    const entries = await strapi.documents('api::team-employee.team-employee').findMany({
      filters: { status: 'invited', invitationAccepted: true, ...(after ? { documentId: { $gt: after } } : {}) },
      fields: ['documentId'], sort: ['documentId:asc'], limit: 100,
    });
    for (const entry of entries) {
      try { if (await strapi.service('api::team-employee.team-invitation').completeAccepted(entry.documentId)) activated++; }
      catch (error) { if (error.details?.code !== 'TEAM_CONFLICT') throw error; }
    }
    if (entries.length < 100) break;
    after = entries.at(-1).documentId;
  }
  return { activated };
};
