/**
 * Shared report computations — single source of truth for the billing/P&L math
 * and the operational summary. Used by:
 *   - GET /api/billing            (server.js)            -> computeBilling
 *   - GET /api/reports/monthly.pdf, /api/invoice.pdf     -> computeOps/Billing
 *   - the email alert engine (lib/alerts.js)             -> computeBilling
 *
 * Extracted from the original /api/billing handler so the numbers can't drift
 * between the screen, the PDF and the alert.
 */
'use strict';
const { db } = require('./rawdb');
const { getSetting } = require('./prisma');
const config = require('../config');
const calc = require('../calc');

// Resolve a transport trip's rate from the configured route table.
async function transportRate(from, to, vehicle) {
  const rates = await getSetting('transport_rates', config.TRANSPORT_RATES);
  const m = rates.find(r => r.from === from && r.to === to && r.vehicle === vehicle);
  return m ? m.rate : null;
}

// Monthly billing / invoice / P&L for `month` (YYYY-MM). Mirrors the previous
// inline /api/billing logic exactly.
async function computeBilling(month) {
  const rates = await getSetting('rates', config.RATES);
  const mg = (await getSetting('mg', config.MG)).qc_daily_parts;
  const mgBilling = !!(await getSetting('mg_billing', config.MG_BILLING));
  const costs = await getSetting('costs', config.COSTS);
  const invoice = await getSetting('invoice', config.INVOICE);

  const agg = await db.prepare(`SELECT
      COALESCE(SUM(l.parts_qty),0)::float load_parts,
      COALESCE(SUM(u.weight_ton),0)::float unload_ton
    FROM daily_entries e
    LEFT JOIN loading l ON l.entry_id = e.id
    LEFT JOIN unloading u ON u.entry_id = e.id
    WHERE substr(e.work_date,1,7) = ?`).get(month);

  const qcDaysRows = await db.prepare(`SELECT q.parts_qty FROM qc q JOIN daily_entries e ON e.id=q.entry_id
    WHERE substr(e.work_date,1,7) = ? AND q.parts_qty > 0`).all(month);
  const qcCalc = calc.qcBilled(qcDaysRows.map(r => r.parts_qty), mg, mgBilling);
  const qcActualQty = qcCalc.actual, qcBilledQty = qcCalc.billed, qcMgUplift = qcCalc.uplift;

  const loadingRev = agg.load_parts * rates.loading.rate;
  const unloadingRev = agg.unload_ton * rates.unloading.rate;
  const qcRev = qcBilledQty * rates.qc.rate;
  const serviceRev = loadingRev + unloadingRev + qcRev;

  const trips = await db.prepare(`SELECT from_loc, to_loc, vehicle_type FROM transport_trips t
    JOIN daily_entries e ON e.id=t.entry_id WHERE substr(e.work_date,1,7) = ?`).all(month);
  const routeMap = {};
  let transportRev = 0, unknownTrips = 0;
  for (const t of trips) {
    const r = await transportRate(t.from_loc, t.to_loc, t.vehicle_type);
    const key = `${t.from_loc} → ${t.to_loc} (${t.vehicle_type})`;
    routeMap[key] = routeMap[key] || { route: key, trips: 0, rate: r, amount: 0, known: r != null };
    routeMap[key].trips++;
    if (r != null) { routeMap[key].amount += r; transportRev += r; } else unknownTrips++;
  }
  const totalRev = serviceRev + transportRev;

  const transportCost = costs.transport_monthly && costs.transport_monthly > 0 ? costs.transport_monthly : transportRev;
  const totalCost = (costs.manpower_monthly || 0) + (costs.overhead_monthly || 0) + transportCost;
  const grossProfit = totalRev - totalCost;
  const margin = totalRev ? grossProfit / totalRev : 0;

  const subtotal = totalRev;
  const gstPct = invoice.gst_pct || 0;
  const { gst_amt: gstAmt, grand_total: grandTotal } = calc.gst(subtotal, gstPct);

  return {
    month, rates, mg, mgBilling,
    quantities: { load_parts: agg.load_parts, unload_ton: agg.unload_ton, qc_actual: qcActualQty, qc_billed: qcBilledQty, qc_mg_uplift: qcMgUplift },
    revenue: { loading: loadingRev, unloading: unloadingRev, qc: qcRev, service: serviceRev, transport: transportRev, total: totalRev },
    transport_routes: Object.values(routeMap), unknown_trips: unknownTrips,
    pnl: { revenue: totalRev, manpower: costs.manpower_monthly || 0, overhead: costs.overhead_monthly || 0, transport: transportCost, total_cost: totalCost, gross_profit: grossProfit, margin },
    invoice: { bill_to: invoice.bill_to, gstin: invoice.gstin || '', notes: invoice.notes || '', subtotal, gst_pct: gstPct, gst_amt: gstAmt, grand_total: grandTotal },
  };
}

// Compact operational summary for `month` (for the PDF report + alert digest).
async function computeOps(month) {
  const rows = await db.prepare(`
    SELECT e.work_date, e.status, e.ppm,
      COALESCE(l.parts_qty,0) load_parts, COALESCE(u.weight_ton,0) unload_ton, COALESCE(q.parts_qty,0) qc_parts,
      (SELECT COALESCE(SUM(actual_count),0)::int FROM manpower_actual m WHERE m.entry_id = e.id) mp_actual
    FROM daily_entries e
    LEFT JOIN loading l ON l.entry_id = e.id
    LEFT JOIN unloading u ON u.entry_id = e.id
    LEFT JOIN qc q ON q.entry_id = e.id
    WHERE substr(e.work_date,1,7) = ? ORDER BY e.work_date`).all(month);

  const approved = await getSetting('approved_manpower', config.APPROVED_MANPOWER);
  const approvedTotal = approved.reduce((a, x) => a + x.approved, 0);
  const mgTarget = (await getSetting('mg', config.MG)).qc_daily_parts;
  const ppmDays = rows.filter(d => d.ppm != null);
  const ppmAvg = ppmDays.length ? Math.round(ppmDays.reduce((a, d) => a + d.ppm, 0) / ppmDays.length) : null;

  let load_parts = 0, unload_ton = 0, qc_parts = 0, mp_actual = 0, mg_short_days = 0, mg_met_days = 0, approved_days = 0;
  rows.forEach(d => {
    load_parts += d.load_parts; unload_ton += d.unload_ton; qc_parts += d.qc_parts; mp_actual += d.mp_actual;
    if (d.qc_parts > 0 && d.qc_parts < mgTarget) mg_short_days++;
    if (d.qc_parts >= mgTarget) mg_met_days++;
    if (d.status === 'APPROVED') approved_days++;
  });
  const opDays = rows.length;
  const qcDays = rows.filter(d => d.qc_parts > 0).length;
  const avgMpPerDay = opDays ? mp_actual / opDays : 0;
  const utilization = approvedTotal ? Math.round((avgMpPerDay / approvedTotal) * 100) : 0;
  const mgAchievement = qcDays ? Math.round((mg_met_days / qcDays) * 100) : 0;

  return { month, opDays, qcDays, load_parts, unload_ton, qc_parts, mgTarget, mg_short_days, mg_met_days,
    approved_days, ppmAvg, approvedTotal, avgMpPerDay, utilization, mgAchievement };
}

module.exports = { computeBilling, computeOps, transportRate };
