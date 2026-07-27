# Admin Modify / Delete of Entered Data — Design

**Date:** 2026-07-28
**Status:** Approved, ready for planning

## Problem

Once a daily entry reaches `SUBMITTED` or `APPROVED`, nobody can change it — not
even an admin. `isEditable()` (`server.js:382`) allows writes only in `DRAFT` or
`REJECTED`, and no DELETE route exists for a daily entry anywhere in the API.

Two consequences:

- A wrong number that got submitted or approved stays wrong forever.
- The Excel importer silently skips locked days (`server.js:556`), so a bad
  upload cannot be corrected by re-uploading.

This matters for money. `/api/summary` and `reports.computeBilling` sum **every**
day in the period regardless of status — `lib/reports.js:106` treats `APPROVED`
as a statistic, not a filter. Wrong data in a locked day is wrong data in the
invoice.

Workers, attendance, leave applications, discrepancies and CAPA records have the
same gap: several have edit routes, none can be deleted.

## Goals

Give ADMIN a controlled path to correct or remove entered data, such that:

1. Nothing is destroyed irrecoverably.
2. Every change carries a reason and an actor.
3. JMC's approval never silently diverges from the billed numbers.
4. Existing report, billing, dashboard and MIS queries stay correct without
   being rewritten.

## Non-goals

- **Versioned / rollbackable rates and settings.** Rates are read at report
  time, so rolling one back would retroactively rewrite historical invoices.
  Doing that safely needs date-effective rates and per-entry rate snapshots —
  a separate project. Settings already has a `PUT`, so rates remain editable.
- **Deleting users or PDI parts.** `users.id` is referenced as `created_by`,
  `approved_by`, `raised_by` and `uploaded_by` across eight tables, and
  `qc_lines.part_no` references `pdi_parts` by value. Deletion orphans history
  and breaks the joins that render names in reports. Both already have an
  active/inactive toggle, which is the correct mechanism and stays as-is.
- **Import-batch tracking.** No `import_batches` table. Undoing a bad upload is
  handled by multi-selecting the affected days, whose dates the import response
  already reports as `created` / `updated` / `skipped`.
- **Automatic snapshot purging.** Retention is unbounded. At this data volume
  that is fine for years; revisit if it ever isn't.

## Approach

**Snapshot, then hard delete.** On delete, the row and all its children are
serialised into a `record_snapshots` table; the original is then genuinely
removed. Restore re-inserts from the snapshot.

The alternative — `deleted_at` columns plus `AND deleted_at IS NULL` on every
read — was rejected. It would require auditing roughly thirty queries across
`server.js`, `lib/reports.js` and the PDF reports, and a single missed filter
would put a deleted day back into an invoice: silent, and wrong money. The
snapshot approach concentrates all the risk in one restore function that an
admin uses rarely and can immediately verify. An awkward restore is a far better
failure mode than a quietly incorrect invoice.

It also yields the audit trail for free. `audit_log.detail` is a single TEXT
column that records *that* something happened, never the prior values.

## Data model

The app runs on **Postgres via Prisma**; `lib/rawdb.js` is a compatibility shim
that rewrites `?` placeholders to `$n`. The SQLite schema in `db.js` is legacy
reference and is not the source of truth.

The new table ships as a Prisma model plus a migration under
`prisma/migrations/<timestamp>_record_snapshots/`, following the pattern of
`20260702120100_device_tokens`.

```sql
CREATE TABLE record_snapshots (
  id          SERIAL PRIMARY KEY,
  entity      TEXT NOT NULL,      -- daily_entry | worker | attendance | leave | discrepancy | capa
  kind        TEXT NOT NULL,      -- DELETE | EDIT_BEFORE
  label       TEXT NOT NULL,      -- human handle: '2026-07-14', 'Ramesh Kumar'
  payload     JSONB NOT NULL,     -- parent row + every child row
  reason      TEXT NOT NULL,
  taken_by    INTEGER REFERENCES users(id),
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  restored_at TIMESTAMPTZ,
  restored_by INTEGER REFERENCES users(id)
);
CREATE INDEX ON record_snapshots (entity, taken_at DESC);
```

