'use strict';

const { isDeepStrictEqual } = require('node:util');
const { createHash } = require('node:crypto');
const { errors: { ValidationError, NotFoundError } } = require('@strapi/utils');
const { LOCK } = require('../utils/attendance');
const { conflict: transferConflict } = require('../utils/payment-confirmations');
const { baseSalariesWeek } = require('../utils/payment-calculation/base-salaries');
const employeeType = 'api::team-employee.team-employee';
const archiveType = 'api::team-settlement-archive.team-settlement-archive';
const employeeId = /^[A-Za-z0-9_-]{1,128}$/;
const archiveId = /^[0-9a-f]{64}$/;
const fields = ['archiveKey', 'employeeDocumentId', 'snapshot', 'createdAt'];
const pageSize = 10;
const dto = entry => ({ id: entry.archiveKey, savedAt: entry.createdAt, snapshot: entry.snapshot });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
const date = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const quantity = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const cents = value => Number.isSafeInteger(value) && value >= 0;
const lineNames = ['salary', 'bonus', 'currentVacation', 'pastVacation', 'vacationPremium', 'seniority', 'other'];
const inputNumbers = [
  'unpaidSalaryDays', 'annualBonusDays', 'bonusEligibleDays', 'bonusAlreadyPaid', 'annualVacationDays',
  'vacationDaysUsed', 'pastVacationDaysDue', 'vacationPremiumPercent', 'vacationPremiumAlreadyPaid', 'otherAmount',
];
const paymentMethods = ['Efectivo', 'Transferencia bancaria', 'Cheque', 'Otro'];

function validBasis(basis) {
  return record(basis) && date(basis.startDate) && date(basis.lastWorkDate) && basis.lastWorkDate >= basis.startDate &&
    quantity(basis.monthlySalary) && basis.monthlySalary >= 0.01 && basis.monthlySalary <= Number.MAX_SAFE_INTEGER / 100;
}

function validRevision(revision) {
  if (!record(revision) || Object.hasOwn(revision, 'reason')) return false;
  const { input, result } = revision;
  if (!validBasis(input) || !inputNumbers.every(key => quantity(input[key])) ||
      (input.seniorityDailyMinimumWage !== null && !quantity(input.seniorityDailyMinimumWage)) ||
      typeof input.otherDescription !== 'string' || input.otherDescription.length > 180) return false;
  if (input.dayOverrides !== undefined && (!record(input.dayOverrides) ||
      !Object.entries(input.dayOverrides).every(([key, value]) => ['currentVacation', 'pastVacation', 'bonus'].includes(key) && quantity(value)))) return false;
  if (input.salaryEntries !== undefined && (!Array.isArray(input.salaryEntries) || input.salaryEntries.length > 366 ||
      !input.salaryEntries.every(row => record(row) && date(row.date) && row.date >= input.startDate && row.date <= input.lastWorkDate &&
        quantity(row.days) && row.days >= 0.01 && row.days <= 1 && Math.abs(row.days * 100 - Math.round(row.days * 100)) < 1e-8))) return false;
  return record(result) && cents(result.total) && record(result.lines) &&
    lineNames.every(key => cents(result.lines[key])) &&
    lineNames.reduce((sum, key) => sum + result.lines[key], 0) === result.total &&
    typeof result.otherDescription === 'string' && result.otherDescription.length <= 180 &&
    (result.lines.other === 0 || result.otherDescription.trim()) &&
    ['dailySalary', 'vacationDaysEarned', 'currentVacationDaysDue'].every(key => quantity(result[key]));
}

function validSnapshot(snapshot) {
  if (!record(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.revisions) || snapshot.revisions.length > 1) return false;
  const { employee, basis, documents, revisions, balance, receipt } = snapshot;
  if (!record(employee) || !text(employee.fullName, 180) || !text(employee.position, 100)) return false;
  if (!validBasis(basis)) return false;
  if (!record(documents) || !text(documents.employer, 180) || !text(documents.address, 260) || !date(documents.issuedOn)) return false;
  const workplace = documents.workplace;
  if (workplace !== undefined && (!record(workplace) || !text(workplace.name, 180) || !text(workplace.address, 260))) return false;
  if (!revisions.every(validRevision)) return false;
  const latest = revisions.at(-1);
  if (latest && (latest.input.startDate !== basis.startDate || latest.input.lastWorkDate !== basis.lastWorkDate || latest.input.monthlySalary !== basis.monthlySalary)) return false;
  if (balance !== null && (!record(balance) || !latest || balance.gross !== latest.result.total ||
      !cents(balance.retained) || balance.retained > balance.gross || !cents(balance.paid))) return false;
  return balance?.paid > 0
    ? record(receipt) && cents(receipt.amount) && receipt.amount > 0 && receipt.amount <= balance.paid &&
      date(receipt.paidOn) && receipt.paidOn <= documents.issuedOn && paymentMethods.includes(receipt.method) &&
      typeof receipt.reference === 'string' && receipt.reference.length <= 120
    : receipt === null;
}

