/**
 * Email alert engine.
 *
 *   evaluate(month)        -> array of {key, level, title, detail} threshold hits
 *   runDigest(force)       -> evaluate current month + email one digest (deduped/day)
 *   notifyRealtime(type,p) -> instant targeted email for a single event
 *   startScheduler()       -> fire runDigest() once/day at the configured hour
 *
 * Thresholds + recipients live in the admin-editable `alerts` setting
 * (config.ALERTS defaults). Dedupe markers live in the `alerts_state` setting.
 * SMTP transport degrades gracefully (lib/mailer.js) so this never throws into a
 * request or the scheduler.
 */
'use strict';
const { db } = require('./rawdb');
const { getSetting, setSetting } = require('./prisma');
const mailer = require('./mailer');
const { computeBilling } = require('./reports');
const config = require('../config');

const rs = (n) => 'Rs. ' + Math.round(Number(n) || 0).toLocaleString('en-IN');

// Evaluate every alert condition for `month` (YYYY-MM). Returns the hits only.
async function evaluate(month) {
  const a = await getSetting('alerts', config.ALERTS);
  const out = [];

  // P&L negative — only after pnl_day_threshold (revenue accrues through month).
  const billing = await computeBilling(month);
  const gp = billing.pnl.gross_profit;
  if (gp < 0 && new Date().getDate() > (a.pnl_day_threshold ?? 20)) {
    out.push({ key: 'PNL_NEGATIVE', level: 'critical', title: `P&L is negative for ${month}`,
      detail: `Gross profit ${rs(gp)} — revenue ${rs(billing.pnl.revenue)} vs cost ${rs(billing.pnl.total_cost)}.` });
  }

  const pa = (await db.prepare("SELECT COUNT(*)::int c FROM daily_entries WHERE status='SUBMITTED'").get()).c;
  if (pa > (a.pending_approvals_max ?? 3))
    out.push({ key: 'PENDING_APPROVALS', level: 'warn', title: `${pa} day(s) awaiting JMC approval`, detail: `Threshold ${a.pending_approvals_max}.` });

  const pm = (await db.prepare("SELECT COUNT(*)::int c FROM manpower_requests WHERE status='PENDING'").get()).c;
  if (pm > (a.pending_mp_max ?? 1))
    out.push({ key: 'PENDING_MP', level: 'warn', title: `${pm} manpower request(s) pending HQ`, detail: `Threshold ${a.pending_mp_max}.` });

  const cutoff = new Date(Date.now() + (a.doc_expiry_days ?? 45) * 86400000).toISOString().slice(0, 10);
  const ed = (await db.prepare("SELECT COUNT(*)::int c FROM worker_documents WHERE expiry_date IS NOT NULL AND expiry_date <= ?").get(cutoff)).c;
  if (ed > 0)
    out.push({ key: 'DOCS_EXPIRING', level: 'warn', title: `${ed} worker document(s) expiring within ${a.doc_expiry_days} days`, detail: 'See Compliance → document expiry.' });

  const ms = (await db.prepare("SELECT COUNT(*)::int c FROM qc q JOIN daily_entries e ON e.id=q.entry_id WHERE substr(e.work_date,1,7)=? AND q.parts_qty>0 AND q.parts_qty<?").get(month, billing.mg)).c;
  if (ms > (a.mg_short_days_max ?? 1))
    out.push({ key: 'MG_SHORT', level: 'warn', title: `${ms} QC day(s) below the MG floor (${billing.mg})`, detail: `Threshold ${a.mg_short_days_max}.` });

  return out;
}

