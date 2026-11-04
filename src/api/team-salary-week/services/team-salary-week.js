'use strict';
const { errors: { ApplicationError, ValidationError } } = require('@strapi/utils');
const { LOCK } = require('../../team-employee/utils/attendance');
const { paymentAccount } = require('../../team-employee/utils/payment-account');
const { snapshotInput, emptySnapshot, storedSnapshot, weekStartInput, currentWeekStart, isClosingAmount, closingBonus, closingRevenues, dayIndices } = require('../utils/input');
const { actorLabel, recordChange, weekHistory } = require('../utils/history');
const { baseSalariesWeek, usesFixedAttendance } = require('../../team-employee/utils/payment-calculation/base-salaries');
const { withFixedAttendance } = require('../utils/fixed-attendance');
const UID = 'api::team-salary-week.team-salary-week', E = 'api::team-employee.team-employee', P = 'api::team-payment-week.team-payment-week';
const BASE_LOCK = 'generoso:team:base-salaries';
const FIELDS = ['documentId', 'weekStart', 'weekStatus', 'releasedAt', 'revision', 'days', 'closingRevenues', 'manualFixedDays'];
const lock = (trx, key) => trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [key]);
const configuration = account => { const { monthlySalary, restDay, payGroup } = paymentAccount(account); return { monthlySalary, restDay, payGroup }; };

