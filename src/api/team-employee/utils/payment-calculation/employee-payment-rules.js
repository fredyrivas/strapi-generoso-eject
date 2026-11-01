// Generated from team/src/lib/employee-payment-rules.ts. Run: node scripts/generate-team-payment.mjs
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPLOYEE_PUNCTUALITY_BONUS = void 0;
exports.calculateEmployeePaymentRules = calculateEmployeePaymentRules;
const base_salaries_1 = require("./base-salaries");
exports.EMPLOYEE_PUNCTUALITY_BONUS = 100;
const workingDaysPerWeek = 6;
const punctualityCutoff = 8 * 3600 + 5 * 60 + 59;
function validDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new RangeError("La fecha del registro no es válida.");
    const parsed = new Date(value + "T12:00:00Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value)
        throw new RangeError("La fecha del registro no es válida.");
}
function localCheckin(record) {
    if (typeof record.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(record.timestamp)) {
        throw new RangeError("El registro necesita la fecha y hora guardadas por el servidor.");
    }
    validDate(record.timestamp.slice(0, 10));
    const instant = new Date(record.timestamp);
    if (!Number.isFinite(instant.getTime()))
        throw new RangeError("La hora del registro no es válida.");
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: base_salaries_1.BASE_SALARIES_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(instant);
    const value = (type) => parts.find(part => part.type === type).value;
    const date = `${value("year")}-${value("month")}-${value("day")}`;
    if (date !== record.date)
        throw new RangeError("La hora del registro no corresponde a su día en Ciudad de México.");
    return Number(value("hour")) * 3600 + Number(value("minute")) * 60 + Number(value("second"));
}
/** Pure calculation for the current account. Does not read/write attendance or payment history. */
function calculateEmployeePaymentRules(input) {
    if (typeof input.monthlySalary !== "number" || !Number.isFinite(input.monthlySalary) || input.monthlySalary < 0 || input.monthlySalary > Number.MAX_SAFE_INTEGER / 100)
        throw new RangeError("El sueldo mensual debe ser un importe no negativo.");
    if (!Number.isInteger(input.restDay) || input.restDay < 0 || input.restDay > 6)
        throw new RangeError("Selecciona un día de descanso de lunes a domingo.");
    if (input.payGroup !== "fixed" && input.payGroup !== "auxiliary")
        throw new RangeError("El grupo de reparto debe ser fijo o auxiliar.");
    const week = (0, base_salaries_1.baseSalariesWeek)(input.referenceDate);
    const base = (0, base_salaries_1.calculateBaseSalariesRows)(input.baseDays);
    const records = new Map();
    for (const record of input.checkins) {
        validDate(record.date);
        if (record.date < week.start || record.date >= week.endExclusive)
            continue;
        if (record.kind !== undefined && record.kind !== "normal" && record.kind !== "sick")
            throw new RangeError("El tipo de check-in no es válido.");
        if (records.has(record.date))
            throw new RangeError("Hay más de un registro para el mismo día; revisa la asistencia.");
        const kind = record.kind ?? "normal";
        // Recompute from the timestamp: legacy punctual flags use a different inclusive boundary.
        // Illness eligibility does not depend on a timestamp or the normal check-in restrictions.
        records.set(record.date, { kind, punctual: kind === "normal" && localCheckin(record) < punctualityCutoff });
    }
    const days = week.days.map((day, dayIndex) => {
        const record = records.get(day.date);
        const rest = dayIndex === input.restDay;
        const normal = !rest && record?.kind === "normal";
        const sick = !rest && record?.kind === "sick";
        const punctual = normal && record.punctual;
        const baseDay = base.days[dayIndex];
        const members = input.payGroup === "fixed" ? baseDay.input.fixedMembers : baseDay.input.auxiliaryMembers;
        // A recorded employee cannot be assigned a group's share if that group has no members.
        const allocationAvailable = members !== null && members > 0;
        const tips = normal ? allocationAvailable ? baseDay.values.individualTips : null : 0;
        const shiftBonus = normal ? allocationAvailable
            ? input.payGroup === "fixed" ? baseDay.values.fixedBonus : baseDay.values.auxiliaryBonus
            : null : 0;
        return {
            ...day, dayIndex,
            status: rest ? "rest" : sick ? "sick" : normal ? punctual ? "on_time" : "late" : "no_record",
            countsForSalary: normal || sick,
            receivesTips: normal,
            punctual,
            tips,
            shiftBonus,
        };
    });
    const normalDays = days.filter(day => day.status === "on_time" || day.status === "late").length;
    const sickDays = days.filter(day => day.status === "sick").length;
    const punctualDays = days.filter(day => day.punctual).length;
    const paidRestDays = normalDays + sickDays > 0 ? 1 : 0;
    const paidDays = normalDays + sickDays + paidRestDays;
    const weeklySalary = input.monthlySalary / 4;
    const dailySalary = weeklySalary / 7;
    const salary = dailySalary * paidDays;
    const punctualityBonus = exports.EMPLOYEE_PUNCTUALITY_BONUS * punctualDays / workingDaysPerWeek;
    const sum = (field) => {
        let total = 0;
        for (const day of days) {
            const value = day[field];
            if (value === null)
                return null;
            total += value;
        }
        return total;
    };
    const tips = sum("tips"), shiftBonus = sum("shiftBonus");
    return {
        referenceDate: input.referenceDate, timeZone: base_salaries_1.BASE_SALARIES_TIME_ZONE, start: week.start, endExclusive: week.endExclusive,
        days,
        attendance: { normalDays, sickDays, punctualDays, lateDays: normalDays - punctualDays, paidRestDays, paidDays },
        monthlySalary: input.monthlySalary, weeklySalary, dailySalary, salary,
        tips, shiftBonus,
        punctuality: punctualDays === workingDaysPerWeek ? "full" : punctualDays > 0 ? "partial" : "none",
        punctualityBonus,
        // Personal extras, consumptions and cash/deposit will be applied in the account step.
        subtotal: tips === null || shiftBonus === null ? null : salary + tips + shiftBonus + punctualityBonus,
        status: tips === null || shiftBonus === null ? "pending" : "ready",
    };
}
