/**
 * PDF generators (pdfkit) for the monthly operations report and the GST invoice.
 * Both stream straight to the Express response. Money uses an "Rs." prefix
 * because pdfkit's built-in Helvetica lacks the ₹ glyph (same approach as the
 * offer-letter generator in server.js).
 */
'use strict';
const PDFDocument = require('pdfkit');
const config = require('../config');

const rs = (n) => 'Rs. ' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const num = (n) => Number(n || 0).toLocaleString('en-IN');

function header(doc, title) {
  doc.fontSize(18).font('Helvetica-Bold').fillColor('#0c1422').text(config.COMPANY.provider, { align: 'center' });
  doc.fontSize(10).font('Helvetica').fillColor('#555').text('JMC Operations Tracker', { align: 'center' });
  doc.moveDown(0.3);
  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#cccccc').stroke();
  doc.moveDown(0.8).fillColor('#000');
  doc.fontSize(14).font('Helvetica-Bold').text(title);
  doc.moveDown(0.5);
}
function kv(doc, label, val) {
  const y = doc.y;
  doc.font('Helvetica').fontSize(10.5).fillColor('#444').text(label, 70, y, { width: 260 });
  doc.font('Helvetica-Bold').fillColor('#000').text(val, 330, y, { width: 209, align: 'right' });
  doc.moveDown(0.25);
}

function streamMonthlyReport(res, { month, ops, billing }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="drona-report-${month}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  doc.pipe(res);
  header(doc, `Monthly Operations Report — ${month}`);

  doc.fontSize(11).font('Helvetica-Bold').fillColor('#000').text('Operations'); doc.moveDown(0.3);
  kv(doc, 'Operating days', String(ops.opDays));
  kv(doc, 'Loading (parts)', num(ops.load_parts));
  kv(doc, 'Unloading (ton)', num(ops.unload_ton));
  kv(doc, 'QC / PDI (parts)', num(ops.qc_parts));
  kv(doc, 'MG achievement', `${ops.mgAchievement}%  (${ops.mg_met_days}/${ops.qcDays} QC days)`);
  kv(doc, 'Days below MG', String(ops.mg_short_days));
  kv(doc, 'Average PPM', ops.ppmAvg != null ? String(ops.ppmAvg) : '—');
  kv(doc, 'Manpower utilization', `${ops.utilization}%  (avg ${ops.avgMpPerDay.toFixed(1)} of ${ops.approvedTotal})`);

  doc.moveDown(0.8);
  doc.fontSize(11).font('Helvetica-Bold').fillColor('#000').text('Financials (P&L)'); doc.moveDown(0.3);
  const p = billing.pnl;
  kv(doc, 'Revenue', rs(p.revenue));
  kv(doc, 'Manpower cost', rs(p.manpower));
  kv(doc, 'Overhead', rs(p.overhead));
  kv(doc, 'Transport', rs(p.transport));
  kv(doc, 'Total cost', rs(p.total_cost));
  doc.font('Helvetica-Bold');
  kv(doc, p.gross_profit >= 0 ? 'Gross profit' : 'Gross LOSS', `${rs(p.gross_profit)}  (${(p.margin * 100).toFixed(1)}%)`);
  doc.font('Helvetica');

  doc.moveDown(1).fontSize(8.5).fillColor('#999')
    .text(`Generated ${new Date().toISOString().slice(0, 10)} · Confidential — Drona ValueChain internal.`, 56, doc.y);
  doc.end();
}

function streamInvoice(res, { month, billing, invoice, invoiceNo }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="invoice-${month}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  doc.pipe(res);
  header(doc, 'Tax Invoice');

  doc.fontSize(10).font('Helvetica');
  kv(doc, 'Invoice no.', invoiceNo);
  kv(doc, 'Billing month', month);
  kv(doc, 'Date', new Date().toISOString().slice(0, 10));
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fillColor('#000').text('Bill to:');
  doc.font('Helvetica').text(invoice.bill_to || '—');
  if (invoice.gstin) doc.text('GSTIN: ' + invoice.gstin);
  doc.moveDown(0.8);

  const q = billing.quantities, r = billing.rates, rev = billing.revenue;
  const items = [
    ['Loading', `${num(q.load_parts)} parts`, '@ ' + rs(r.loading.rate), rs(rev.loading)],
    ['Unloading', `${num(q.unload_ton)} ton`, '@ ' + rs(r.unloading.rate), rs(rev.unloading)],
    ['QC / PDI', `${num(q.qc_billed)} parts${q.qc_mg_uplift ? ` (incl. ${q.qc_mg_uplift} MG)` : ''}`, '@ ' + rs(r.qc.rate), rs(rev.qc)],
    ['Transport', '', '', rs(rev.transport)],
  ];
  let y = doc.y + 2;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000');
  doc.text('Service', 56, y, { width: 150 }); doc.text('Qty', 206, y, { width: 140 });
  doc.text('Rate', 346, y, { width: 90, align: 'right' }); doc.text('Amount', 446, y, { width: 93, align: 'right' });
  y += 16; doc.moveTo(56, y).lineTo(539, y).strokeColor('#cccccc').stroke(); y += 6;
  doc.font('Helvetica');
  items.forEach(it => {
    doc.text(it[0], 56, y, { width: 150 }); doc.text(it[1], 206, y, { width: 140 });
    doc.text(it[2], 346, y, { width: 90, align: 'right' }); doc.text(it[3], 446, y, { width: 93, align: 'right' });
    y += 18;
  });
  doc.y = y + 4;
  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#cccccc').stroke();
  doc.moveDown(0.5);
  kv(doc, 'Subtotal', rs(billing.invoice.subtotal));
  kv(doc, `GST (${billing.invoice.gst_pct}%)`, rs(billing.invoice.gst_amt));
  doc.font('Helvetica-Bold'); kv(doc, 'Grand total', rs(billing.invoice.grand_total)); doc.font('Helvetica');
  if (invoice.notes) doc.moveDown(0.5).fontSize(9).fillColor('#666').text(invoice.notes);
  doc.moveDown(1).fontSize(8.5).fillColor('#999')
    .text('Computer-generated invoice — Drona ValueChain (Drona Logitech Pvt. Ltd.).');
  doc.end();
}

module.exports = { streamMonthlyReport, streamInvoice };
