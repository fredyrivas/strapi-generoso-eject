'use strict';

/**
 * Migra el enum reservado checklist-execution.status a executionStatus.
 * Ejecutar después de agregar executionStatus al schema y antes de retirar status.
 */

const { createStrapi } = require('@strapi/strapi');

const UID = 'api::checklist-execution.checklist-execution';
const allowedStatuses = new Set(['pending', 'reviewed', 'completed']);

async function main() {
  const strapi = await createStrapi().load();
  try {
    const executions = await strapi.documents(UID).findMany({
      fields: ['documentId', 'status', 'executionStatus'],
    });
    const summary = { total: executions.length, migrated: 0, preserved: 0, invalid: [] };

    for (const execution of executions) {
      if (execution.executionStatus) {
        summary.preserved += 1;
        continue;
      }
      if (!allowedStatuses.has(execution.status)) {
        summary.invalid.push(`${execution.documentId}: ${execution.status ?? 'vacío'}`);
        continue;
      }
      await strapi.documents(UID).update({
        documentId: execution.documentId,
        data: { executionStatus: execution.status },
      });
      summary.migrated += 1;
    }

    if (summary.invalid.length) {
      throw new Error(`Estados no migrables: ${summary.invalid.join(', ')}`);
    }
    console.info(`Migración de executionStatus terminada: ${summary.migrated} migrados; ${summary.preserved} existentes conservados.`);
  } finally {
    await strapi.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
