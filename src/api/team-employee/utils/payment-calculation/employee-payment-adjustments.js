// Generated from team/src/lib/employee-payment-adjustments.ts. Run: node scripts/generate-team-payment.mjs
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.noPaymentCancellations = exports.paymentCancellationReasons = exports.paymentCancellationLabels = exports.paymentCancellationConcepts = void 0;
exports.paymentMoney = paymentMoney;
exports.paymentCancellations = paymentCancellations;
exports.calculateEmployeePaymentAdjustments = calculateEmployeePaymentAdjustments;
exports.paymentCancellationConcepts = ["tips", "shiftBonus", "punctualityBonus"];
exports.paymentCancellationLabels = { tips: "Propinas", shiftBonus: "Bonos del turno", punctualityBonus: "Bono de puntualidad" };
exports.paymentCancellationReasons = { not_applicable: "No aplica", penalty: "Penalización" };
const noPaymentCancellations = () => ({ tips: null, shiftBonus: null, punctualityBonus: null });
exports.noPaymentCancellations = noPaymentCancellations;
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
/** Cash changes the transfer amount, not the employee's total earnings. */
function calculateEmployeePaymentAdjustments(subtotal, input, amounts = null) {
    if (subtotal !== null && (typeof subtotal !== "number" || !Number.isFinite(subtotal) || subtotal < 0))
        throw new RangeError("El subtotal no es válido.");
    if (!Array.isArray(input.consumptions))
        throw new RangeError("Revisa la lista de consumos.");
    const consumptions = input.consumptions.map(item => {
        if (!item || typeof item.concept !== "string" || !item.concept.trim() || item.concept.trim().length > 180)
            throw new RangeError("Cada consumo necesita un concepto de hasta 180 caracteres.");
        return { concept: item.concept.trim(), amount: paymentMoney(item.amount) };
    });
    const consumptionTotal = consumptions.reduce((total, item) => total + item.amount, 0);
    const extraPay = paymentMoney(input.extraPay), cash = paymentMoney(input.cash);
    // Cancellations are a final filter: the rules keep their amounts and only this account drops the cancelled concepts.
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
    const total = subtotal === null ? null : subtotal - (cancelledTotal ?? 0) + extraPay - consumptionTotal;
    const deposit = total === null ? null : total - cash;
    if (![consumptionTotal, cancelledTotal ?? 0, total ?? 0, deposit ?? 0].every(Number.isFinite))
        throw new RangeError("Revisa los importes de la cuenta.");
    // Preserve negative balances for review instead of silently clamping or creating debt history.
    return { consumptions, consumptionTotal, cancellations, cancelledTotal, extraPay, cash, total, deposit };
}
