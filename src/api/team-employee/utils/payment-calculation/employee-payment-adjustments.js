// Generated from team/src/lib/employee-payment-adjustments.ts. Run: node scripts/generate-team-payment.mjs
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyPaymentAdjustments = exports.noPaymentCancellations = exports.paymentCancellationReasons = exports.paymentCancellationLabels = exports.paymentCancellationConcepts = void 0;
exports.paymentMoney = paymentMoney;
exports.paymentCancellations = paymentCancellations;
exports.paymentEntries = paymentEntries;
exports.calculateEmployeePaymentAdjustments = calculateEmployeePaymentAdjustments;
exports.paymentCancellationConcepts = ["tips", "shiftBonus", "punctualityBonus"];
exports.paymentCancellationLabels = { tips: "Propinas", shiftBonus: "Bonos del turno", punctualityBonus: "Bono de puntualidad" };
exports.paymentCancellationReasons = { not_applicable: "No aplica", penalty: "Penalización" };
const noPaymentCancellations = () => ({ tips: null, shiftBonus: null, punctualityBonus: null });
exports.noPaymentCancellations = noPaymentCancellations;
const emptyPaymentAdjustments = () => ({ consumptions: [], extraPayments: [], cash: 0, cancellations: (0, exports.noPaymentCancellations)() });
exports.emptyPaymentAdjustments = emptyPaymentAdjustments;
const limit = Number.MAX_SAFE_INTEGER / 100;
function paymentMoney(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > limit)
        throw new RangeError("Los importes deben ser números válidos no negativos.");
    return value;
}
function paymentCancellations(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== exports.paymentCancellationConcepts.length)
        throw new RangeError("Revisa las cancelaciones de conceptos.");
    const entries = value;
    return Object.fromEntries(exports.paymentCancellationConcepts.map(concept => {
        const reason = entries[concept];
        if (!Object.hasOwn(entries, concept) || (reason !== null && !Object.hasOwn(exports.paymentCancellationReasons, reason)))
            throw new RangeError("Revisa las cancelaciones de conceptos.");
        return [concept, reason];
    }));
}
function calendarDate(value) {
    const date = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + "T12:00:00Z") : null;
    return date !== null && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** Validate a dated list; with a week, every date must fall from its Monday to its Sunday. */
function paymentEntries(value, label, week = null) {
    if (!Array.isArray(value))
        throw new RangeError(`Revisa la lista de ${label}.`);
    return value.map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 3 || !["date", "concept", "amount"].every(key => Object.hasOwn(item, key)))
            throw new RangeError(`Cada renglón de ${label} necesita fecha, concepto e importe.`);
        const { date, concept, amount } = item;
        if (!calendarDate(date))
            throw new RangeError(`Cada renglón de ${label} necesita una fecha válida.`);
        if (week && (date < week.start || date >= week.endExclusive))
            throw new RangeError(`Las fechas de ${label} deben estar dentro de la semana.`);
        if (typeof concept !== "string" || !concept.trim() || concept.trim().length > 180)
            throw new RangeError(`Cada renglón de ${label} necesita un concepto de hasta 180 caracteres.`);
        return { date: date, concept: concept.trim(), amount: paymentMoney(amount) };
    });
}
/** Cash changes the transfer amount, not the employee's total earnings. */
function calculateEmployeePaymentAdjustments(subtotal, input, amounts = null) {
    if (subtotal !== null && (typeof subtotal !== "number" || !Number.isFinite(subtotal) || subtotal < 0))
        throw new RangeError("El subtotal no es válido.");
    const consumptions = paymentEntries(input.consumptions, "consumos");
    const extraPayments = paymentEntries(input.extraPayments, "pagos extra");
    const consumptionTotal = consumptions.reduce((total, item) => total + item.amount, 0);
    const extraPayTotal = extraPayments.reduce((total, item) => total + item.amount, 0);
    const cash = paymentMoney(input.cash);
    // Cancellations are a final filter: the rules keep their amounts and only this week drops the cancelled concepts.
    const cancellations = paymentCancellations(input.cancellations ?? (0, exports.noPaymentCancellations)());
    let cancelledTotal = 0;
    for (const concept of exports.paymentCancellationConcepts) {
        if (!cancellations[concept])
            continue;
        const amount = amounts?.[concept] ?? null;
        if (amount === null) {
            cancelledTotal = null;
            break;
        }
        cancelledTotal += paymentMoney(amount);
    }
    if (subtotal !== null && cancelledTotal === null)
        throw new RangeError("Faltan los importes de los conceptos cancelados.");
    const total = subtotal === null ? null : subtotal - (cancelledTotal ?? 0) + extraPayTotal - consumptionTotal;
    const deposit = total === null ? null : total - cash;
    if (![consumptionTotal, extraPayTotal, cancelledTotal ?? 0, total ?? 0, deposit ?? 0].every(Number.isFinite))
        throw new RangeError("Revisa los importes de la cuenta.");
    // Preserve negative balances for review instead of silently clamping or creating debt history.
    return { consumptions, consumptionTotal, extraPayments, extraPayTotal, cancellations, cancelledTotal, cash, total, deposit };
}