// One row per week, keyed by its Monday. Missing weeks read as empty drafts; nothing is reset.
module.exports = ({ strapi, clock = () => new Date() }) => {
  const find = weekStart => strapi.documents(UID).findFirst({ filters: { weekStart }, fields: FIELDS });
  async function dto(row, weekStart) {
    const snapshot = row ? storedSnapshot(row) : emptySnapshot(weekStart);
    const published = row?.weekStatus === 'published';
    const automaticBonusDays = [...closingRevenues(row)].flatMap(([index, revenue]) =>
      snapshot.days[index].input.bonuses === closingBonus(revenue) ? [index] : []);
    const manualFixedDays = row?.manualFixedDays ?? [];
    return { ...snapshot, weekStatus: published ? 'published' : 'draft', releasedAt: published ? new Date(row.releasedAt).toISOString() : null, history: await weekHistory(strapi, weekStart),
      ...(automaticBonusDays.length ? { automaticBonusDays } : {}),
      ...(manualFixedDays.length ? { manualFixedDays } : {}),
    };
  }
  function tipsDto(row, week) {
    const { revision, days } = row ? storedSnapshot(row) : emptySnapshot(week.start);
    const revenues = closingRevenues(row);
    return {
      weekStart: week.start, today: week.today, revision, weekStatus: row?.weekStatus === 'published' ? 'published' : 'draft',
      days: days.flatMap(({ dayIndex, input: { cardTips, cashTips } }) => {
        const { date } = week.days[dayIndex];
        return date <= week.today ? [{ date, cardTips, cashTips, revenue: revenues.get(dayIndex) ?? null }] : [];
      }),
    };
  }

  function checkRevision(row, revision) {
    if ((row?.revision ?? 0) !== revision) throw new ApplicationError('Otra edición cambió Base sueldos. Vuelve a consultar antes de guardar.', { code: 'TEAM_CONFLICT' });
  }

  function persist(row, input, extra = {}) {
    const data = { weekStart: input.weekStart, revision: input.revision + 1, days: input.days, ...extra };
    return row
      ? strapi.documents(UID).update({ documentId: row.documentId, data, fields: FIELDS })
      : strapi.documents(UID).create({ data: { ...data, weekStatus: 'draft', releasedAt: null }, fields: FIELDS });
  }

  return {
    async readDailyTips() {
      const week = baseSalariesWeek(undefined, clock());
      return tipsDto(await find(week.start), week);
    },

    async saveDailyTips(value, user) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'cardTips,cashTips,date,revenue,revision'
        || ![value.cardTips, value.cashTips, value.revenue].every(isClosingAmount)) {
        throw new ValidationError('Revisa los ingresos y los importes de propinas.');
      }
      return strapi.db.transaction(async ({ trx }) => {
        await lock(trx, BASE_LOCK);
        const week = baseSalariesWeek(undefined, clock());
        const dayIndex = week.days.findIndex(day => day.date === value.date && day.date <= week.today);
        if (dayIndex === -1) throw new ValidationError('Selecciona un día de la semana en curso hasta hoy.');
        if (!Number.isInteger(value.revision) || value.revision < 0 || value.revision > 2147483646) throw new ValidationError('La revisión de la base no es válida.');
        const row = await find(week.start);
        if (row?.weekStatus === 'published') throw new ApplicationError('La semana ya está publicada.', { code: 'TEAM_CONFLICT' });
        checkRevision(row, value.revision);
        const input = row ? storedSnapshot(row) : emptySnapshot(week.start);
        const day = input.days[dayIndex];
        const revenues = closingRevenues(row);
        const before = { cardTips: day.input.cardTips, cashTips: day.input.cashTips, bonuses: day.input.bonuses, revenue: revenues.get(dayIndex) ?? null };
        const bonuses = before.revenue === value.revenue ? before.bonuses : closingBonus(value.revenue);
        day.input = { ...day.input, cardTips: value.cardTips, cashTips: value.cashTips, bonuses };
        revenues.set(dayIndex, value.revenue);
        const saved = await persist(row, input, { closingRevenues: Object.fromEntries(revenues) });
        const after = { cardTips: day.input.cardTips, cashTips: day.input.cashTips, bonuses: day.input.bonuses, revenue: value.revenue };
        await recordChange(strapi, { weekStart: week.start, area: 'base', actor: actorLabel(user), summary: `Guardó cierre del ${week.days[dayIndex].dateLabel}`, before, after });
        return tipsDto(saved, week);
      });
    },

    async read(weekStart = currentWeekStart(clock())) {
      weekStartInput(weekStart);
      if (!usesFixedAttendance(weekStart)) return dto(await find(weekStart), weekStart);
      return strapi.db.transaction(async ({ trx }) => {
        await lock(trx, LOCK); await lock(trx, BASE_LOCK);
        const row = await find(weekStart);
        const week = await dto(row, weekStart);
        return week.weekStatus === 'published' ? week : withFixedAttendance(strapi, week, clock(), row?.manualFixedDays);
      });
    },

    async save(value, user) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Revisa los datos de Base sueldos.');
      const { fixedMemberEdits = [], ...payload } = value;
      const input = snapshotInput(payload);
      const edits = dayIndices(fixedMemberEdits);
      return strapi.db.transaction(async ({ trx }) => {
        if (usesFixedAttendance(input.weekStart)) await lock(trx, LOCK);
        await lock(trx, BASE_LOCK);
        const row = await find(input.weekStart);
        checkRevision(row, input.revision);
        const previous = row ? storedSnapshot(row) : null;
        const manualFixedDays = new Set(row?.manualFixedDays ?? []);
        if (usesFixedAttendance(input.weekStart)) {
          for (const day of input.days) {
            if (edits.includes(day.dayIndex)) {
              if (day.input.fixedMembers === null) manualFixedDays.delete(day.dayIndex);
              else manualFixedDays.add(day.dayIndex);
            } else if (manualFixedDays.has(day.dayIndex)) {
              day.input.fixedMembers = previous.days[day.dayIndex].input.fixedMembers;
            }
          }
        }
        const manualDays = [...manualFixedDays];
        const snapshot = row?.weekStatus === 'published' ? input : await withFixedAttendance(strapi, input, clock(), manualDays);
        const saved = await persist(row, snapshot, edits.length && usesFixedAttendance(input.weekStart) ? { manualFixedDays: manualDays } : {});
        await recordChange(strapi, { weekStart: input.weekStart, area: 'base', actor: actorLabel(user), summary: 'Guardó Base sueldos', before: previous?.days ?? null, after: snapshot.days });
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
        const now = clock();
        const data = { weekStatus: value.published ? 'published' : 'draft', releasedAt: value.published ? now.toISOString() : null, revision: row.revision + 1 };
        if (usesFixedAttendance(weekStart)) data.days = (await withFixedAttendance(strapi, storedSnapshot(row), now, row.manualFixedDays)).days;
        const saved = await strapi.documents(UID).update({ documentId: row.documentId, data, fields: FIELDS });
        await recordChange(strapi, { weekStart, area: 'publication', actor: actorLabel(user), summary: value.published ? 'Publicó la semana' : 'Regresó la semana a captura' });
        return dto(saved, weekStart);
      });
    },
  };
};
