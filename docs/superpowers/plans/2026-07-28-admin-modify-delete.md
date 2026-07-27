# Admin Modify / Delete of Entered Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an ADMIN correct or remove already-entered data — daily entry days, workers, attendance, leave, discrepancies, CAPA — with every destructive action snapshotted first so it can be restored.

**Architecture:** Snapshot-then-hard-delete. Before any admin delete or override-edit, the row plus all its child rows are serialised into a new `record_snapshots` table; the original is then genuinely deleted (or overwritten). Because deleted rows are truly gone, the ~30 existing billing / report / MIS queries stay correct without being touched. Restore re-inserts from the snapshot. All table-shape knowledge lives in one registry in `lib/recycleBin.js`.

**Tech Stack:** Node 18+, Express, Postgres via Prisma (`lib/rawdb.js` is a raw-SQL shim that rewrites `?` → `$n`), vanilla-JS SPA in `public/app.js`, `node:test` for tests.

**Spec:** `docs/superpowers/specs/2026-07-28-admin-modify-delete-design.md`

## Global Constraints

- **Postgres is the source of truth.** `db.js` holds a legacy SQLite schema — do **not** add the new table there. Schema changes go in `prisma/schema.prisma` plus a migration under `prisma/migrations/`.
- **All new routes** require `auth` then `requireRole('ADMIN')`.
- **`reason` is mandatory** on every destructive action: minimum **5 characters after trimming**, else HTTP `400`.
- **Raw SQL only**, via `db.prepare(sql).get/all/run` — all async, `?` placeholders. Never call Prisma model methods; the codebase does not use them.
- **Attachment and document files in `uploads/` are never unlinked** by a delete. Only DB rows go.
- **Bulk transactions** pass `{ timeout: 120000, maxWait: 15000 }` as the second argument to `db.transaction`, matching `server.js:565`.
- **Frontend escaping:** every interpolated value goes through `esc()` (`public/app.js:9`).
- Existing HTTP error convention: throw `Object.assign(new Error(msg), { http: 409 })` and let the route map `err.http || 500`.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | **Modify** — add `RecordSnapshot` model |
| `prisma/migrations/20260728120000_record_snapshots/migration.sql` | **Create** — the table |
| `lib/recycleBin.js` | **Create** — entity registry + pure snapshot/restore-plan functions + DB wrappers |
| `test/recycleBin.test.js` | **Create** — unit tests for the pure functions |
| `server.js` | **Modify** — three admin routes; admin override in `POST /api/entries` |
| `public/app.js` | **Modify** — `ROUTES.archive` (Data Admin view), nav registration, inline delete buttons |

---

### Task 1: Database table

**Files:**
- Modify: `prisma/schema.prisma` (append at end of file)
- Create: `prisma/migrations/20260728120000_record_snapshots/migration.sql`

**Interfaces:**
- Consumes: nothing
- Produces: table `record_snapshots` with columns `id, entity, kind, label, payload, reason, taken_by, taken_at, restored_at, restored_by`

- [ ] **Step 1: Add the Prisma model**

Append to `prisma/schema.prisma`, following the `DeviceToken` model's style (PascalCase model, `@map` to snake_case columns, `@@map` to the table):

```prisma
// Pre-image of a record an ADMIN deleted or override-edited. Deletes are real
// deletes, so every existing report/billing query stays correct untouched; this
// table is what makes them reversible. `payload` holds the parent row plus all
// child rows. Restored rows keep their snapshot with `restored_at` set, so the
// archive reads as a two-way history rather than a queue that empties.
model RecordSnapshot {
  id         Int       @id @default(autoincrement())
  entity     String    // daily_entry | worker | attendance | leave | discrepancy | capa
  kind       String    // DELETE | EDIT_BEFORE
  label      String    // human handle, e.g. '2026-07-14'
  payload    Json
  reason     String
  takenBy    Int?      @map("taken_by")
  takenAt    DateTime  @default(now()) @map("taken_at")
  restoredAt DateTime? @map("restored_at")
  restoredBy Int?      @map("restored_by")

  @@index([entity, takenAt], map: "idx_record_snapshots_entity")
  @@map("record_snapshots")
}
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260728120000_record_snapshots/migration.sql`:

```sql
-- CreateTable
CREATE TABLE "record_snapshots" (
    "id" SERIAL NOT NULL,
    "entity" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "taken_by" INTEGER,
    "taken_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restored_at" TIMESTAMP(3),
    "restored_by" INTEGER,

    CONSTRAINT "record_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_record_snapshots_entity" ON "record_snapshots"("entity", "taken_at");
```

No foreign keys on `taken_by` / `restored_by`: a snapshot must survive even if the acting user row is later changed, and the app renders names via `LEFT JOIN`.

- [ ] **Step 3: Apply the migration**

Run: `npx prisma migrate deploy`
Expected: `1 migration found` … `Applied`. If the local `DATABASE_URL` is unreachable, run `npx prisma generate` and note that `migrate deploy` must run on the target environment before this feature works.

- [ ] **Step 4: Verify the table exists**

Run: `node -e "const{prisma}=require('./lib/prisma');prisma.$queryRawUnsafe('SELECT * FROM record_snapshots LIMIT 1').then(r=>{console.log('OK',r);process.exit(0)}).catch(e=>{console.error(e.message);process.exit(1)})"`
Expected: `OK []`

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260728120000_record_snapshots/migration.sql
git commit -m "feat(db): add record_snapshots table for admin delete/edit recovery"
```

---

### Task 2: Entity registry and pure functions

**Files:**
- Create: `lib/recycleBin.js`
- Test: `test/recycleBin.test.js`

**Interfaces:**
- Consumes: nothing (pure module, no DB import yet)
- Produces:
  - `ENTITIES` — object keyed by entity name
  - `getEntity(name) -> entityDef` (throws `{http:422}` if unknown)
  - `validateReason(reason) -> string` (throws `{http:400}` if < 5 chars trimmed)
  - `buildPayload({ entity, parent, children, extra }) -> payloadObject`
  - `buildRestorePlan({ entity, kind, payload }) -> plan`
  - `MIN_REASON = 5`

- [ ] **Step 1: Write the failing tests**

Create `test/recycleBin.test.js`:

```js
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
  const p = rb.buildPayload({ entity: 'daily_entry', parent: DAY, children: KIDS,
                              extra: { discrepancy_ids: [3, 4] } });
  assert.deepStrictEqual(p.extra.discrepancy_ids, [3, 4]);
});

test('DELETE plan inserts fresh: parent id stripped, child ids and FK stripped', () => {
  const payload = rb.buildPayload({ entity: 'daily_entry', parent: DAY, children: KIDS });
  const plan = rb.buildRestorePlan({ entity: 'daily_entry', kind: 'DELETE', payload });
  assert.strictEqual(plan.mode, 'INSERT');
  assert.strictEqual(plan.table, 'daily_entries');
  assert.ok(!('id' in plan.parent), 'parent id must be stripped so it regenerates');
  assert.strictEqual(plan.parent.work_date, '2026-07-14');
  const line = plan.children.find(c => c.table === 'qc_lines').rows[0];
  assert.ok(!('id' in line));
  assert.ok(!('entry_id' in line), 'FK is rewritten to the new parent id at insert time');
});

