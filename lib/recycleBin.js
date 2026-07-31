/**
 * Recycle bin for admin destructive actions.
 *
 * Deletes are REAL deletes — so every existing billing / report / MIS query
 * stays correct without a `deleted_at IS NULL` filter that someone could
 * forget. What makes them reversible is the pre-image written to
 * `record_snapshots` first.
 *
 * This module is the only place that knows table shapes. The serialise and
 * plan-building functions are pure so they can be tested without a database;
 * DB I/O lives in capture()/remove()/restore(), which all take the
 * transaction-bound handle from db.transaction so the snapshot and the
 * mutation commit or roll back together.
 */
'use strict';

const MIN_REASON = 5;

// `unique` lists the columns of a UNIQUE constraint a restore could collide
// with. Empty means the row can always be re-inserted.
const ENTITIES = {
  daily_entry: {
    table:    'daily_entries',
    children: ['manpower_actual', 'loading', 'unloading', 'qc', 'qc_lines',
               'transport_trips', 'attachments'],
    childKey: 'entry_id',
    unique:   ['work_date'],
    label:    (r) => String(r.work_date),
  },
  worker: {
    table:    'workers',
    children: ['worker_documents'],
    childKey: 'worker_id',
    // roll_no carries a UNIQUE index. It is nullable, and SQL NULL never
    // matches itself, so unnumbered workers still restore freely.
    unique:   ['roll_no'],
    label:    (r) => String(r.name || `Worker #${r.id}`),
  },
  attendance: {
    table:    'attendance',
    children: [],
    childKey: null,
    unique:   ['work_date', 'worker_id'],
    label:    (r) => `${r.work_date} · worker #${r.worker_id}`,
  },
  leave: {
    table:    'leave_applications',
    children: [],
    childKey: null,
    unique:   [],
    label:    (r) => `${r.from_date} → ${r.to_date} · worker #${r.worker_id}`,
  },
  discrepancy: {
    table:    'discrepancies',
    children: [],
    childKey: null,
    unique:   [],
    label:    (r) => `${r.disc_date} · ${r.type}`,
  },
  capa: {
    table:    'capa',
    children: [],
    childKey: null,
    unique:   [],
    label:    (r) => String(r.title || `CAPA #${r.id}`),
  },
};

function httpError(message, http) {
  return Object.assign(new Error(message), { http });
}

function getEntity(name) {
  const e = ENTITIES[name];
  if (!e) throw httpError(`Unknown entity: ${name}`, 422);
  return e;
}

function validateReason(reason) {
  const r = String(reason == null ? '' : reason).trim();
  if (r.length < MIN_REASON)
    throw httpError(`A reason of at least ${MIN_REASON} characters is required`, 400);
  return r;
}

/** Serialise a parent row plus its child rows into a storable payload. */
function buildPayload({ entity, parent, children = {}, extra = {} }) {
  const def = getEntity(entity);
  return { entity, label: def.label(parent), parent, children, extra };
}

// Postgres timestamp columns arrive from Prisma as Date objects, and
// JSON.stringify flattens them to ISO strings when the snapshot is stored.
// Postgres will NOT implicitly cast text -> timestamp on the way back in
// (SQLSTATE 42804), so revive them before the re-insert binds parameters.
// Plain 'YYYY-MM-DD' values are left alone — those columns really are text.
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function reviveTimestamps(row) {
  const out = {};
  for (const [k, v] of Object.entries(row))
    out[k] = (typeof v === 'string' && ISO_DATETIME.test(v)) ? new Date(v) : v;
  return out;
}

/**
 * Turn a stored snapshot into an executable restore plan.
 *   DELETE      -> INSERT a fresh row (ids regenerate, FKs rewritten on insert)
 *   EDIT_BEFORE -> OVERWRITE the still-existing row in place, keeping its id
 */
function buildRestorePlan({ entity, kind, payload }) {
  const def = getEntity(entity);
  const overwrite = kind === 'EDIT_BEFORE';
  const parent = reviveTimestamps(payload.parent);
  const id = parent.id;
  if (!overwrite) delete parent.id;

  const children = def.children
    .map((table) => ({
      table,
      rows: ((payload.children || {})[table] || []).map((row) => {
        const copy = reviveTimestamps(row);
        delete copy.id;                                 // regenerate — the old id may be taken
        if (def.childKey) delete copy[def.childKey];    // rewritten to the new parent id
        return copy;
      }),
    }));
  // Every child table stays in the plan even when the snapshot holds no rows
  // for it. An OVERWRITE restore clears each listed table before re-inserting,
  // so dropping the empty ones here would leave rows added after the snapshot
  // in place — the restore would not match the pre-image. The insert loop is a
  // no-op for an empty `rows`, so keeping them costs nothing.

  // Overwriting a row in place cannot collide with itself.
  const conflict = (!overwrite && def.unique.length)
    ? Object.fromEntries(def.unique.map((col) => [col, payload.parent[col]]))
    : null;

  return {
    mode: overwrite ? 'OVERWRITE' : 'INSERT',
    entity, table: def.table, childKey: def.childKey,
    id, parent, children, conflict, extra: payload.extra || {},
  };
}

