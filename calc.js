'use strict';
/**
 * Pure, side-effect-free financial calculators.
 * Extracted from the route handlers so the money math can be unit-tested
 * in isolation (see test/calc.test.js).
 */

// QC/PDI is billed at the Minimum-Guarantee floor per operating day when
// mgBilling is on: each day bills max(actualParts, mg). Returns the actual and
// billed quantities plus the MG uplift (extra parts billed because of the floor).
function qcBilled(qcDaysParts, mg, mgBilling) {
  const actual = qcDaysParts.reduce((a, p) => a + (p || 0), 0);
  const billed = mgBilling
    ? qcDaysParts.reduce((a, p) => a + Math.max(p || 0, mg), 0)
    : actual;
  return { actual, billed, uplift: billed - actual };
}

// GST on a subtotal. gstPct is a whole-number percentage (e.g. 18 = 18%).
function gst(subtotal, gstPct) {
  const amt = Math.round(subtotal * (gstPct || 0)) / 100;
  return { gst_amt: amt, grand_total: subtotal + amt };
}

// Per-worker monthly wage from attendance + salary structure.
// PF = 12% of earned basic; ESI = 0.75% of (gross+OT) while it is <= the
// statutory ₹21,000 ceiling; OT is paid at 2x the hourly rate.
function wageRow(w, presentDays, otHours, stdDays) {
  const perDay = w.wage_type === 'DAILY'
    ? (w.daily_wage || 0)
    : ((w.monthly_gross || 0) / stdDays);
  const gross = Math.round(perDay * presentDays);
  const hourly = perDay / 8;
  const otPay = Math.round((otHours || 0) * hourly * 2);
  const basicEarned = w.wage_type === 'DAILY'
    ? gross
    : Math.round((w.basic || 0) / stdDays * presentDays);
  const pf = w.pf_applicable ? Math.round(basicEarned * 0.12) : 0;
  const esi = (w.esi_applicable && (gross + otPay) <= 21000)
    ? Math.round((gross + otPay) * 0.0075)
    : 0;
  const net = gross + otPay - pf - esi;
  return { gross, ot_pay: otPay, pf, esi, net };
}

module.exports = { qcBilled, gst, wageRow };
