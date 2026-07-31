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
// Statutory ESI wage ceiling (INR/month). Shared with lib/reports.js so the
// employer's contribution stops at exactly the same point the employee's does.
const ESI_WAGE_CEILING = 21000;

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
  const esi = (w.esi_applicable && (gross + otPay) <= ESI_WAGE_CEILING)
    ? Math.round((gross + otPay) * 0.0075)
    : 0;
  const net = gross + otPay - pf - esi;
  // basic_earned is returned so the P&L can charge employer PF on it — the
  // employer contribution is a company cost, unlike the `pf` deducted above.
  return { gross, ot_pay: otPay, pf, esi, net, basic_earned: basicEarned };
}

const money = (n) => Math.round(Number(n) || 0);
const sum = (lines) => lines.reduce((a, l) => a + money(l.amount), 0);

/**
 * Full top-to-bottom P&L statement.
 *
 *   Revenue − direct            = Gross Profit
 *   Gross Profit − indirect     = EBITDA
 *   EBITDA − depreciation − amortisation = EBIT
 *   EBIT − interest             = PBT
 *   PBT − tax                   = Net Profit
 *
 * `direct` and `indirect` are arrays of { name, amount, ... }; every other
 * field is a plain monthly amount. Tax is charged on PBT only when it is
 * positive — a loss-making month carries no tax rather than a negative one.
 * Margins are fractions of revenue (0 when there is no revenue to divide by).
 */
function pnlStatement({ revenue = 0, direct = [], indirect = [],
                        depreciation = 0, amortisation = 0, interest = 0, taxPct = 0 } = {}) {
  const rev = money(revenue);
  const margin = (v) => (rev ? v / rev : 0);

  const directTotal = sum(direct);
  const grossProfit = rev - directTotal;

  const indirectTotal = sum(indirect);
  const ebitda = grossProfit - indirectTotal;

  const dep = money(depreciation), amort = money(amortisation);
  const ebit = ebitda - dep - amort;

  const int = money(interest);
  const pbt = ebit - int;

  const tax = pbt > 0 ? Math.round(pbt * (Number(taxPct) || 0) / 100) : 0;
  const netProfit = pbt - tax;

  return {
    revenue: rev,
    direct_lines: direct, direct_total: directTotal,
    gross_profit: grossProfit, gross_margin: margin(grossProfit),
    indirect_lines: indirect, indirect_total: indirectTotal,
    ebitda, ebitda_margin: margin(ebitda),
    depreciation: dep, amortisation: amort, ebit, ebit_margin: margin(ebit),
    interest: int, pbt,
    tax_pct: Number(taxPct) || 0, tax,
    net_profit: netProfit, net_margin: margin(netProfit),
  };
}

module.exports = { qcBilled, gst, wageRow, pnlStatement, ESI_WAGE_CEILING };
