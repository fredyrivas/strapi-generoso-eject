'use strict';

/**
 * Importa el catálogo de áreas y productos de producción desde el CSV
 * operativo. Es idempotente: se puede ejecutar varias veces sin duplicar
 * áreas ni productos, y conserva las jornadas históricas intactas.
 *
 * Uso:
 * node scripts/import-production-catalog.js "/ruta/Lista de Producción - Producción.csv"
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { createStrapi } = require('@strapi/strapi');

const AREA_UID = 'api::production-area.production-area';
const ITEM_UID = 'api::production-item.production-item';

const areas = {
  'Panadería': { tone: 'gold', sortOrder: 0 },
  'Linea Fría': { name: 'Línea fría', tone: 'blue', sortOrder: 1 },
  'Linea Caliente': { name: 'Línea caliente', tone: 'orange', sortOrder: 2 },
  'Limpieza, desinfección y otros': { tone: 'green', sortOrder: 3 },
};

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value.trim());
  return values;
}

function readCatalog(csv) {
  let currentArea;
  const catalog = [];
  const rows = csv.split(/\r?\n/).filter(Boolean).map(parseCsvLine);

  for (const row of rows.slice(1)) {
    const [task, lots, batchSize, completed] = row;
    if (!task) continue;

    if (!lots && !batchSize && !completed && areas[task]) {
      currentArea = task;
      continue;
    }
    if (!currentArea || !lots) continue;

    catalog.push({
      areaKey: currentArea,
      name: task,
      defaultBatchSize: batchSize || 'Sin especificar',
    });
  }
  return catalog;
}

async function firstDocument(strapi, uid, filters) {
  const records = await strapi.documents(uid).findMany({
    filters,
    fields: ['documentId', 'name'],
    status: 'published',
  });
  return records[0];
}

async function upsertArea(strapi, csvName, config) {
  const name = config.name ?? csvName;
  const existing = await firstDocument(strapi, AREA_UID, { name });
  const data = { name, tone: config.tone, sortOrder: config.sortOrder, active: true };
  if (existing) {
    return strapi.documents(AREA_UID).update({ documentId: existing.documentId, data, status: 'published' });
  }
  return strapi.documents(AREA_UID).create({ data, status: 'published' });
}

async function upsertItem(strapi, area, item, sortOrder) {
  const existing = await firstDocument(strapi, ITEM_UID, {
    name: item.name,
    productionArea: { documentId: area.documentId },
  });
  const data = {
    name: item.name,
    defaultBatchSize: item.defaultBatchSize,
    sortOrder,
    active: true,
    productionArea: area.documentId,
  };
  if (existing) {
    await strapi.documents(ITEM_UID).update({ documentId: existing.documentId, data, status: 'published' });
    return false;
  }
  await strapi.documents(ITEM_UID).create({ data, status: 'published' });
  return true;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) throw new Error('Indica la ruta del CSV como primer argumento.');
  const csv = await fs.readFile(path.resolve(csvPath), 'utf8');
  const catalog = readCatalog(csv);
  if (!catalog.length) throw new Error('No se encontraron productos importables en el CSV.');

  const strapi = await createStrapi().load();
  try {
    const persistedAreas = new Map();
    for (const [csvName, config] of Object.entries(areas)) {
      persistedAreas.set(csvName, await upsertArea(strapi, csvName, config));
    }

    let created = 0;
    for (const [areaKey, area] of persistedAreas) {
      const items = catalog.filter((item) => item.areaKey === areaKey);
      for (const [sortOrder, item] of items.entries()) {
        if (await upsertItem(strapi, area, item, sortOrder)) created += 1;
      }
    }
    console.info(`Importación terminada: ${persistedAreas.size} áreas y ${catalog.length} productos (${created} creados).`);
  } finally {
    await strapi.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
