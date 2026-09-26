'use strict';

/* Conserva la clasificación de las tareas existentes al renombrar la opción. */
exports.up = async (knex) => {
  const tableName = 'checklist_tasks';
  if (!await knex.schema.hasTable(tableName) || !await knex.schema.hasColumn(tableName, 'task_category')) return;

  await knex(tableName).where('task_category', 'Limpieza').update({ task_category: 'Limpieza y operativas' });
};

exports.down = async (knex) => {
  const tableName = 'checklist_tasks';
  if (!await knex.schema.hasTable(tableName) || !await knex.schema.hasColumn(tableName, 'task_category')) return;

  await knex(tableName).where('task_category', 'Limpieza y operativas').update({ task_category: 'Limpieza' });
};