test('DELETE plan preserves attachments.filename verbatim', () => {
  const payload = rb.buildPayload({ entity: 'daily_entry', parent: DAY, children: KIDS });
  const plan = rb.buildRestorePlan({ entity: 'daily_entry', kind: 'DELETE', payload });
  const att = plan.children.find(c => c.table === 'attachments').rows[0];
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
    entity: 'capa', kind: 'DELETE',
    payload: rb.buildPayload({ entity: 'capa', parent: { id: 1, title: 'Fix QR' }, children: {} }),
  });
  assert.deepStrictEqual(plan.children, []);
  assert.strictEqual(plan.conflict, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/recycleBin.test.js`
Expected: FAIL — `Cannot find module '../lib/recycleBin'`

- [ ] **Step 3: Write the implementation**

Create `lib/recycleBin.js`:

```js
/**
 * Recycle bin for admin destructive actions.
 *
 * Deletes are REAL deletes — so every existing billing / report / MIS query
 * stays correct without a `deleted_at IS NULL` filter that someone could
 * forget. What makes them reversible is the pre-image written to
 * `record_snapshots` first.
 *
 * This module is the only place that knows table shapes. The serialise and
 * plan-building functions below are pure so they can be tested without a
 * database; DB I/O lives in capture()/restore() (added in a later task).
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
    unique:   [],
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

/**
 * Turn a stored snapshot into an executable restore plan.
 *   DELETE      -> INSERT a fresh row (ids regenerate, FKs rewritten on insert)
 *   EDIT_BEFORE -> OVERWRITE the still-existing row in place, keeping its id
 */
function buildRestorePlan({ entity, kind, payload }) {
  const def = getEntity(entity);
  const overwrite = kind === 'EDIT_BEFORE';
  const parent = { ...payload.parent };
  const id = parent.id;
  if (!overwrite) delete parent.id;

  const children = def.children
    .map((table) => ({
      table,
      rows: (payload.children[table] || []).map((row) => {
        const copy = { ...row };
        delete copy.id;                       // regenerate — the old id may be taken
        if (def.childKey) delete copy[def.childKey];  // rewritten to the new parent id
        return copy;
      }),
    }))
    .filter((c) => c.rows.length);

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

module.exports = { ENTITIES, MIN_REASON, getEntity, validateReason, buildPayload, buildRestorePlan };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/recycleBin.test.js`
Expected: all 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add lib/recycleBin.js test/recycleBin.test.js
git commit -m "feat(lib): add recycleBin entity registry and snapshot/restore planning"
```

---

### Task 3: Database wrappers — capture and restore

**Files:**
- Modify: `lib/recycleBin.js` (append; add `require` at top)

**Interfaces:**
- Consumes: `buildPayload`, `buildRestorePlan`, `getEntity`, `validateReason` from Task 2
- Produces:
  - `async capture(tx, { entity, id, kind, reason, userId }) -> { snapshotId, label }`
  - `async remove(tx, { entity, id, reason, userId }) -> { snapshotId, label }`
  - `async restore(tx, snapshotId, userId) -> { entity, label }`

- [ ] **Step 1: No new imports**

`lib/recycleBin.js` deliberately does **not** require `./rawdb`. Every function
below receives the transaction-bound handle (`tx`) from the caller, so this
module stays free of DB-connection side effects at import time — which is what
lets `test/recycleBin.test.js` run without a database.

- [ ] **Step 2: Append the wrappers**

Insert before `module.exports` in `lib/recycleBin.js`:

```js
// ---- DB I/O ---------------------------------------------------------------
// Every function takes a `tx` (the transaction-bound handle from
// db.transaction) so capture + mutate commit or roll back together.

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
```

- [ ] **Step 3: Extend the exports**

Replace the `module.exports` line with:

```js
module.exports = { ENTITIES, MIN_REASON, getEntity, validateReason,
                   buildPayload, buildRestorePlan, capture, remove, restore };
```

- [ ] **Step 4: Verify the pure tests still pass**

Run: `node --test test/recycleBin.test.js`
Expected: all 11 tests still PASS. They must keep passing with no database running — if that ever stops being true, something has introduced a connection-time import into this module.

- [ ] **Step 5: Commit**

```bash
git add lib/recycleBin.js
git commit -m "feat(lib): add capture/remove/restore DB wrappers to recycleBin"
```

---

### Task 4: Admin routes

**Files:**
- Modify: `server.js` — insert after the attachments block, before `// ---- Discrepancies` (around line 601)

**Interfaces:**
- Consumes: `capture`, `remove`, `restore`, `validateReason`, `getEntity` from Task 3
- Produces:
  - `DELETE /api/admin/:entity` body `{ ids: number[], reason }` → `{ deleted: [{id,label,snapshotId}], failed: [{id,error}] }`
  - `GET /api/admin/snapshots?entity=&kind=&limit=` → `{ snapshots: [...] }`
  - `POST /api/admin/snapshots/:id/restore` → `{ ok: true, entity, label }`

- [ ] **Step 1: Add the require**

At the top of `server.js`, beside the other `lib/` requires:

```js
const recycleBin = require('./lib/recycleBin');
```

- [ ] **Step 2: Add the three routes**

```js
// ---- Admin data management (modify / delete with recovery) -----------------
// Deletes are real deletes so every billing/report query stays correct; what
// makes them reversible is the snapshot written first. See lib/recycleBin.js.

app.delete('/api/admin/:entity', auth, requireRole('ADMIN'), async (req, res) => {
  const { entity } = req.params;
  const { ids, reason } = req.body || {};
  try {
    recycleBin.getEntity(entity);
    recycleBin.validateReason(reason);
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ error: 'ids must be a non-empty array' });

    const run = db.transaction(async (tx) => {
      const deleted = [], failed = [];
      for (const id of ids) {
        try {
          const r = await recycleBin.remove(tx, { entity, id, reason, userId: req.user.id });
          deleted.push({ id: Number(id), label: r.label, snapshotId: r.snapshotId });
        } catch (e) {
          failed.push({ id: Number(id), error: e.message });
        }
      }
      return { deleted, failed };
    }, { timeout: 120000, maxWait: 15000 });

    const r = await run();
    audit(req.user.id, 'ADMIN_DELETE',
      { entity, count: r.deleted.length, labels: r.deleted.map((d) => d.label), reason });
    res.json(r);
  } catch (err) {
    res.status(err.http || 500).json({ error: err.message });
  }
});

app.get('/api/admin/snapshots', auth, requireRole('ADMIN'), async (req, res) => {
  const { entity, kind } = req.query;
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  let sql = `SELECT s.id, s.entity, s.kind, s.label, s.reason, s.taken_at, s.restored_at,
                    tu.name AS taken_by_name, ru.name AS restored_by_name
             FROM record_snapshots s
             LEFT JOIN users tu ON tu.id = s.taken_by
             LEFT JOIN users ru ON ru.id = s.restored_by
             WHERE 1=1`;
  const args = [];
  if (entity) { sql += ' AND s.entity = ?'; args.push(entity); }
  if (kind)   { sql += ' AND s.kind = ?';   args.push(kind); }
  sql += ' ORDER BY s.taken_at DESC LIMIT ?';
  args.push(limit);
  res.json({ snapshots: await db.prepare(sql).all(...args) });
});

app.post('/api/admin/snapshots/:id/restore', auth, requireRole('ADMIN'), async (req, res) => {
  const run = db.transaction(
    async (tx) => recycleBin.restore(tx, Number(req.params.id), req.user.id),
    { timeout: 120000, maxWait: 15000 });
  try {
    const r = await run();
    audit(req.user.id, 'ADMIN_RESTORE', { entity: r.entity, label: r.label });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(err.http || 500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Start the server and check it boots**

Run: `npm start`
Expected: server listens with no syntax or require errors. Stop it with Ctrl-C.

- [ ] **Step 4: Smoke-test the listing route**

With the server running and logged in as `admin` in a browser, open the devtools console and run:

```js
await (await fetch('/api/admin/snapshots')).json()
```

Expected: `{ snapshots: [] }`. As a non-admin user, expect HTTP `403`.

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(api): admin delete, snapshot listing and restore routes"
```

---

### Task 5: Admin edit override

**Files:**
- Modify: `server.js:447-498` — the `POST /api/entries` handler

**Interfaces:**
- Consumes: `recycleBin.capture`, `recycleBin.validateReason`
- Produces: `POST /api/entries` accepts `admin_override: boolean`, `reason: string`, `keep_approval: boolean`

- [ ] **Step 1: Replace the lock check**

In `POST /api/entries`, the `else` branch currently reads:

```js
    } else {
      if (!isEditable(entry.status))
        throw Object.assign(new Error('Entry is locked (already submitted/approved)'), { http: 409 });
      entryId = entry.id;
```

Replace with:

```js
    } else {
      // ADMIN may edit a locked day, but only deliberately: an explicit
      // override flag plus a reason, with a pre-image snapshot taken first so
      // the edit is as recoverable as a delete.
      const override = b.admin_override === true && req.user.role === 'ADMIN';
      if (!isEditable(entry.status) && !override)
        throw Object.assign(new Error('Entry is locked (already submitted/approved)'), { http: 409 });
      entryId = entry.id;
      if (override) {
        recycleBin.validateReason(b.reason);
        await recycleBin.capture(tx, { entity: 'daily_entry', id: entryId,
          kind: 'EDIT_BEFORE', reason: b.reason, userId: req.user.id });
      }
```

- [ ] **Step 2: Make the status update respect the approval choice**

The line immediately below currently forces `status='DRAFT'`:

```js
      await tx.prepare(`UPDATE daily_entries SET shift=?, notes=?, ppm=?, status='DRAFT', updated_at=now() WHERE id=?`)
        .run(b.shift || 'DAY', b.notes || null, ppmVal, entryId);
```

Replace with:

```js
      // A normal edit reopens the day as DRAFT. An admin override defaults to
      // sending it back to JMC (keep_approval must be opted into explicitly),
      // so JMC is never billed for numbers they did not sign off on.
      if (override && b.keep_approval === true) {
        await tx.prepare(`UPDATE daily_entries SET shift=?, notes=?, ppm=?, updated_at=now() WHERE id=?`)
          .run(b.shift || 'DAY', b.notes || null, ppmVal, entryId);
      } else if (override) {
        const note = `[Admin edit ${new Date().toISOString().slice(0, 10)}] ${String(b.reason).trim()}`;
        await tx.prepare(`UPDATE daily_entries SET shift=?, notes=?, ppm=?, status='SUBMITTED',
                          approved_by=NULL, approved_at=NULL, submitted_at=now(),
                          jmc_remarks=?, updated_at=now() WHERE id=?`)
          .run(b.shift || 'DAY', b.notes || null, ppmVal, note, entryId);
      } else {
        await tx.prepare(`UPDATE daily_entries SET shift=?, notes=?, ppm=?, status='DRAFT', updated_at=now() WHERE id=?`)
          .run(b.shift || 'DAY', b.notes || null, ppmVal, entryId);
      }
```

- [ ] **Step 3: Audit the override distinctly**

Replace the existing audit call in the route's `try` block:

```js
    audit(req.user.id, b.submit ? 'ENTRY_SUBMIT' : 'ENTRY_SAVE', { date: b.work_date });
```

with:

```js
    if (b.admin_override === true && req.user.role === 'ADMIN') {
      audit(req.user.id, 'ENTRY_ADMIN_EDIT',
        { date: b.work_date, reason: String(b.reason).trim(), keep_approval: b.keep_approval === true });
    } else {
      audit(req.user.id, b.submit ? 'ENTRY_SUBMIT' : 'ENTRY_SAVE', { date: b.work_date });
    }
```

- [ ] **Step 4: Verify both paths by hand**

Start the server, log in as `admin`, and in the devtools console:

```js
// 1. Without the override an approved day must still be refused:
await (await fetch('/api/entries', {method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ work_date:'<an APPROVED date>', shift:'DAY' })})).json()
// Expected: { error: 'Entry is locked (already submitted/approved)' }

// 2. A short reason must be refused:
await (await fetch('/api/entries', {method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ work_date:'<same date>', admin_override:true, reason:'no' })})).json()
// Expected: { error: 'A reason of at least 5 characters is required' }

// 3. A valid override must succeed and reset the status:
await (await fetch('/api/entries', {method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ work_date:'<same date>', admin_override:true,
                         reason:'corrected tonnage' })})).json()
// Expected: entry.status === 'SUBMITTED', approved_by === null
```

Then confirm a snapshot was written: `await (await fetch('/api/admin/snapshots?kind=EDIT_BEFORE')).json()`

- [ ] **Step 5: Commit**

```bash
git add server.js
git commit -m "feat(api): admin override edit for locked days with pre-image snapshot"
```

---

### Task 6: Data Admin view — Days tab

**Files:**
- Modify: `public/app.js:100-116` (nav registration), and append `ROUTES.archive` near `ROUTES.audit` (~line 1302)

**Interfaces:**
- Consumes: `DELETE /api/admin/:entity`, `GET /api/summary`
- Produces: `ROUTES.archive`, nav key `archive`

- [ ] **Step 1: Register the nav entry**

In `ROLE_NAV`, append `'archive'` to the ADMIN list only:

```js
  ADMIN:        ['dashboard','entry','workers','onboarding','attendance','leave','compliance','approvals','discrepancies','capa','requests','reports','mis','billing','settings','users','audit','archive'],
```

In `NAV_META`, add beneath the `audit` entry:

```js
  archive:{ic:'🗃',label:'Data Admin'},
```

- [ ] **Step 2: Add the view**

Append after `ROUTES.audit` in `public/app.js`:

```js
// ===========================================================================
// DATA ADMIN (admin-only): correct or remove entered data, and restore it.
// ===========================================================================
ROUTES.archive = async function () {
  const v = $('#view');
  let tab = 'DAYS';
  let month = new Date().toISOString().slice(0, 7);

  const shell = () => topbar('Data Admin',
      'Correct or remove entered data. Everything deleted here can be restored.') +
    `<div class="card"><div class="row" style="gap:8px">
       <button class="btn ${tab==='DAYS'?'primary':'ghost'}" data-tab="DAYS">Days</button>
       <button class="btn ${tab==='BIN'?'primary':'ghost'}" data-tab="BIN">Recycle Bin</button>
     </div></div><div id="daBody"><div class="empty">Loading…</div></div>`;

  function mount() {
    v.innerHTML = shell();
    v.querySelectorAll('[data-tab]').forEach(b =>
      b.addEventListener('click', () => { tab = b.dataset.tab; mount(); }));
    (tab === 'DAYS' ? renderDays : renderBin)();
  }

  async function renderDays() {
    const body = $('#daBody');
    body.innerHTML = `<div class="card">
      <div class="row" style="gap:8px;align-items:end">
        <div class="field"><label>Month</label>
          <input type="month" id="daMonth" value="${esc(month)}"></div>
        <button class="btn danger" id="daDel" disabled>Delete selected</button>
      </div>
      <div id="daDays" class="empty" style="margin-top:8px">Loading…</div></div>`;
    $('#daMonth').addEventListener('change', (e) => { month = e.target.value; renderDays(); });

    let days = [];
    try {
      days = (await api('/summary?month=' + encodeURIComponent(month))).days || [];
    } catch (e) { $('#daDays').textContent = e.message; return; }
    if (!days.length) { $('#daDays').textContent = 'No days recorded in this month.'; return; }

    $('#daDays').outerHTML = `<div class="tscroll" style="margin-top:8px"><table><thead><tr>
      <th></th><th>Date</th><th>Status</th><th>Load</th><th>Unload (t)</th><th>QC</th><th></th>
      </tr></thead><tbody>${days.map(d => `<tr>
        <td><input type="checkbox" class="daPick" value="${d.id}"
             data-status="${esc(d.status)}" data-date="${esc(d.work_date)}"></td>
        <td>${esc(d.work_date)}</td>
        <td><span class="tag">${esc(d.status)}</span></td>
        <td>${fmt(d.load_parts)}</td><td>${fmt(d.unload_ton)}</td><td>${fmt(d.qc_parts)}</td>
        <td><button class="btn ghost sm" data-edit="${esc(d.work_date)}">Edit</button></td>
      </tr>`).join('')}</tbody></table></div>`;

    const picks = () => [...v.querySelectorAll('.daPick:checked')];
    v.querySelectorAll('.daPick').forEach(c => c.addEventListener('change', () => {
      $('#daDel').disabled = !picks().length;
    }));
    v.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
      location.hash = '#entry?date=' + encodeURIComponent(b.dataset.edit);
    }));

    $('#daDel').addEventListener('click', async () => {
      const sel = picks();
      const approved = sel.filter(c => c.dataset.status === 'APPROVED').length;
      const warn = approved
        ? `\n\n${approved} of ${sel.length} selected days are approved by JMC. ` +
          `Deleting them will change the ${month} invoice.`
        : '';
      const reason = prompt(
        `Delete ${sel.length} day(s)?${warn}\n\nReason (min 5 characters) — required:`);
      if (reason === null) return;
      try {
        const r = await api('/admin/daily_entry', {
          method: 'DELETE', body: { ids: sel.map(c => Number(c.value)), reason },
        });
        toast(`Deleted ${r.deleted.length} day(s)` +
              (r.failed.length ? `, ${r.failed.length} failed` : ''),
              r.failed.length ? 'warn' : 'ok');
        renderDays();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  async function renderBin() { $('#daBody').innerHTML = '<div class="card empty">—</div>'; }

  mount();
};
```

`renderBin` is a stub here and is filled in by Task 7.

- [ ] **Step 3: Verify the Days tab**

Start the server, log in as `admin`, click **Data Admin** in the sidebar.
Expected: the Days tab lists the current month's days with checkboxes; **Delete selected** is disabled until something is ticked; ticking an `APPROVED` day and clicking it shows the invoice warning in the prompt.

Then log in as `operator`.
Expected: no **Data Admin** item in the sidebar.

- [ ] **Step 4: Verify a delete round-trips**

Tick one day, delete it with reason `test delete`, confirm the toast, and confirm the row disappears. Then check the snapshot exists:

```js
await (await fetch('/api/admin/snapshots?entity=daily_entry')).json()
```

Expected: one snapshot with `kind: 'DELETE'` and the day's date as `label`.

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): Data Admin view with month day list and bulk delete"
```

---

### Task 7: Recycle Bin tab

**Files:**
- Modify: `public/app.js` — replace the `renderBin` stub from Task 6

**Interfaces:**
- Consumes: `GET /api/admin/snapshots`, `POST /api/admin/snapshots/:id/restore`
- Produces: nothing downstream

- [ ] **Step 1: Replace the stub**

Replace the whole `async function renderBin() { … }` line with:

```js
  async function renderBin() {
    const body = $('#daBody');
    body.innerHTML = `<div class="card"><div id="daBin" class="empty">Loading…</div></div>`;
    let snaps = [];
    try {
      snaps = (await api('/admin/snapshots')).snapshots || [];
    } catch (e) { $('#daBin').textContent = e.message; return; }
    if (!snaps.length) {
      $('#daBin').textContent = 'Nothing has been deleted or override-edited yet.';
      return;
    }
    const KIND = { DELETE: 'Deleted', EDIT_BEFORE: 'Edited' };
    $('#daBin').outerHTML = `<div class="tscroll"><table><thead><tr>
      <th>When</th><th>What</th><th>Action</th><th>By</th><th>Reason</th><th></th>
      </tr></thead><tbody>${snaps.map(s => `<tr>
        <td class="small muted">${esc((s.taken_at || '').toString().replace('T', ' ').slice(0, 16))}</td>
        <td>${esc(s.label)}<div class="small muted">${esc(s.entity)}</div></td>
        <td><span class="tag">${esc(KIND[s.kind] || s.kind)}</span></td>
        <td>${esc(s.taken_by_name || '—')}</td>
        <td class="small muted">${esc(s.reason)}</td>
        <td>${s.restored_at
              ? `<span class="small muted">Restored by ${esc(s.restored_by_name || '—')}</span>`
              : `<button class="btn ghost sm" data-restore="${s.id}">Restore</button>`}</td>
      </tr>`).join('')}</tbody></table></div>`;

    v.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await api(`/admin/snapshots/${b.dataset.restore}/restore`, { method: 'POST' });
        toast(`Restored ${r.label}`, 'ok');
        renderBin();
      } catch (e) { toast(e.message, 'err'); b.disabled = false; }
    }));
  }
