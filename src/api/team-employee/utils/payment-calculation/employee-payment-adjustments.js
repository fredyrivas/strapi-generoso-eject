// Generated from team/src/lib/employee-payment-adjustments.ts. Run: node scripts/generate-team-payment.mjs
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentMoney = paymentMoney;
exports.calculateEmployeePaymentAdjustments = calculateEmployeePaymentAdjustments;
const limit = Number.MAX_SAFE_INTEGER / 100;
function paymentMoney(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > limit)
        throw new RangeError("Los importes deben ser números válidos no negativos.");
    return value;
}
/** Cash changes the transfer amount, not the employee's total earnings. */
function calculateEmployeePaymentAdjustments(subtotal, input) {
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
    const total = subtotal === null ? null : subtotal + extraPay - consumptionTotal;
    const deposit = total === null ? null : total - cash;
    if (![consumptionTotal, total ?? 0, deposit ?? 0].every(Number.isFinite))
        throw new RangeError("Revisa los importes de la cuenta.");
    // Preserve negative balances for review instead of silently clamping or creating debt history.
    return { consumptions, consumptionTotal, extraPay, cash, total, deposit };
}