function conflict(ctx, message) {
  ctx.status = 409;
  ctx.body = { error: { message } };
}

function validCombined(snapshot) {
  const { combinedPayment: payment, receipt, balance, basis } = snapshot;
  if (!record(payment) || !text(payment.reference, 120) || !date(payment.paidOn) || payment.paidOn > baseSalariesWeek().today ||
      !cents(payment.settlementCents) || payment.settlementCents === 0 || !cents(payment.priorPaidCents) || !cents(payment.totalCents) ||
      !Array.isArray(payment.weeks) || !payment.weeks.length || payment.weeks.length > 26 ||
      receipt?.method !== 'Transferencia bancaria' || receipt.reference !== payment.reference ||
      receipt.paidOn !== payment.paidOn || receipt.amount !== payment.settlementCents ||
      balance.paid !== payment.priorPaidCents + payment.settlementCents || balance.paid > balance.gross - balance.retained) return false;
  const first = baseSalariesWeek(basis.startDate).start, last = baseSalariesWeek(basis.lastWorkDate).start;
  if (!payment.weeks.every(week => record(week) && date(week.weekStart) && week.weekStart >= first && week.weekStart <= last &&
      baseSalariesWeek(week.weekStart).start === week.weekStart &&
      ['version', 'depositCents', 'cashCents', 'pendingCents', 'amountCents'].every(key => cents(week[key])) &&
      week.amountCents > 0 && week.amountCents <= week.pendingCents && week.pendingCents <= week.depositCents &&
      Array.isArray(week.salaryDates) && week.salaryDates.length <= 7 && week.salaryDates.every(date))) return false;
  return new Set(payment.weeks.map(week => week.weekStart)).size === payment.weeks.length &&
    payment.weeks.reduce((sum, week) => sum + week.amountCents, payment.settlementCents) === payment.totalCents;
}

function verifySalary(snapshot, covered) {
  const input = snapshot.revisions[0]?.input;
  if (!Array.isArray(input?.salaryEntries)) throw new ValidationError('Confirma las fechas de salario pendientes.');
  const dates = input.salaryEntries.filter(row => !covered.has(row.date));
  if (new Set(dates.map(row => row.date)).size !== dates.length ||
      dates.reduce((sum, row) => sum + Math.round(row.days * 100), 0) / 100 !== input.unpaidSalaryDays) {
    throw transferConflict('Cambiaron las fechas cubiertas por nómina. Vuelve a calcular el finiquito.');
  }
}