```

- [ ] **Step 2: Verify restore works**

As `admin`, open **Data Admin → Recycle Bin**.
Expected: the day deleted in Task 6 is listed with reason `test delete` and a **Restore** button. Click it.
Expected: a success toast; the row now reads "Restored by …" with no button; the day reappears under the **Days** tab with its original figures.

- [ ] **Step 3: Verify the conflict path**

Delete a day, re-create that same date via **Daily Entry**, then try to restore the snapshot.
Expected: an error toast reading `<date> already exists. Delete that record first, then restore.` and the snapshot stays un-restored.

- [ ] **Step 4: Verify double-restore is refused**

Click **Restore** on an already-restored snapshot via the console:

```js
await (await fetch('/api/admin/snapshots/1/restore', {method:'POST'})).json()
```

Expected: `{ error: 'This snapshot has already been restored' }`

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): recycle bin tab with restore"
```

---

### Task 8: Inline delete on the remaining record types

**Files:**
- Modify: `public/app.js` — the `ROUTES.workers`, `ROUTES.attendance`, `ROUTES.leave`, `ROUTES.discrepancies` and `ROUTES.capa` list renderers

**Interfaces:**
- Consumes: `DELETE /api/admin/:entity` from Task 4
- Produces: nothing downstream

- [ ] **Step 1: Add a shared helper**