`kind` covers both destructive operations. A `DELETE` snapshot restores the
record; an `EDIT_BEFORE` snapshot restores the pre-edit values, so a bad admin
edit is as recoverable as a bad delete.

Restored snapshots keep their row with `restored_at` set, so the archive reads
as a two-way history rather than a queue that empties.

## Components

### `lib/recycleBin.js`

The only module that knows table shapes. An entity registry:

```js
const ENTITIES = {
  daily_entry: {
    table:    'daily_entries',
    label:    r => r.work_date,
    children: ['manpower_actual','loading','unloading','qc','qc_lines',
               'transport_trips','attachments'],
    childKey: 'entry_id',
    unique:   'work_date',
  },
  // …five more, fully specified in the table below
};
```

The complete set:

| entity | table | children (`childKey`) | `label` | `unique` |
|---|---|---|---|---|
| `daily_entry` | `daily_entries` | `manpower_actual`, `loading`, `unloading`, `qc`, `qc_lines`, `transport_trips`, `attachments` (`entry_id`) | `work_date` | `work_date` |
| `worker` | `workers` | `worker_documents` (`worker_id`) | `name` | none |
| `attendance` | `attendance` | none | `work_date` + worker name | none |
| `leave` | `leave_applications` | none | worker name + date range | none |
| `discrepancy` | `discrepancies` | none | `disc_date` + `type` | none |
| `capa` | `capa` | none | `title` or id | none |

Only `daily_entry` has a unique key that a restore can collide with; the others
restore unconditionally. `worker` is the only other entity with children.

Adding a seventh entity later is a registry entry, not new code.

Serialisation and restore-plan construction are **pure functions** —
`buildPayload(parent, childRows)` and `buildRestorePlan(payload)` — with DB I/O
confined to thin `capture()` / `restore()` wrappers. This keeps the logic
testable without a database, matching how `calc.js` and `lib/authToken.js` are
tested today.

### Routes

All require `requireRole('ADMIN')` and a non-trivial `reason`.

| Route | Purpose |
|---|---|
| `DELETE /api/admin/:entity` | Body `{ ids: [...], reason }`. One call serves both single and bulk delete. Each id produces its own snapshot, so they restore independently. |
| `GET /api/admin/snapshots` | Archive listing; filterable by `entity` and `kind`. |
| `POST /api/admin/snapshots/:id/restore` | Restores parent and children in one transaction. |

`reason` is required on every destructive route and must be at least 5
characters after trimming; anything shorter is a `400`.

The delete route carries a JSON body, which is legal for `DELETE` and supported
by both `express.json()` and the `fetch`-based `api()` helper the frontend uses.

**Restore semantics differ by `kind`:**

- `DELETE` snapshot — the record no longer exists, so restore **inserts** the
  parent and its children fresh.
- `EDIT_BEFORE` snapshot — the record still exists, so restore **overwrites** it
  in place by id, replacing child rows wholesale. Restoring an `EDIT_BEFORE`
  first captures the current state as a new `EDIT_BEFORE` snapshot, so undo is
  itself undoable.

### Admin edit override

Edits reuse `POST /api/entries` rather than adding a parallel handler. At the
`isEditable` check (`server.js:461`), a request from an ADMIN carrying
`admin_override: true` and a `reason` passes through. An `EDIT_BEFORE` snapshot
is captured first.

Approval handling is chosen per edit:

- `keep_approval: false` — **the default.** Status returns to `SUBMITTED`,
  `approved_by` and `approved_at` are cleared, and a note is appended to
  `jmc_remarks` recording what admin changed and why. The day re-enters JMC's
  queue.
- `keep_approval: true` — status is left untouched. Snapshot and audit entry are
  still written.

Defaulting to re-approval means the safe path is the one an admin gets by not
thinking about it.

Audit action: `ENTRY_ADMIN_EDIT`, with the reason and the `keep_approval` choice.

### UI

