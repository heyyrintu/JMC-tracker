# Feature build spec — Email Alerts, PDF Report/Invoice, CAPA

Hand-off doc so a fresh (lean-context) Claude Code session can build these three
features without re-discovering the codebase. The SQLite→PostgreSQL+Prisma
migration is already done and committed (`8ef4547`) on branch
`postgres-prisma-migration`.

## Stack recap (post-migration)
- Express API in `server.js`; all handlers are **async**.
- Data access: `lib/rawdb.js` → `db.prepare(sql).get/all/run` (await) + `db.transaction(async tx => …)`, running raw SQL through Prisma against Postgres. Positional `?` placeholders auto-convert to `$1…`. Aggregates need `::int` / `::float` casts (Postgres returns COUNT/SUM as BigInt).
- `lib/prisma.js` → `prisma` client + async `getSetting(key, fallback)` / `setSetting(key, value)` (settings stored as `jsonb`).
- Pure math in `calc.js`. Business config/defaults in `config.js` (seeded into `settings` table; admin-editable).
- Frontend SPA `public/app.js`: `ROUTES.<name> = async () => {…}` rendered into `#view`; nav from `ROLE_NAV` + `NAV_META`; `api(path, {method, body})` helper; `topbar()`, `toast(msg, kind)`, `h(html)`, `esc()`, `fmt()`, `inr()`; modals use `.modal-backdrop`/`.modal`.
- Roles: `OPERATOR`, `JMC_APPROVER`, `HQ`, `ADMIN`. `requireRole(...)` enforces server-side.

## Decisions already locked (do not re-ask)
1. **Email transport:** nodemailer over SMTP, env-configured.
2. **Recipients:** a single admin-configured comma-separated list in Settings (no `email` column on users).
3. **Trigger:** **both** a nightly digest **and** real-time event emails.
4. **Scope:** all three features.

## Already scaffolded (committed with this spec)
- `package.json`: added `nodemailer` dep (run `npm install`).
- `config.js`: added `ALERTS` defaults block (enabled, recipients, digest_hour, pnl_day_threshold, pending_approvals_max, pending_mp_max, doc_expiry_days, mg_short_days_max).

---

## Feature 1 — Email alerts

### Env (add to `.env` and `.env.example`)
```
SMTP_HOST=...
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_SECURE=false      # true for port 465
ALERT_FROM="Drona ValueChain <alerts@drona...>"
```

### New files
- **`lib/mailer.js`** — nodemailer transport built from the env vars above. Exports `sendMail({to, subject, html, text})` and `isConfigured()`. If `SMTP_HOST` is unset, degrade gracefully: log + resolve (never throw), so dev/scheduler keep working.
- **`lib/reports.js`** — extract reusable computations (also used by Feature 2):
  - `computeBilling(month)` — move the body of the current `/api/billing` handler here verbatim; return the same object. Move `transportRate(from,to,vehicle)` here too (it only needs `getSetting`+`config`); update `server.js` to import it.
  - `computeOps(month)` — compact operational summary for the report/digest: opDays, load_parts, unload_ton, qc_parts, mg_target, mg_short_days, mg_met_days, ppmAvg, approvedTotal, avgMpPerDay, utilization. Derive from a `daily_entries` aggregate query (mirror `/api/summary`) + `getSetting`.
