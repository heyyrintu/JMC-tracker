/**
 * Excel importer for the JMC MIS workbook.
 *
 * Reads the PDI / Loading / Un-Loading sheets and folds their line-item rows into
 * one operational record per date, shaped like the daily-entry form's POST body
 * so `writeEntryOps()` in server.js can store either without caring which it got.
 *
 * Workbook layout (all three sheets): title block on rows 1-3, blank row 4, the
 * column header on row 5, data from row 6. Column A is empty — real columns start
 * at B, so columns are resolved by header name rather than fixed positions.
 *
 * Sheets are matched by NAME, not by the title text inside them: the workbook's
 * Loading and Un-Loading sheets carry each other's titles.
 *
 * Per-day mapping (the app stores daily aggregates; the sheets are line items):
 *   PDI        -> qc.lines[]            one row per inspected part
 *   Loading    -> loading.parts_qty     = SUM(Part Qty.)
 *   Un-Loading -> unloading.weight_ton  = SUM(Loads(KG)) / 1000
 *                 unloading.truck_count = number of trip rows
 */
'use strict';
const ExcelJS = require('exceljs');

const HEADER_ROW = 5;
const MAX_BYTES = 10 * 1024 * 1024;

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const pad = (n) => String(n).padStart(2, '0');
const str = (v) => (v == null ? '' : String(v).trim());
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// exceljs cell values arrive as scalars, Dates, formula results, or rich text.
function cellVal(cell) {
  const v = cell ? cell.value : null;
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if (v.result !== undefined) return v.result; // formula cell
    if (v.text !== undefined) return v.text;     // hyperlink cell
    return null;                                 // error cell
  }
  return v;
}

// exceljs anchors date cells at UTC midnight, so UTC getters avoid an
// off-by-one day; text we fall back to parsing is local, so it uses local ones.
const ymdUtc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const ymdLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Normalise a date cell (Date | Excel serial | text) to 'YYYY-MM-DD', or null. */
function toYmd(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : ymdUtc(v);
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel serial -> epoch ms (25569 days between 1899-12-30 and 1970-01-01).
    const d = new Date(Math.round((v - 25569) * 86400000));
    return Number.isNaN(d.getTime()) ? null : ymdUtc(d);
  }
  const s = str(v);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s); // dd/mm/yyyy
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : ymdLocal(d);
}

const findSheet = (wb, key) => wb.worksheets.find((ws) => norm(ws.name) === key);

/** Map normalised header text -> column number, read from HEADER_ROW. */
function headerMap(ws) {
  const map = {};
  ws.getRow(HEADER_ROW).eachCell({ includeEmpty: false }, (cell, col) => {
    const key = norm(cellVal(cell));
    if (key && !(key in map)) map[key] = col;
  });
  return map;
}

const val = (row, H, key) => (H[key] == null ? null : cellVal(row.getCell(H[key])));
const rowHasData = (row, H) =>
  Object.values(H).some((c) => str(cellVal(row.getCell(c))) !== '');

/**
 * Parse a base64 data-URL upload into { days, counts, warnings }.
 * `days` entries are ready to hand to writeEntryOps().
 */