module.exports = {
  async list(ctx) {
    ctx.set('Cache-Control', 'no-store');
    const documentId = ctx.params.documentId;
    const page = ctx.query.page ?? '1';
    if (!employeeId.test(documentId) || typeof page !== 'string' || !/^[1-9]\d{0,3}$/.test(page) ||
        Object.keys(ctx.query).some(key => key !== 'page')) return ctx.badRequest('Revisa la persona o página seleccionada.');
    const entries = await strapi.documents(archiveType).findMany({
      filters: { employeeDocumentId: documentId }, fields, sort: ['createdAt:desc', 'archiveKey:asc'],
      start: (Number(page) - 1) * pageSize, limit: pageSize + 1,
    });
    ctx.body = { entries: entries.slice(0, pageSize).map(dto), hasMore: entries.length > pageSize };
  },

  async save(ctx) {
    ctx.set('Cache-Control', 'no-store');
    const documentId = ctx.params.documentId;
    const body = ctx.request.body;
    if (!employeeId.test(documentId) || !record(body) || typeof body.id !== 'string' || !archiveId.test(body.id) ||
        Object.keys(ctx.query).length || Buffer.byteLength(JSON.stringify(body)) > 64_000 || !validSnapshot(body.snapshot) || body.snapshot.combinedPayment !== undefined) {
      return ctx.badRequest('Revisa los datos del expediente.');
    }
    const expectedKey = createHash('sha256').update(documentId).update('\0').update(JSON.stringify(body.snapshot)).digest('hex');
    if (expectedKey !== body.id) return ctx.badRequest('La clave del expediente no corresponde a sus datos.');
    const archives = strapi.documents(archiveType);
    const find = () => archives.findFirst({ filters: { archiveKey: body.id }, fields });
    const replay = entry => {
      if (entry.employeeDocumentId !== documentId || !isDeepStrictEqual(entry.snapshot, body.snapshot)) {
        return conflict(ctx, 'La clave del expediente ya está en uso con otros datos.');
      }
      ctx.body = dto(entry);
    };
    const existing = await find();
    if (existing) return replay(existing);

    const employee = await strapi.documents(employeeType).findOne({ documentId, fields: ['fullName', 'position', 'startDate'] });
    if (!employee) return ctx.notFound('La persona seleccionada ya no existe.');
    if (employee.fullName !== body.snapshot.employee.fullName || employee.position !== body.snapshot.employee.position ||
        employee.startDate !== body.snapshot.basis.startDate) {
      return conflict(ctx, 'La ficha de la persona cambió. Actualiza el listado antes de guardar.');
    }
    try {
      const entry = await archives.create({
        data: { archiveKey: body.id, employeeDocumentId: documentId, actorAccountId: ctx.state.user.id, snapshot: body.snapshot },
        fields,
      });
      ctx.body = dto(entry);
      ctx.status = 201;
    } catch (error) {
      const concurrent = await find();
      if (!concurrent) throw error;
      return replay(concurrent);
    }
  },

  async registerCombined(ctx) {
    ctx.set('Cache-Control', 'no-store');
    const { documentId } = ctx.params;
    const body = ctx.request.body;
    if (!employeeId.test(documentId) || !record(body) || Object.keys(ctx.query).length ||
        Buffer.byteLength(JSON.stringify(body)) > 64_000 || !validSnapshot(body.snapshot) || !validCombined(body.snapshot)) {
      return ctx.badRequest('Revisa el desglose y los datos de la transferencia.');
    }
    const { snapshot } = body;
    const payment = snapshot.combinedPayment;
    const normalizedReference = payment.reference.toUpperCase();
    const key = createHash('sha256').update('combined\0').update(documentId).update('\0').update(normalizedReference).digest('hex');
    if (body.id !== key) return ctx.badRequest('La referencia no corresponde a la operación.');
    try {
      const saved = await strapi.db.transaction(async ({ trx }) => {
        // Match the weekly payment lock order. Nested summary reads and writes share this transaction.
        for (const lock of [LOCK, 'generoso:team:base-salaries']) await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [lock]);
        const archives = strapi.documents(archiveType);
        const previous = await archives.findFirst({ filters: { archiveKey: key }, fields });
        if (previous) {
          if (previous.employeeDocumentId !== documentId || !isDeepStrictEqual(previous.snapshot, snapshot)) {
            throw transferConflict('Esa referencia bancaria ya está registrada con otros datos. Consulta el expediente guardado.');
          }
          return { entry: previous, status: 200 };
        }
        const employee = await strapi.documents(employeeType).findOne({ documentId, fields: ['fullName', 'position', 'startDate'] });
        if (!employee) throw new NotFoundError('La persona seleccionada ya no existe.');
        if (employee.fullName !== snapshot.employee.fullName || employee.position !== snapshot.employee.position || employee.startDate !== snapshot.basis.startDate) {
          throw transferConflict('La ficha de la persona cambió. Actualiza el listado antes de registrar el pago.');
        }
        const last = await archives.findFirst({
          filters: { employeeDocumentId: documentId, combinedExitDate: snapshot.basis.lastWorkDate },
          sort: ['createdAt:desc', 'id:desc'], fields: ['snapshot'],
        });
        if (payment.priorPaidCents < (last?.snapshot.balance.paid ?? 0)) {
          throw transferConflict('El finiquito ya tiene pagos registrados. Actualiza el importe previamente pagado.');
        }
        const actor = ctx.state.user;
        const weekly = strapi.service('api::team-employee.team-payment-confirmations');
        const covered = new Set();
        for (const expected of payment.weeks) {
          const current = await weekly.read(documentId, actor.id, expected.weekStart);
          if (current.status === 'paid' || !current.payroll ||
              ['version', 'depositCents', 'cashCents', 'pendingCents'].some(field => current[field] !== expected[field]) ||
              !isDeepStrictEqual([...current.payroll.salaryDates].sort(), expected.salaryDates)) {
            throw transferConflict('Cambió el saldo o la cobertura de una semana. Actualiza los pagos y recalcula antes de registrar.');
          }
          if (current.events.some(event => event.method === 'transfer' && event.reference.toUpperCase() === normalizedReference)) {
            throw transferConflict('Esa referencia ya figura en los pagos de una semana seleccionada.');
          }
          current.payroll.salaryDates.forEach(day => covered.add(day));
        }
        verifySalary(snapshot, covered);
        for (const week of payment.weeks) {
          const requestId = createHash('sha256').update(key).update(week.weekStart).digest('hex').slice(0, 32);
          await weekly.register(documentId, actor, {
            ...week, requestId, paidOn: payment.paidOn, method: 'transfer', reference: payment.reference,
          }, key);
        }
        const entry = await archives.create({
          data: { archiveKey: key, employeeDocumentId: documentId, actorAccountId: actor.id, combinedExitDate: snapshot.basis.lastWorkDate, snapshot }, fields,
        });
        return { entry, status: 201 };
      });
      ctx.body = dto(saved.entry);
      ctx.status = saved.status;
    } catch (error) {
      if (error.details?.code !== 'TEAM_CONFLICT') throw error;
      return conflict(ctx, error.message);
    }
  },
};