// ---- DB I/O ---------------------------------------------------------------
// Every function takes `tx` (the transaction-bound handle from db.transaction).
// This module deliberately does not require ./rawdb, so it stays free of
// DB-connection side effects at import time — which is what lets the unit
// tests run without a database.

const cols = (row) => Object.keys(row);
const marks = (row) => cols(row).map(() => '?').join(',');
const quoted = (row) => cols(row).map((c) => `"${c}"`).join(',');

/** Read a row and its children, and write a snapshot. Does NOT mutate. */
async function capture(tx, { entity, id, kind, reason, userId }) {
  const def = getEntity(entity);
  const cleanReason = validateReason(reason);

  const parent = await tx.prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(Number(id));
  if (!parent) throw httpError(`${entity} #${id} not found`, 404);

  const children = {};
  for (const table of def.children) {
    children[table] = await tx.prepare(
      `SELECT * FROM ${table} WHERE ${def.childKey} = ?`).all(parent.id);
  }

  // discrepancies.qc_entry_id points at a daily entry but is NOT part of the
  // cascade, so record which rows we are about to orphan and can re-link.
  const extra = {};
  if (entity === 'daily_entry') {
    const linked = await tx.prepare(
      'SELECT id FROM discrepancies WHERE qc_entry_id = ?').all(parent.id);
    extra.discrepancy_ids = linked.map((d) => d.id);
  }

  const payload = buildPayload({ entity, parent, children, extra });
  const row = await tx.prepare(
    `INSERT INTO record_snapshots (entity, kind, label, payload, reason, taken_by)
     VALUES (?,?,?,CAST(? AS JSONB),?,?) RETURNING id`)
    .get(entity, kind, payload.label, JSON.stringify(payload), cleanReason, userId || null);

  return { snapshotId: row.id, label: payload.label };
}

/** Snapshot then hard-delete. Children go via ON DELETE CASCADE. */
async function remove(tx, { entity, id, reason, userId }) {
  const def = getEntity(entity);
  const result = await capture(tx, { entity, id, kind: 'DELETE', reason, userId });

  if (entity === 'daily_entry') {
    await tx.prepare(
      'UPDATE discrepancies SET qc_entry_id = NULL WHERE qc_entry_id = ?').run(Number(id));
  }
  await tx.prepare(`DELETE FROM ${def.table} WHERE id = ?`).run(Number(id));
  return result;
}

/** Re-insert (DELETE) or overwrite in place (EDIT_BEFORE) from a snapshot. */
async function restore(tx, snapshotId, userId) {
  const snap = await tx.prepare(
    'SELECT * FROM record_snapshots WHERE id = ?').get(Number(snapshotId));
  if (!snap) throw httpError(`Snapshot #${snapshotId} not found`, 404);
  if (snap.restored_at) throw httpError('This snapshot has already been restored', 409);

  const payload = typeof snap.payload === 'string' ? JSON.parse(snap.payload) : snap.payload;
  const plan = buildRestorePlan({ entity: snap.entity, kind: snap.kind, payload });

  let parentId = plan.id;

  if (plan.mode === 'INSERT') {
    if (plan.conflict) {
      const where = Object.keys(plan.conflict).map((c) => `"${c}" = ?`).join(' AND ');
      const clash = await tx.prepare(`SELECT id FROM ${plan.table} WHERE ${where}`)
        .get(...Object.values(plan.conflict));
      if (clash)
        throw httpError(
          `${snap.label} already exists. Delete that record first, then restore.`, 409);
    }
    const ins = await tx.prepare(
      `INSERT INTO ${plan.table} (${quoted(plan.parent)}) VALUES (${marks(plan.parent)})
       RETURNING id`).get(...Object.values(plan.parent));
    parentId = ins.id;
  } else {
    // Undo must itself be undoable: capture where the record stands right now
    // before we overwrite it with the older pre-image.
    await capture(tx, { entity: snap.entity, id: plan.id, kind: 'EDIT_BEFORE',
      reason: `State before restoring snapshot #${snap.id}`, userId });

    const sets = cols(plan.parent).filter((c) => c !== 'id');
    await tx.prepare(
      `UPDATE ${plan.table} SET ${sets.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`)
      .run(...sets.map((c) => plan.parent[c]), plan.id);
    // Child rows are replaced wholesale — the payload is the whole truth.
    for (const c of plan.children)
      await tx.prepare(`DELETE FROM ${c.table} WHERE ${plan.childKey} = ?`).run(plan.id);
  }

  for (const c of plan.children) {
    for (const row of c.rows) {
      const full = { [plan.childKey]: parentId, ...row };
      await tx.prepare(
        `INSERT INTO ${c.table} (${quoted(full)}) VALUES (${marks(full)})`)
        .run(...Object.values(full));
    }
  }

  for (const dId of (plan.extra.discrepancy_ids || []))
    await tx.prepare('UPDATE discrepancies SET qc_entry_id = ? WHERE id = ?').run(parentId, dId);

  await tx.prepare(
    'UPDATE record_snapshots SET restored_at = now(), restored_by = ? WHERE id = ?')
    .run(userId || null, snap.id);

  return { entity: snap.entity, label: snap.label };
}

module.exports = { ENTITIES, MIN_REASON, getEntity, validateReason,
                   buildPayload, buildRestorePlan, capture, remove, restore };
