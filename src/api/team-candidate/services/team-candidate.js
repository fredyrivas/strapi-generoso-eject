'use strict';

const { errors: { ValidationError, NotFoundError } } = require('@strapi/utils');
const { questionnaire, positions, sources } = require('../utils/questionnaire');
const { actorFrom, applyAction, candidateDetails, newWorkflow, stages, statuses } = require('../utils/workflow');

const uid = 'api::team-candidate.team-candidate';
const listFields = ['documentId', 'fullName', 'position', 'stage', 'status', 'score', 'createdAt', 'updatedAt'];

function summary(entry) {
  const { documentId, fullName, position, stage, status, score, createdAt, updatedAt } = entry;
  return { documentId, fullName, position, stage, status, score: score || null, createdAt, updatedAt };
}

function detail(entry, actor) {
  const { phone, source, notes, workflow } = entry;
  return { candidate: { ...summary(entry), phone, source, notes, workflow }, actor, questionnaire, positions: positions(), sources };
}

function validId(documentId) {
  if (typeof documentId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(documentId)) throw new NotFoundError('El expediente no existe.');
}

function filtersFrom(query) {
  const { search = '', position = '', stage = '', status = '', sort = 'date', page = '1' } = query;
  if ([search, position, stage, status, sort, page].some(value => typeof value !== 'string')
    || search.length > 150 || position.length > 100 || (stage && !stages.includes(stage))
    || (status && !statuses.includes(status)) || !['date', 'score'].includes(sort) || !/^[1-9]\d{0,4}$/.test(page)) {
    throw new ValidationError('Revisa los filtros del listado.');
  }
  const filters = {
    ...(search.trim() ? { fullName: { $containsi: search.trim() } } : {}),
    ...(position ? { position } : {}),
    ...(stage ? { stage } : {}),
    ...(status ? { status } : {}),
  };
  return { filters, sort, page: Number(page) };
}

module.exports = ({ strapi }) => {
  const documents = strapi.documents(uid);
  return {
    async list(query) {
      const { filters, sort, page } = filtersFrom(query);
      const pageSize = 25;
      const order = [...(sort === 'score' ? ['score:desc'] : []), 'createdAt:desc', 'documentId:asc'];
      const [entries, total, usedPositions] = await Promise.all([
        documents.findMany({ filters, fields: listFields, sort: order, start: (page - 1) * pageSize, limit: pageSize }),
        documents.count({ filters }),
        strapi.db.connection(strapi.db.metadata.get(uid).tableName).distinct('position'),
      ]);
      const vacancyFilters = [...new Set([...positions(), ...usedPositions.map(entry => entry.position)])].sort((a, b) => a.localeCompare(b, 'es'));
      const { interview, simulation } = questionnaire;
      return {
        candidates: entries.map(summary), positions: positions(), vacancyFilters, sources, page,
        pageCount: Math.max(1, Math.ceil(total / pageSize)), total, interviewSheet: { interview, simulation },
      };
    },

    async create(input, user) {
      const actor = actorFrom(user);
      const requestKey = input?.requestKey;
      if (typeof requestKey !== 'string' || !/^[a-f0-9-]{36}$/.test(requestKey)) throw new ValidationError('La solicitud de alta no es válida.');
      const data = candidateDetails(input);
      return strapi.db.transaction(async ({ trx }) => {
        const key = `${actor.id}:${requestKey}`;
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`generoso:recruitment:${key}`]);
        const existing = await documents.findFirst({ filters: { requestKey: key }, fields: ['documentId'] });
        if (existing) return { documentId: existing.documentId };
        const workflow = newWorkflow(actor, new Date().toISOString());
        const created = await documents.create({ data: { ...data, requestKey: key, stage: 'new', status: 'new', workflow } });
        return { documentId: created.documentId };
      });
    },

    async read(documentId, user) {
      validId(documentId);
      const entry = await documents.findOne({ documentId });
      if (!entry) throw new NotFoundError('El expediente no existe.');
      return detail(entry, actorFrom(user));
    },

    async update(documentId, input, user) {
      validId(documentId);
      const actor = actorFrom(user);
      return strapi.db.transaction(async ({ trx }) => {
        const locked = await trx(strapi.db.metadata.get(uid).tableName).select('id').where({ document_id: documentId }).forUpdate().first();
        if (!locked) throw new NotFoundError('El expediente no existe.');
        const entry = await documents.findOne({ documentId });
        const data = applyAction(entry, input, actor, new Date().toISOString());
        const updated = await documents.update({ documentId, data });
        return { candidate: detail(updated, actor).candidate };
      });
    },
  };
};