async function parse(dataUrl) {
  const m = /^data:([^;,]*);base64,([\s\S]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Error('Invalid upload — expected a base64-encoded file.');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('The file is empty.');
  if (buf.length > MAX_BYTES) throw new Error('File too large (max 10 MB).');

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf);
  } catch (_) {
    throw new Error('Could not read the workbook — please upload a valid .xlsx file.');
  }

  const days = new Map();
  const dayOf = (d) => {
    if (!days.has(d)) days.set(d, { work_date: d });
    return days.get(d);
  };
  // A sub-record is attached only once a sheet actually contributes a row for
  // that date. A missing key means "this workbook says nothing about it", which
  // writeEntryOps() leaves alone — quite different from an explicit zero, which
  // would wipe figures typed in by hand or loaded by an earlier import.
  const sect = (d, key, init) => {
    const day = dayOf(d);
    if (!day[key]) day[key] = init();
    return day[key];
  };

  const counts = { pdi: 0, loading: 0, unloading: 0 };
  const warnings = [];

  // Walk a sheet's data rows, resolving the date column once per sheet.
  const eachDataRow = (ws, fn) => {
    const H = headerMap(ws);
    if (H.date == null) {
      warnings.push(`Sheet "${ws.name}": no "Date" column on row ${HEADER_ROW} — skipped.`);
      return;
    }
    let undated = 0;
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n <= HEADER_ROW) return;
      const d = toYmd(val(row, H, 'date'));
      if (!d) {
        if (rowHasData(row, H)) undated++;
        return;
      }
      fn(row, H, d);
    });
    if (undated) warnings.push(`Sheet "${ws.name}": ${undated} row(s) without a readable date were ignored.`);
  };

  const pdi = findSheet(wb, 'pdi');
  if (pdi) {
    eachDataRow(pdi, (row, H, d) => {
      const part = str(val(row, H, 'partno')).toUpperCase();
      const checked = num(val(row, H, 'inspected'));
      const rejected = num(val(row, H, 'rejected'));
      const rework = num(val(row, H, 'rework'));
      if (!part && !checked && !rejected && !rework) return;
      // qc_lines has no inspector column; keep the name with the remarks rather
      // than dropping it silently.
      const inspector = str(val(row, H, 'inspectors'));
      const remarks = [str(val(row, H, 'remarks')), inspector && `Inspector: ${inspector}`]
        .filter(Boolean).join(' · ');
      sect(d, 'qc', () => ({ lines: [] })).lines.push({
        part_no: part || null,
        checked_qty: checked,
        rejected_qty: rejected,
        rework_qty: rework,
        remarks: remarks || null,
      });
      counts.pdi++;
    });
  } else warnings.push('No "PDI" sheet found — no inspection lines imported.');

  const loading = findSheet(wb, 'loading');
  if (loading) {
    eachDataRow(loading, (row, H, d) => {
      const qty = num(val(row, H, 'partqty'));
      if (!qty) return;
      // No truck_count key: the sheet has no truck column, so the importer must
      // not claim the day had zero trucks.
      sect(d, 'loading', () => ({ parts_qty: 0 })).parts_qty += qty;
      counts.loading++;
    });
  } else warnings.push('No "Loading" sheet found — no loading totals imported.');

  const unloading = findSheet(wb, 'unloading');
  if (unloading) {
    const kgByDay = new Map();
    eachDataRow(unloading, (row, H, d) => {
      sect(d, 'unloading', () => ({ truck_count: 0, weight_ton: 0 })).truck_count += 1; // one row = one trip
      kgByDay.set(d, (kgByDay.get(d) || 0) + num(val(row, H, 'loadskg')));
      counts.unloading++;
    });
    for (const [d, kg] of kgByDay) {
      days.get(d).unloading.weight_ton = Math.round((kg / 1000) * 1000) / 1000;
    }
  } else warnings.push('No "Un-Loading" sheet found — no unloading tonnage imported.');

  return {
    days: [...days.values()].sort((a, b) => (a.work_date < b.work_date ? -1 : 1)),
    counts,
    warnings,
  };
}

// ---- Blank template -------------------------------------------------------
// The workbook handed out by "Download sample sheet". Its layout is built from
// the same constants parse() reads (sheet names, HEADER_ROW, header text), so a
// filled-in template imports without any edits. Header strings are matched
// through norm() on the way back in, i.e. case- and punctuation-insensitive.
const TEMPLATE_ROWS = 300;
const FIRST_COL = 2;                                  // column A stays blank, as in the MIS workbook
const SAMPLE_DATE = new Date(Date.UTC(2026, 5, 24));  // 2026-06-24, UTC-anchored to match toYmd

