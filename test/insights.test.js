'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ins = require('../lib/insights');

const day = (d, qc) => ({ work_date: `2026-07-${String(d).padStart(2, '0')}`, qc_parts: qc, status: 'APPROVED' });

test('pctChange returns null without a baseline rather than 0 or Infinity', () => {
  assert.strictEqual(ins.pctChange(500, 0), null);
  assert.strictEqual(ins.pctChange(120, 100), 20);
  assert.strictEqual(ins.pctChange(80, 100), -20);
});

test('trend flags whether a move is good for the metric', () => {
  const up = ins.trend(120, 100, { goodWhen: 'up' });
  assert.strictEqual(up.dir, 'up');
  assert.strictEqual(up.good, true);

  // For defect rate, rising is bad.
  const ppm = ins.trend(700, 500, { goodWhen: 'down' });
  assert.strictEqual(ppm.dir, 'up');
  assert.strictEqual(ppm.good, false);

  const flat = ins.trend(100, 100);
  assert.strictEqual(flat.dir, 'flat');
  assert.strictEqual(flat.good, null);
});

test('streaks groups consecutive dates and splits on gaps', () => {
  const r = ins.streaks(['2026-07-03', '2026-07-04', '2026-07-05', '2026-07-09']);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], ['2026-07-03', '2026-07-04', '2026-07-05']);
  assert.deepStrictEqual(r[1], ['2026-07-09']);
});

test('streaks spans a month boundary', () => {
  const r = ins.streaks(['2026-07-31', '2026-08-01']);
  assert.strictEqual(r.length, 1); // one run, not two months
});

test('volatility is null for a series too short or flat to judge', () => {
  assert.strictEqual(ins.volatility([100]), null);
  assert.strictEqual(ins.volatility([0, 0]), null); // mean 0 — no division
  assert.strictEqual(ins.volatility([100, 100, 100]), 0);
});

test('extremes ignores zero-activity days', () => {
  const e = ins.extremes([day(1, 0), day(2, 900), day(3, 300)], 'qc_parts');
  assert.strictEqual(e.best.qc_parts, 900);
  assert.strictEqual(e.worst.qc_parts, 300); // not the 0 day
  assert.strictEqual(ins.extremes([day(1, 0)], 'qc_parts'), null);
});

test('MG shortfalls are reported as a run, not as separate findings', () => {
  const days = [day(3, 100), day(4, 100), day(5, 100), day(6, 900)];
  const found = ins.buildInsights({ days, mgTarget: 600 });
  const mg = found.find((i) => i.title === 'Minimum guarantee');
  assert.match(mg.text, /below the MG floor on 3 of 4/);
  assert.match(mg.text, /3-day run/);
  assert.strictEqual(mg.level, 'bad'); // only 25% met
});

test('meeting MG on every inspection day reads as good news', () => {
  const found = ins.buildInsights({ days: [day(1, 700), day(2, 800)], mgTarget: 600 });
  const mg = found.find((i) => i.title === 'Minimum guarantee');
  assert.strictEqual(mg.level, 'good');
  assert.match(mg.text, /met on all 2/);
});

test('buildInsights returns nothing for an empty period', () => {
  assert.deepStrictEqual(ins.buildInsights({ days: [] }), []);
});

test('every insight is tagged client or internal', () => {
  const found = ins.buildInsights({
    days: [day(1, 700), day(2, 100)], prevDays: [day(1, 300)], mgTarget: 600, ppmTarget: 500,
    qcQuality: { checked: 1000, rejected: 20, rework: 5, rejection_rate: 2, fpy: 97.5, ppm_derived: 20000 },
    discTot: { total: 3, open_c: 1, variance: 12 },
    utilization: 45, pendingApprovals: 2, overdueCapa: 1, expiringDocs: 4,
  });
  assert.ok(found.length > 5);
  assert.ok(found.every((i) => i.scope === 'client' || i.scope === 'internal'));
  assert.ok(found.every((i) => ['good', 'warn', 'bad', 'info'].includes(i.level)));
});

test('the JMC client never receives internal findings', () => {
  const found = ins.buildInsights({
    days: [day(1, 700)], mgTarget: 600,
    utilization: 45, pendingApprovals: 2, overdueCapa: 1, expiringDocs: 4,
  });
  assert.ok(found.some((i) => i.scope === 'internal'), 'fixture should contain internal findings');

  const client = ins.forRole(found, 'JMC_APPROVER');
  assert.ok(client.length, 'client still sees delivery findings');
  assert.ok(client.every((i) => i.scope === 'client'));
  // Drona roles keep everything.
  assert.strictEqual(ins.forRole(found, 'ADMIN').length, found.length);
  assert.strictEqual(ins.forRole(found, 'HQ').length, found.length);
});

test('no insight leaks a currency figure onto the client dashboard', () => {
  const found = ins.buildInsights({
    days: [day(1, 700), day(2, 100)], prevDays: [day(1, 300)], mgTarget: 600, ppmTarget: 500,
    qcQuality: { checked: 1000, rejected: 20, rework: 5, rejection_rate: 2, fpy: 97.5, ppm_derived: 20000 },
    discTot: { total: 3, open_c: 1, variance: 12 }, utilization: 95,
  });
  assert.ok(found.every((i) => !/[₹$]|\brupee|revenue|profit|margin|invoice/i.test(i.text)));
});
