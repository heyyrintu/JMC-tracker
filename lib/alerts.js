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
const { computeBilling, computeOps, computeDay } = require('./reports');
const config = require('../config');
const T = require('./emailTemplate');

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
  const critical = items.filter(i => i.level === 'critical').length;
  const accent = critical ? 'bad' : 'warn';
  const body =
    T.noticeCard({ tone: accent, title: `${items.length} operations alert${items.length === 1 ? '' : 's'} for ${month}`,
      html: 'The following thresholds were tripped. Open the dashboard for full context and to take action.' }) +
    T.statGrid([
      { label: 'Total alerts', value: items.length, sub: 'need attention', tone: accent },
      { label: 'Critical', value: critical, sub: critical ? 'act now' : 'none', tone: critical ? 'bad' : 'ok' },
    ]) +
    T.sectionTitle('Details', accent) +
    T.alertList(items);
  return T.layout({ title: 'Operations Alerts', kicker: 'Alert Digest', accent,
    subtitle: `Threshold review for <b>${month}</b>`, preheader: `${items.length} alert(s) for ${month}`,
    body, footerNote: 'Sent because one or more alert thresholds were exceeded.' });
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
      html = T.layout({ title: 'Day submitted for approval', kicker: 'Approval Needed', accent: 'brand',
        subtitle: `Awaiting JMC end-of-day sign-off`, preheader: `Day ${payload.work_date} awaits approval`,
        body: T.noticeCard({ tone: 'brand', title: `Daily entry · ${payload.work_date}`,
          html: `Submitted${payload.by ? ' by <b>' + T.esc(payload.by) + '</b>' : ''} and now awaiting JMC end-of-day approval.` }) });
    } else if (type === 'MP_REQUEST') {
      subject = `[Drona] Extra manpower requested`;
      html = T.layout({ title: 'Extra manpower requested', kicker: 'Manpower Request', accent: 'warn',
        subtitle: 'Pending HQ approval', preheader: `${payload.extra_count} ${payload.category} requested`,
        body: T.noticeCard({ tone: 'warn', title: `${T.esc(payload.extra_count)} ${T.esc(payload.category)}`,
          html: `Requested by <b>${T.esc(payload.by || 'an operator')}</b>.<br/><span style="color:#7c8698">Reason:</span> ${T.esc(payload.reason || '—')}` }) });
    } else if (type === 'PNL_NEGATIVE') {
      const month = new Date().toISOString().slice(0, 7);
      if (new Date().getDate() <= (a.pnl_day_threshold ?? 20)) return { skipped: 'too-early' };
      const state = await getSetting('alerts_state', {});
      if (state.last_pnl_alert_month === month) return { skipped: 'deduped' };
      const billing = await computeBilling(month);
      if (billing.pnl.gross_profit >= 0) return { skipped: 'positive' };
      subject = `[Drona] ⚠ P&L negative for ${month}`;
      html = T.layout({ title: 'P&L is negative', kicker: 'Critical Alert', accent: 'bad',
        subtitle: `Month-to-date result for <b>${month}</b>`, preheader: `P&L negative for ${month}`,
        body: T.noticeCard({ tone: 'bad', title: `Gross profit ${rs(billing.pnl.gross_profit)}`,
          html: `Month-to-date P&amp;L for <b>${month}</b> is negative.` }) +
          T.statGrid([
            { label: 'Revenue', value: rs(billing.pnl.revenue), tone: 'ok' },
            { label: 'Total cost', value: rs(billing.pnl.total_cost), tone: 'bad' },
          ]) });
      await setSetting('alerts_state', { ...state, last_pnl_alert_month: month });
    } else return { skipped: 'unknown-type' };
    return await mailer.sendMail({ to: a.recipients, subject, html });
  } catch (e) { console.error('[alerts] notifyRealtime failed:', e.message); return { error: e.message }; }
}

// ---- Daily operations summary (always-send; separate from the threshold digest)
const num = (n) => Number(n || 0).toLocaleString('en-IN');

async function dashboardCounts() {
  const docCutoff = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
  const c = (sql, ...p) => db.prepare(sql).get(...p).then(r => r.c);
  return {
    pending_approvals: await c("SELECT COUNT(*)::int c FROM daily_entries WHERE status='SUBMITTED'"),
    open_discrepancies: await c("SELECT COUNT(*)::int c FROM discrepancies WHERE status='OPEN'"),
    pending_mp_requests: await c("SELECT COUNT(*)::int c FROM manpower_requests WHERE status='PENDING'"),
    pending_leaves: await c("SELECT COUNT(*)::int c FROM leave_applications WHERE status='PENDING'"),
    expiring_docs: await c("SELECT COUNT(*)::int c FROM worker_documents WHERE expiry_date IS NOT NULL AND expiry_date <= ?", docCutoff),
    open_capa: await c("SELECT COUNT(*)::int c FROM capa WHERE status NOT IN ('DONE','VERIFIED')"),
  };
}