function digestHtml(month, items) {
  const rows = items.map(i => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee">
      <b style="color:${i.level === 'critical' ? '#b00020' : '#a06a00'}">${i.title}</b>
      <div style="color:#555;font-size:13px;margin-top:2px">${i.detail || ''}</div></td></tr>`).join('');
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#222">
    <h2 style="margin:0 0 4px">Drona ValueChain — Operations Alerts</h2>
    <div style="color:#666;margin-bottom:12px">${month}</div>
    <table style="border-collapse:collapse;width:100%;max-width:640px;border:1px solid #eee">${rows}</table>
    <p style="color:#999;font-size:12px;margin-top:14px">Automated digest from the JMC Operations Tracker.</p></div>`;
}

// Evaluate the current month and send one digest email. Deduped to once/day
// unless force=true (used by the "Preview/Test" admin action).
async function runDigest(force = false) {
  try {
    const a = await getSetting('alerts', config.ALERTS);
    if (!a.enabled && !force) return { skipped: 'disabled' };
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const state = await getSetting('alerts_state', {});
    if (!force && state.last_digest_date === today) return { skipped: 'already-sent-today' };
    const items = await evaluate(month);
    let result = { sent: 0 };
    if (items.length) {
      await mailer.sendMail({ to: a.recipients, subject: `[Drona] Alert digest — ${items.length} item(s) (${month})`, html: digestHtml(month, items) });
      result = { sent: items.length };
    }
    if (!force) await setSetting('alerts_state', { ...state, last_digest_date: today });
    return result;
  } catch (e) { console.error('[alerts] runDigest failed:', e.message); return { error: e.message }; }
}

// Instant single-event email. Never throws into the calling request.
async function notifyRealtime(type, payload = {}) {
  try {
    const a = await getSetting('alerts', config.ALERTS);
    if (!a.enabled || !a.recipients) return { skipped: 'disabled' };
    let subject, html;
    if (type === 'ENTRY_SUBMITTED') {
      subject = `[Drona] Day ${payload.work_date} submitted for JMC approval`;
      html = `<p>Daily entry for <b>${payload.work_date}</b> was submitted${payload.by ? ' by ' + payload.by : ''} and now awaits JMC end-of-day approval.</p>`;
    } else if (type === 'MP_REQUEST') {
      subject = `[Drona] Extra manpower requested`;
      html = `<p>${payload.by || 'An operator'} requested <b>${payload.extra_count} ${payload.category}</b>.</p><p>Reason: ${payload.reason || '—'}</p>`;
    } else if (type === 'PNL_NEGATIVE') {
      const month = new Date().toISOString().slice(0, 7);
      if (new Date().getDate() <= (a.pnl_day_threshold ?? 20)) return { skipped: 'too-early' };
      const state = await getSetting('alerts_state', {});
      if (state.last_pnl_alert_month === month) return { skipped: 'deduped' };
      const billing = await computeBilling(month);
      if (billing.pnl.gross_profit >= 0) return { skipped: 'positive' };
      subject = `[Drona] ⚠ P&L negative for ${month}`;
      html = `<p>Month-to-date P&amp;L for <b>${month}</b> is negative: gross profit <b>${rs(billing.pnl.gross_profit)}</b> (revenue ${rs(billing.pnl.revenue)} vs cost ${rs(billing.pnl.total_cost)}).</p>`;
      await setSetting('alerts_state', { ...state, last_pnl_alert_month: month });
    } else return { skipped: 'unknown-type' };
    return await mailer.sendMail({ to: a.recipients, subject, html });
  } catch (e) { console.error('[alerts] notifyRealtime failed:', e.message); return { error: e.message }; }
}

// Lightweight daily scheduler (no extra dependency): wake every 15 min, fire the
// digest once per day once the configured hour has passed.
function startScheduler() {
  const tick = async () => {
    try {
      const a = await getSetting('alerts', config.ALERTS);
      if (!a.enabled) return;
      if (new Date().getHours() < (a.digest_hour ?? 2)) return;
      const today = new Date().toISOString().slice(0, 10);
      const state = await getSetting('alerts_state', {});
      if (state.last_digest_date === today) return;
      await runDigest();
    } catch (e) { console.error('[alerts] scheduler tick failed:', e.message); }
  };
  setInterval(tick, 15 * 60 * 1000).unref();
  setTimeout(tick, 30 * 1000).unref(); // first check shortly after boot
}

module.exports = { evaluate, runDigest, notifyRealtime, startScheduler };
