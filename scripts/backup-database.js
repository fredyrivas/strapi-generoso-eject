'use strict';

/**
 * Respalda todas las tablas públicas de PostgreSQL como un snapshot JSON.
 * Uso: node --env-file=.env scripts/backup-database.js [directorio-de-salida]
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

function quotedIdentifier(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

async function main() {
  const connectionString = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Falta DATABASE_PUBLIC_URL o DATABASE_URL.');

  const outputDirectory = path.resolve(process.argv[2] ?? 'exports');
  await fs.mkdir(outputDirectory, { recursive: true });

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const tables = await client.query(`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name asc
    `);
    const snapshot = {
      createdAt: new Date().toISOString(),
      source: 'strapi-generoso-eject',
      tables: {},
    };

    for (const { table_name: tableName } of tables.rows) {
      const [columns, rows] = await Promise.all([
        client.query(`
          select column_name, data_type, is_nullable, column_default
          from information_schema.columns
          where table_schema = 'public' and table_name = $1
          order by ordinal_position asc
        `, [tableName]),
        client.query(`select * from public.${quotedIdentifier(tableName)}`),
      ]);
      snapshot.tables[tableName] = { columns: columns.rows, rows: rows.rows };
    }

    const timestamp = snapshot.createdAt.replace(/[:.]/g, '-');
    const filePath = path.join(outputDirectory, `database-backup-${timestamp}.json`);
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
    console.info(`Respaldo creado: ${filePath} (${tables.rows.length} tablas).`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