function summaryHtml({ yesterday, month, day, ops, counts, alertsItems }) {
  // Yesterday — headline figures as colourful stat cards, or an empty-state notice.
  const dayBlock = day
    ? T.statGrid([
        { label: 'Loading', value: `${num(day.load_parts)}`, sub: `parts · ${num(day.load_trucks)} trucks`, tone: 'brand' },
        { label: 'Unloading', value: `${num(day.unload_ton)}`, sub: `ton · ${num(day.unload_trucks)} trucks`, tone: 'teal' },
        { label: 'QC / PDI', value: num(day.qc_parts), sub: 'parts checked', tone: 'ok' },
        { label: 'Transport', value: num(day.trips), sub: 'trips', tone: 'slate' },
      ]) + `<div style="margin-top:10px">${T.pillRow([{ label: 'Status', value: day.status, tone: day.status === 'APPROVED' ? 'ok' : day.status === 'REJECTED' ? 'bad' : 'warn' }])}</div>`
    : T.noticeCard({ tone: 'slate', title: 'No entry recorded', html: `Nothing was logged for <b>${yesterday}</b>.` });

  // Month-to-date — KPI table, with MG achievement tinted green/amber.
  const mgTone = ops.mgAchievement >= 100 ? 'ok' : ops.mgAchievement >= 80 ? 'warn' : 'bad';
  const mtdBlock = T.kvTable([
    ['Operating days', num(ops.opDays)],
    ['Loading (parts)', num(ops.load_parts)],
    ['Unloading (ton)', num(ops.unload_ton)],
    ['QC / PDI (parts)', num(ops.qc_parts)],
    ['MG achievement', `${ops.mgAchievement}% &middot; ${ops.mg_met_days}/${ops.qcDays} QC days`],
  ], mgTone);

  // Pending work — pills, each tinted by whether the count is non-zero.
  const pend = (label, value, hot = 'warn') => ({ label, value, tone: value > 0 ? hot : 'ok' });
  const pendingBlock = T.pillRow([
    pend('Approvals', counts.pending_approvals),
    pend('Discrepancies', counts.open_discrepancies, 'bad'),
    pend('MP requests', counts.pending_mp_requests),
    pend('Leaves', counts.pending_leaves),
    pend('Docs expiring', counts.expiring_docs, 'bad'),
    pend('Open CAPA', counts.open_capa, 'bad'),
  ]);

  const alertsBlock = alertsItems.length
    ? T.sectionTitle('Active alerts', alertsItems.some(i => i.level === 'critical') ? 'bad' : 'warn') + T.alertList(alertsItems)
    : T.noticeCard({ tone: 'ok', title: 'No active alerts', html: 'All monitored thresholds are within range.' });

  const body =
    T.sectionTitle(`Yesterday · ${yesterday}`, 'brand') + dayBlock +
    T.sectionTitle(`Month-to-date · ${month}`, 'teal') + mtdBlock +
    T.sectionTitle('Pending', 'warn') + pendingBlock +
    alertsBlock;

  return T.layout({ title: 'Daily Operations Summary', kicker: 'Daily Summary', accent: 'brand',
    subtitle: `Recap for <b>${yesterday}</b> &middot; month ${month}`, preheader: `Ops recap for ${yesterday}`,
    body, footerNote: 'Sent automatically each morning for the day that just ended.' });
}

// Build + send the daily ops summary for the day that just ended. Deduped to
// once/day unless force=true (the "Send summary now" admin action).
async function runDailySummary(force = false) {
  try {
    const a = await getSetting('alerts', config.ALERTS);
    if (!a.summary_enabled && !force) return { skipped: 'disabled' };
    const today = new Date().toISOString().slice(0, 10);
    const state = await getSetting('alerts_state', {});
    if (!force && state.last_summary_date === today) return { skipped: 'already-sent-today' };

    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const month = yesterday.slice(0, 7);
    const [day, ops, counts, alertsItems] = [await computeDay(yesterday), await computeOps(month), await dashboardCounts(), await evaluate(month)];
    const html = summaryHtml({ yesterday, month, day, ops, counts, alertsItems });

    let result = { sent: 0 };
    if (a.summary_recipients) {
      await mailer.sendMail({ to: a.summary_recipients, subject: `[Drona] Daily Ops Summary — ${yesterday}`, html });
      result = { sent: 1, to: a.summary_recipients };
    } else result = { skipped: 'no-recipients' };
    if (!force) await setSetting('alerts_state', { ...state, last_summary_date: today });
    return result;
  } catch (e) { console.error('[alerts] runDailySummary failed:', e.message); return { error: e.message }; }
}

// Lightweight daily scheduler (no extra dependency): wake every 15 min, fire the
// digest once per day once the configured hour has passed.
function startScheduler() {
  const tick = async () => {
    try {
      const a = await getSetting('alerts', config.ALERTS);
      const now = new Date(), hour = now.getHours();
      const today = now.toISOString().slice(0, 10);
      const state = await getSetting('alerts_state', {});
      // Threshold digest — only-if-tripped, at digest_hour.
      if (a.enabled && hour >= (a.digest_hour ?? 2) && state.last_digest_date !== today) await runDigest();
      // Daily operations summary — always-send, at summary_hour (default midnight).
      if (a.summary_enabled && hour >= (a.summary_hour ?? 0) && state.last_summary_date !== today) await runDailySummary();
    } catch (e) { console.error('[alerts] scheduler tick failed:', e.message); }
  };
  setInterval(tick, 15 * 60 * 1000).unref();
  setTimeout(tick, 30 * 1000).unref(); // first check shortly after boot
}

// digestHtml/summaryHtml are pure (plain-object in, HTML out) — exported so the
// email design can be previewed/tested without a database.
module.exports = { evaluate, runDigest, runDailySummary, notifyRealtime, startScheduler, digestHtml, summaryHtml };
