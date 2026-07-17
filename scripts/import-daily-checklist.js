'use strict';

/**
 * Importa tareas recurrentes y su primera ejecución pendiente desde el
 * calendario operativo de Daily Checklist. Es seguro volverlo a ejecutar:
 * no duplica tareas ni ejecuciones, ni modifica estados ya operados.
 *
 * Uso:
 * node scripts/import-daily-checklist.js "/ruta/Calendario de limpieza profunda - Generoso - Hoja 2.csv"
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { createStrapi } = require('@strapi/strapi');

const TASK_UID = 'api::checklist-task.checklist-task';
const EXECUTION_UID = 'api::checklist-execution.checklist-execution';
const months = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
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

function parseSpanishDate(value) {
  const normalized = value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const match = normalized.match(/(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo),\s*(\d{1,2}) de ([a-z]+) de (\d{4})/);
  if (!match) throw new Error(`Fecha inválida: ${value}`);

  const [, day, monthName, year] = match;
  const month = months[monthName];
  if (month === undefined) throw new Error(`Mes inválido: ${monthName}`);
  return `${year}-${String(month + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function mexicoDateAsDatetime(date) {
  return `${date}T12:00:00.000-06:00`;
}

function shift(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'servicio') return 'service';
  if (normalized === 'producción' || normalized === 'produccion') return 'production';
  throw new Error(`Turno inválido: ${value}`);
}

function readTasks(csv) {
  const rows = csv.split(/\r?\n/).filter(Boolean).map(parseCsvLine);
  const expectedHeaders = ['Tarea', 'Intervalo días', 'Última vez', 'Último turno', 'Alterna', 'Próximo turno', 'Próxima fecha'];
  if (JSON.stringify(rows[0]) !== JSON.stringify(expectedHeaders)) {
    throw new Error('El CSV no tiene las columnas esperadas para Daily Checklist.');
  }

  return rows.slice(1).map((row, index) => {
    const [rawName, rawInterval, rawLastDone, rawLastShift, rawAlternates, rawNextShift, rawScheduledFor] = row;
    const name = rawName.trim() === 'Terraza (cancel, puertas, piso, muebles, g)'
      ? 'Terraza (cancel, puertas, piso y muebles)'
      : rawName.trim();
    const intervalDays = Number(rawInterval);
    if (!name || !Number.isInteger(intervalDays) || intervalDays < 1) {
      throw new Error(`Tarea o intervalo inválido en la fila ${index + 2}.`);
    }
    if (rawAlternates !== 'Sí' && rawAlternates !== 'No') {
      throw new Error(`Valor de alternancia inválido para ${name}: ${rawAlternates}`);
    }

    return {
      name,
      intervalDays,
      reviewedAt: mexicoDateAsDatetime(parseSpanishDate(rawLastDone)),
      lastShift: shift(rawLastShift),
      alternatesShifts: rawAlternates === 'Sí',
      nextShift: shift(rawNextShift),
      scheduledFor: parseSpanishDate(rawScheduledFor),
      sortOrder: index,
    };
  });
}

async function findTask(strapi, name) {
  const records = await strapi.documents(TASK_UID).findMany({
    filters: { name },
    fields: ['documentId', 'name'],
  });
  return records[0];
}

async function ensureExecution(strapi, task, item) {
  const existing = await strapi.documents(EXECUTION_UID).findMany({
    filters: {
      scheduledFor: item.scheduledFor,
      task: { documentId: task.documentId },
    },
    fields: ['documentId'],
  });
  if (existing.length) return false;

  await strapi.documents(EXECUTION_UID).create({
    data: {
      task: task.documentId,
      scheduledFor: item.scheduledFor,
      shift: item.nextShift,
      status: 'pending',
      reviewedAt: item.reviewedAt,
    },
  });
  return true;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) throw new Error('Indica la ruta del CSV como primer argumento.');

  const csv = await fs.readFile(path.resolve(csvPath), 'utf8');
  const tasks = readTasks(csv);
  const strapi = await createStrapi().load();

  try {
    let createdTasks = 0;
    let createdExecutions = 0;
    for (const item of tasks) {
      let task = await findTask(strapi, item.name);
      if (!task) {
        task = await strapi.documents(TASK_UID).create({
          data: {
            name: item.name,
            intervalDays: item.intervalDays,
            lastShift: item.lastShift,
            alternatesShifts: item.alternatesShifts,
            active: true,
            sortOrder: item.sortOrder,
          },
        });
        createdTasks += 1;
      }
      if (await ensureExecution(strapi, task, item)) createdExecutions += 1;
    }
    console.info(`Importación terminada: ${tasks.length} tareas procesadas (${createdTasks} creadas) y ${createdExecutions} ejecuciones pendientes creadas.`);
  } finally {
    await strapi.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