One new ADMIN-only nav entry — `archive` / `🗃` / "Data Admin" — registered in
`ROLE_NAV.ADMIN` and `NAV_META` (`public/app.js:100`), implemented as
`ROUTES.archive` following the shape of `ROUTES.audit` (`public/app.js:1302`).

Two tabs:

- **Days** — pick a month, list every day with its status, tick checkboxes,
  "Delete selected" with a single reason prompt for the batch. An Edit button on
  a locked day opens the normal entry form with an override banner, the reason
  field and the re-approval toggle.
- **Recycle Bin** — snapshot history with a Restore button per row.

Workers, attendance, leave, discrepancies and CAPA get an inline ADMIN-only
Delete on their existing lists, opening the same reason dialog. No new views.

Keeping day management in its own admin view leaves `ROUTES.entry` and
`ROUTES.reports` untouched and role-neutral.

## Edge cases

**Restore into an occupied slot.** `daily_entries.work_date` is UNIQUE. If the
date was re-created after deletion, restore refuses with `409` naming the
conflict: *"2026-07-14 already exists (status DRAFT). Delete that day first,
then restore."* No silent merge.

**Child row identity.** Restore does not preserve original child ids; they
regenerate and `entry_id` is rewritten to the new parent id. Preserving ids
would collide with rows inserted since. `attachments.filename` is the one field
that must survive verbatim, as it points at a real file.

**Attachment files are never unlinked.** Deleting a day cascades its
`attachments` rows, but the files stay in `uploads/`. Unlinking is the single
irreversible act, and keeping the bytes is what makes restore work. Orphaned
files are a separate cleanup concern, out of scope here.

**Dangling cross-references.** `discrepancies.qc_entry_id` points into
`daily_entries` and is not part of the cascade. The delete nulls it and records
the affected discrepancy ids inside the snapshot, so restore re-links them.

**Concurrency.** Capture-then-delete runs inside one `db.transaction`, re-reading
the record's status within the transaction — the same guard the Excel importer
uses at `server.js:540`. This prevents an admin deleting a day in the instant
JMC approves it.

**Bulk timeout.** Deleting a month of days with their QC lines exceeds Prisma's
5-second default. Bulk delete passes `{ timeout: 120000, maxWait: 15000 }`, as
`server.js:565` already does for the import.

## Error handling

| Code | Condition |
|---|---|
| `400` | Missing or trivially short `reason`; empty `ids` |
| `403` | Caller is not ADMIN |
| `404` | Unknown snapshot id |
| `409` | Snapshot already restored; or restore conflicts with an existing unique key |
| `422` | Unknown entity name |

In the UI, a delete selection containing `APPROVED` days shows an explicit
warning with a count — *"3 of 8 selected days are approved by JMC. Deleting them
will change the July 2026 invoice."* Reason is required on every destructive
action, never optional.

## Testing

`test/recycleBin.test.js`, using `node:test` and pure functions with no
database, consistent with `test/calc.test.js` and `test/authToken.test.js`:

- Snapshot payload shape for a parent with multiple child tables.
- Restore-plan generation: child ids stripped, foreign key rewritten to the new
  parent id.
- `attachments.filename` survives a delete/restore round trip unchanged.
- Conflict detection against a set of existing unique keys.
- Unknown entity name is rejected.
- An `EDIT_BEFORE` plan targets the existing id in place; a `DELETE` plan
  allocates a new one.
- A `reason` shorter than 5 characters after trimming is rejected.

The DB wrappers stay thin enough not to warrant integration tests; this repo has
no DB-backed test infrastructure and this change does not justify introducing
it.

## Build order

1. Prisma model + migration for `record_snapshots`.
2. `lib/recycleBin.js` — registry and pure functions.
3. `test/recycleBin.test.js`.
4. `capture()` / `restore()` DB wrappers.
5. Admin routes: delete, list, restore.
6. Admin edit override on `POST /api/entries`.
7. `ROUTES.archive` — Days tab, then Recycle Bin tab.
8. Inline delete on worker / attendance / leave / discrepancy / CAPA lists.
