'use strict';

const UID = 'api::checklist-execution.checklist-execution';

function relationIdentifier(value) {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return undefined;
  const candidate = Array.isArray(value.connect) ? value.connect[0] : value.connect ?? value.set;
  if (typeof candidate === 'string' || typeof candidate === 'number') return candidate;
  return candidate?.documentId ?? candidate?.id;
}

async function ensureUniqueTaskExecution(event) {
  const { data, where = {} } = event.params;
  let current;
  if (where.documentId) {
    current = await strapi.documents(UID).findOne({
      documentId: where.documentId,
      populate: { task: { fields: ['documentId'] } },
    });
  }

  const scheduledFor = data.scheduledFor ?? current?.scheduledFor;
  const task = relationIdentifier(data.task) ?? current?.task?.documentId;
  if (!scheduledFor || !task) return;

  const existing = await strapi.documents(UID).findMany({
    filters: { scheduledFor, task: { documentId: String(task) } },
    fields: ['documentId'],
  });
  const currentId = where.documentId ?? where.id;
  if (existing.some((execution) => execution.documentId !== currentId)) {
    throw new Error('Ya existe una ejecución para esta tarea y fecha programada.');
  }
}

module.exports = {
  async beforeCreate(event) {
    await ensureUniqueTaskExecution(event);
  },
  async beforeUpdate(event) {
    await ensureUniqueTaskExecution(event);
  },
};
