/**
 * Analyst layer — turns a period's operational rows into comparable trends and
 * plain-English findings. Pure and side-effect free (no DB, no settings reads)
 * so it unit-tests without a database, the same way calc.js does.
 *
 * Used by GET /api/summary and GET /api/mis (server.js).
 *
 * Every insight carries a `scope`:
 *   'client'   — service delivery. Safe for the JMC client's own login.
 *   'internal' — Drona's own staffing/admin. Never sent to the client.
 * Nothing here computes or emits money: the dashboard and MIS are deliberately
 * financial-free, and the P&L lives on the Finance page instead.
 */
'use strict';

const round1 = (n) => Math.round(n * 10) / 10;

// Percentage change from `prev` to `cur`. Null when there is no baseline to
// divide by — the caller shows "no prior period" rather than a fake 0% or ∞.
function pctChange(cur, prev) {
  if (!prev) return null;
  return round1(((cur - prev) / prev) * 100);
}

/** A KPI's movement against the previous period. */
function trend(cur, prev, { goodWhen = 'up' } = {}) {
  const change = pctChange(cur, prev);
  const dir = cur === prev || change === null ? 'flat' : (cur > prev ? 'up' : 'down');
  const good = dir === 'flat' ? null : (goodWhen === 'up' ? dir === 'up' : dir === 'down');
  return { current: cur, previous: prev, change, dir, good };
}

const sum = (rows, key) => rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);

/** Spread of a series as a % of its mean — how erratic output was day to day. */
function volatility(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  if (!m) return null;
  const variance = mean(xs.map((x) => (x - m) ** 2));
  return round1((Math.sqrt(variance) / m) * 100);
}

/** Highest and lowest day for a metric, ignoring days with no activity. */
function extremes(days, key) {
  const active = days.filter((d) => (Number(d[key]) || 0) > 0);
  if (!active.length) return null;
  const sorted = [...active].sort((a, b) => b[key] - a[key]);
  return { best: sorted[0], worst: sorted[sorted.length - 1] };
}

/**
 * Group consecutive dates into runs, so "missed MG on the 3rd, 4th and 5th"
 * reads as one streak rather than three separate findings.
 */
function streaks(dates) {
  const out = [];
  for (const d of [...dates].sort()) {
    const last = out[out.length - 1];
    const prevDay = last && new Date(last[last.length - 1] + 'T00:00:00Z').getTime() + 86400000;
    if (last && prevDay === new Date(d + 'T00:00:00Z').getTime()) last.push(d);
    else out.push([d]);
  }
  return out;
}

const dayNum = (d) => Number(String(d).slice(8, 10));
const listDays = (ds) => ds.map(dayNum).join(', ');

/**
 * Build the analyst commentary for a period.
 *
 * `days` / `prevDays` are the per-day rows from the summary/MIS query.
 * Anything unavailable can be omitted — each finding is guarded on its inputs,
 * so a caller with only volume data still gets volume findings.
 */
