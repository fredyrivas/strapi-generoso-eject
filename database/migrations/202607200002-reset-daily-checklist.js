'use strict';

/*
 * Reinicio solicitado del Daily Checklist.
 * Elimina de forma intencional las tablas y datos del modelo anterior antes de
 * que Strapi cree el único collection type checklist_tasks definido actualmente.
 */
exports.up = async (knex) => {
  const relatedTables = await knex('information_schema.tables')
    .select('table_name')
    .where('table_type', 'BASE TABLE')
    .whereRaw('table_schema = current_schema()')
    .where((query) => query
      .where('table_name', 'checklist_tasks')
      .orWhere('table_name', 'like', 'checklist_execution%')
      .orWhere('table_name', 'like', 'checklist_tasks_execution%'));

  for (const { table_name: tableName } of relatedTables) {
    await knex.raw('DROP TABLE IF EXISTS ?? CASCADE', [tableName]);
  }
};

exports.down = async () => {
  throw new Error('El reinicio de Daily Checklist elimina datos y no tiene reversión automática.');
};
