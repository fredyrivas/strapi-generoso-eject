'use strict';
const { errors: { ApplicationError, ValidationError } } = require('@strapi/utils');
const { LOCK } = require('../../team-employee/utils/attendance');
const { paymentAccount } = require('../../team-employee/utils/payment-account');
const { snapshotInput, emptySnapshot, storedSnapshot, weekStartInput, currentWeekStart } = require('../utils/input');
const { actorLabel, recordChange, weekHistory } = require('../utils/history');
const UID = 'api::team-salary-week.team-salary-week', E = 'api::team-employee.team-employee', P = 'api::team-payment-week.team-payment-week';
const BASE_LOCK = 'generoso:team:base-salaries';
const FIELDS = ['documentId', 'weekStart', 'weekStatus', 'releasedAt', 'revision', 'days'];
const lock = (trx, key) => trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
const configuration = account => { const { monthlySalary, restDay, payGroup } = paymentAccount(account); return { monthlySalary, restDay, payGroup }; };

// One row per week, keyed by its Monday. Missing weeks read as empty drafts; nothing is reset.
module.exports = ({ strapi, clock = () => new Date() }) => {
  const find = weekStart => strapi.documents(UID).findFirst({ filters: { weekStart }, fields: FIELDS });
  async function dto(row, weekStart) {
    const snapshot = row ? storedSnapshot(row) : emptySnapshot(weekStart);
    const published = row?.weekStatus === 'published';
    return { ...snapshot, weekStatus: published ? 'published' : 'draft', releasedAt: published ? new Date(row.releasedAt).toISOString() : null, history: await weekHistory(strapi, weekStart) };
  }
  return {
    async read(weekStart = currentWeekStart(clock())) {
      weekStartInput(weekStart);
      return dto(await find(weekStart), weekStart);
    },

    async save(value, user) {
      const input = snapshotInput(value);
      return strapi.db.transaction(async ({ trx }) => {
        // A single lock protects every base week.
        await lock(trx, BASE_LOCK);
        const row = await find(input.weekStart);
        if ((row?.revision ?? 0) !== input.revision) throw new ApplicationError('Otra edición cambió Base sueldos. Vuelve a consultar antes de guardar.', { code: 'TEAM_CONFLICT' });
        const data = { weekStart: input.weekStart, revision: input.revision + 1, days: input.days };
        const saved = row
          ? await strapi.documents(UID).update({ documentId: row.documentId, data, fields: FIELDS })
          : await strapi.documents(UID).create({ data: { ...data, weekStatus: 'draft', releasedAt: null }, fields: FIELDS });
        await recordChange(strapi, { weekStart: input.weekStart, area: 'base', actor: actorLabel(user), summary: 'Guardó Base sueldos', before: row ? storedSnapshot(row).days : null, after: input.days });
        return dto(saved, input.weekStart);
      });
    },

    // Publishing freezes each employee's salary configuration for the week; returning it to capture releases it.
    async publish(value, user) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'published,revision,weekStart' || typeof value.published !== 'boolean'
        || !Number.isInteger(value.revision) || value.revision < 1 || value.revision > 2147483646) throw new ValidationError('Revisa la semana y su revisión.');
      const weekStart = weekStartInput(value.weekStart);
      return strapi.db.transaction(async ({ trx }) => {
        // Same order as payment reads: attendance/payment first, then the base.
        await lock(trx, LOCK); await lock(trx, BASE_LOCK);
        const row = await find(weekStart);
        if (!row) throw new ValidationError('Guarda Base sueldos antes de publicar la semana.');
        if (row.revision !== value.revision) throw new ApplicationError('Otra edición cambió Base sueldos. Vuelve a consultar antes de publicar.', { code: 'TEAM_CONFLICT' });
        if ((row.weekStatus === 'published') === value.published) throw new ApplicationError(value.published ? 'La semana ya está publicada.' : 'La semana ya está en captura.', { code: 'TEAM_CONFLICT' });
        const employees = await strapi.documents(E).findMany({ filters: { teamRole: { $ne: 'operative' } }, fields: ['documentId', 'paymentAccount'], limit: 500 });
        for (const employee of employees) {
          const weekKey = employee.documentId + ':' + weekStart;
          const current = await strapi.documents(P).findFirst({ filters: { weekKey }, fields: ['documentId', 'revision'] });
          const frozen = value.published ? configuration(employee.paymentAccount) : null;
          if (current) await strapi.documents(P).update({ documentId: current.documentId, data: { configuration: frozen } });
          else if (frozen) await strapi.documents(P).create({ data: { employee: employee.documentId, weekKey, weekStart, revision: 1, adjustments: { consumptions: [], extraPayments: [], cash: 0, cancellations: { tips: null, shiftBonus: null, punctualityBonus: null } }, configuration: frozen } });
        }
        const data = { weekStatus: value.published ? 'published' : 'draft', releasedAt: value.published ? clock().toISOString() : null, revision: row.revision + 1 };
        const saved = await strapi.documents(UID).update({ documentId: row.documentId, data, fields: FIELDS });
        await recordChange(strapi, { weekStart, area: 'publication', actor: actorLabel(user), summary: value.published ? 'Publicó la semana' : 'Regresó la semana a captura' });
        return dto(saved, weekStart);
      });
    },
  };
};
