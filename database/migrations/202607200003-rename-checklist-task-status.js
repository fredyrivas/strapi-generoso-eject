'use strict';

/*
 * "status" es reservado por el Content Manager de Strapi v5 para el estado
 * interno del documento. Renombramos la columna antes de que Strapi sincronice
 * el schema, para conservar los valores existentes (por ejemplo, "revisada").
 */
exports.up = async (knex) => {
  const tableName = 'checklist_tasks';
  const hasTable = await knex.schema.hasTable(tableName);

  if (!hasTable) return;

  const [hasStatus, hasTaskStatus] = await Promise.all([
    knex.schema.hasColumn(tableName, 'status'),
    knex.schema.hasColumn(tableName, 'task_status'),
  ]);

  if (hasStatus && !hasTaskStatus) {
    await knex.schema.alterTable(tableName, (table) => {
      table.renameColumn('status', 'task_status');
    });
  }
};

exports.down = async (knex) => {
  const tableName = 'checklist_tasks';
  const hasTable = await knex.schema.hasTable(tableName);

  if (!hasTable) return;

  const [hasStatus, hasTaskStatus] = await Promise.all([
    knex.schema.hasColumn(tableName, 'status'),
    knex.schema.hasColumn(tableName, 'task_status'),
  ]);

  if (!hasStatus && hasTaskStatus) {
    await knex.schema.alterTable(tableName, (table) => {
      table.renameColumn('task_status', 'status');
    });
  }
};
