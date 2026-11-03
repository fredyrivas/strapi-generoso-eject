'use strict';
const { createHash } = require('node:crypto');
const { errors: { ApplicationError, ValidationError, NotFoundError, ForbiddenError } } = require('@strapi/utils');
const { currentWeek } = require('../utils/personal-access');
const { LOCK, localClock, openAt, punctualAt, locationInput, validateLocation, challengeFor, validChallenge, weekWithRecords } = require('../utils/attendance');
const { attendanceKind } = require('../utils/attendance-kind');
const { weekStartInput } = require('../../team-salary-week/utils/input');
const E = 'api::team-employee.team-employee', U = 'plugin::users-permissions.user', A = 'api::team-checkin.team-checkin';
const available = entry => entry?.status === 'active' && entry.account?.confirmed === true && !entry.account.blocked && entry.account.provider === 'local';
const conflict = message => new ApplicationError(message, { code: 'TEAM_CONFLICT' });
const ATTENDANCE_FIELDS = ['date', 'timestamp', 'punctual', 'kind'];
const attendanceDto = row => ({ date: row.date, timestamp: new Date(row.timestamp).toISOString(), kind: attendanceKind(row.kind), punctual: attendanceKind(row.kind) === 'normal' && punctualAt(new Date(row.timestamp)) });
const accountBinding = (id, documentId) => createHash('sha256').update('team-account:' + id + ':' + documentId).digest('hex');
// Administrative arrivals use fixed Mexico City times on either side of the punctuality limit.
const ADMIN_ARRIVALS = { on_time: { hour: 8, kind: 'normal', punctual: true }, late: { hour: 9, kind: 'normal', punctual: false }, sick: { hour: 8, kind: 'sick', punctual: false } };
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
function adminArrival(date, status) {
  const arrival = ADMIN_ARRIVALS[status];
  // Mexico City has no daylight saving time (UTC-6); the checks below reject any other offset.
  const timestamp = new Date(date + 'T' + String(arrival.hour + 6).padStart(2, '0') + ':00:00Z');
  const local = localClock(timestamp);
  if (local.date !== date || local.seconds !== arrival.hour * 3600 || punctualAt(timestamp) !== (status !== 'late')) throw new ApplicationError('No se pudo calcular la hora local del registro.');
  return { timestamp: timestamp.toISOString(), kind: arrival.kind, punctual: arrival.punctual };
}
const requireAttendance = entry => {
  if (entry.teamRole === 'operative') throw new ForbiddenError('El rol Operativo no tiene habilitado el check-in.');
};