- **`lib/alerts.js`** —
  - `evaluate(month)` → array of `{key, level, title, detail}` from thresholds in the `alerts` setting + `computeBilling` + count queries. **P&L-negative rule:** only flag when `gross_profit < 0` AND `new Date().getDate() > pnl_day_threshold` (revenue accrues through the month, so it's negative early by construction).
  - `runDigest()` → `evaluate(currentMonth)`, build one HTML email, send to `alerts.recipients`, then record the run date in a `alerts_state` setting (jsonb) to dedupe (skip if already sent today).
  - `notifyRealtime(type, payload)` → targeted emails for: `ENTRY_SUBMITTED` (a day awaits JMC approval), `MP_REQUEST` (extra manpower requested), `PNL_NEGATIVE` (checked after an entry is approved; dedupe once/day/month via `alerts_state`).
  - `startScheduler()` → lightweight `setInterval` (every ~15 min) that runs `runDigest()` once per day when local hour ≥ `digest_hour` and not yet run today (store last-run date in `alerts_state`). No new dep.

### `server.js` wiring
- Import `reports`, `alerts`, `mailer`. Replace `/api/billing` body with `await computeBilling(month)`. Remove the now-duplicated `transportRate`.
- Add `alerts` to `clientConfig()` (ADMIN/HQ only) and to the `PUT /api/settings` whitelist.
- New routes: `POST /api/alerts/test` (ADMIN → send a test email via `mailer`), `GET /api/alerts/preview` (ADMIN/HQ → `evaluate(currentMonth)` without sending).
- Real-time hooks: in `POST /api/entries` when `b.submit` → `alerts.notifyRealtime('ENTRY_SUBMITTED', …)`; in `POST /api/manpower-requests` → `notifyRealtime('MP_REQUEST', …)`; in `POST /api/entries/:id/decision` on APPROVE → `notifyRealtime('PNL_NEGATIVE', …)`.
- In `start()`: `alerts.startScheduler()` after `seed()`.

### `prisma/seed.js`
- `await ensureSetting('alerts', config.ALERTS)`.

### Frontend (`public/app.js`)
- In `ROUTES.settings`, add an **"Email Alerts"** card: enabled toggle, recipients textarea, the threshold numbers, **Send test email** button (`POST /api/alerts/test`), and a **Preview alerts** button (`GET /api/alerts/preview`) showing what would fire now. Persist via the existing settings save (`PUT /api/settings` with `{alerts:{…}}`).

---

## Feature 2 — Monthly PDF report + GST invoice

### New file `lib/pdf.js`
- `streamMonthlyReport(res, {month, ops, billing})` — pipe a pdfkit doc to `res`: letterhead (`config.COMPANY`), ops KPI table (loading/unloading/QC, MG achievement %, PPM avg, utilization), then P&L summary from `billing.pnl`.
- `streamInvoice(res, {month, billing, invoice, invoiceNo})` — GST invoice: bill-to (`invoice.bill_to`), GSTIN, line items (Loading parts×rate, Unloading ton×rate, QC billed×rate, Transport), subtotal, GST (`invoice.gst_pct`), grand total. Reuse the `rs()` "Rs." helper pattern from `generateOfferLetter` in `server.js` (pdfkit fonts lack ₹).
- Set headers: `Content-Type: application/pdf`, `Content-Disposition: inline; filename=...`.

### `server.js` routes (ADMIN/HQ)
- `GET /api/reports/monthly.pdf?month=YYYY-MM` → `computeOps` + `computeBilling` → `streamMonthlyReport`.
- `GET /api/invoice.pdf?month=YYYY-MM&no=...` → `computeBilling` + `getSetting('invoice')` → `streamInvoice`. Default invoiceNo `DRN/${YYYY-MM}` (stateless — no invoices table for now; note lifecycle/persistence as a future enhancement).
- Cookie auth (`sid`, httpOnly) is sent automatically on direct browser GETs, so the SPA can just `window.open(url)`.

### Frontend
- Add **Download monthly report (PDF)** and **Download GST invoice (PDF)** buttons in `ROUTES.billing` (and/or `ROUTES.mis`), opening the URLs with the current month.

---

## Feature 3 — CAPA / 8D workflow

### Prisma model (add to `prisma/schema.prisma`, then `npx prisma migrate dev --name capa`)
```prisma
model Capa {
  id                   Int       @id @default(autoincrement())
  discrepancyId        Int?      @map("discrepancy_id")
  title                String
  rootCause            String?   @map("root_cause")
  correctiveAction     String?   @map("corrective_action")
  preventiveAction     String?   @map("preventive_action")
  owner                String?
  dueDate              String?   @map("due_date")        // YYYY-MM-DD
  priority             String    @default("MEDIUM")       // LOW|MEDIUM|HIGH
  status               String    @default("OPEN")         // OPEN|IN_PROGRESS|DONE|VERIFIED
  verificationRemarks  String?   @map("verification_remarks")
  createdBy            Int?      @map("created_by")
  closedAt             DateTime? @map("closed_at")
  createdAt            DateTime  @default(now()) @map("created_at")
  updatedAt            DateTime  @default(now()) @map("updated_at")
  @@index([status], map: "idx_capa_status")
  @@map("capa")
}
```

### `server.js` routes
- `GET /api/capa?status=` (auth) — list with optional discrepancy join (`LEFT JOIN discrepancies`). Include an `overdue` flag (`due_date < today AND status NOT IN (DONE,VERIFIED)`).
- `POST /api/capa` (OPERATOR/HQ/JMC_APPROVER/ADMIN) — create, optional `discrepancy_id`.
- `PUT /api/capa/:id` (same) — update fields/status; set `closed_at = now()` when status becomes DONE/VERIFIED.
- VERIFY restricted to HQ/ADMIN (status → VERIFIED + `verification_remarks`).
- Add `open_capa` and `overdue_capa` counts to `GET /api/summary`.

### Frontend
- New `ROUTES.capa` screen: list + filters, create modal (prefillable from a discrepancy), inline status updates, overdue highlighting.
- Add `capa` to `ROLE_NAV` (all roles) and a `NAV_META.capa` entry (e.g. `{ic:'🛠', label:'CAPA / 8D'}`).
- In `ROUTES.discrepancies`, add a **"Create CAPA"** action that opens the CAPA modal with `discrepancy_id` prefilled. Surface `overdue_capa` as a dashboard badge.

---

## Build order & verification
1. `npm install` (gets nodemailer).
2. Feature 1 backend → add SMTP test via `POST /api/alerts/test`; `GET /api/alerts/preview`.
3. Feature 3 migration (`prisma migrate dev --name capa`) + routes.
4. Feature 2 PDF routes.
5. Frontend for all three.
6. Smoke test: boot server (note: a stale server may hold port 3000 — use `PORT=3100`), log in as admin, exercise `/api/alerts/preview`, the two PDF URLs, and CAPA CRUD. Reuse the curl pattern from the migration session.
7. Commit on the same branch.

## Notes / gotchas
- Timestamps now serialize as ISO (`2026-06-22T09:17:59.000Z`).
- Keep responses **snake_case** (frontend contract) — raw SQL via `lib/rawdb.js` already does this; cast aggregates.
- `db.js` is dead code (kept for the SQLite importer); don't reintroduce it.
- A repo GateGuard hook requires a short "facts" preface before each file write/edit.
