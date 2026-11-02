// Generated from team/src/lib/base-salaries.ts. Run: node scripts/generate-team-payment.mjs
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BASE_SALARIES_TIME_ZONE = void 0;
exports.emptyBaseSalariesInput = emptyBaseSalariesInput;
exports.baseSalariesWeek = baseSalariesWeek;
exports.calculateBaseSalariesDay = calculateBaseSalariesDay;
exports.calculateBaseSalariesRows = calculateBaseSalariesRows;
exports.calculateBaseSalariesWeek = calculateBaseSalariesWeek;
exports.BASE_SALARIES_TIME_ZONE = "America/Mexico_City";
const dayLabels = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];
const inputFields = ["cardTips", "cashTips", "fixedMembers", "auxiliaryMembers", "bonuses"];
function emptyBaseSalariesInput() {
    return { cardTips: null, cashTips: null, fixedMembers: null, auxiliaryMembers: null, bonuses: null };
}
function calendarDate(value) {
    const date = new Date(value + "T12:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new RangeError("La fecha debe ser una fecha válida con formato AAAA-MM-DD.");
    }
    return date;
}
function addDays(date, count) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + count);
    return next.toISOString().slice(0, 10);
}
/** Calendar arithmetic follows the Mexico City date, independently of the host timezone. */
function baseSalariesWeek(selectedDate, now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: exports.BASE_SALARIES_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const value = (type) => parts.find(part => part.type === type).value;
    const today = `${value("year")}-${value("month")}-${value("day")}`;
    const monday = calendarDate(selectedDate ?? today);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const formatter = new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
    return {
        timeZone: exports.BASE_SALARIES_TIME_ZONE,
        today,
        start: addDays(monday, 0),
        endExclusive: addDays(monday, 7),
        days: dayLabels.map((label, index) => {
            const date = addDays(monday, index);
            return { date, label, dateLabel: formatter.format(calendarDate(date)) };
        }),
    };
}
/** Keep the sheet's intermediate precision; round only when presenting amounts. */
function calculateBaseSalariesDay(input) {
    const issues = [];
    const values = emptyBaseSalariesInput();
    for (const field of inputFields) {
        const value = input[field];
        if (value === null || value === undefined) {
            issues.push({ code: "missing_input", field });
        }
        else if (typeof value !== "number" || !Number.isFinite(value) || value < 0
            || (field === "fixedMembers" || field === "auxiliaryMembers"
                ? !Number.isSafeInteger(value) || value > Number.MAX_SAFE_INTEGER / 2
                : value > Number.MAX_SAFE_INTEGER / 100)) {
            issues.push({ code: "invalid_input", field });
        }
        else {
            values[field] = value;
        }
    }
    const { cardTips, cashTips, fixedMembers, auxiliaryMembers, bonuses } = values;
    const totalTips = cardTips !== null && cashTips !== null ? cardTips * (1 - 0.035) + cashTips : null;
    const members = fixedMembers !== null && auxiliaryMembers !== null ? fixedMembers + auxiliaryMembers : null;
    let individualTips = null;
    if (totalTips !== null && members !== null) {
        if (members === 0)
            issues.push({ code: "zero_divisor", result: "individualTips" });
        else
            individualTips = totalTips / members;
    }
    let fixedBonus = null;
    if (bonuses !== null && auxiliaryMembers !== null) {
        if (auxiliaryMembers > 0)
            fixedBonus = bonuses * 0.7;
        else if (fixedMembers === 0)
            issues.push({ code: "zero_divisor", result: "fixedBonus" });
        else if (fixedMembers !== null)
            fixedBonus = bonuses / fixedMembers;
    }
    const auxiliaryBonus = auxiliaryMembers === null ? null : auxiliaryMembers === 0 ? 0 : bonuses !== null ? bonuses * 0.3 : null;
    const fixedTotal = individualTips !== null && fixedBonus !== null ? individualTips + fixedBonus : null;
    const auxiliaryTotal = auxiliaryMembers === null ? null : auxiliaryMembers === 0 ? 0
        : individualTips !== null && auxiliaryBonus !== null ? individualTips + auxiliaryBonus : null;
    const status = issues.some(issue => issue.code !== "missing_input") ? "invalid" : issues.length ? "pending" : "ready";
    return {
        status,
        issues,
        values: { totalTips, individualTips, bonuses, fixedBonus, auxiliaryBonus, fixedTotal, auxiliaryTotal },
    };
}
/** The seven editable rows belong to weekdays, independently of calendar dates. */
function calculateBaseSalariesRows(records = []) {
    const inputs = new Map();
    for (const record of records) {
        if (!Number.isInteger(record.dayIndex) || record.dayIndex < 0 || record.dayIndex > 6)
            throw new RangeError("La fila debe corresponder a un día de lunes a domingo.");
        if (inputs.has(record.dayIndex))
            throw new RangeError("La base contiene un día duplicado.");
        inputs.set(record.dayIndex, record.input);
    }
    const days = dayLabels.map((_label, dayIndex) => {
        const input = { ...(inputs.get(dayIndex) ?? emptyBaseSalariesInput()) };
        return { dayIndex, input, ...calculateBaseSalariesDay(input) };
    });
    const sum = (field) => {
        let total = null;
        for (const day of days) {
            const value = day.values[field];
            // Pending days are skipped so the total shows progress; it stays null only when no day has a value.
            if (value !== null)
                total = (total ?? 0) + value;
        }
        return total;
    };
    return {
        days,
        status: days.some(day => day.status === "invalid") ? "invalid" : days.some(day => day.status === "pending") ? "pending" : "ready",
        totals: {
            totalTips: sum("totalTips"), individualTips: sum("individualTips"), bonuses: sum("bonuses"),
            fixedBonus: sum("fixedBonus"), auxiliaryBonus: sum("auxiliaryBonus"),
            fixedTotal: sum("fixedTotal"), auxiliaryTotal: sum("auxiliaryTotal"),
        },
    };
}
/** Calendar dates are an optional presentation of the same weekday calculations. */
function calculateBaseSalariesWeek(selectedDate, records = [], now = new Date()) {
    const week = baseSalariesWeek(selectedDate, now);
    const rows = records.map(record => {
        calendarDate(record.date);
        const dayIndex = week.days.findIndex(day => day.date === record.date);
        if (dayIndex < 0)
            throw new RangeError("El día no pertenece a la semana seleccionada.");
        return { dayIndex, input: record.input };
    });
    const calculation = calculateBaseSalariesRows(rows);
    return { ...week, ...calculation, days: calculation.days.map(day => ({ ...week.days[day.dayIndex], ...day })) };
}