const TEMPLATE_SHEETS = [
  {
    name: 'PDI',
    title: 'JMC Works — Alwar | PDI / QC Daily Log',
    hint: 'One row per part inspected. Date and Part No are required; Inspected / Rejected / Rework are piece counts. Row 6 is an example — delete it before importing.',
    headers: ['Date', 'S.no.', 'Part No', 'Category', 'Inspected', 'Rejected', 'Rework', 'Inspector(s)', 'Remarks'],
    widths: [13, 8, 15, 14, 11, 10, 10, 18, 34],
    partCol: 2, // 0-based index of 'Part No' — gets the dropdown
    sample: [null, 1, 'FTY00314', 'Chassis', 16, 0, 0, 'A. Kumar', 'EXAMPLE ROW — delete before importing'],
  },
  {
    name: 'Loading',
    title: 'JMC Works — Alwar | Loading Daily Log',
    hint: 'One row per part loaded. Part Qty. is summed per date into that day\'s loading total. Row 6 is an example — delete it before importing.',
    headers: ['Date', 'S.no.', 'Part No', 'Category', 'Part Qty.'],
    widths: [13, 8, 15, 14, 12],
    partCol: 2,
    sample: [null, 1, 'FTY00314', 'Chassis', 16],
  },
  {
    name: 'Un-Loading',
    title: 'JMC Works — Alwar | Unloading Daily Log',
    hint: 'One row per vehicle trip. Loads(KG) are summed per date and converted to tons; each row counts as one trip. Row 6 is an example — delete it before importing.',
    headers: ['Date', 'Vehicle/Type', 'Trips', 'Loads(KG)', 'Remarks'],
    widths: [13, 22, 9, 13, 34],
    partCol: null,
    sample: [null, 'Truck', 1, 13245, 'EXAMPLE ROW — delete before importing'],
  },
];

/**
 * Build the blank import template. `parts` (optional) is the active parts
 * master — [{ part_no, category }] — used to fill the Lists sheet and drive the
 * Part No dropdowns. Returns an ExcelJS workbook ready to stream.
 */
function buildTemplate(parts = []) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Drona ValueChain';
  wb.created = SAMPLE_DATE;

  // Reference sheet first, so the dropdown formulae below have a target.
  const lists = wb.addWorksheet('Lists');
  lists.getCell(1, 1).value = 'Part Number';
  lists.getCell(1, 2).value = 'Category';
  lists.getRow(1).font = { bold: true };
  lists.getColumn(1).width = 16;
  lists.getColumn(2).width = 16;
  parts.forEach((p, i) => {
    lists.getCell(i + 2, 1).value = p.part_no;
    lists.getCell(i + 2, 2).value = p.category;
  });
  const partRange = parts.length ? `Lists!$A$2:$A$${parts.length + 1}` : null;

  for (const spec of TEMPLATE_SHEETS) {
    const ws = wb.addWorksheet(spec.name);
    const lastCol = FIRST_COL + spec.headers.length - 1;

    ws.getCell(1, FIRST_COL).value = 'DRONA LOGITECH PVT. LTD.';
    ws.getCell(1, FIRST_COL).font = { bold: true, size: 13 };
    ws.getCell(2, FIRST_COL).value = spec.title;
    ws.getCell(2, FIRST_COL).font = { bold: true, size: 11, color: { argb: 'FF3A6FD0' } };
    ws.mergeCells(3, FIRST_COL, 3, lastCol);
    ws.getCell(3, FIRST_COL).value = spec.hint;
    ws.getCell(3, FIRST_COL).font = { size: 9, color: { argb: 'FF666666' } };
    ws.getCell(3, FIRST_COL).alignment = { wrapText: true, vertical: 'top' };

    spec.headers.forEach((label, i) => {
      const cell = ws.getCell(HEADER_ROW, FIRST_COL + i);
      cell.value = label;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B4C7E' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      ws.getColumn(FIRST_COL + i).width = spec.widths[i];
    });

    // One greyed-out example row, then blank rows pre-formatted for entry.
    const firstData = HEADER_ROW + 1;
    spec.sample.forEach((v, i) => {
      const cell = ws.getCell(firstData, FIRST_COL + i);
      cell.value = i === 0 ? SAMPLE_DATE : v;
      cell.font = { italic: true, color: { argb: 'FF999999' } };
    });

    for (let r = firstData; r < firstData + TEMPLATE_ROWS; r++) {
      ws.getCell(r, FIRST_COL).numFmt = 'yyyy-mm-dd';
      if (partRange && spec.partCol != null) {
        ws.getCell(r, FIRST_COL + spec.partCol).dataValidation = {
          type: 'list', allowBlank: true, formulae: [`=${partRange}`],
        };
      }
    }

    ws.views = [{ state: 'frozen', ySplit: HEADER_ROW }];
  }

  return wb;
}

module.exports = { parse, toYmd, buildTemplate };
