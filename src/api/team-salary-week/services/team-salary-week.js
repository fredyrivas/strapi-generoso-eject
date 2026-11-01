'use strict';
const { errors: { ApplicationError } } = require('@strapi/utils');
const { snapshotInput, emptySnapshot, storedSnapshot, currentReferenceDate } = require('../utils/input');
const UID = 'api::team-salary-week.team-salary-week';
const RECORD_KEY = 'base-sueldos';
const FIELDS = ['documentId', 'referenceDate', 'revision', 'days'];

// One saved reference date labels the same seven weekday rows, never partitions them.
// The route policy authorizes callers. No results or employee/account relations are stored.
module.exports = ({ strapi, clock = () => new Date() }) => ({
  async read() {
    const row = await strapi.documents(UID).findFirst({ filters: { recordKey: RECORD_KEY }, fields: FIELDS });
    if (row?.referenceDate != null) return storedSnapshot(row);
    // Initialize the date once, including existing bases, without replacing any inputs.
    return strapi.db.transaction(async ({ trx }) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['generoso:team:base-salaries']);
      const docs = strapi.documents(UID);
      const current = await docs.findFirst({ filters: { recordKey: RECORD_KEY }, fields: FIELDS });
      if (current?.referenceDate != null) return storedSnapshot(current);
      const referenceDate = currentReferenceDate(clock());
      const saved = current
        ? await docs.update({ documentId: current.documentId, data: { referenceDate, revision: current.revision + 1 }, fields: FIELDS })
        : await docs.create({ data: { recordKey: RECORD_KEY, ...emptySnapshot(referenceDate), revision: 1 }, fields: FIELDS });
      return storedSnapshot(saved);
    });
  },

  async save(value) {
    const input = snapshotInput(value);
    return strapi.db.transaction(async ({ trx }) => {
      // A single lock protects the base, independently of any displayed dates.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['generoso:team:base-salaries']);
      const docs = strapi.documents(UID);
      const row = await docs.findFirst({ filters: { recordKey: RECORD_KEY }, fields: FIELDS });
      if ((row?.revision ?? 0) !== input.revision) throw new ApplicationError('Otra edición cambió Base sueldos. Vuelve a consultar antes de guardar.', { code: 'TEAM_CONFLICT' });
      const data = { recordKey: RECORD_KEY, referenceDate: input.referenceDate, revision: input.revision + 1, days: input.days };
      const saved = row
        ? await docs.update({ documentId: row.documentId, data, fields: FIELDS })
        : await docs.create({ data, fields: FIELDS });
      return storedSnapshot(saved);
    });
  },
});
