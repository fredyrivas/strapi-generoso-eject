'use strict';

/**
 * Migra checklist-task.lastDoneAt a checklist-execution.reviewedAt.
 * Debe ejecutarse antes de eliminar lastDoneAt y completedAt del schema.
 */

const { createStrapi } = require('@strapi/strapi');

const TASK_UID = 'api::checklist-task.checklist-task';
const EXECUTION_UID = 'api::checklist-execution.checklist-execution';

function mexicoDateAsDatetime(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Fecha inválida: ${date}`);
  // Mediodía en Ciudad de México evita que el valor UTC se muestre como el día anterior.
  return `${date}T12:00:00.000-06:00`;
}

function latestExecution(executions) {
  return [...executions].sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor))[0];
}

async function main() {
  const strapi = await createStrapi().load();
  try {
    const tasks = await strapi.documents(TASK_UID).findMany({
      filters: { lastDoneAt: { $notNull: true } },
      fields: ['documentId', 'name', 'lastDoneAt'],
      populate: { executions: { fields: ['documentId', 'scheduledFor', 'reviewedAt'] } },
    });
    const summary = { tasks: tasks.length, migrated: 0, preserved: 0, missingExecution: [] };

    for (const task of tasks) {
      const execution = latestExecution(task.executions ?? []);
      if (!execution) {
        summary.missingExecution.push(task.name);
        continue;
      }
      if (execution.reviewedAt) {
        summary.preserved += 1;
        continue;
      }
      await strapi.documents(EXECUTION_UID).update({
        documentId: execution.documentId,
        data: { reviewedAt: mexicoDateAsDatetime(task.lastDoneAt) },
      });
      summary.migrated += 1;
    }

    if (summary.missingExecution.length) {
      throw new Error(`Tareas sin checklist-execution: ${summary.missingExecution.join(', ')}`);
    }
    console.info(`Migración terminada: ${summary.migrated} reviewedAt migrados; ${summary.preserved} valores existentes conservados.`);
  } finally {
    await strapi.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
