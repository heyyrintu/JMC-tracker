'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { qcBilled, gst, wageRow, pnlStatement } = require('../calc');

test('qcBilled applies the MG floor per day when billing is on', () => {
  const r = qcBilled([500, 700, 600], 600, true);
  assert.equal(r.actual, 1800);
  assert.equal(r.billed, 600 + 700 + 600); // the 500 day is floored up to 600
  assert.equal(r.uplift, 100);
});

test('qcBilled bills the actual quantity when MG billing is off', () => {
  const r = qcBilled([500, 700], 600, false);
  assert.equal(r.billed, 1200);
  assert.equal(r.uplift, 0);
});

test('gst computes amount and grand total', () => {
  assert.deepEqual(gst(1000, 18), { gst_amt: 180, grand_total: 1180 });
  assert.deepEqual(gst(1000, 0), { gst_amt: 0, grand_total: 1000 });
});

test('wageRow: full monthly attendance, PF deducted, ESI above ceiling', () => {
  const w = { wage_type: 'MONTHLY', monthly_gross: 26000, basic: 13000, pf_applicable: 1, esi_applicable: 1 };
  const r = wageRow(w, 26, 0, 26);
  assert.equal(r.gross, 26000);
  assert.equal(r.pf, 1560);   // 12% of 13000
  assert.equal(r.esi, 0);     // gross 26000 > the ₹21,000 ESI ceiling
  assert.equal(r.net, 26000 - 1560);
});

test('wageRow: daily wage with overtime, ESI below ceiling', () => {
  const w = { wage_type: 'DAILY', daily_wage: 500, pf_applicable: 0, esi_applicable: 1 };
  const r = wageRow(w, 20, 10, 26); // 20 present days, 10 OT hours
  const hourly = 500 / 8;
  const otPay = Math.round(10 * hourly * 2);
  assert.equal(r.gross, 10000);
  assert.equal(r.ot_pay, otPay);
  assert.equal(r.pf, 0);
  assert.equal(r.esi, Math.round((10000 + otPay) * 0.0075));
  assert.equal(r.net, 10000 + otPay - r.esi);
});

test('wageRow returns earned basic so employer PF can be charged on it', () => {
  const w = { wage_type: 'MONTHLY', monthly_gross: 26000, basic: 13000, pf_applicable: 1, esi_applicable: 0 };
  assert.equal(wageRow(w, 13, 0, 26).basic_earned, 6500); // half the standard days
});

test('pnlStatement walks revenue down to net profit', () => {
  const r = pnlStatement({
    revenue: 1000000,
    direct: [{ name: 'Payroll', amount: 400000 }, { name: 'Transport', amount: 100000 }],
    indirect: [{ name: 'Overhead', amount: 200000 }],
    depreciation: 50000, amortisation: 10000, interest: 40000, taxPct: 25,
  });
  assert.equal(r.direct_total, 500000);
  assert.equal(r.gross_profit, 500000);
  assert.equal(r.indirect_total, 200000);
  assert.equal(r.ebitda, 300000);
  assert.equal(r.ebit, 240000);          // 300000 − 50000 − 10000
  assert.equal(r.pbt, 200000);           // 240000 − 40000 interest
  assert.equal(r.tax, 50000);            // 25% of a positive PBT
  assert.equal(r.net_profit, 150000);
});

test('pnlStatement reports margins as fractions of revenue', () => {
  const r = pnlStatement({ revenue: 1000, direct: [{ amount: 400 }], indirect: [{ amount: 100 }] });
  assert.equal(r.gross_margin, 0.6);
  assert.equal(r.ebitda_margin, 0.5);
  assert.equal(r.net_margin, 0.5);       // no D&A, interest or tax configured
});

test('pnlStatement charges no tax on a loss and never divides by zero revenue', () => {
  const loss = pnlStatement({ revenue: 100, direct: [{ amount: 500 }], taxPct: 30 });
  assert.equal(loss.gross_profit, -400);
  assert.equal(loss.tax, 0);             // a loss-making month carries no tax
  assert.equal(loss.net_profit, -400);

  const empty = pnlStatement({ revenue: 0, indirect: [{ amount: 250 }] });
  assert.equal(empty.ebitda, -250);
  assert.equal(empty.ebitda_margin, 0);  // 0 rather than NaN/Infinity
});

test('pnlStatement tolerates missing arguments', () => {
  const r = pnlStatement();
  assert.equal(r.revenue, 0);
  assert.equal(r.net_profit, 0);
  assert.deepStrictEqual(r.direct_lines, []);
});

test('wageRow: partial-month monthly worker prorates gross and basic', () => {
  const w = { wage_type: 'MONTHLY', monthly_gross: 26000, basic: 13000, pf_applicable: 1, esi_applicable: 0 };
  const r = wageRow(w, 13, 0, 26); // half the standard days
  assert.equal(r.gross, 13000);
  assert.equal(r.pf, Math.round(13000 / 26 * 13 * 0.12)); // PF on prorated basic
});
