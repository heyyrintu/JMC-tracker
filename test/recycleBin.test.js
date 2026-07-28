'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rb = require('../lib/recycleBin');

const DAY = { id: 7, work_date: '2026-07-14', status: 'APPROVED', notes: 'x' };
const KIDS = {
  qc_lines: [{ id: 41, entry_id: 7, part_no: 'P-1', checked_qty: 10 }],
  attachments: [{ id: 9, entry_id: 7, filename: 'att_7_123_ab.jpg', caption: null }],
};

test('getEntity rejects an unknown entity with 422', () => {
  assert.throws(() => rb.getEntity('nope'), (e) => e.http === 422);
});

test('getEntity returns the daily_entry definition', () => {
  const e = rb.getEntity('daily_entry');
  assert.strictEqual(e.table, 'daily_entries');
  assert.strictEqual(e.childKey, 'entry_id');
  assert.deepStrictEqual(e.unique, ['work_date']);
});

test('attendance declares its composite unique key', () => {
  assert.deepStrictEqual(rb.getEntity('attendance').unique, ['work_date', 'worker_id']);
});

test('validateReason trims and rejects short reasons', () => {
  assert.throws(() => rb.validateReason('  ok  '), (e) => e.http === 400);
  assert.throws(() => rb.validateReason(null), (e) => e.http === 400);
  assert.strictEqual(rb.validateReason('  wrong tonnage  '), 'wrong tonnage');
});

test('buildPayload captures parent, children and label', () => {
  const p = rb.buildPayload({ entity: 'daily_entry', parent: DAY, children: KIDS });
  assert.strictEqual(p.entity, 'daily_entry');
  assert.strictEqual(p.label, '2026-07-14');
  assert.deepStrictEqual(p.parent, DAY);
  assert.strictEqual(p.children.qc_lines.length, 1);
  assert.deepStrictEqual(p.extra, {});
});

test('buildPayload carries extra relink data', () => {
  const p = rb.buildPayload({
    entity: 'daily_entry', parent: DAY, children: KIDS,
    extra: { discrepancy_ids: [3, 4] },
  });
  assert.deepStrictEqual(p.extra.discrepancy_ids, [3, 4]);
});

test('DELETE plan inserts fresh: parent id stripped, child ids and FK stripped', () => {
  const payload = rb.buildPayload({ entity: 'daily_entry', parent: DAY, children: KIDS });
  const plan = rb.buildRestorePlan({ entity: 'daily_entry', kind: 'DELETE', payload });
  assert.strictEqual(plan.mode, 'INSERT');
  assert.strictEqual(plan.table, 'daily_entries');
  assert.ok(!('id' in plan.parent), 'parent id must be stripped so it regenerates');
  assert.strictEqual(plan.parent.work_date, '2026-07-14');
  const line = plan.children.find((c) => c.table === 'qc_lines').rows[0];
  assert.ok(!('id' in line));
  assert.ok(!('entry_id' in line), 'FK is rewritten to the new parent id at insert time');
});

test('DELETE plan preserves attachments.filename verbatim', () => {
  const payload = rb.buildPayload({ entity: 'daily_entry', parent: DAY, children: KIDS });
  const plan = rb.buildRestorePlan({ entity: 'daily_entry', kind: 'DELETE', payload });
  const att = plan.children.find((c) => c.table === 'attachments').rows[0];
  assert.strictEqual(att.filename, 'att_7_123_ab.jpg');
});

test('DELETE plan reports the unique key to check before inserting', () => {
  const payload = rb.buildPayload({ entity: 'daily_entry', parent: DAY, children: KIDS });
  const plan = rb.buildRestorePlan({ entity: 'daily_entry', kind: 'DELETE', payload });
  assert.deepStrictEqual(plan.conflict, { work_date: '2026-07-14' });
});

test('EDIT_BEFORE plan overwrites in place and keeps the original id', () => {
  const payload = rb.buildPayload({ entity: 'daily_entry', parent: DAY, children: KIDS });
  const plan = rb.buildRestorePlan({ entity: 'daily_entry', kind: 'EDIT_BEFORE', payload });
  assert.strictEqual(plan.mode, 'OVERWRITE');
  assert.strictEqual(plan.id, 7);
  assert.strictEqual(plan.conflict, null, 'overwriting its own row cannot self-conflict');
});

test('entities without children produce an empty children list', () => {
  const plan = rb.buildRestorePlan({
    entity: 'capa',
    kind: 'DELETE',
    payload: rb.buildPayload({ entity: 'capa', parent: { id: 1, title: 'Fix QR' }, children: {} }),
  });
  assert.deepStrictEqual(plan.children, []);
  assert.strictEqual(plan.conflict, null);
});
