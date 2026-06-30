/**
 * Drona ValueChain — JMC Operations Tracker
 * Express API + static frontend.
 *
 * Data layer: PostgreSQL via Prisma. The db.prepare(sql).get/all/run helper
 * (lib/rawdb.js) runs the SQL below through Prisma's raw query API, so every
 * call is async (awaited) and result rows keep their snake_case shape.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
require('express-async-errors'); // forward async handler rejections to the error middleware
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const { db, prisma } = require('./lib/rawdb');
const { getSetting, setSetting } = require('./lib/prisma');
const { seed } = require('./prisma/seed');
const config = require('./config');
const calc = require('./calc');
const reports = require('./lib/reports');
const alerts = require('./lib/alerts');
const pdf = require('./lib/pdf');
const mailer = require('./lib/mailer');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_HOURS = 12;

// Trust the first proxy hop (nginx/caddy in the documented deploy) so req.ip
// reflects the real client for rate limiting, and Secure cookies work over TLS.
app.set('trust proxy', 1);

// Folder for uploaded proof photos.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Security headers on every response. CSP allows our own scripts only (blocks
// injected external scripts), with inline styles + Google Fonts permitted
// because the SPA renders many inline style attributes.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self'",
  "connect-src 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '20mb' })); // room for base64 photos + PDF documents (client pre-resizes images)
app.use(cookieParser());
// Uploaded files contain operational proof photos AND worker PII (ID / bank
// documents). They must never be world-readable: require a valid session, and
// restrict worker photos/documents (wphoto_ / wdoc_ prefixes) to Drona HR roles
// so the JMC client can only ever load daily-entry attachment photos.
app.get('/uploads/:file', auth, (req, res) => {
  const file = path.basename(String(req.params.file || '')); // strip any traversal
  const full = path.join(UPLOAD_DIR, file);
  if (path.dirname(full) !== UPLOAD_DIR) return res.status(400).json({ error: 'Bad path' });
  if (/^(w(doc|photo)|offer)_/.test(file) && !DRONA_HR.includes(req.user.role))
    return res.status(403).json({ error: 'Not permitted' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(full, (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'Not found' }); });
});

// ---- Helpers --------------------------------------------------------------
function audit(userId, action, detail) {
  // Fire-and-forget; never let an audit write break the request it records.
  return db.prepare('INSERT INTO audit_log (user_id, action, detail) VALUES (?, ?, ?)')
    .run(userId || null, action, detail ? JSON.stringify(detail) : null)
    .catch((e) => console.error('audit failed:', e.message));
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, name: u.name, username: u.username, role: u.role, company: u.company,
           roleLabel: config.ROLES[u.role] || u.role };
}
async function currentUser(req) {
  const token = req.cookies.sid;
  if (!token) return null;
  // Sessions expire server-side after SESSION_HOURS — a stolen token can't live
  // forever, and the client-side cookie maxAge alone is not trustworthy.
  const row = await db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                          WHERE s.token = ? AND u.active = true
                            AND s.created_at > now() - interval '${SESSION_HOURS} hours'`)
    .get(token);
  return row || null;
}
async function pruneSessions() {
  try {
    await db.prepare(`DELETE FROM sessions WHERE created_at <= now() - interval '${SESSION_HOURS} hours'`).run();
  } catch (_) {}
}
async function auth(req, res, next) {
  try {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'Not authenticated' });
    req.user = u;
    next();
  } catch (e) { next(e); }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return res.status(403).json({ error: 'Not permitted for your role' });
    next();
  };
}

// ---- Auth -----------------------------------------------------------------
const SESSION_COOKIE = { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 1000 * 60 * 60 * SESSION_HOURS };

// A real bcrypt hash to compare against when the username is unknown, so the
// response time doesn't reveal whether an account exists (anti-enumeration).
const DUMMY_HASH = bcrypt.hashSync('unused-placeholder-password', 10);

// In-memory login throttle (per client IP). Zero-dependency; resets on restart.
const LOGIN_WINDOW_MS = 15 * 60 * 1000, LOGIN_MAX = 10;
const loginHits = new Map();
function loginThrottle(ip) {
  const now = Date.now();
  const rec = loginHits.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) { loginHits.set(ip, { first: now, count: 1 }); return true; }
  rec.count++;
  return rec.count <= LOGIN_MAX;
}
function loginReset(ip) { loginHits.delete(ip); }

app.post('/api/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!loginThrottle(ip))
    return res.status(429).json({ error: 'Too many login attempts — try again later' });
  const { username, password } = req.body || {};
  const u = await db.prepare('SELECT * FROM users WHERE username = ? AND active = true').get((username || '').trim());
  // Always run a bcrypt comparison (real or dummy) for constant-ish timing.
  const ok = bcrypt.compareSync(password || '', u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok)
    return res.status(401).json({ error: 'Invalid username or password' });
  loginReset(ip);
  pruneSessions();
  const token = crypto.randomBytes(24).toString('hex');
  await db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, u.id);
  res.cookie('sid', token, SESSION_COOKIE);
  audit(u.id, 'LOGIN');
  res.json({ user: publicUser(u) });
});

app.post('/api/logout', auth, async (req, res) => {
  await db.prepare('DELETE FROM sessions WHERE token = ?').run(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
});

// Self-service password change. Verifies the current password, then rotates the
// hash and revokes the user's *other* sessions (keeps the caller signed in).
app.post('/api/me/password', auth, async (req, res) => {
  const { current, password } = req.body || {};
  if (!password || password.length < 5)
    return res.status(400).json({ error: 'New password must be at least 5 characters' });
  const u = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!u || !bcrypt.compareSync(current || '', u.password_hash))
    return res.status(401).json({ error: 'Current password is incorrect' });
  await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.user.id);
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, req.cookies.sid);
  audit(req.user.id, 'PASSWORD_CHANGE');
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const u = await currentUser(req);
  res.json({ user: publicUser(u), config: await clientConfig(u) });
});

async function clientConfig(user) {
  const cfg = {
    company: config.COMPANY,
    roles: config.ROLES,
    showBilling: !!(await getSetting('show_billing', false)),
    rates: await getSetting('rates', config.RATES),
    mg: await getSetting('mg', config.MG),
    approvedManpower: await getSetting('approved_manpower', config.APPROVED_MANPOWER),
    vehicleTypes: config.VEHICLE_TYPES,
    locations: config.COMMON_LOCATIONS,
    workingDays: config.WORKING_DAYS_PER_MONTH,
    ppmTarget: await getSetting('ppm_target', config.PPM_TARGET),
    defectTypes: await getSetting('defect_types', config.DEFECT_TYPES),
    mgBilling: !!(await getSetting('mg_billing', config.MG_BILLING)),
    leaveTypes: config.LEAVE_TYPES,
    leavePolicy: await getSetting('leave_policy', config.LEAVE_POLICY),
    demo: !IS_PROD, // gate the on-screen demo-credentials hint
  };
  // Internal financials — monthly costs and invoice/GST details — are Drona
  // management only. Never ship them to the JMC client or floor operators
  // (the Settings screen that consumes them is ADMIN-only anyway).
  if (user && (user.role === 'ADMIN' || user.role === 'HQ')) {
    cfg.costs = await getSetting('costs', config.COSTS);
    cfg.invoice = await getSetting('invoice', config.INVOICE);
    cfg.alerts = await getSetting('alerts', config.ALERTS);
  }
  return cfg;
}

// ---- Entry assembly -------------------------------------------------------
async function loadEntry(id) {
  const e = await db.prepare('SELECT * FROM daily_entries WHERE id = ?').get(id);
  if (!e) return null;
  e.manpower = await db.prepare('SELECT category, approved_count, actual_count FROM manpower_actual WHERE entry_id = ?').all(id);
  e.loading = (await db.prepare('SELECT parts_qty, manpower_count, truck_count FROM loading WHERE entry_id = ?').get(id))
              || { parts_qty: 0, manpower_count: 0, truck_count: 0 };
  e.unloading = (await db.prepare('SELECT truck_count, weight_ton, manpower_count FROM unloading WHERE entry_id = ?').get(id))
              || { truck_count: 0, weight_ton: 0, manpower_count: 0 };
  e.qc = (await db.prepare('SELECT parts_qty, manpower_count FROM qc WHERE entry_id = ?').get(id))
              || { parts_qty: 0, manpower_count: 0 };
  e.qc.lines = await db.prepare('SELECT id, part_no, checked_qty, rejected_qty, rework_qty, defect_type, remarks FROM qc_lines WHERE entry_id = ? ORDER BY id').all(id);
  // Derived quality metrics from the per-part lines (rejected / checked).
  const qcAgg = e.qc.lines.reduce((a, l) => {
    a.checked += l.checked_qty; a.rejected += l.rejected_qty; a.rework += l.rework_qty; return a;
  }, { checked: 0, rejected: 0, rework: 0 });
  e.qc.checked = qcAgg.checked;
  e.qc.rejected = qcAgg.rejected;
  e.qc.rework = qcAgg.rework;
  e.qc.passed = Math.max(0, qcAgg.checked - qcAgg.rejected - qcAgg.rework);
  e.qc.ppm_derived = qcAgg.checked > 0 ? Math.round((qcAgg.rejected / qcAgg.checked) * 1e6) : null;
  e.qc.fpy = qcAgg.checked > 0 ? +(((qcAgg.checked - qcAgg.rejected - qcAgg.rework) / qcAgg.checked) * 100).toFixed(1) : null;
  e.transport = await db.prepare('SELECT id, from_loc, to_loc, vehicle_type, trip_time, remarks FROM transport_trips WHERE entry_id = ? ORDER BY trip_time').all(id);
  e.attachments = (await db.prepare(`SELECT a.id, a.filename, a.caption, a.created_at, u.name AS uploaded_by_name
    FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by WHERE a.entry_id = ? ORDER BY a.id`).all(id))
    .map(a => ({ ...a, url: '/uploads/' + a.filename }));
  const mg = await getSetting('mg', config.MG);
  e.mg_target = mg.qc_daily_parts;
  e.mg_shortfall = Math.max(0, mg.qc_daily_parts - e.qc.parts_qty);
  e.mg_met = e.qc.parts_qty >= mg.qc_daily_parts;
  e.created_by_name = e.created_by ? ((await db.prepare('SELECT name FROM users WHERE id=?').get(e.created_by)) || {}).name : null;
  e.approved_by_name = e.approved_by ? ((await db.prepare('SELECT name FROM users WHERE id=?').get(e.approved_by)) || {}).name : null;
  return e;
}

// ---- Entries: list --------------------------------------------------------
app.get('/api/entries', auth, async (req, res) => {
  const { from, to, status, month } = req.query;
  let sql = 'SELECT id, work_date, status, shift, submitted_at, approved_at FROM daily_entries WHERE 1=1';
  const args = [];
  if (from) { sql += ' AND work_date >= ?'; args.push(from); }
  if (to)   { sql += ' AND work_date <= ?'; args.push(to); }
  if (month){ sql += " AND substr(work_date,1,7) = ?"; args.push(month); }
  if (status){ sql += ' AND status = ?'; args.push(status); }
  sql += ' ORDER BY work_date DESC LIMIT 400';
  res.json({ entries: await db.prepare(sql).all(...args) });
});

app.get('/api/entries/:id', auth, async (req, res) => {
  const e = await loadEntry(Number(req.params.id));
  if (!e) return res.status(404).json({ error: 'Not found' });
  res.json({ entry: e });
});

// Get-or-create the entry for a date (operator workspace).
app.get('/api/entry-by-date/:date', auth, async (req, res) => {
  const date = req.params.date;
  let row = await db.prepare('SELECT id FROM daily_entries WHERE work_date = ?').get(date);
  if (!row) return res.json({ entry: null });
  res.json({ entry: await loadEntry(row.id) });
});

// ---- Entries: create/update (Operator only, while editable) ---------------
function isEditable(status) { return status === 'DRAFT' || status === 'REJECTED'; }

app.post('/api/entries', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const b = req.body || {};
  if (!b.work_date) return res.status(400).json({ error: 'work_date required' });

  const approved = await getSetting('approved_manpower', config.APPROVED_MANPOWER);
  const approvedMap = Object.fromEntries(approved.map(a => [a.category, a.approved]));

  const run = db.transaction(async (tx) => {
    const ppmVal = (b.ppm != null && b.ppm !== '') ? Number(b.ppm) : null;
    let entry = await tx.prepare('SELECT * FROM daily_entries WHERE work_date = ?').get(b.work_date);
    let entryId;
    if (!entry) {
      const row = await tx.prepare(`INSERT INTO daily_entries (work_date, status, shift, notes, ppm, created_by)
                               VALUES (?, 'DRAFT', ?, ?, ?, ?) RETURNING id`)
                     .get(b.work_date, b.shift || 'DAY', b.notes || null, ppmVal, req.user.id);
      entryId = row.id;
    } else {
      if (!isEditable(entry.status))
        throw Object.assign(new Error('Entry is locked (already submitted/approved)'), { http: 409 });
      entryId = entry.id;
      await tx.prepare(`UPDATE daily_entries SET shift=?, notes=?, ppm=?, status='DRAFT', updated_at=now() WHERE id=?`)
        .run(b.shift || 'DAY', b.notes || null, ppmVal, entryId);
    }

    // Manpower
    await tx.prepare('DELETE FROM manpower_actual WHERE entry_id = ?').run(entryId);
    for (const m of (b.manpower || [])) {
      await tx.prepare(`INSERT INTO manpower_actual (entry_id, category, approved_count, actual_count) VALUES (?, ?, ?, ?)`)
        .run(entryId, m.category, approvedMap[m.category] ?? 0, Number(m.actual_count) || 0);
    }

    // Loading
    const L = b.loading || {};
    await tx.prepare(`INSERT INTO loading (entry_id, parts_qty, manpower_count, truck_count) VALUES (?,?,?,?)
                ON CONFLICT(entry_id) DO UPDATE SET parts_qty=excluded.parts_qty,
                manpower_count=excluded.manpower_count, truck_count=excluded.truck_count`)
      .run(entryId, +L.parts_qty || 0, +L.manpower_count || 0, +L.truck_count || 0);

    // Unloading
    const U = b.unloading || {};
    await tx.prepare(`INSERT INTO unloading (entry_id, truck_count, weight_ton, manpower_count) VALUES (?,?,?,?)
                ON CONFLICT(entry_id) DO UPDATE SET truck_count=excluded.truck_count,
                weight_ton=excluded.weight_ton, manpower_count=excluded.manpower_count`)
      .run(entryId, +U.truck_count || 0, +U.weight_ton || 0, +U.manpower_count || 0);

    // QC — per-part inspection lines roll up into the qc daily total.
    const Q = b.qc || {};
    await tx.prepare('DELETE FROM qc_lines WHERE entry_id = ?').run(entryId);
    let qcChecked = 0, qcRejected = 0, qcInserted = 0;
    for (const ln of (Array.isArray(Q.lines) ? Q.lines : [])) {
      const chk = +ln.checked_qty || 0, rej = +ln.rejected_qty || 0, rw = +ln.rework_qty || 0;
      if (chk === 0 && rej === 0 && rw === 0 && !ln.part_no) continue; // skip blank rows
      qcChecked += chk; qcRejected += rej; qcInserted++;
      await tx.prepare(`INSERT INTO qc_lines (entry_id, part_no, checked_qty, rejected_qty, rework_qty, defect_type, remarks)
                              VALUES (?,?,?,?,?,?,?)`)
        .run(entryId, ln.part_no || null, chk, rej, rw, ln.defect_type || null, ln.remarks || null);
    }
    // With detailed lines, parts_qty = total checked; otherwise the single field.
    const qcParts = qcInserted ? qcChecked : (+Q.parts_qty || 0);
    await tx.prepare(`INSERT INTO qc (entry_id, parts_qty, manpower_count) VALUES (?,?,?)
                ON CONFLICT(entry_id) DO UPDATE SET parts_qty=excluded.parts_qty,
                manpower_count=excluded.manpower_count`)
      .run(entryId, qcParts, +Q.manpower_count || 0);
    // Auto-derive PPM from defects when inspection lines exist (overrides manual).
    if (qcInserted && qcChecked > 0) {
      await tx.prepare('UPDATE daily_entries SET ppm = ? WHERE id = ?').run(Math.round((qcRejected / qcChecked) * 1e6), entryId);
    }

    // Transport
    await tx.prepare('DELETE FROM transport_trips WHERE entry_id = ?').run(entryId);
    for (const t of (b.transport || [])) {
      if (!t.from_loc || !t.to_loc || !t.vehicle_type) continue;
      // Normalise locations (trim + upper) so free-text entries still match the
      // configured route-rate table, which is keyed on uppercase location names.
      const from = String(t.from_loc).trim().toUpperCase();
      const to = String(t.to_loc).trim().toUpperCase();
      await tx.prepare(`INSERT INTO transport_trips (entry_id, from_loc, to_loc, vehicle_type, trip_time, remarks)
                             VALUES (?,?,?,?,?,?)`)
        .run(entryId, from, to, t.vehicle_type, t.trip_time || null, t.remarks || null);
    }

    if (b.submit) {
      await tx.prepare(`UPDATE daily_entries SET status='SUBMITTED', submitted_at=now(),
                  jmc_remarks=NULL, updated_at=now() WHERE id=?`).run(entryId);
    }
    return entryId;
  });

  try {
    const id = await run();
    audit(req.user.id, b.submit ? 'ENTRY_SUBMIT' : 'ENTRY_SAVE', { date: b.work_date });
    if (b.submit) alerts.notifyRealtime('ENTRY_SUBMITTED', { work_date: b.work_date, by: req.user.name });
    res.json({ entry: await loadEntry(id) });
  } catch (err) {
    res.status(err.http || 500).json({ error: err.message });
  }
});

// ---- Photo attachments (proof of work) ------------------------------------
app.post('/api/entries/:id/attachments', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const e = await db.prepare('SELECT * FROM daily_entries WHERE id = ?').get(Number(req.params.id));
  if (!e) return res.status(404).json({ error: 'Entry not found' });
  if (!isEditable(e.status)) return res.status(409).json({ error: 'Day is locked — cannot add photos' });
  const { dataUrl, caption } = req.body || {};
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return res.status(400).json({ error: 'Invalid image' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max ~6MB)' });
  const filename = `att_${e.id}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  await db.prepare('INSERT INTO attachments (entry_id, filename, caption, uploaded_by) VALUES (?,?,?,?)')
    .run(e.id, filename, caption || null, req.user.id);
  audit(req.user.id, 'PHOTO_ADD', { entry: e.id });
  res.json({ ok: true });
});

app.delete('/api/attachments/:id', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const a = await db.prepare('SELECT a.*, e.status FROM attachments a JOIN daily_entries e ON e.id=a.entry_id WHERE a.id=?').get(Number(req.params.id));
  if (!a) return res.status(404).json({ error: 'Not found' });
  if (!isEditable(a.status)) return res.status(409).json({ error: 'Day is locked' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, a.filename)); } catch (_) {}
  await db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  res.json({ ok: true });
});

// ---- Discrepancies (concern areas) ----------------------------------------
async function loadDisc(id) {
  return db.prepare(`SELECT d.*, ru.name AS raised_by_name, sv.name AS resolved_by_name,
    (COALESCE(d.qty_dispatched,0) - COALESCE(d.qty_billed,0)) AS variance
    FROM discrepancies d
    LEFT JOIN users ru ON ru.id = d.raised_by
    LEFT JOIN users sv ON sv.id = d.resolved_by WHERE d.id = ?`).get(id);
}

app.get('/api/discrepancies', auth, async (req, res) => {
  const { status, type, month } = req.query;
  let sql = `SELECT d.*, ru.name AS raised_by_name, sv.name AS resolved_by_name,
    (COALESCE(d.qty_dispatched,0) - COALESCE(d.qty_billed,0)) AS variance
    FROM discrepancies d
    LEFT JOIN users ru ON ru.id = d.raised_by
    LEFT JOIN users sv ON sv.id = d.resolved_by WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND d.status = ?'; args.push(status); }
  if (type) { sql += ' AND d.type = ?'; args.push(type); }
  if (month) { sql += ' AND substr(d.disc_date,1,7) = ?'; args.push(month); }
  sql += ' ORDER BY d.status DESC, d.created_at DESC LIMIT 400';
  res.json({ discrepancies: await db.prepare(sql).all(...args) });
});

app.post('/api/discrepancies', auth, requireRole('OPERATOR', 'JMC_APPROVER', 'ADMIN'), async (req, res) => {
  const b = req.body || {};
  const types = ['DISPATCH_VS_BILL','WRONG_PART','QR_ISSUE','TPH_HYZINE','OTHER'];
  if (!types.includes(b.type)) return res.status(400).json({ error: 'Invalid type' });
  const sev = ['LOW','MEDIUM','HIGH'].includes(b.severity) ? b.severity : 'MEDIUM';
  const row = await db.prepare(`INSERT INTO discrepancies
    (disc_date, type, part_no, description, qty_dispatched, qty_billed, qr_code, severity, raised_by, raised_company, qc_entry_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`)
    .get(b.disc_date || new Date().toISOString().slice(0,10), b.type, b.part_no || null, b.description || null,
      b.qty_dispatched != null && b.qty_dispatched !== '' ? Number(b.qty_dispatched) : null,
      b.qty_billed != null && b.qty_billed !== '' ? Number(b.qty_billed) : null,
      b.qr_code || null, sev, req.user.id, req.user.company,
      b.qc_entry_id != null && b.qc_entry_id !== '' ? Number(b.qc_entry_id) : null);
  audit(req.user.id, 'DISC_RAISE', { id: row.id, type: b.type });
  res.json({ discrepancy: await loadDisc(row.id) });
});

app.post('/api/discrepancies/:id/resolve', auth, requireRole('OPERATOR', 'JMC_APPROVER', 'ADMIN'), async (req, res) => {
  const d = await db.prepare('SELECT * FROM discrepancies WHERE id = ?').get(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Not found' });
  if (d.status === 'RESOLVED') return res.status(409).json({ error: 'Already resolved' });
  await db.prepare(`UPDATE discrepancies SET status='RESOLVED', resolution=?, resolved_by=?, resolved_at=now() WHERE id=?`)
    .run((req.body || {}).resolution || null, req.user.id, d.id);
  audit(req.user.id, 'DISC_RESOLVE', { id: d.id });
  res.json({ discrepancy: await loadDisc(d.id) });
});

// ---- EOD approval (JMC) ---------------------------------------------------
app.post('/api/entries/:id/decision', auth, requireRole('JMC_APPROVER', 'ADMIN'), async (req, res) => {
  const { decision, remarks } = req.body || {};
  const e = await db.prepare('SELECT * FROM daily_entries WHERE id = ?').get(Number(req.params.id));
  if (!e) return res.status(404).json({ error: 'Not found' });
  if (e.status !== 'SUBMITTED')
    return res.status(409).json({ error: 'Only submitted entries can be approved/rejected' });
  if (!['APPROVE', 'REJECT'].includes(decision))
    return res.status(400).json({ error: 'decision must be APPROVE or REJECT' });
  const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await db.prepare(`UPDATE daily_entries SET status=?, approved_by=?, approved_at=now(),
              jmc_remarks=?, updated_at=now() WHERE id=?`)
    .run(status, req.user.id, remarks || null, e.id);
  audit(req.user.id, 'ENTRY_' + status, { date: e.work_date, remarks });
  if (status === 'APPROVED') alerts.notifyRealtime('PNL_NEGATIVE', {});
  res.json({ entry: await loadEntry(e.id) });
});

// ---- Manpower requests ----------------------------------------------------
app.get('/api/manpower-requests', auth, async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT r.*, ru.name AS requested_by_name, du.name AS decided_by_name
             FROM manpower_requests r
             LEFT JOIN users ru ON ru.id = r.requested_by
             LEFT JOIN users du ON du.id = r.decided_by WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND r.status = ?'; args.push(status); }
  sql += ' ORDER BY r.created_at DESC LIMIT 200';
  res.json({ requests: await db.prepare(sql).all(...args) });
});

app.post('/api/manpower-requests', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const b = req.body || {};
  if (!b.category || !b.extra_count) return res.status(400).json({ error: 'category and extra_count required' });
  const today = new Date().toISOString().slice(0, 10);
  const row = await db.prepare(`INSERT INTO manpower_requests
    (req_date, needed_date, category, extra_count, reason, ppm_current, requested_by)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(today, b.needed_date || null, b.category, Number(b.extra_count), b.reason || null,
         b.ppm_current != null ? Number(b.ppm_current) : null, req.user.id);
  audit(req.user.id, 'MP_REQUEST', { id: row.id });
  alerts.notifyRealtime('MP_REQUEST', { by: req.user.name, category: b.category, extra_count: Number(b.extra_count), reason: b.reason });
  res.json({ id: row.id });
});

app.post('/api/manpower-requests/:id/decision', auth, requireRole('HQ', 'ADMIN'), async (req, res) => {
  const { decision, remarks } = req.body || {};
  const r = await db.prepare('SELECT * FROM manpower_requests WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (r.status !== 'PENDING') return res.status(409).json({ error: 'Already decided' });
  if (!['APPROVE', 'REJECT'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await db.prepare(`UPDATE manpower_requests SET status=?, decided_by=?, decided_at=now(), decision_remarks=? WHERE id=?`)
    .run(status, req.user.id, remarks || null, r.id);
  audit(req.user.id, 'MP_' + status, { id: r.id });
  res.json({ ok: true });
});

// ---- Reports / dashboard --------------------------------------------------
app.get('/api/summary', auth, async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const rows = await db.prepare(`
    SELECT e.id, e.work_date, e.status,
      COALESCE(l.parts_qty,0) load_parts, COALESCE(l.truck_count,0) load_trucks, COALESCE(l.manpower_count,0) load_mp,
      COALESCE(u.truck_count,0) unload_trucks, COALESCE(u.weight_ton,0) unload_ton,
      COALESCE(q.parts_qty,0) qc_parts, COALESCE(q.manpower_count,0) qc_mp,
      (SELECT COUNT(*)::int FROM transport_trips t WHERE t.entry_id = e.id) trips,
      (SELECT COALESCE(SUM(actual_count),0)::int FROM manpower_actual m WHERE m.entry_id = e.id) mp_actual
    FROM daily_entries e
    LEFT JOIN loading l ON l.entry_id = e.id
    LEFT JOIN unloading u ON u.entry_id = e.id
    LEFT JOIN qc q ON q.entry_id = e.id
    WHERE substr(e.work_date,1,7) = ?
    ORDER BY e.work_date`).all(month);

  const mg = (await getSetting('mg', config.MG)).qc_daily_parts;
  const totals = rows.reduce((t, r) => {
    t.load_parts += r.load_parts; t.load_trucks += r.load_trucks;
    t.unload_trucks += r.unload_trucks; t.unload_ton += r.unload_ton;
    t.qc_parts += r.qc_parts; t.trips += r.trips;
    if (r.status === 'APPROVED') t.approved_days++;
    if (r.qc_parts > 0 && r.qc_parts < mg) t.mg_short_days++;
    return t;
  }, { load_parts:0, load_trucks:0, unload_trucks:0, unload_ton:0, qc_parts:0, trips:0, approved_days:0, mg_short_days:0 });

  const docCutoff = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  res.json({ month, mg_target: mg, days: rows, totals,
    pending_approvals: (await db.prepare("SELECT COUNT(*)::int c FROM daily_entries WHERE status='SUBMITTED'").get()).c,
    pending_mp_requests: (await db.prepare("SELECT COUNT(*)::int c FROM manpower_requests WHERE status='PENDING'").get()).c,
    open_discrepancies: (await db.prepare("SELECT COUNT(*)::int c FROM discrepancies WHERE status='OPEN'").get()).c,
    pending_leaves: (await db.prepare("SELECT COUNT(*)::int c FROM leave_applications WHERE status='PENDING'").get()).c,
    pending_onboarding: (await db.prepare("SELECT COUNT(*)::int c FROM workers WHERE onboard_status='PENDING'").get()).c,
    expiring_docs: (await db.prepare("SELECT COUNT(*)::int c FROM worker_documents WHERE expiry_date IS NOT NULL AND expiry_date <= ?").get(docCutoff)).c,
    open_capa: (await db.prepare("SELECT COUNT(*)::int c FROM capa WHERE status NOT IN ('DONE','VERIFIED')").get()).c,
    overdue_capa: (await db.prepare("SELECT COUNT(*)::int c FROM capa WHERE status NOT IN ('DONE','VERIFIED') AND due_date IS NOT NULL AND due_date < ?").get(new Date().toISOString().slice(0,10))).c });
});

// ---- Billing / Invoice / P&L (Drona internal) -----------------------------
app.get('/api/billing', auth, requireRole('ADMIN', 'HQ'), async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  res.json(await reports.computeBilling(month));
});

// ---- MIS (management dashboard aggregation) -------------------------------
app.get('/api/mis', auth, async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const days = await db.prepare(`
    SELECT e.work_date, e.status, e.ppm,
      COALESCE(l.parts_qty,0) load_parts, COALESCE(l.truck_count,0) load_trucks, COALESCE(l.manpower_count,0) load_mp,
      COALESCE(u.truck_count,0) unload_trucks, COALESCE(u.weight_ton,0) unload_ton,
      COALESCE(q.parts_qty,0) qc_parts, COALESCE(q.manpower_count,0) qc_mp,
      (SELECT COUNT(*)::int FROM transport_trips t WHERE t.entry_id = e.id) trips,
      (SELECT COALESCE(SUM(actual_count),0)::int FROM manpower_actual m WHERE m.entry_id = e.id) mp_actual
    FROM daily_entries e
    LEFT JOIN loading l ON l.entry_id = e.id
    LEFT JOIN unloading u ON u.entry_id = e.id
    LEFT JOIN qc q ON q.entry_id = e.id
    WHERE substr(e.work_date,1,7) = ? ORDER BY e.work_date`).all(month);

  const approved = await getSetting('approved_manpower', config.APPROVED_MANPOWER);
  const approvedTotal = approved.reduce((a, x) => a + x.approved, 0);
  const mgTarget = (await getSetting('mg', config.MG)).qc_daily_parts;
  const ppmTarget = await getSetting('ppm_target', config.PPM_TARGET);
  const ppmDays = days.filter(d => d.ppm != null);
  const ppmAvg = ppmDays.length ? Math.round(ppmDays.reduce((a, d) => a + d.ppm, 0) / ppmDays.length) : null;

  const mpCat = await db.prepare(`SELECT category, COUNT(*)::int days, AVG(actual_count)::float avg_actual, SUM(actual_count)::int sum_actual
    FROM manpower_actual m JOIN daily_entries e ON e.id = m.entry_id
    WHERE substr(e.work_date,1,7) = ? GROUP BY category`).all(month);

  const discByType = await db.prepare(`SELECT type, COUNT(*)::int c, SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END)::int open_c
    FROM discrepancies WHERE substr(disc_date,1,7) = ? GROUP BY type`).all(month);
  const discBySev = await db.prepare(`SELECT severity, COUNT(*)::int c FROM discrepancies
    WHERE substr(disc_date,1,7) = ? GROUP BY severity`).all(month);
  const discTot = await db.prepare(`SELECT COUNT(*)::int total, SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END)::int open_c,
    COALESCE(SUM(qty_dispatched),0)::int disp, COALESCE(SUM(qty_billed),0)::int bill,
    COALESCE(SUM(COALESCE(qty_dispatched,0)-COALESCE(qty_billed,0)),0)::int variance
    FROM discrepancies WHERE substr(disc_date,1,7) = ?`).get(month);

  const trByVehicle = await db.prepare(`SELECT vehicle_type, COUNT(*)::int c
    FROM transport_trips t JOIN daily_entries e ON e.id = t.entry_id
    WHERE substr(e.work_date,1,7) = ? GROUP BY vehicle_type ORDER BY c DESC`).all(month);
  const trByRoute = await db.prepare(`SELECT from_loc || ' → ' || to_loc route, vehicle_type, COUNT(*)::int c
    FROM transport_trips t JOIN daily_entries e ON e.id = t.entry_id
    WHERE substr(e.work_date,1,7) = ? GROUP BY from_loc, to_loc, vehicle_type ORDER BY c DESC`).all(month);

  const mpReq = await db.prepare(`SELECT status, COUNT(*)::int c, COALESCE(SUM(extra_count),0)::int extra
    FROM manpower_requests WHERE substr(req_date,1,7) = ? GROUP BY status`).all(month);

  const totals = days.reduce((t, d) => {
    t.load_parts += d.load_parts; t.load_trucks += d.load_trucks;
    t.unload_trucks += d.unload_trucks; t.unload_ton += d.unload_ton;
    t.qc_parts += d.qc_parts; t.trips += d.trips; t.mp_actual += d.mp_actual;
    if (d.qc_parts > 0 && d.qc_parts < mgTarget) t.mg_short_days++;
    if (d.qc_parts >= mgTarget) t.mg_met_days++;
    if (d.status === 'APPROVED') t.approved_days++;
    return t;
  }, { load_parts:0, load_trucks:0, unload_trucks:0, unload_ton:0, qc_parts:0, trips:0, mp_actual:0, mg_short_days:0, mg_met_days:0, approved_days:0 });

  const opDays = days.length;
  const qcDays = days.filter(d => d.qc_parts > 0).length;
  const avgMpPerDay = opDays ? totals.mp_actual / opDays : 0;
  const utilization = approvedTotal ? Math.round((avgMpPerDay / approvedTotal) * 100) : 0;
  const mgAchievement = qcDays ? Math.round((totals.mg_met_days / qcDays) * 100) : 0;

  // QC quality — derived from per-part inspection lines this month.
  const qcQ = await db.prepare(`SELECT COALESCE(SUM(checked_qty),0)::int checked, COALESCE(SUM(rejected_qty),0)::int rejected, COALESCE(SUM(rework_qty),0)::int rework
    FROM qc_lines ql JOIN daily_entries e ON e.id = ql.entry_id WHERE substr(e.work_date,1,7) = ?`).get(month);
  const defectPareto = await db.prepare(`SELECT COALESCE(defect_type,'OTHER') defect_type, SUM(rejected_qty)::int qty
    FROM qc_lines ql JOIN daily_entries e ON e.id = ql.entry_id
    WHERE substr(e.work_date,1,7) = ? AND rejected_qty > 0
    GROUP BY COALESCE(defect_type,'OTHER') ORDER BY qty DESC`).all(month);
  const qcQuality = {
    checked: qcQ.checked, rejected: qcQ.rejected, rework: qcQ.rework,
    passed: Math.max(0, qcQ.checked - qcQ.rejected - qcQ.rework),
    rejection_rate: qcQ.checked ? +((qcQ.rejected / qcQ.checked) * 100).toFixed(2) : 0,
    fpy: qcQ.checked ? +(((qcQ.checked - qcQ.rejected - qcQ.rework) / qcQ.checked) * 100).toFixed(1) : null,
    ppm_derived: qcQ.checked ? Math.round((qcQ.rejected / qcQ.checked) * 1e6) : null,
  };

  res.json({ month, mgTarget, ppmTarget, ppmAvg, approved, approvedTotal, days, mpCat, discByType, discBySev, discTot,
    trByVehicle, trByRoute, mpReq, totals, opDays, qcDays, avgMpPerDay, utilization, mgAchievement,
    qcQuality, defectPareto });
});

// ---- Admin: settings + users ---------------------------------------------
app.put('/api/settings', auth, requireRole('ADMIN'), async (req, res) => {
  const b = req.body || {};
  if (b.rates) await setSetting('rates', b.rates);
  if (b.mg) await setSetting('mg', b.mg);
  if (b.approvedManpower) await setSetting('approved_manpower', b.approvedManpower);
  if (typeof b.showBilling === 'boolean') await setSetting('show_billing', b.showBilling);
  if (b.costs) await setSetting('costs', b.costs);
  if (b.invoice) await setSetting('invoice', b.invoice);
  if (b.ppmTarget != null) await setSetting('ppm_target', Number(b.ppmTarget));
  if (typeof b.mgBilling === 'boolean') await setSetting('mg_billing', b.mgBilling);
  if (b.transportRates) await setSetting('transport_rates', b.transportRates);
  if (b.leavePolicy) await setSetting('leave_policy', b.leavePolicy);
  if (b.alerts) await setSetting('alerts', b.alerts);
  audit(req.user.id, 'SETTINGS_UPDATE');
  res.json({ config: await clientConfig(req.user) });
});

app.get('/api/users', auth, requireRole('ADMIN'), async (req, res) => {
  res.json({ users: await db.prepare('SELECT id, name, username, role, company, active FROM users ORDER BY id').all() });
});

app.post('/api/users', auth, requireRole('ADMIN'), async (req, res) => {
  const { name, username, password, role, company } = req.body || {};
  if (!name || !username || !password || !role || !company)
    return res.status(400).json({ error: 'All fields required' });
  if (password.length < 5) return res.status(400).json({ error: 'Password must be at least 5 characters' });
  if (!config.ROLES[role]) return res.status(400).json({ error: 'Invalid role' });
  try {
    await db.prepare(`INSERT INTO users (name, username, password_hash, role, company) VALUES (?,?,?,?,?)`)
      .run(name, username.trim(), bcrypt.hashSync(password, 10), role, company);
    audit(req.user.id, 'USER_CREATE', { username });
    res.json({ ok: true });
  } catch (e) {
    if (/duplicate key|unique/i.test(e.message)) return res.status(409).json({ error: 'Username already exists' });
    throw e;
  }
});

app.post('/api/users/:id/toggle', auth, requireRole('ADMIN'), async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Not found' });
  // Don't let the last active admin be deactivated — that would lock everyone out of Admin.
  if (u.role === 'ADMIN' && u.active === true) {
    const activeAdmins = (await db.prepare("SELECT COUNT(*)::int c FROM users WHERE role='ADMIN' AND active=true").get()).c;
    if (activeAdmins <= 1) return res.status(409).json({ error: 'Cannot deactivate the last active admin' });
  }
  await db.prepare('UPDATE users SET active = NOT active WHERE id=?').run(u.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-password', auth, requireRole('ADMIN'), async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 5) return res.status(400).json({ error: 'Password too short' });
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password, 10), Number(req.params.id));
  res.json({ ok: true });
});

// ---- Workers (HR master) --------------------------------------------------
const WORKER_FIELDS = ['roll_no','name','father_name','gender','dob','blood_group','mobile','address',
  'aadhaar','pan','uan','esic_no','department','designation','date_of_joining','date_of_exit','supervisor',
  'wage_type','monthly_gross','daily_wage','basic','hra','allowances','pf_applicable','esi_applicable',
  'bank_holder','bank_name','account_no','ifsc','emergency_name','emergency_phone','emergency_relation','status'];
const maskTail = (s, keep = 4) => { s = String(s || ''); return s ? '••••' + s.slice(-keep) : ''; };
// Roles allowed to see Drona's HR/worker data at all (the JMC client is excluded).
const DRONA_HR = ['OPERATOR', 'HQ', 'ADMIN'];
// Identifier fields masked for any role that isn't full-PII management.
const MASK_FIELDS = ['aadhaar', 'pan', 'uan', 'esic_no', 'account_no', 'ifsc'];

async function workerDocs(id) {
  return (await db.prepare(`SELECT d.id, d.doc_type, d.doc_slot, d.filename, d.caption, d.expiry_date, d.created_at, u.name uploaded_by_name
    FROM worker_documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.worker_id = ? ORDER BY d.id`).all(id))
    .map(d => ({ ...d, url: '/uploads/' + d.filename, is_pdf: /\.pdf$/i.test(d.filename) }));
}

app.get('/api/workers', auth, requireRole(...DRONA_HR), async (req, res) => {
  const { status, department, q, onboard } = req.query;
  let sql = 'SELECT * FROM workers WHERE 1=1'; const args = [];
  if (status) { sql += ' AND status = ?'; args.push(status); }
  if (department) { sql += ' AND department = ?'; args.push(department); }
  if (onboard) { sql += ' AND onboard_status = ?'; args.push(onboard); }
  if (q) { sql += ' AND (name LIKE ? OR roll_no LIKE ? OR mobile LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY CASE status WHEN \'ACTIVE\' THEN 0 ELSE 1 END, name LIMIT 1000';
  const rows = (await db.prepare(sql).all(...args)).map(w => ({
    id: w.id, roll_no: w.roll_no, name: w.name, father_name: w.father_name, department: w.department,
    designation: w.designation, mobile: w.mobile, status: w.status, date_of_joining: w.date_of_joining,
    aadhaar_masked: maskTail(w.aadhaar), account_masked: maskTail(w.account_no),
    wage_type: w.wage_type, monthly_gross: w.monthly_gross, daily_wage: w.daily_wage,
    onboard_status: w.onboard_status, has_offer: !!w.offer_letter_file,
    photo: w.photo ? '/uploads/' + w.photo : null,
  }));
  res.json({ workers: rows });
});

app.get('/api/workers/:id', auth, requireRole(...DRONA_HR), async (req, res) => {
  const w = await db.prepare('SELECT * FROM workers WHERE id = ?').get(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'Not found' });
  // Full PII only for Drona management; any other role gets all identifiers masked.
  const full = ['ADMIN', 'HQ', 'OPERATOR'].includes(req.user.role);
  if (!full) MASK_FIELDS.forEach(f => { w[f] = maskTail(w[f]); });
  w.photo_url = w.photo ? '/uploads/' + w.photo : null;
  w.offer_letter_url = w.offer_letter_file ? '/uploads/' + w.offer_letter_file : null;
  w.documents = await workerDocs(w.id);
  res.json({ worker: w });
});

function collectWorker(b) {
  const o = {};
  for (const f of WORKER_FIELDS) {
    if (!(f in b)) { o[f] = null; continue; }
    if (['monthly_gross','daily_wage','basic','hra','allowances'].includes(f)) o[f] = Number(b[f]) || 0;
    else if (['pf_applicable','esi_applicable'].includes(f)) o[f] = !!b[f];
    else o[f] = b[f] === '' ? null : b[f];
  }
  if (!o.status) o.status = 'ACTIVE';
  if (!o.wage_type) o.wage_type = 'MONTHLY';
  return o;
}

app.post('/api/workers', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'Name is required' });
  const o = collectWorker(b);
  const cols = WORKER_FIELDS, ph = cols.map(() => '?').join(',');
  try {
    // New hires begin onboarding as DRAFT; they only join attendance/payroll
    // rosters once HQ approves them.
    const row = await db.prepare(`INSERT INTO workers (${cols.join(',')}, onboard_status) VALUES (${ph}, 'DRAFT') RETURNING id`)
      .get(...cols.map(c => o[c]));
    audit(req.user.id, 'WORKER_CREATE', { id: row.id });
    res.json({ id: row.id });
  } catch (e) {
    if (/duplicate key|unique/i.test(e.message)) return res.status(409).json({ error: 'Roll no already exists' });
    console.error('Worker save error:', e);
    return res.status(500).json({ error: 'Could not save worker' });
  }
});

app.put('/api/workers/:id', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const w = await db.prepare('SELECT id FROM workers WHERE id = ?').get(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'Not found' });
  const o = collectWorker(req.body || {});
  const set = WORKER_FIELDS.map(c => `${c}=?`).join(',');
  try {
    await db.prepare(`UPDATE workers SET ${set}, updated_at=now() WHERE id=?`).run(...WORKER_FIELDS.map(c => o[c]), w.id);
    audit(req.user.id, 'WORKER_UPDATE', { id: w.id });
    res.json({ ok: true });
  } catch (e) {
    if (/duplicate key|unique/i.test(e.message)) return res.status(409).json({ error: 'Roll no already exists' });
    console.error('Worker save error:', e);
    return res.status(500).json({ error: 'Could not save worker' });
  }
});

// Worker photo + documents (base64 image, client pre-resized)
function saveImage(dataUrl, prefix) {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) return { error: 'Image too large' };
  const filename = `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return { filename };
}

// Worker documents may be images OR PDFs (Aadhaar, PAN, passbook scans, etc).
function saveDocument(dataUrl, prefix) {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp)|application\/pdf);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const mime = m[1];
  const ext = mime === 'application/pdf' ? 'pdf' : (mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 12 * 1024 * 1024) return { error: 'File too large (max 12 MB)' };
  const filename = `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
  return { filename };
}

app.post('/api/workers/:id/photo', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const w = await db.prepare('SELECT * FROM workers WHERE id=?').get(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'Not found' });
  const r = saveImage((req.body || {}).dataUrl, 'wphoto');
  if (!r || r.error) return res.status(400).json({ error: r ? r.error : 'Invalid image' });
  if (w.photo) { try { fs.unlinkSync(path.join(UPLOAD_DIR, w.photo)); } catch (_) {} }
  await db.prepare('UPDATE workers SET photo=? WHERE id=?').run(r.filename, w.id);
  res.json({ url: '/uploads/' + r.filename });
});

const DOC_SLOTS = ['AADHAAR', 'PAN', 'PASSBOOK', 'OTHER'];
app.post('/api/workers/:id/documents', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const w = await db.prepare('SELECT id FROM workers WHERE id=?').get(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const r = saveDocument(b.dataUrl, 'wdoc');
  if (!r || r.error) return res.status(400).json({ error: r ? r.error : 'Only image or PDF files are accepted' });
  const slot = DOC_SLOTS.includes(b.doc_slot) ? b.doc_slot : 'OTHER';
  // One document per fixed slot (except OTHER) — replace any existing file.
  if (slot !== 'OTHER') {
    const prev = await db.prepare('SELECT id, filename FROM worker_documents WHERE worker_id=? AND doc_slot=?').all(w.id, slot);
    for (const p of prev) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, p.filename)); } catch (_) {}
      await db.prepare('DELETE FROM worker_documents WHERE id=?').run(p.id);
    }
  }
  await db.prepare('INSERT INTO worker_documents (worker_id, doc_type, doc_slot, filename, caption, expiry_date, uploaded_by) VALUES (?,?,?,?,?,?,?)')
    .run(w.id, b.doc_type || slot, slot, r.filename, b.caption || null, b.expiry_date || null, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/worker-documents/:id', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const d = await db.prepare('SELECT * FROM worker_documents WHERE id=?').get(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(path.join(UPLOAD_DIR, d.filename)); } catch (_) {}
  await db.prepare('DELETE FROM worker_documents WHERE id=?').run(d.id);
  res.json({ ok: true });
});

// ---- Onboarding workflow (OPERATOR submits -> HQ approves) -----------------
const REQUIRED_DOC_SLOTS = ['AADHAAR', 'PAN', 'PASSBOOK'];

// Fields/documents a candidate must have before HQ approval is requested.
async function onboardingGaps(w) {
  const gaps = [];
  if (!w.name) gaps.push('full name');
  if (!w.designation) gaps.push('designation');
  if (!w.date_of_joining) gaps.push('date of joining');
  if (!(Number(w.monthly_gross) > 0 || Number(w.daily_wage) > 0)) gaps.push('salary');
  if (!w.photo) gaps.push('passport photo');
  const slots = new Set((await db.prepare('SELECT doc_slot FROM worker_documents WHERE worker_id=?').all(w.id)).map(d => d.doc_slot));
  REQUIRED_DOC_SLOTS.forEach(s => { if (!slots.has(s)) gaps.push(s.charAt(0) + s.slice(1).toLowerCase() + ' document'); });
  return gaps;
}

app.get('/api/workers/:id/onboarding-gaps', auth, requireRole(...DRONA_HR), async (req, res) => {
  const w = await db.prepare('SELECT * FROM workers WHERE id=?').get(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json({ status: w.onboard_status, gaps: await onboardingGaps(w) });
});

app.post('/api/workers/:id/submit', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const w = await db.prepare('SELECT * FROM workers WHERE id=?').get(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (!['DRAFT', 'REJECTED'].includes(w.onboard_status))
    return res.status(409).json({ error: 'Already submitted or approved' });
  const gaps = await onboardingGaps(w);
  if (gaps.length) return res.status(400).json({ error: 'Incomplete — add: ' + gaps.join(', ') });
  await db.prepare("UPDATE workers SET onboard_status='PENDING', submitted_by=?, submitted_at=now() WHERE id=?")
    .run(req.user.id, w.id);
  audit(req.user.id, 'ONBOARD_SUBMIT', { id: w.id });
  res.json({ ok: true });
});

function decideOnboarding(decision) {
  return async (req, res) => {
    const w = await db.prepare('SELECT * FROM workers WHERE id=?').get(Number(req.params.id));
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (w.onboard_status !== 'PENDING') return res.status(409).json({ error: 'Not pending approval' });
    const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    await db.prepare("UPDATE workers SET onboard_status=?, approved_by=?, approved_at=now(), approval_remarks=? WHERE id=?")
      .run(status, req.user.id, (req.body || {}).remarks || null, w.id);
    audit(req.user.id, 'ONBOARD_' + status, { id: w.id });
    res.json({ ok: true });
  };
}
app.post('/api/workers/:id/approve', auth, requireRole('HQ', 'ADMIN'), decideOnboarding('APPROVE'));
app.post('/api/workers/:id/reject', auth, requireRole('HQ', 'ADMIN'), decideOnboarding('REJECT'));

// ---- Offer letter (PDF, generated only after approval) ---------------------
// pdfkit's built-in fonts are WinAnsi-encoded and lack the ₹ glyph, so money is
// rendered with the "Rs." prefix.
function rs(n) { return 'Rs. ' + Number(n || 0).toLocaleString('en-IN'); }
function generateOfferLetter(filePath, t, cfg) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    const stream = fs.createWriteStream(filePath);
    stream.on('finish', resolve); stream.on('error', reject); doc.on('error', reject);
    doc.pipe(stream);

    // Letterhead
    doc.fontSize(18).font('Helvetica-Bold').text(cfg.company, { align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text([cfg.address, cfg.city, [cfg.email, cfg.phone].filter(Boolean).join('  ·  ')].filter(Boolean).join('\n'), { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#cccccc').stroke();
    doc.moveDown(1).fillColor('#000');

    doc.fontSize(10).font('Helvetica').text('Date: ' + t.letter_date, { align: 'right' });
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(11).text('To,');
    doc.font('Helvetica').fontSize(10).text(t.name);
    if (t.address) doc.text(t.address);
    doc.moveDown(1);

    doc.font('Helvetica-Bold').fontSize(12).text('Subject: Offer of Employment', { underline: true });
    doc.moveDown(0.8);

    doc.font('Helvetica').fontSize(10.5);
    doc.text(`Dear ${t.name},`);
    doc.moveDown(0.6);
    doc.text(`We are pleased to offer you the position of ${t.designation || '—'}` +
      (t.department ? ` in the ${t.department} department` : '') +
      ` at ${cfg.company}. Your appointment is effective from ${t.date_of_joining || '—'}.`,
      { align: 'justify' });
    doc.moveDown(0.8);

    doc.font('Helvetica-Bold').text('Compensation');
    doc.font('Helvetica').moveDown(0.3);
    const row = (label, val) => {
      const y = doc.y;
      doc.text(label, 70, y, { width: 260, continued: false });
      doc.text(val, 330, y, { width: 200, align: 'right' });
      doc.moveDown(0.2);
    };
    if (t.wage_type === 'DAILY') {
      row('Daily wage', rs(t.daily_wage));
    } else {
      if (t.basic)      row('Basic', rs(t.basic) + ' / month');
      if (t.hra)        row('House Rent Allowance', rs(t.hra) + ' / month');
      if (t.allowances) row('Other Allowances', rs(t.allowances) + ' / month');
      doc.font('Helvetica-Bold'); row('Gross (monthly)', rs(t.monthly_gross)); doc.font('Helvetica');
    }
    doc.moveDown(0.3).fontSize(9).fillColor('#555')
      .text('Statutory deductions (PF / ESI, as applicable) will be made per prevailing law.', 70);
    doc.fillColor('#000').fontSize(10.5).moveDown(0.8);

    doc.text(`This offer carries a probation period of ${cfg.probation_months} months. After confirmation, ` +
      `either party may terminate the engagement with ${cfg.notice_days} days’ written notice.`, { align: 'justify' });
    doc.moveDown(0.6);
    if (cfg.notes) doc.fontSize(9.5).fillColor('#444').text(cfg.notes, { align: 'justify' }).fillColor('#000').fontSize(10.5);
    doc.moveDown(0.8);
    doc.text('We look forward to welcoming you to the team.');
    doc.moveDown(2);

    doc.font('Helvetica-Bold').text(cfg.signatory_name);
    doc.font('Helvetica').fontSize(9.5).fillColor('#555').text(cfg.signatory_title);
    doc.fillColor('#000');

    doc.moveDown(3).fontSize(9).fillColor('#777')
      .text('_______________________________', { continued: false })
      .text(`Accepted by ${t.name}   (Signature / Date)`);

    doc.end();
  });
}

app.post('/api/workers/:id/offer-letter', auth, requireRole('HQ', 'ADMIN'), async (req, res) => {
  const w = await db.prepare('SELECT * FROM workers WHERE id=?').get(Number(req.params.id));
  if (!w) return res.status(404).json({ error: 'Not found' });
  if (w.onboard_status !== 'APPROVED') return res.status(409).json({ error: 'Worker must be approved before generating an offer letter' });
  const cfg = await getSetting('offer', config.OFFER);
  const b = req.body || {};
  const pick = (k) => b[k] != null && b[k] !== '' ? b[k] : w[k];
  const terms = {
    name: w.name,
    address: w.address || '',
    designation: pick('designation') || '',
    department: pick('department') || '',
    date_of_joining: pick('date_of_joining') || '',
    wage_type: w.wage_type || 'MONTHLY',
    monthly_gross: Number(pick('monthly_gross')) || 0,
    basic: Number(pick('basic')) || 0,
    hra: Number(pick('hra')) || 0,
    allowances: Number(pick('allowances')) || 0,
    daily_wage: Number(pick('daily_wage')) || 0,
    letter_date: b.letter_date || new Date().toISOString().slice(0, 10),
  };
  const filename = `offer_${w.id}_${Date.now()}.pdf`;
  try {
    await generateOfferLetter(path.join(UPLOAD_DIR, filename), terms, cfg);
  } catch (e) {
    console.error('Offer letter error:', e);
    return res.status(500).json({ error: 'Could not generate offer letter' });
  }
  if (w.offer_letter_file) { try { fs.unlinkSync(path.join(UPLOAD_DIR, w.offer_letter_file)); } catch (_) {} }
  await db.prepare("UPDATE workers SET offer_letter_file=?, offer_letter_at=now(), offer_terms=? WHERE id=?")
    .run(filename, JSON.stringify(terms), w.id);
  audit(req.user.id, 'OFFER_LETTER', { id: w.id });
  res.json({ url: '/uploads/' + filename });
});

// ---- Attendance -----------------------------------------------------------
app.get('/api/attendance', auth, requireRole(...DRONA_HR), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const dept = req.query.department;
  let sql = `SELECT w.id worker_id, w.roll_no, w.name, w.department,
      a.status, a.in_time, a.out_time, a.ot_hours, a.remarks
    FROM workers w
    LEFT JOIN attendance a ON a.worker_id = w.id AND a.work_date = ?
    WHERE w.status = 'ACTIVE' AND w.onboard_status = 'APPROVED'`;
  const args = [date];
  if (dept) { sql += ' AND w.department = ?'; args.push(dept); }
  sql += ' ORDER BY w.department, w.name';
  res.json({ date, rows: await db.prepare(sql).all(...args) });
});

app.post('/api/attendance', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const { date, records } = req.body || {};
  if (!date || !Array.isArray(records)) return res.status(400).json({ error: 'date and records required' });
  const run = db.transaction(async (tx) => {
    for (const r of records) {
      await tx.prepare(`INSERT INTO attendance (work_date, worker_id, status, in_time, out_time, ot_hours, remarks, marked_by)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(work_date, worker_id) DO UPDATE SET status=excluded.status, in_time=excluded.in_time,
          out_time=excluded.out_time, ot_hours=excluded.ot_hours, remarks=excluded.remarks, marked_by=excluded.marked_by`)
        .run(date, Number(r.worker_id), r.status || 'PRESENT', r.in_time || null, r.out_time || null,
          Number(r.ot_hours) || 0, r.remarks || null, req.user.id);
    }
  });
  await run();
  audit(req.user.id, 'ATTENDANCE_SAVE', { date, count: records.length });
  res.json({ ok: true, saved: records.length });
});

app.get('/api/attendance/register', auth, requireRole(...DRONA_HR), async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const workers = await db.prepare("SELECT id, roll_no, name, department FROM workers WHERE status='ACTIVE' AND onboard_status='APPROVED' ORDER BY department, name").all();
  const recs = await db.prepare(`SELECT worker_id, work_date, status, ot_hours FROM attendance WHERE substr(work_date,1,7)=?`).all(month);
  const byWorker = {};
  for (const r of recs) {
    (byWorker[r.worker_id] = byWorker[r.worker_id] || {})[r.work_date.slice(8)] = { s: r.status, ot: r.ot_hours };
  }
  const present = (s) => s === 'PRESENT' ? 1 : s === 'HALF_DAY' ? 0.5 : 0;
  const rows = workers.map(w => {
    const days = byWorker[w.id] || {};
    let p = 0, a = 0, l = 0, ot = 0;
    Object.values(days).forEach(d => { p += present(d.s); if (d.s === 'ABSENT') a++; if (d.s === 'LEAVE') l++; ot += d.ot || 0; });
    return { ...w, days, present_days: p, absent_days: a, leave_days: l, ot_hours: ot };
  });
  res.json({ month, workers: rows });
});

// ---- Leave management -----------------------------------------------------
function daysInclusive(from, to) {
  const a = new Date(from), b = new Date(to);
  if (isNaN(a) || isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

app.get('/api/leave', auth, requireRole(...DRONA_HR), async (req, res) => {
  const { status, worker_id, year } = req.query;
  let sql = `SELECT l.*, w.name worker_name, w.roll_no, w.department,
      ab.name applied_by_name, db_.name decided_by_name
    FROM leave_applications l
    JOIN workers w ON w.id = l.worker_id
    LEFT JOIN users ab ON ab.id = l.applied_by
    LEFT JOIN users db_ ON db_.id = l.decided_by WHERE 1=1`;
  const args = [];
  if (status) { sql += ' AND l.status = ?'; args.push(status); }
  if (worker_id) { sql += ' AND l.worker_id = ?'; args.push(Number(worker_id)); }
  if (year) { sql += ' AND substr(l.from_date,1,4) = ?'; args.push(String(year)); }
  sql += ' ORDER BY l.status DESC, l.from_date DESC LIMIT 500';
  res.json({ leaves: await db.prepare(sql).all(...args) });
});

app.post('/api/leave', auth, requireRole('OPERATOR', 'ADMIN'), async (req, res) => {
  const b = req.body || {};
  if (!b.worker_id || !b.leave_type || !b.from_date || !b.to_date)
    return res.status(400).json({ error: 'worker, type, from and to dates are required' });
  if (!config.LEAVE_TYPES.includes(b.leave_type)) return res.status(400).json({ error: 'Invalid leave type' });
  const days = b.days != null && b.days !== '' ? Number(b.days) : daysInclusive(b.from_date, b.to_date);
  if (days <= 0) return res.status(400).json({ error: 'Invalid date range' });
  const row = await db.prepare(`INSERT INTO leave_applications (worker_id, leave_type, from_date, to_date, days, reason, applied_by)
    VALUES (?,?,?,?,?,?,?) RETURNING id`).get(Number(b.worker_id), b.leave_type, b.from_date, b.to_date, days, b.reason || null, req.user.id);
  audit(req.user.id, 'LEAVE_APPLY', { id: row.id });
  res.json({ id: row.id });
});

app.post('/api/leave/:id/decision', auth, requireRole('HQ', 'ADMIN'), async (req, res) => {
  const { decision, remarks } = req.body || {};
  const l = await db.prepare('SELECT * FROM leave_applications WHERE id = ?').get(Number(req.params.id));
  if (!l) return res.status(404).json({ error: 'Not found' });
  if (l.status !== 'PENDING') return res.status(409).json({ error: 'Already decided' });
  if (!['APPROVE', 'REJECT'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
  const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await db.prepare(`UPDATE leave_applications SET status=?, decided_by=?, decided_at=now(), decision_remarks=? WHERE id=?`)
    .run(status, req.user.id, remarks || null, l.id);
  audit(req.user.id, 'LEAVE_' + status, { id: l.id });
  res.json({ ok: true });
});

app.get('/api/leave/balances', auth, requireRole(...DRONA_HR), async (req, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  const policy = await getSetting('leave_policy', config.LEAVE_POLICY);
  const workers = req.query.worker_id
    ? await db.prepare("SELECT id, roll_no, name, department FROM workers WHERE id = ?").all(Number(req.query.worker_id))
    : await db.prepare("SELECT id, roll_no, name, department FROM workers WHERE status='ACTIVE' AND onboard_status='APPROVED' ORDER BY name").all();
  const taken = await db.prepare(`SELECT worker_id, leave_type, COALESCE(SUM(days),0)::float d
    FROM leave_applications WHERE status='APPROVED' AND substr(from_date,1,4)=? GROUP BY worker_id, leave_type`).all(year);
  const takenMap = {};
  taken.forEach(t => { (takenMap[t.worker_id] = takenMap[t.worker_id] || {})[t.leave_type] = t.d; });
  const rows = workers.map(w => {
    const byType = config.LEAVE_TYPES.map(t => {
      const ent = policy[t] || 0, used = (takenMap[w.id] || {})[t] || 0;
      return { type: t, entitlement: ent, taken: used, balance: ent - used };
    });
    return { ...w, byType };
  });
  res.json({ year, policy, types: config.LEAVE_TYPES, workers: rows });
});

// ---- Compliance: wage register --------------------------------------------
app.get('/api/compliance/wage-register', auth, requireRole('ADMIN', 'HQ'), async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const stdDays = config.WORKING_DAYS_PER_MONTH || 26;
  const workers = await db.prepare("SELECT * FROM workers WHERE status='ACTIVE' AND onboard_status='APPROVED' ORDER BY department, name").all();
  const att = await db.prepare(`SELECT worker_id, status, ot_hours FROM attendance WHERE substr(work_date,1,7)=?`).all(month);
  const byW = {};
  att.forEach(a => { const m = byW[a.worker_id] = byW[a.worker_id] || { p: 0, ot: 0 };
    m.p += a.status === 'PRESENT' ? 1 : a.status === 'HALF_DAY' ? 0.5 : 0; m.ot += a.ot_hours || 0; });
  let tot = { present: 0, gross: 0, ot: 0, pf: 0, esi: 0, net: 0 };
  const rows = workers.map(w => {
    const m = byW[w.id] || { p: 0, ot: 0 };
    const r = calc.wageRow(w, m.p, m.ot, stdDays);
    tot.present += m.p; tot.gross += r.gross; tot.ot += r.ot_pay; tot.pf += r.pf; tot.esi += r.esi; tot.net += r.net;
    return { id: w.id, roll_no: w.roll_no, name: w.name, department: w.department, wage_type: w.wage_type,
      present_days: m.p, ot_hours: m.ot, gross: r.gross, ot_pay: r.ot_pay, pf: r.pf, esi: r.esi, net: r.net };
  });
  res.json({ month, std_days: stdDays, rows, totals: tot });
});

// ---- Compliance: document expiry ------------------------------------------
app.get('/api/compliance/document-expiry', auth, requireRole(...DRONA_HR), async (req, res) => {
  const days = Number(req.query.days || 45);
  const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const rows = (await db.prepare(`SELECT d.id, d.doc_type, d.expiry_date, d.filename, w.id worker_id, w.name worker_name, w.roll_no, w.department
    FROM worker_documents d JOIN workers w ON w.id = d.worker_id
    WHERE d.expiry_date IS NOT NULL AND d.expiry_date <= ?
    ORDER BY d.expiry_date`).all(cutoff))
    .map(r => ({ ...r, url: '/uploads/' + r.filename, expired: r.expiry_date < today }));
  res.json({ within_days: days, documents: rows });
});

// ---- Audit log (Admin) ----------------------------------------------------
app.get('/api/audit', auth, requireRole('ADMIN'), async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const rows = await db.prepare(`SELECT a.id, a.action, a.detail, a.at, u.name AS user_name, u.username
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC LIMIT ?`).all(limit);
  res.json({ entries: rows });
});

// ---- PDI parts master -----------------------------------------------------
app.get('/api/pdi-parts', auth, async (req, res) => {
  const all = req.query.all === '1' && req.user.role === 'ADMIN';
  const sql = 'SELECT id, part_no, category, description, active FROM pdi_parts'
    + (all ? '' : ' WHERE active = true') + ' ORDER BY category, part_no';
  res.json({ parts: await db.prepare(sql).all() });
});

app.post('/api/pdi-parts', auth, requireRole('ADMIN'), async (req, res) => {
  const b = req.body || {};
  const part_no = String(b.part_no || '').trim().toUpperCase();
  if (!part_no) return res.status(400).json({ error: 'Part number required' });
  const category = ['CHASSIS', 'BUS_BODY', 'OTHER'].includes(b.category) ? b.category : 'OTHER';
  try {
    const row = await db.prepare('INSERT INTO pdi_parts (part_no, category, description) VALUES (?,?,?) RETURNING id')
      .get(part_no, category, b.description || null);
    audit(req.user.id, 'PDI_PART_ADD', { part_no });
    res.json({ id: row.id });
  } catch (e) {
    if (/duplicate key|unique/i.test(e.message)) return res.status(409).json({ error: 'Part number already exists' });
    throw e;
  }
});

app.post('/api/pdi-parts/:id/toggle', auth, requireRole('ADMIN'), async (req, res) => {
  const p = await db.prepare('SELECT id FROM pdi_parts WHERE id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'Not found' });
  await db.prepare('UPDATE pdi_parts SET active = NOT active WHERE id=?').run(p.id);
  res.json({ ok: true });
});

// Bulk import — paste part numbers (any whitespace/comma/semicolon separated).
// Re-importing an updated sheet adds new parts and reactivates existing ones.
app.post('/api/pdi-parts/import', auth, requireRole('ADMIN'), async (req, res) => {
  const b = req.body || {};
  const category = ['CHASSIS', 'BUS_BODY', 'OTHER'].includes(b.category) ? b.category : 'OTHER';
  const tokens = [...new Set(String(b.text || '').split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (!tokens.length) return res.status(400).json({ error: 'No part numbers found' });
  const run = db.transaction(async (tx) => {
    let added = 0, updated = 0;
    for (const t of tokens) {
      const info = await tx.prepare('INSERT INTO pdi_parts (part_no, category) VALUES (?,?) ON CONFLICT(part_no) DO NOTHING').run(t, category);
      if (info.changes) added++; else { await tx.prepare('UPDATE pdi_parts SET active = true, category = ? WHERE part_no = ?').run(category, t); updated++; }
    }
    return { added, updated };
  });
  const { added, updated } = await run();
  audit(req.user.id, 'PDI_PART_IMPORT', { category, added, updated });
  res.json({ added, updated, total: tokens.length });
});

// ---- Email alerts ---------------------------------------------------------
app.post('/api/alerts/test', auth, requireRole('ADMIN'), async (req, res) => {
  const a = await getSetting('alerts', config.ALERTS);
  const to = (req.body && req.body.to) || a.recipients;
  if (!to) return res.status(400).json({ error: 'No recipients configured' });
  if (!mailer.isConfigured()) return res.status(400).json({ error: 'SMTP is not configured (set SMTP_HOST etc. in .env)' });
  const result = await mailer.sendMail({ to, subject: '[Drona] Test alert email',
    html: '<p>This is a test alert from the JMC Operations Tracker. If you received this, SMTP is working.</p>' });
  audit(req.user.id, 'ALERT_TEST', { to });
  res.json({ ok: true, result });
});

app.get('/api/alerts/preview', auth, requireRole('ADMIN', 'HQ'), async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  res.json({ month, smtp_configured: mailer.isConfigured(), items: await alerts.evaluate(month) });
});

// ---- PDF: monthly report + GST invoice (Drona internal) -------------------
app.get('/api/reports/monthly.pdf', auth, requireRole('ADMIN', 'HQ'), async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const [ops, billing] = await Promise.all([reports.computeOps(month), reports.computeBilling(month)]);
  pdf.streamMonthlyReport(res, { month, ops, billing });
});

app.get('/api/invoice.pdf', auth, requireRole('ADMIN', 'HQ'), async (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const billing = await reports.computeBilling(month);
  const invoice = await getSetting('invoice', config.INVOICE);
  const invoiceNo = req.query.no || `DRN/${month}`;
  pdf.streamInvoice(res, { month, billing, invoice, invoiceNo });
});

// ---- CAPA / 8D ------------------------------------------------------------
app.get('/api/capa', auth, async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT c.*, d.type AS disc_type, d.part_no AS disc_part_no, u.name AS created_by_name,
      (c.due_date IS NOT NULL AND c.due_date < ? AND c.status NOT IN ('DONE','VERIFIED')) AS overdue
    FROM capa c
    LEFT JOIN discrepancies d ON d.id = c.discrepancy_id
    LEFT JOIN users u ON u.id = c.created_by WHERE 1=1`;
  const args = [new Date().toISOString().slice(0, 10)];
  if (status) { sql += ' AND c.status = ?'; args.push(status); }
  sql += ` ORDER BY CASE c.status WHEN 'OPEN' THEN 0 WHEN 'IN_PROGRESS' THEN 1 WHEN 'DONE' THEN 2 ELSE 3 END,
           c.due_date NULLS LAST, c.id DESC LIMIT 500`;
  res.json({ capa: await db.prepare(sql).all(...args) });
});

app.post('/api/capa', auth, requireRole('OPERATOR', 'JMC_APPROVER', 'HQ', 'ADMIN'), async (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'Title is required' });
  const priority = ['LOW', 'MEDIUM', 'HIGH'].includes(b.priority) ? b.priority : 'MEDIUM';
  const row = await db.prepare(`INSERT INTO capa
    (discrepancy_id, title, root_cause, corrective_action, preventive_action, owner, due_date, priority, created_by)
    VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`)
    .get(b.discrepancy_id != null && b.discrepancy_id !== '' ? Number(b.discrepancy_id) : null,
      String(b.title).trim(), b.root_cause || null, b.corrective_action || null, b.preventive_action || null,
      b.owner || null, b.due_date || null, priority, req.user.id);
  audit(req.user.id, 'CAPA_CREATE', { id: row.id });
  res.json({ id: row.id });
});

app.put('/api/capa/:id', auth, requireRole('OPERATOR', 'JMC_APPROVER', 'HQ', 'ADMIN'), async (req, res) => {
  const c = await db.prepare('SELECT * FROM capa WHERE id=?').get(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const status = ['OPEN', 'IN_PROGRESS', 'DONE', 'VERIFIED'].includes(b.status) ? b.status : c.status;
  if (status === 'VERIFIED' && !['HQ', 'ADMIN'].includes(req.user.role))
    return res.status(403).json({ error: 'Only HQ / Admin can verify a CAPA' });
  const priority = ['LOW', 'MEDIUM', 'HIGH'].includes(b.priority) ? b.priority : c.priority;
  const closing = (status === 'DONE' || status === 'VERIFIED');
  await db.prepare(`UPDATE capa SET title=?, root_cause=?, corrective_action=?, preventive_action=?, owner=?,
      due_date=?, priority=?, status=?, verification_remarks=?,
      closed_at = CASE WHEN ? AND closed_at IS NULL THEN now() WHEN ? THEN NULL ELSE closed_at END,
      updated_at=now() WHERE id=?`)
    .run(b.title != null ? String(b.title).trim() : c.title, b.root_cause ?? c.root_cause,
      b.corrective_action ?? c.corrective_action, b.preventive_action ?? c.preventive_action,
      b.owner ?? c.owner, b.due_date ?? c.due_date, priority, status, b.verification_remarks ?? c.verification_remarks,
      closing, !closing, c.id);
  audit(req.user.id, 'CAPA_UPDATE', { id: c.id, status });
  res.json({ ok: true });
});

// ---- Static frontend ------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// JSON error handler — stops an uncaught route error from leaking an HTML stack
// trace and always gives the SPA's fetch() a parseable body.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(err.http || 500).json({ error: IS_PROD ? 'Server error' : (err.message || 'Server error') });
});

// Sweep expired sessions hourly (not only at login) so the table can't grow
// indefinitely for users who never sign back in.
setInterval(pruneSessions, 60 * 60 * 1000).unref();

// Ensure defaults exist, then start listening.
async function start() {
  try { await seed(); } catch (e) { console.error('Seed on boot failed:', e.message); }
  alerts.startScheduler();
  app.listen(PORT, () => {
    console.log(`\n  Drona ValueChain — JMC Ops Tracker`);
    console.log(`  Running at http://localhost:${PORT}\n`);
  });
}
start();