Add directly above `ROUTES.archive` in `public/app.js`:

```js
// Admin-only inline delete. Renders nothing for non-admins, so the same list
// markup serves every role.
function adminDelBtn(entity, id) {
  return State.user.role === 'ADMIN'
    ? `<button class="btn ghost sm" data-adel="${entity}:${id}">Delete</button>` : '';
}

// Wire every [data-adel] button inside `root`. `after` re-renders the list.
function wireAdminDel(root, after) {
  root.querySelectorAll('[data-adel]').forEach(b => b.addEventListener('click', async () => {
    const [entity, id] = b.dataset.adel.split(':');
    const reason = prompt('Delete this record?\n\nReason (min 5 characters) — required:');
    if (reason === null) return;
    try {
      await api('/admin/' + entity, { method: 'DELETE', body: { ids: [Number(id)], reason } });
      toast('Deleted — restore it from Data Admin → Recycle Bin', 'ok');
      after();
    } catch (e) { toast(e.message, 'err'); }
  }));
}
```

- [ ] **Step 2: Wire it into each list**

> **Read each renderer before editing it.** The five views do not share a row
> layout, so the exact action cell differs. The pattern below is fixed; the
> insertion point must be located per file.

Worked example — `ROUTES.discrepancies` renders each row ending in an action
cell holding a Resolve button:

