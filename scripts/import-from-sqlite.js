/**
 * One-time ETL: copy all rows from the legacy SQLite file (data.sqlite) into the
 * new Postgres database via Prisma. Run AFTER `prisma migrate deploy/dev`.
 *
 *   node scripts/import-from-sqlite.js            # uses ./data.sqlite
 *   SQLITE_PATH=/path/old.sqlite node scripts/import-from-sqlite.js
 *
 * Safe to re-run: rows are inserted with skipDuplicates, original primary keys
 * are preserved (so foreign keys line up), and the Postgres id sequences are
 * reset afterwards. Conversions: integer-booleans -> Boolean, 'YYYY-MM-DD HH:MM:SS'
 * (UTC) timestamps -> Date, settings.value JSON text -> jsonb object. Plain
 * business dates ('YYYY-MM-DD') are passed through unchanged.
 */
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { prisma } = require('../lib/prisma');

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data.sqlite');

// ---- value converters -----------------------------------------------------
const BOOL = (v) => (v == null ? null : !!v);
const DT = (v) => (v ? new Date(String(v).replace(' ', 'T') + 'Z') : null);
const JSN = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return v; } };

// ---- table specs (Postgres parent-first order) ----------------------------
// Each row maps an SQLite column -> [prismaField, converter?]. Columns not
// listed are dropped; converter defaults to identity.
const I = (x) => x;
const specs = [
  { model: 'user', seq: true, map: {
      id: ['id'], name: ['name'], username: ['username'], password_hash: ['passwordHash'],
      role: ['role'], company: ['company'], active: ['active', BOOL], created_at: ['createdAt', DT] } },

  { model: 'setting', seq: false, map: {
      key: ['key'], value: ['value', JSN], updated_at: ['updatedAt', DT] } },

  { model: 'session', seq: false, map: {
      token: ['token'], user_id: ['userId'], created_at: ['createdAt', DT] } },

  { model: 'pdiPart', seq: true, map: {
      id: ['id'], part_no: ['partNo'], category: ['category'], description: ['description'],
      active: ['active', BOOL], created_at: ['createdAt', DT] } },

  { model: 'worker', seq: true, map: {
      id: ['id'], roll_no: ['rollNo'], name: ['name'], father_name: ['fatherName'], gender: ['gender'],
      dob: ['dob'], blood_group: ['bloodGroup'], mobile: ['mobile'], address: ['address'],
      aadhaar: ['aadhaar'], pan: ['pan'], uan: ['uan'], esic_no: ['esicNo'], department: ['department'],
      designation: ['designation'], date_of_joining: ['dateOfJoining'], date_of_exit: ['dateOfExit'],
      supervisor: ['supervisor'], wage_type: ['wageType'], monthly_gross: ['monthlyGross'],
      daily_wage: ['dailyWage'], basic: ['basic'], hra: ['hra'], allowances: ['allowances'],
      pf_applicable: ['pfApplicable', BOOL], esi_applicable: ['esiApplicable', BOOL],
      bank_holder: ['bankHolder'], bank_name: ['bankName'], account_no: ['accountNo'], ifsc: ['ifsc'],
      emergency_name: ['emergencyName'], emergency_phone: ['emergencyPhone'], emergency_relation: ['emergencyRelation'],
      status: ['status'], photo: ['photo'], onboard_status: ['onboardStatus'], submitted_by: ['submittedBy'],
      submitted_at: ['submittedAt', DT], approved_by: ['approvedBy'], approved_at: ['approvedAt', DT],
      approval_remarks: ['approvalRemarks'], offer_letter_file: ['offerLetterFile'],
      offer_letter_at: ['offerLetterAt', DT], offer_terms: ['offerTerms'],
      created_at: ['createdAt', DT], updated_at: ['updatedAt', DT] } },

  { model: 'dailyEntry', seq: true, map: {
      id: ['id'], work_date: ['workDate'], status: ['status'], shift: ['shift'], notes: ['notes'],
      ppm: ['ppm'], created_by: ['createdBy'], submitted_at: ['submittedAt', DT], approved_by: ['approvedBy'],
      approved_at: ['approvedAt', DT], jmc_remarks: ['jmcRemarks'], created_at: ['createdAt', DT],
      updated_at: ['updatedAt', DT] } },

  { model: 'manpowerActual', seq: true, map: {
      id: ['id'], entry_id: ['entryId'], category: ['category'],
      approved_count: ['approvedCount'], actual_count: ['actualCount'] } },

  { model: 'loading', seq: false, map: {
      entry_id: ['entryId'], parts_qty: ['partsQty'], manpower_count: ['manpowerCount'], truck_count: ['truckCount'] } },

  { model: 'unloading', seq: false, map: {
      entry_id: ['entryId'], truck_count: ['truckCount'], weight_ton: ['weightTon'], manpower_count: ['manpowerCount'] } },

  { model: 'qc', seq: false, map: {
      entry_id: ['entryId'], parts_qty: ['partsQty'], manpower_count: ['manpowerCount'] } },

  { model: 'qcLine', seq: true, map: {
      id: ['id'], entry_id: ['entryId'], part_no: ['partNo'], checked_qty: ['checkedQty'],
      rejected_qty: ['rejectedQty'], rework_qty: ['reworkQty'], defect_type: ['defectType'], remarks: ['remarks'] } },

  { model: 'transportTrip', seq: true, map: {
      id: ['id'], entry_id: ['entryId'], from_loc: ['fromLoc'], to_loc: ['toLoc'],
      vehicle_type: ['vehicleType'], trip_time: ['tripTime'], remarks: ['remarks'] } },

  { model: 'attachment', seq: true, map: {
      id: ['id'], entry_id: ['entryId'], filename: ['filename'], caption: ['caption'],
      uploaded_by: ['uploadedBy'], created_at: ['createdAt', DT] } },

  { model: 'workerDocument', seq: true, map: {
      id: ['id'], worker_id: ['workerId'], doc_type: ['docType'], doc_slot: ['docSlot'], filename: ['filename'],
      caption: ['caption'], expiry_date: ['expiryDate'], uploaded_by: ['uploadedBy'], created_at: ['createdAt', DT] } },

  { model: 'attendance', seq: true, map: {
      id: ['id'], work_date: ['workDate'], worker_id: ['workerId'], status: ['status'], in_time: ['inTime'],
      out_time: ['outTime'], ot_hours: ['otHours'], remarks: ['remarks'], marked_by: ['markedBy'], created_at: ['createdAt', DT] } },

  { model: 'leaveApplication', seq: true, map: {
      id: ['id'], worker_id: ['workerId'], leave_type: ['leaveType'], from_date: ['fromDate'], to_date: ['toDate'],
      days: ['days'], reason: ['reason'], status: ['status'], applied_by: ['appliedBy'], decided_by: ['decidedBy'],
      decided_at: ['decidedAt', DT], decision_remarks: ['decisionRemarks'], created_at: ['createdAt', DT] } },

  { model: 'manpowerRequest', seq: true, map: {
      id: ['id'], req_date: ['reqDate'], needed_date: ['neededDate'], category: ['category'], extra_count: ['extraCount'],
      reason: ['reason'], ppm_current: ['ppmCurrent'], status: ['status'], requested_by: ['requestedBy'],
      decided_by: ['decidedBy'], decided_at: ['decidedAt', DT], decision_remarks: ['decisionRemarks'], created_at: ['createdAt', DT] } },

  { model: 'discrepancy', seq: true, map: {
      id: ['id'], disc_date: ['discDate'], type: ['type'], part_no: ['partNo'], description: ['description'],
      qty_dispatched: ['qtyDispatched'], qty_billed: ['qtyBilled'], qr_code: ['qrCode'], severity: ['severity'],
      status: ['status'], raised_by: ['raisedBy'], raised_company: ['raisedCompany'], resolution: ['resolution'],
      resolved_by: ['resolvedBy'], resolved_at: ['resolvedAt', DT], qc_entry_id: ['qcEntryId'], created_at: ['createdAt', DT] } },

  { model: 'auditLog', seq: true, map: {
      id: ['id'], user_id: ['userId'], action: ['action'], detail: ['detail'], at: ['at', DT] } },
];

