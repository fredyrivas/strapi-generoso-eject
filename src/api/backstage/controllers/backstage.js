'use strict';

const AREA_UID = 'api::production-area.production-area';
const RUN_UID = 'api::production-run.production-run';
const RUN_ITEM_UID = 'api::production-run-item.production-run-item';

function requestData(ctx) {
  return ctx.request.body?.data ?? ctx.request.body ?? {};
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`));
}

function requireBatches(ctx, value) {
  if (!Number.isInteger(value) || value < 0) {
    ctx.badRequest('batches debe ser un entero mayor o igual a cero.');
    return false;
  }
  return true;
}

async function listRunsForDate(date) {
  return strapi.documents(RUN_UID).findMany({
    filters: { date },
    populate: {
      productionArea: { fields: ['name', 'tone', 'sortOrder', 'active'] },
      items: {
        fields: ['batches', 'batchSizeSnapshot', 'completed', 'completedAt'],
        populate: { productionItem: { fields: ['name', 'sortOrder', 'active'] } },
      },
    },
  });
}

async function createRunWithItems(area, date) {
  const run = await strapi.documents(RUN_UID).create({
    data: {
      date,
      status: 'open',
      productionArea: area.documentId,
    },
  });

  await Promise.all(
    (area.productionItems ?? []).map((productionItem) =>
      strapi.documents(RUN_ITEM_UID).create({
        data: {
          batches: 0,
          batchSizeSnapshot: productionItem.defaultBatchSize,
          completed: false,
          productionRun: run.documentId,
          productionItem: productionItem.documentId,
        },
      })
    )
  );
}

async function ensureRunsForDate(date) {
  const areas = await strapi.documents(AREA_UID).findMany({
    filters: { active: true },
    sort: ['sortOrder:asc', 'name:asc'],
    fields: ['name', 'tone', 'sortOrder'],
    populate: {
      productionItems: {
        filters: { active: true },
        sort: ['sortOrder:asc', 'name:asc'],
        fields: ['name', 'defaultBatchSize', 'sortOrder'],
      },
    },
  });
  const runs = await listRunsForDate(date);
  const areaIdsWithRun = new Set(
    runs.map((run) => run.productionArea?.documentId).filter(Boolean)
  );

  for (const area of areas) {
    if (!areaIdsWithRun.has(area.documentId)) {
      try {
        await createRunWithItems(area, date);
      } catch (error) {
        // Dos solicitudes simultáneas pueden intentar inicializar la misma área.
        // El lifecycle conserva la unicidad; volvemos a leer el resultado ganador.
        if (!String(error.message).includes('Ya existe una jornada')) throw error;
      }
    }
  }
  return listRunsForDate(date);
}

function normalizeProduction(areas, runs) {
  const runsByArea = new Map(
    runs.map((run) => [run.productionArea?.documentId, run])
  );

  return areas.map((area) => {
    const run = runsByArea.get(area.documentId);
    const items = (run?.items ?? [])
      .filter((item) => item.productionItem?.active !== false)
      .sort((left, right) => {
        const order = (left.productionItem?.sortOrder ?? 0) - (right.productionItem?.sortOrder ?? 0);
        return order || (left.productionItem?.name ?? '').localeCompare(right.productionItem?.name ?? '');
      })
      .map((item) => ({
        id: item.documentId ?? String(item.id),
        name: item.productionItem?.name ?? 'Producto sin nombre',
        batches: item.batches ?? 0,
        batchSize: item.batchSizeSnapshot ?? item.productionItem?.defaultBatchSize ?? '',
        complete: Boolean(item.completed),
      }));

    return {
      id: area.documentId ?? String(area.id),
      name: area.name,
      tone: area.tone,
      items,
    };
  });
}

async function findRunOr404(ctx, documentId, populate = {}) {
  const run = await strapi.documents(RUN_UID).findOne({ documentId, populate });
  if (!run) ctx.notFound('Jornada de producción no encontrada.');
  return run;
}

module.exports = {
  async production(ctx) {
    const date = ctx.query.date ?? new Date().toISOString().slice(0, 10);
    if (!validDate(date)) return ctx.badRequest('date debe tener el formato YYYY-MM-DD.');

    const areas = await strapi.documents(AREA_UID).findMany({
      filters: { active: true },
      sort: ['sortOrder:asc', 'name:asc'],
      fields: ['name', 'tone', 'sortOrder'],
    });
    const runs = await ensureRunsForDate(date);
    ctx.body = { data: normalizeProduction(areas, runs) };
  },

  async updateRun(ctx) {
    const payload = requestData(ctx);
    if (!Array.isArray(payload.items)) return ctx.badRequest('items debe ser un arreglo.');
    const run = await findRunOr404(ctx, ctx.params.id, { items: { fields: ['documentId'] } });
    if (!run) return;
    const allowedIds = new Set((run.items ?? []).map((item) => item.documentId));

    for (const item of payload.items) {
      if (!item?.id || !allowedIds.has(item.id)) {
        return ctx.badRequest('Todos los renglones deben pertenecer a la jornada indicada.');
      }
      if (!requireBatches(ctx, item.batches)) return;
    }
    await Promise.all(payload.items.map((item) =>
      strapi.documents(RUN_ITEM_UID).update({ documentId: item.id, data: { batches: item.batches } })
    ));
    ctx.body = { data: { id: run.documentId, updated: payload.items.length } };
  },

  async updateRunItem(ctx) {
    const payload = requestData(ctx);
    if (!requireBatches(ctx, payload.batches)) return;
    const item = await strapi.documents(RUN_ITEM_UID).findOne({ documentId: ctx.params.id });
    if (!item) return ctx.notFound('Renglón de producción no encontrado.');
    const updated = await strapi.documents(RUN_ITEM_UID).update({
      documentId: item.documentId,
      data: { batches: payload.batches },
    });
    ctx.body = { data: updated };
  },

  async completeRunItem(ctx) {
    const payload = requestData(ctx);
    const item = await strapi.documents(RUN_ITEM_UID).findOne({ documentId: ctx.params.id });
    if (!item) return ctx.notFound('Renglón de producción no encontrado.');
    const completed = typeof payload.completed === 'boolean' ? payload.completed : !item.completed;
    const updated = await strapi.documents(RUN_ITEM_UID).update({
      documentId: item.documentId,
      data: { completed, completedAt: completed ? new Date().toISOString() : null },
    });
    ctx.body = { data: updated };
  },

  async resetRun(ctx) {
    const run = await findRunOr404(ctx, ctx.params.id, { items: { fields: ['documentId'] } });
    if (!run) return;
    await Promise.all((run.items ?? []).map((item) =>
      strapi.documents(RUN_ITEM_UID).update({
        documentId: item.documentId,
        data: { batches: 0, completed: false, completedAt: null },
      })
    ));
    const updatedRun = await strapi.documents(RUN_UID).update({
      documentId: run.documentId,
      data: { status: 'open' },
    });
    ctx.body = { data: updatedRun };
  },
};
