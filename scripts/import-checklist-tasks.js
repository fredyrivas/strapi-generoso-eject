'use strict';

/*
 * Carga tareas independientes de Daily Checklist desde el CSV acordado.
 * Es idempotente: crea por nombre y actualiza si la tarea ya existe.
 *
 * Uso:
 *   node scripts/import-checklist-tasks.js --dry-run "/ruta/tareas.csv"
 *   railway run node scripts/import-checklist-tasks.js "/ruta/tareas.csv"
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const TASK_UID = 'api::checklist-task.checklist-task';
const REQUIRED_HEADERS = [
  'name', 'alternatesShifts', 'weekdays', 'taskType', 'frecuency', 'interval',
  'lastDone', 'previousShift', 'currentShift', 'scheduledFor', 'status',
];
const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const SHIFTS = new Set(['servicio', 'producción', 'servicio y producción']);
const STATUSES = new Set(['vencida', 'hoy', 'proxima', 'terminada', 'revisada']);
const TASK_TYPES = new Set(['interval', 'weekdays']);
const FREQUENCIES = new Set(['weekly', 'biweekly', 'monthly']);

function parseCsv(input) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (character === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((character === '\r' || character === '\n') && !quoted) {
      if (character === '\r' && next === '\n') index += 1;
      row.push(value);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

function parseDate(value, label) {
  const normalized = value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const match = normalized.match(/(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo),\s*(\d{1,2}) de ([a-z]+) de (\d{4})/);
  if (!match) throw new Error(`${label} no tiene una fecha válida: ${value}`);
  const [, rawDay, monthName, year] = match;
  const month = MONTHS[monthName];
  if (!month) throw new Error(`${label} contiene un mes inválido: ${monthName}`);
  const day = Number(rawDay);
  const date = new Date(Date.UTC(Number(year), month - 1, day));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${label} contiene una fecha inválida: ${value}`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizedShift(value, label) {
  const shift = value.trim().toLowerCase();
  if (!SHIFTS.has(shift)) throw new Error(`${label} inválido: ${value}`);
  return shift;
}

function optionalInteger(value, label, min, max) {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const result = Number(normalized);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${label} inválido: ${value}`);
  return result;
}

function optionalEnum(value, label, allowed) {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!allowed.has(normalized)) throw new Error(`${label} inválido: ${value}`);
  return normalized;
}

function parseBoolean(value, label) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${label} debe ser TRUE o FALSE: ${value}`);
}

function readTasks(csv) {
  const [headers, ...rows] = parseCsv(csv.replace(/^\uFEFF/, ''));
  if (JSON.stringify(headers) !== JSON.stringify(REQUIRED_HEADERS)) {
    throw new Error(`El CSV debe tener estas columnas, en este orden: ${REQUIRED_HEADERS.join(', ')}.`);
  }

  const seenNames = new Set();
  return rows.map((row, index) => {
    const line = index + 2;
    const [name, alternatesShifts, weekdays, taskType, frecuency, interval, lastDone, previousShift, currentShift, scheduledFor, status] = row;
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error(`Línea ${line}: name es requerido.`);
    if (seenNames.has(normalizedName)) throw new Error(`Línea ${line}: name duplicado: ${normalizedName}.`);
    seenNames.add(normalizedName);

    const data = {
      name: normalizedName,
      scheduledFor: parseDate(scheduledFor, `Línea ${line} scheduledFor`),
      taskType: optionalEnum(taskType, `Línea ${line} taskType`, TASK_TYPES),
      taskStatus: optionalEnum(status, `Línea ${line} status`, STATUSES),
      alternatesShifts: parseBoolean(alternatesShifts, `Línea ${line} alternatesShifts`),
      weekdays: optionalInteger(weekdays, `Línea ${line} weekdays`, 1, 7),
      frecuency: optionalEnum(frecuency, `Línea ${line} frecuency`, FREQUENCIES),
      interval: optionalInteger(interval, `Línea ${line} interval`, 1, Number.MAX_SAFE_INTEGER),
      lastDone: lastDone.trim() ? parseDate(lastDone, `Línea ${line} lastDone`) : undefined,
      previousShift: previousShift.trim() ? normalizedShift(previousShift, `Línea ${line} previousShift`) : undefined,
      currentShift: currentShift.trim() ? normalizedShift(currentShift, `Línea ${line} currentShift`) : undefined,
    };
    return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
  });
}

async function main() {
  const [firstArgument, secondArgument] = process.argv.slice(2);
  const dryRun = firstArgument === '--dry-run';
  const csvPath = path.resolve(dryRun ? secondArgument : firstArgument || '');
  if (!csvPath || csvPath === path.resolve('')) throw new Error('Indica la ruta del CSV.');

  const tasks = readTasks(await fs.readFile(csvPath, 'utf8'));
  if (dryRun) {
    console.info(JSON.stringify({ valid: true, tasks: tasks.length, preview: tasks.slice(0, 3) }, null, 2));
    return;
  }

  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi().load();
  try {
    let created = 0;
    let updated = 0;
    for (const task of tasks) {
      const existing = await strapi.db.query(TASK_UID).findOne({ where: { name: task.name } });
      if (existing) {
        await strapi.documents(TASK_UID).update({ documentId: existing.documentId, data: task });
        updated += 1;
      } else {
        await strapi.documents(TASK_UID).create({ data: task });
        created += 1;
      }
    }
    console.info(`Importación terminada: ${created} creadas, ${updated} actualizadas, ${tasks.length} total.`);
  } finally {
    await strapi.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