// SQLite table name for each Prisma model (for reading + sequence reset).
const TABLE = {
  user: 'users', setting: 'settings', session: 'sessions', pdiPart: 'pdi_parts', worker: 'workers',
  dailyEntry: 'daily_entries', manpowerActual: 'manpower_actual', loading: 'loading', unloading: 'unloading',
  qc: 'qc', qcLine: 'qc_lines', transportTrip: 'transport_trips', attachment: 'attachments',
  workerDocument: 'worker_documents', attendance: 'attendance', leaveApplication: 'leave_applications',
  manpowerRequest: 'manpower_requests', discrepancy: 'discrepancies', auditLog: 'audit_log',
};

function convertRow(row, map) {
  const out = {};
  for (const [col, [field, conv]] of Object.entries(map)) {
    out[field] = (conv || I)(row[col]);
  }
  return out;
}

async function main() {
  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  console.log(`Reading legacy data from ${SQLITE_PATH}\n`);
  let grand = 0;

  for (const spec of specs) {
    const table = TABLE[spec.model];
    let rows;
    try {
      rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    } catch (e) {
      console.log(`  ${table.padEnd(20)} — table absent in source, skipped`);
      continue;
    }
    if (!rows.length) { console.log(`  ${table.padEnd(20)} — 0 rows`); continue; }
    const data = rows.map((r) => convertRow(r, spec.map));
    const res = await prisma[spec.model].createMany({ data, skipDuplicates: true });
    grand += res.count;
    console.log(`  ${table.padEnd(20)} — ${res.count}/${rows.length} imported`);
  }

  // Reset id sequences so future inserts don't collide with imported ids.
  console.log('\nResetting id sequences…');
  for (const spec of specs) {
    if (!spec.seq) continue;
    const table = TABLE[spec.model];
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), (SELECT COALESCE(MAX(id), 1) FROM "${table}"))`
    );
  }

  sqlite.close();
  console.log(`\n✔ Import complete — ${grand} rows copied into Postgres.`);
}

main()
  .catch((e) => { console.error('\n✖ Import failed:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