```js
        <td><button class="btn ghost sm" data-res="${d.id}">Resolve</button></td>
```

becomes:

```js
        <td><button class="btn ghost sm" data-res="${d.id}">Resolve</button>
            ${adminDelBtn('discrepancy', d.id)}</td>
```

and immediately after that list's existing `querySelectorAll('[data-res]')`
wiring, add:

```js
    wireAdminDel(v, render);
```

Apply the identical two-part change (button in the action cell, `wireAdminDel`
beside the existing wiring) to each renderer, with these entity names:

| Renderer | entity | re-render call |
|---|---|---|
| `ROUTES.workers` | `worker` | the local `render` |
| `ROUTES.attendance` | `attendance` | the local `render` |
| `ROUTES.leave` | `leave` | the local `render` |
| `ROUTES.discrepancies` | `discrepancy` | the local `render` |
| `ROUTES.capa` | `capa` | the local `render` |

Where a renderer has no `render` function in scope, pass `() => ROUTES.<name>()`
instead — e.g. `wireAdminDel(v, () => ROUTES.capa())`.

- [ ] **Step 3: Verify each list**

As `admin`, open each of the five views.
Expected: a **Delete** button on every row; deleting one removes it and it appears in the Recycle Bin with the right entity name; restoring it brings it back.

As `operator`, open the same views.
Expected: no Delete buttons anywhere.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including `test/recycleBin.test.js`, `test/calc.test.js` and `test/authToken.test.js`.

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "feat(ui): admin inline delete for workers, attendance, leave, discrepancies and CAPA"
```

---

## Deviations from the spec

- The spec said only `daily_entry` has a unique key a restore can collide with. That is wrong: `attendance` carries `UNIQUE (work_date, worker_id)`. The registry's `unique` is therefore a **list of columns**, and `attendance` declares `['work_date', 'worker_id']`.
- Bulk delete is **per-id fault-tolerant**: one bad id returns in `failed[]` rather than rolling back the whole batch, so deleting 30 days does not fail because of one already-removed row.
