'use strict';
const { createHash } = require('node:crypto');
const { errors: { ApplicationError, ValidationError, NotFoundError } } = require('@strapi/utils');
const { currentWeek } = require('../utils/personal-access');
const { LOCK, localClock, openAt, punctualAt, locationInput, validateLocation, challengeFor, validChallenge, weekWithRecords } = require('../utils/attendance');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user', A = 'api::team-checkin.team-checkin', OLD = 'api::checkin.checkin';
const available = entry => entry?.status === 'active' && entry.account?.confirmed === true && !entry.account.blocked && entry.account.provider === 'local';
const conflict = message => new ApplicationError(message, { code: 'TEAM_CONFLICT' });
const attendanceDto = row => ({ date: row.date, timestamp: new Date(row.timestamp).toISOString(), punctual: row.punctual });
const accountBinding = (id, documentId) => createHash('sha256').update('team-account:' + id + ':' + documentId).digest('hex');
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);

module.exports = ({ strapi, clock = () => new Date() }) => {
  const secret = () => strapi.config.get('plugin::users-permissions.jwtSecret');
  const weekRows = (employee, now) => { const week = currentWeek(now); return strapi.documents(A).findMany({ filters: { employee: { documentId: employee }, date: { $gte: week.start, $lt: week.endExclusive } }, fields: ['date', 'timestamp', 'punctual'], limit: 7 }); };
  const legacyTable = () => strapi.db.metadata.get(OLD).tableName;
  const legacyQuery = now => { const week = currentWeek(now); return strapi.db.connection(legacyTable()).where('fecha_dia', '>=', week.start).where('fecha_dia', '<', week.endExclusive); };
  const legacyDto = row => ({ documentId: row.document_id, name: row.empleado || 'Sin nombre', date: String(row.date), timestamp: row.timestamp ? new Date(row.timestamp).toISOString() : null });
  async function lockEmployee(documentId, trx) {
    const row = await strapi.db.connection(strapi.db.metadata.get(E).tableName).transacting(trx).select('id').where({ document_id: documentId }).forUpdate().first();
    if (!row) throw new NotFoundError('La persona seleccionada no existe.');
    const entry = await strapi.documents(E).findOne({ documentId, fields: ['documentId', 'fullName', 'status'], populate: { account: { fields: ['id', 'blocked', 'confirmed', 'provider'] } } });
    if (!entry?.account) throw conflict('La cuenta no está disponible.');
    const lockedAccount = await strapi.db.connection(strapi.db.metadata.get(U).tableName).transacting(trx).select('id').where({ id: entry.account.id }).forUpdate().first();
    if (!lockedAccount) throw conflict('La cuenta no está disponible.');
    const account = await strapi.db.query(U).findOne({ where: { id: entry.account.id }, select: ['id', 'confirmed', 'blocked', 'provider'] });
    return { ...entry, account };
  }
  return {
    async welcomeForAccount(accountId) {
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw conflict('Inicia sesión en Team.');
      const entry = await strapi.documents(E).findFirst({ filters: { account: { id: accountId } }, fields: ['documentId', 'fullName', 'status'], populate: { account: { fields: ['id', 'confirmed', 'blocked', 'provider'] } } });
      if (!available(entry) || entry.account.id !== accountId) throw conflict('Tu cuenta no tiene un perfil de empleado activo.');
      const documentId = entry.documentId, hash = accountBinding(accountId, documentId);
      const now = clock(), rows = await weekRows(documentId, now), week = weekWithRecords(rows, now);
      const registered = rows.some(row => row.date === week.today), state = registered ? 'registered' : openAt(now) ? 'available' : 'closed';
      return { status: 'ready', identity: { fullName: entry.fullName }, week, checkinAvailable: state === 'available', checkinState: state, challenge: state === 'available' ? challengeFor(secret(), hash, now) : null };
    },
    async record(accountId, input) {
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw conflict('Inicia sesión en Team.');
      const data = locationInput(input), received = clock();
      const initial = await strapi.documents(E).findFirst({ filters: { account: { id: accountId } }, fields: ['documentId'] });
      if (!initial) throw conflict('Tu cuenta no tiene un perfil de empleado activo.');
      const hash = accountBinding(accountId, initial.documentId);
      return strapi.db.transaction(async ({ trx }) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [LOCK]);
        const entry = await lockEmployee(initial.documentId, trx);
        if (!available(entry) || entry.account.id !== accountId) throw conflict('Tu cuenta ya no tiene acceso a registrar llegadas.');
        if (!validChallenge(secret(), hash, data.challenge, clock()) || localClock(clock()).date !== localClock(received).date) throw conflict('La comprobación de llegada venció o cambió el acceso. Actualiza la página e intenta de nuevo.');
        const date = localClock(received).date, dayKey = entry.documentId + ':' + date;
        const existing = await strapi.documents(A).findFirst({ filters: { dayKey }, fields: ['date', 'timestamp', 'punctual'] });
        if (existing) return { status: 'already_registered', checkin: attendanceDto(existing) };
        if (!openAt(received)) throw new ValidationError('El registro de llegada cierra a las 12:00 p. m., en horario de Ciudad de México.');
        validateLocation(data);
        const saved = await strapi.documents(A).create({ data: { employee: entry.documentId, dayKey, date, timestamp: received.toISOString(), punctual: punctualAt(received) }, fields: ['date', 'timestamp', 'punctual'] });
        return { status: 'recorded', checkin: attendanceDto(saved) };
      });
    },
    async adminWeek(rawPage = '1', rawLegacyPage = '1') {
      if (![rawPage, rawLegacyPage].every(value => /^[1-9]\d{0,4}$/.test(String(value)))) throw new ValidationError('La página no es válida.');
      const page = Number(rawPage), legacyPage = Number(rawLegacyPage), pageSize = 25, now = clock(), week = currentWeek(now);
      const employees = await strapi.documents(E).findMany({ fields: ['documentId', 'fullName', 'status'], sort: ['fullName:asc', 'documentId:asc'], start: (page - 1) * pageSize, limit: pageSize });
      const total = await strapi.documents(E).count();
      const rows = employees.length ? await strapi.documents(A).findMany({ filters: { employee: { documentId: { $in: employees.map(entry => entry.documentId) } }, date: { $gte: week.start, $lt: week.endExclusive } }, fields: ['date', 'timestamp', 'punctual'], populate: { employee: { fields: ['documentId'] } }, limit: pageSize * 7 }) : [];
      const legacy = await legacyQuery(now).distinctOn('document_id').select('document_id', 'empleado', 'timestamp', strapi.db.connection.raw('fecha_dia::text as date')).orderBy('document_id').orderBy('updated_at', 'desc').orderBy('id', 'desc').offset((legacyPage - 1) * pageSize).limit(pageSize);
      const [{ count }] = await legacyQuery(now).countDistinct('document_id as count');
      return { week, employees: employees.map(entry => ({ ...entry, days: weekWithRecords(rows.filter(row => row.employee?.documentId === entry.documentId), now).days })), pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) }, legacy: { records: legacy.map(legacyDto), pagination: { page: legacyPage, pageSize, total: Number(count), pageCount: Math.max(1, Math.ceil(Number(count) / pageSize)) } } };
    },
    async linkLegacy(documentId, employeeDocumentId) {
      if (!validId(documentId) || !validId(employeeDocumentId)) throw new ValidationError('Selecciona un registro y un empleado válidos.');
      return strapi.db.transaction(async ({ trx }) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [LOCK]);
        const entry = await lockEmployee(employeeDocumentId, trx);
        const row = await legacyQuery(clock()).transacting(trx).where({ document_id: documentId }).select('document_id', 'timestamp', strapi.db.connection.raw('fecha_dia::text as date')).orderBy('updated_at', 'desc').orderBy('id', 'desc').forUpdate().first();
        if (!row?.timestamp) throw conflict('El registro ya no está disponible o no tiene una hora válida.');
        const timestamp = new Date(row.timestamp), date = localClock(timestamp).date, week = currentWeek(clock());
        if (date < week.start || date >= week.endExclusive || timestamp.getTime() > clock().getTime()) throw conflict('La hora del registro no corresponde a una llegada válida de la semana vigente.');
        const dayKey = entry.documentId + ':' + date;
        if (await strapi.documents(A).findFirst({ filters: { dayKey }, fields: ['documentId'] })) throw conflict('Esta persona ya tiene un registro para ese día. No se sobrescribió.');
        const saved = await strapi.documents(A).create({ data: { employee: entry.documentId, dayKey, date, timestamp: timestamp.toISOString(), punctual: punctualAt(timestamp) }, fields: ['date', 'timestamp', 'punctual'] });
        await strapi.documents(OLD).delete({ documentId });
        return { status: 'linked', checkin: attendanceDto(saved) };
      });
    },
    async purge() {
      return strapi.db.transaction(async ({ trx }) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [LOCK]);
        const week = currentWeek(clock()), outside = { $or: [{ date: { $lt: week.start } }, { date: { $gte: week.endExclusive } }, { date: { $null: true } }] };
        let deleted = 0;
        while (true) {
          const entries = await strapi.documents(A).findMany({ filters: outside, fields: ['documentId'], limit: 100 });
          if (!entries.length) break;
          for (const entry of entries) { await strapi.documents(A).delete({ documentId: entry.documentId }); deleted++; }
        }
        const table = legacyTable();
        const legacyDeleted = await strapi.db.connection(table).transacting(trx).where(builder => builder.where('fecha_dia', '<', week.start).orWhere('fecha_dia', '>=', week.endExclusive).orWhereNull('fecha_dia')).delete();
        const duplicates = await trx.raw('DELETE FROM ?? WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY updated_at DESC, id DESC) AS n FROM ??) versions WHERE n > 1)', [table, table]);
        return { deleted, legacyDeleted, legacyVersionsRemoved: duplicates.rowCount ?? 0 };
      });
    },
  };
};
