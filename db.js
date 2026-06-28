/**
 * Database layer — SQLite via Node's built-in node:sqlite (no native build needed).
 * Creates schema, seeds default config + users on first run.
 *
 * Run `npm run seed` (or `node db.js --seed`) to (re)seed defaults.
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built-in, no native build required (Node >= 22.5)
const bcrypt = require('bcryptjs');
const config = require('./config');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON');

// better-sqlite3-style transaction helper so the rest of the app is unchanged.
db.transaction = (fn) => (...args) => {
  db.exec('BEGIN');
  try { const r = fn(...args); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
};

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,           -- OPERATOR | JMC_APPROVER | HQ | ADMIN
    company TEXT NOT NULL,        -- DRONA | JMC
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Key/value settings (rates, MG, approved manpower) as JSON.
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One record per operating day.
  CREATE TABLE IF NOT EXISTS daily_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_date TEXT NOT NULL UNIQUE,           -- YYYY-MM-DD
    status TEXT NOT NULL DEFAULT 'DRAFT',      -- DRAFT | SUBMITTED | APPROVED | REJECTED
    shift TEXT DEFAULT 'DAY',
    notes TEXT,
    created_by INTEGER,
    submitted_at TEXT,
    approved_by INTEGER,
    approved_at TEXT,
    jmc_remarks TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (approved_by) REFERENCES users(id)
  );

  -- Actual manpower deployed per category for a day.
  CREATE TABLE IF NOT EXISTS manpower_actual (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    category TEXT NOT NULL,        -- LOADER | UNLOADER | INSPECTOR | SUPERVISOR
    approved_count INTEGER NOT NULL DEFAULT 0,
    actual_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (entry_id) REFERENCES daily_entries(id) ON DELETE CASCADE
  );

  -- Loading: parts loaded, with manpower & truck counts.
  CREATE TABLE IF NOT EXISTS loading (
    entry_id INTEGER PRIMARY KEY,
    parts_qty INTEGER NOT NULL DEFAULT 0,
    manpower_count INTEGER NOT NULL DEFAULT 0,
    truck_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (entry_id) REFERENCES daily_entries(id) ON DELETE CASCADE
  );

  -- Unloading: trucks unloaded + weight in tons.
  CREATE TABLE IF NOT EXISTS unloading (
    entry_id INTEGER PRIMARY KEY,
    truck_count INTEGER NOT NULL DEFAULT 0,
    weight_ton REAL NOT NULL DEFAULT 0,
    manpower_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (entry_id) REFERENCES daily_entries(id) ON DELETE CASCADE
  );

  -- QC / PTL / PDI: parts checked + manpower. MG flag computed in app.
  CREATE TABLE IF NOT EXISTS qc (
    entry_id INTEGER PRIMARY KEY,
    parts_qty INTEGER NOT NULL DEFAULT 0,
    manpower_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (entry_id) REFERENCES daily_entries(id) ON DELETE CASCADE
  );

  -- Individual transport trips (from / to / vehicle / timestamp).
  CREATE TABLE IF NOT EXISTS transport_trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    from_loc TEXT NOT NULL,
    to_loc TEXT NOT NULL,
    vehicle_type TEXT NOT NULL,
    trip_time TEXT,               -- HH:MM
    remarks TEXT,
    FOREIGN KEY (entry_id) REFERENCES daily_entries(id) ON DELETE CASCADE
  );

  -- Extra-manpower requests (raised on site, approved by HQ).
  CREATE TABLE IF NOT EXISTS manpower_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    req_date TEXT NOT NULL,
    needed_date TEXT,
    category TEXT NOT NULL,
    extra_count INTEGER NOT NULL,
    reason TEXT,
    ppm_current INTEGER,          -- current parts-per-minute / production no.
    status TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | APPROVED | REJECTED
    requested_by INTEGER,
    decided_by INTEGER,
    decided_at TEXT,
    decision_remarks TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (requested_by) REFERENCES users(id),
    FOREIGN KEY (decided_by) REFERENCES users(id)
  );

  -- Photo / file attachments (proof of work) linked to a day.
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    caption TEXT,
    uploaded_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (entry_id) REFERENCES daily_entries(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id)
  );

  -- Discrepancy log — the JMC "concern areas".
  CREATE TABLE IF NOT EXISTS discrepancies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    disc_date TEXT NOT NULL,
    type TEXT NOT NULL,            -- DISPATCH_VS_BILL | WRONG_PART | QR_ISSUE | TPH_HYZINE | OTHER
    part_no TEXT,
    description TEXT,
    qty_dispatched INTEGER,
    qty_billed INTEGER,
    qr_code TEXT,
    severity TEXT NOT NULL DEFAULT 'MEDIUM',   -- LOW | MEDIUM | HIGH
    status TEXT NOT NULL DEFAULT 'OPEN',        -- OPEN | RESOLVED
    raised_by INTEGER,
    raised_company TEXT,
    resolution TEXT,
    resolved_by INTEGER,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (raised_by) REFERENCES users(id),
    FOREIGN KEY (resolved_by) REFERENCES users(id)
  );

  -- Worker master (HR records — NOT app logins).
  CREATE TABLE IF NOT EXISTS workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_no TEXT UNIQUE,
    name TEXT NOT NULL,
    father_name TEXT,
    gender TEXT,
    dob TEXT,
    blood_group TEXT,
    mobile TEXT,
    address TEXT,
    aadhaar TEXT,
    pan TEXT,
    uan TEXT,                 -- PF Universal Account Number
    esic_no TEXT,
    department TEXT,          -- LOADER | UNLOADER | INSPECTOR | SUPERVISOR | OTHER
    designation TEXT,
    date_of_joining TEXT,
    date_of_exit TEXT,
    supervisor TEXT,
    wage_type TEXT DEFAULT 'MONTHLY',   -- MONTHLY | DAILY
    monthly_gross REAL DEFAULT 0,
    daily_wage REAL DEFAULT 0,
    basic REAL DEFAULT 0,
    hra REAL DEFAULT 0,
    allowances REAL DEFAULT 0,
    pf_applicable INTEGER DEFAULT 1,
    esi_applicable INTEGER DEFAULT 1,
    bank_holder TEXT,
    bank_name TEXT,
    account_no TEXT,
    ifsc TEXT,
    emergency_name TEXT,
    emergency_phone TEXT,
    emergency_relation TEXT,
    status TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | INACTIVE
    photo TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS worker_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER NOT NULL,
    doc_type TEXT,
    filename TEXT NOT NULL,
    caption TEXT,
    uploaded_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_date TEXT NOT NULL,
    worker_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PRESENT',  -- PRESENT | ABSENT | HALF_DAY | LEAVE | WEEKLY_OFF
    in_time TEXT,
    out_time TEXT,
    ot_hours REAL DEFAULT 0,
    remarks TEXT,
    marked_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (work_date, worker_id),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS leave_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER NOT NULL,
    leave_type TEXT NOT NULL,        -- CL | SL | EL | LWP
    from_date TEXT NOT NULL,
    to_date TEXT NOT NULL,
    days REAL NOT NULL DEFAULT 1,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',   -- PENDING | APPROVED | REJECTED
    applied_by INTEGER,
    decided_by INTEGER,
    decided_at TEXT,
    decision_remarks TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (worker_id) REFERENCES workers(id) ON DELETE CASCADE
  );

  -- Lightweight audit trail.
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);
  // Additive migrations (safe to run repeatedly; ignore "duplicate column").
  try { db.exec('ALTER TABLE daily_entries ADD COLUMN ppm INTEGER'); } catch (_) {}
  try { db.exec('ALTER TABLE worker_documents ADD COLUMN expiry_date TEXT'); } catch (_) {}

  // Indexes for the hot filter/join paths (SQLite does not auto-index foreign
  // keys). Created after the ALTERs so expiry_date exists. Safe to re-run.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entries_status    ON daily_entries(status);
    CREATE INDEX IF NOT EXISTS idx_manpower_entry    ON manpower_actual(entry_id);
    CREATE INDEX IF NOT EXISTS idx_trips_entry       ON transport_trips(entry_id);
    CREATE INDEX IF NOT EXISTS idx_attendance_date   ON attendance(work_date);
    CREATE INDEX IF NOT EXISTS idx_attendance_worker ON attendance(worker_id);
    CREATE INDEX IF NOT EXISTS idx_disc_date         ON discrepancies(disc_date);
    CREATE INDEX IF NOT EXISTS idx_disc_status       ON discrepancies(status);
    CREATE INDEX IF NOT EXISTS idx_wdocs_worker      ON worker_documents(worker_id);
    CREATE INDEX IF NOT EXISTS idx_wdocs_expiry      ON worker_documents(expiry_date);
    CREATE INDEX IF NOT EXISTS idx_leave_worker      ON leave_applications(worker_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user     ON sessions(user_id);
  `);
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(key, JSON.stringify(value));
}

function seed() {
  init();
  // Seed settings only if missing (don't clobber admin edits).
  if (getSetting('rates') === null) setSetting('rates', config.RATES);
  if (getSetting('mg') === null) setSetting('mg', config.MG);
  if (getSetting('approved_manpower') === null) setSetting('approved_manpower', config.APPROVED_MANPOWER);
  if (getSetting('show_billing') === null) setSetting('show_billing', config.SHOW_BILLING);
  if (getSetting('transport_rates') === null) setSetting('transport_rates', config.TRANSPORT_RATES);
  if (getSetting('costs') === null) setSetting('costs', config.COSTS);
  if (getSetting('invoice') === null) setSetting('invoice', config.INVOICE);
  if (getSetting('ppm_target') === null) setSetting('ppm_target', config.PPM_TARGET);
  if (getSetting('mg_billing') === null) setSetting('mg_billing', config.MG_BILLING);
  if (getSetting('leave_policy') === null) setSetting('leave_policy', config.LEAVE_POLICY);

  const defaults = [
    { name: 'System Admin',  username: 'admin',    password: 'admin123', role: 'ADMIN',        company: 'DRONA' },
    { name: 'Site Operator', username: 'operator', password: 'oper123',  role: 'OPERATOR',     company: 'DRONA' },
    { name: 'Drona HQ',      username: 'hq',       password: 'hq123',    role: 'HQ',           company: 'DRONA' },
    { name: 'JMC Approver',  username: 'jmc',      password: 'jmc123',   role: 'JMC_APPROVER', company: 'JMC' },
  ];
  const insert = db.prepare(`INSERT OR IGNORE INTO users (name, username, password_hash, role, company)
                             VALUES (?, ?, ?, ?, ?)`);
  let created = 0;
  for (const u of defaults) {
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username);
    if (!exists) {
      insert.run(u.name, u.username, bcrypt.hashSync(u.password, 10), u.role, u.company);
      created++;
    }
  }
  console.log(`Seed complete. Users created: ${created}. DB: ${DB_PATH}`);
}

init();

module.exports = { db, getSetting, setSetting, seed };

// Allow `node db.js --seed`
if (require.main === module && process.argv.includes('--seed')) {
  seed();
}