module.exports = ({ strapi, clock = () => new Date() }) => {
  const secret = () => strapi.config.get('plugin::users-permissions.jwtSecret');
  const weekRows = (employee, now) => { const week = currentWeek(now); return strapi.documents(A).findMany({ filters: { employee: { documentId: employee }, date: { $gte: week.start, $lt: week.endExclusive } }, fields: ATTENDANCE_FIELDS, limit: 7 }); };
  async function lockEmployee(documentId, trx) {
    const row = await strapi.db.connection(strapi.db.metadata.get(E).tableName).transacting(trx).select('id').where({ document_id: documentId }).forUpdate().first();
    if (!row) throw new NotFoundError('La persona seleccionada no existe.');
    const entry = await strapi.documents(E).findOne({ documentId, fields: ['documentId', 'fullName', 'status', 'teamRole'], populate: { account: { fields: ['id', 'blocked', 'confirmed', 'provider'] } } });
    if (!entry?.account) throw conflict('La cuenta no está disponible.');
    const lockedAccount = await strapi.db.connection(strapi.db.metadata.get(U).tableName).transacting(trx).select('id').where({ id: entry.account.id }).forUpdate().first();
    if (!lockedAccount) throw conflict('La cuenta no está disponible.');
    const account = await strapi.db.query(U).findOne({ where: { id: entry.account.id }, select: ['id', 'confirmed', 'blocked', 'provider'] });
    return { ...entry, account };
  }
  return {
    async welcomeForAccount(accountId) {
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw conflict('Inicia sesión en Team.');
      const entry = await strapi.documents(E).findFirst({ filters: { account: { id: accountId } }, fields: ['documentId', 'fullName', 'status', 'teamRole'], populate: { account: { fields: ['id', 'confirmed', 'blocked', 'provider'] } } });
      if (!available(entry) || entry.account.id !== accountId) throw conflict('Tu cuenta no tiene un perfil de empleado activo.');
      requireAttendance(entry);
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
        requireAttendance(entry);
        if (!validChallenge(secret(), hash, data.challenge, clock()) || localClock(clock()).date !== localClock(received).date) throw conflict('La comprobación de llegada venció o cambió el acceso. Actualiza la página e intenta de nuevo.');
        const date = localClock(received).date, dayKey = entry.documentId + ':' + date;
        const existing = await strapi.documents(A).findFirst({ filters: { dayKey }, fields: ATTENDANCE_FIELDS });
        if (existing) return { status: 'already_registered', checkin: attendanceDto(existing) };
        if (!openAt(received)) throw new ValidationError('El registro de llegada cierra a las 12:00 p. m., en horario de Ciudad de México.');
        validateLocation(data);
        const saved = await strapi.documents(A).create({ data: { employee: entry.documentId, dayKey, date, timestamp: received.toISOString(), kind: 'normal', punctual: punctualAt(received) }, fields: ATTENDANCE_FIELDS });
        return { status: 'recorded', checkin: attendanceDto(saved) };
      });
    },
    async reportSick(accountId, input) {
      if (!Number.isSafeInteger(accountId) || accountId <= 0) throw conflict('Inicia sesión en Team.');
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new ValidationError('El reporte de enfermedad no acepta datos adicionales.');
      const received = clock();
      const initial = await strapi.documents(E).findFirst({ filters: { account: { id: accountId } }, fields: ['documentId'] });
      if (!initial) throw conflict('Tu cuenta no tiene un perfil de empleado activo.');
      return strapi.db.transaction(async ({ trx }) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [LOCK]);
        const entry = await lockEmployee(initial.documentId, trx);
        if (!available(entry) || entry.account.id !== accountId) throw conflict('Tu cuenta ya no tiene acceso a registrar asistencia.');
        requireAttendance(entry);
        const date = localClock(received).date, dayKey = entry.documentId + ':' + date;
        const existing = await strapi.documents(A).findFirst({ filters: { dayKey }, fields: ATTENDANCE_FIELDS });
        if (existing) return { status: 'already_registered', checkin: attendanceDto(existing) };
        const saved = await strapi.documents(A).create({ data: { employee: entry.documentId, dayKey, date, timestamp: received.toISOString(), kind: 'sick', punctual: false }, fields: ATTENDANCE_FIELDS });
        return { status: 'recorded', checkin: attendanceDto(saved) };
      });
    },
    async adminRecord(documentId, date, input) {
      if (typeof documentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(documentId)) throw new ValidationError('La persona seleccionada no es válida.');
      if (!validDate(date)) throw new ValidationError('La fecha debe tener formato AAAA-MM-DD.');
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join() !== 'status' || !Object.hasOwn(ADMIN_ARRIVALS, input.status)) throw new ValidationError('El registro solo acepta puntual, con retraso o enfermedad.');
      if (date > localClock(clock()).date) throw new ValidationError('No se puede registrar asistencia en días futuros.');
      const arrival = adminArrival(date, input.status);
      return strapi.db.transaction(async ({ trx }) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [LOCK]);
        const row = await strapi.db.connection(strapi.db.metadata.get(E).tableName).transacting(trx).select('id').where({ document_id: documentId }).forUpdate().first();
        const entry = row && await strapi.documents(E).findOne({ documentId, fields: ['documentId', 'teamRole', 'paymentAccount'] });
        if (!entry) throw new NotFoundError('La persona seleccionada no existe.');
        requireAttendance(entry);
        // restDay uses Monday = 0, like the payment rules.
        if (entry.paymentAccount?.restDay === (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7) throw new ValidationError('Ese día es el descanso de la persona y no admite registro de asistencia.');
        const dayKey = entry.documentId + ':' + date;
        const existing = await strapi.documents(A).findFirst({ filters: { dayKey }, fields: ['documentId', ...ATTENDANCE_FIELDS] });
        const saved = existing
          ? await strapi.documents(A).update({ documentId: existing.documentId, data: arrival, fields: ATTENDANCE_FIELDS })
          : await strapi.documents(A).create({ data: { employee: entry.documentId, dayKey, date, ...arrival }, fields: ATTENDANCE_FIELDS });
        return { status: existing ? 'updated' : 'recorded', checkin: attendanceDto(saved) };
      });
    },
    // Without a week it shows the current one; past and future weeks only read their records.
    async adminWeek(rawPage = '1', weekStart = null) {
      if (!/^[1-9]\d{0,4}$/.test(String(rawPage))) throw new ValidationError('La página no es válida.');
      if (weekStart !== null) weekStartInput(weekStart);
      const page = Number(rawPage), pageSize = 25, now = clock(), week = currentWeek(now, weekStart);
      const filters = { teamRole: { $ne: 'operative' } };
      const employees = await strapi.documents(E).findMany({ filters, fields: ['documentId', 'fullName', 'status'], sort: ['fullName:asc', 'documentId:asc'], start: (page - 1) * pageSize, limit: pageSize });
      const total = await strapi.documents(E).count({ filters });
      const rows = employees.length ? await strapi.documents(A).findMany({ filters: { employee: { documentId: { $in: employees.map(entry => entry.documentId) } }, date: { $gte: week.start, $lt: week.endExclusive } }, fields: ATTENDANCE_FIELDS, populate: { employee: { fields: ['documentId'] } }, limit: pageSize * 7 }) : [];
      return { week, employees: employees.map(entry => ({ ...entry, days: weekWithRecords(rows.filter(row => row.employee?.documentId === entry.documentId), now, weekStart).days })), pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) } };
    },
  };
};
