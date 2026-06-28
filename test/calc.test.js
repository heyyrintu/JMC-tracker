'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { qcBilled, gst, wageRow } = require('../calc');

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

test('wageRow: partial-month monthly worker prorates gross and basic', () => {
  const w = { wage_type: 'MONTHLY', monthly_gross: 26000, basic: 13000, pf_applicable: 1, esi_applicable: 0 };
  const r = wageRow(w, 13, 0, 26); // half the standard days
  assert.equal(r.gross, 13000);
  assert.equal(r.pf, Math.round(13000 / 26 * 13 * 0.12)); // PF on prorated basic
});
