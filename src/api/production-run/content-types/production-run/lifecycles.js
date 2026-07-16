'use strict';

const UID = 'api::production-run.production-run';

function relationIdentifier(value) {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return undefined;
  const candidate = Array.isArray(value.connect) ? value.connect[0] : value.connect ?? value.set;
  if (typeof candidate === 'string' || typeof candidate === 'number') return candidate;
  return candidate?.documentId ?? candidate?.id;
}

async function ensureUniqueDailyAreaRun(event) {
  const { data, where = {} } = event.params;
  let current;
  if (where.documentId) {
    current = await strapi.documents(UID).findOne({
      documentId: where.documentId,
      populate: { productionArea: { fields: ['documentId'] } },
    });
  }
  const date = data.date ?? current?.date;
  const productionArea = relationIdentifier(data.productionArea) ?? current?.productionArea?.documentId;

  // Una actualización sin jornada existente o sin área no puede validarse aquí.
  if (!date || !productionArea) return;

  const existing = await strapi.documents(UID).findMany({
    filters: { date, productionArea: { documentId: String(productionArea) } },
    fields: ['documentId'],
  });
  const currentId = where.documentId ?? where.id;
  if (existing.some((run) => run.documentId !== currentId)) {
    throw new Error('Ya existe una jornada de producción para esta área y fecha.');
  }
}

module.exports = {
  async beforeCreate(event) {
    await ensureUniqueDailyAreaRun(event);
  },
  async beforeUpdate(event) {
    await ensureUniqueDailyAreaRun(event);
  },
};
