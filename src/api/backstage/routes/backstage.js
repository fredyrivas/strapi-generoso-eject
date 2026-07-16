'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/backstage/production',
      handler: 'backstage.production',
      config: { auth: {} },
    },
    {
      method: 'PUT',
      path: '/backstage/production-runs/:id',
      handler: 'backstage.updateRun',
      config: { auth: {} },
    },
    {
      method: 'PATCH',
      path: '/backstage/production-run-items/:id',
      handler: 'backstage.updateRunItem',
      config: { auth: {} },
    },
    {
      method: 'POST',
      path: '/backstage/production-run-items/:id/complete',
      handler: 'backstage.completeRunItem',
      config: { auth: {} },
    },
    {
      method: 'POST',
      path: '/backstage/production-runs/:id/reset',
      handler: 'backstage.resetRun',
      config: { auth: {} },
    },
  ],
};