function buildInsights({ days = [], prevDays = [], mgTarget = 0, ppmTarget = 0,
                         qcQuality = null, discTot = null, utilization = null,
                         pendingApprovals = 0, overdueCapa = 0, expiringDocs = 0 } = {}) {
  const out = [];
  const add = (level, scope, title, text) => out.push({ level, scope, title, text });
  if (!days.length) return out;

  // ---- Volume vs the previous period ---------------------------------------
  const qc = sum(days, 'qc_parts'), prevQc = sum(prevDays, 'qc_parts');
  if (prevDays.length) {
    const ch = pctChange(qc, prevQc);
    if (ch !== null && Math.abs(ch) >= 5) {
      add(ch > 0 ? 'good' : 'warn', 'client', 'QC volume',
        `QC/PDI volume ${ch > 0 ? 'rose' : 'fell'} ${Math.abs(ch)}% against the previous period ` +
        `(${prevQc.toLocaleString('en-IN')} → ${qc.toLocaleString('en-IN')} parts).`);
    } else if (ch !== null) {
      add('info', 'client', 'QC volume', `QC/PDI volume held steady at ${qc.toLocaleString('en-IN')} parts (${ch >= 0 ? '+' : ''}${ch}%).`);
    }
  }

  // ---- Minimum-guarantee adherence ----------------------------------------
  if (mgTarget > 0) {
    const qcDays = days.filter((d) => d.qc_parts > 0);
    const shortDays = qcDays.filter((d) => d.qc_parts < mgTarget).map((d) => d.work_date);
    if (qcDays.length && !shortDays.length) {
      add('good', 'client', 'Minimum guarantee',
        `The MG floor of ${mgTarget.toLocaleString('en-IN')} parts/day was met on all ${qcDays.length} inspection day(s).`);
    } else if (shortDays.length) {
      const runs = streaks(shortDays);
      const worst = runs.reduce((a, r) => (r.length > a.length ? r : a), runs[0]);
      const pctMet = Math.round(((qcDays.length - shortDays.length) / qcDays.length) * 100);
      add(pctMet >= 80 ? 'warn' : 'bad', 'client', 'Minimum guarantee',
        `QC fell below the MG floor on ${shortDays.length} of ${qcDays.length} inspection day(s) (${pctMet}% met)` +
        (worst.length > 1
          ? `, including a ${worst.length}-day run on the ${listDays(worst)}.`
          : ` — on the ${listDays(shortDays)}.`));
    }
  }

  // ---- Best / worst output day --------------------------------------------
  const ex = extremes(days, 'qc_parts');
  if (ex && ex.best !== ex.worst) {
    add('info', 'client', 'Peak and trough',
      `Strongest day was ${ex.best.work_date} at ${Number(ex.best.qc_parts).toLocaleString('en-IN')} parts; ` +
      `weakest was ${ex.worst.work_date} at ${Number(ex.worst.qc_parts).toLocaleString('en-IN')}.`);
  }

  // ---- Consistency ---------------------------------------------------------
  const vol = volatility(days.filter((d) => d.qc_parts > 0).map((d) => d.qc_parts));
  if (vol !== null) {
    add(vol > 40 ? 'warn' : 'good', 'client', 'Consistency',
      vol > 40
        ? `Daily output is uneven — day-to-day spread is ${vol}% of the average, which makes capacity planning harder.`
        : `Daily output is steady, with a day-to-day spread of just ${vol}% around the average.`);
  }

  // ---- Quality -------------------------------------------------------------
  if (qcQuality && qcQuality.checked > 0) {
    const { rejection_rate: rr, fpy, rejected, rework, ppm_derived: ppm } = qcQuality;
    add(rr > 1 ? 'warn' : 'good', 'client', 'Quality',
      `${Number(qcQuality.checked).toLocaleString('en-IN')} parts inspected — ${rr}% rejected ` +
      `(${Number(rejected).toLocaleString('en-IN')} rejected, ${Number(rework).toLocaleString('en-IN')} rework)` +
      (fpy != null ? `, first-pass yield ${fpy}%.` : '.'));
    if (ppmTarget && ppm != null) {
      add(ppm > ppmTarget ? 'bad' : 'good', 'client', 'Defect rate',
        ppm > ppmTarget
          ? `Defect rate is ${Number(ppm).toLocaleString('en-IN')} PPM, above the ${Number(ppmTarget).toLocaleString('en-IN')} PPM target.`
          : `Defect rate is ${Number(ppm).toLocaleString('en-IN')} PPM, inside the ${Number(ppmTarget).toLocaleString('en-IN')} PPM target.`);
    }
  }

  // ---- Discrepancies -------------------------------------------------------
  if (discTot && discTot.total > 0) {
    add(discTot.open_c > 0 ? 'warn' : 'good', 'client', 'Discrepancies',
      `${discTot.total} discrepancy(ies) logged, ${discTot.open_c} still open.` +
      (discTot.variance ? ` Dispatched-vs-billed variance stands at ${Number(discTot.variance).toLocaleString('en-IN')} parts.` : ''));
  }

  // ---- Internal only -------------------------------------------------------
  if (utilization != null && utilization > 0) {
    add(utilization > 110 || utilization < 70 ? 'warn' : 'good', 'internal', 'Manpower utilisation',
      utilization > 110
        ? `Deployment is running at ${utilization}% of approved headcount — sustained overuse.`
        : utilization < 70
          ? `Deployment is running at only ${utilization}% of approved headcount — capacity is idle.`
          : `Deployment is running at ${utilization}% of approved headcount, within the normal band.`);
  }
  if (pendingApprovals > 0) {
    add('warn', 'internal', 'Approvals',
      `${pendingApprovals} submitted day(s) are still awaiting JMC sign-off.`);
  }
  if (overdueCapa > 0) {
    add('bad', 'internal', 'CAPA', `${overdueCapa} CAPA action(s) are past their due date.`);
  }
  if (expiringDocs > 0) {
    add('warn', 'internal', 'Compliance',
      `${expiringDocs} worker document(s) expire within the next 45 days.`);
  }

  return out;
}

/** Drop anything the JMC client should not see. */
function forRole(insights, role) {
  return role === 'JMC_APPROVER' ? insights.filter((i) => i.scope === 'client') : insights;
}

module.exports = { pctChange, trend, volatility, extremes, streaks, buildInsights, forRole };
