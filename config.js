/**
 * Drona ValueChain — JMC Operations Tracker
 * Central business configuration.
 *
 * These are SEED DEFAULTS. Once the app runs, an ADMIN can change rates,
 * approved manpower and MG values from the Settings screen (stored in DB).
 * Money/billing is calculated and stored but HIDDEN in the UI for now
 * (per current requirement: "quantities only"). Flip SHOW_BILLING to true
 * later to reveal revenue everywhere.
 */

module.exports = {
  COMPANY: {
    provider: 'Drona ValueChain (Drona Logitech Pvt. Ltd.)',
    client: 'JMC Works Pvt. Ltd.',
  },

  // Toggle to reveal revenue/billing columns across the app.
  SHOW_BILLING: false,

  WORKING_DAYS_PER_MONTH: 26,

  // ---- Rates (from approved proposal) -------------------------------------
  RATES: {
    loading: { unit: 'PART', rate: 2.5 },     // Loading billed per part
    unloading: { unit: 'TON', rate: 125 },    // Unloading billed per ton
    qc: { unit: 'PART', rate: 9 },            // QC / PDI billed per part
  },

  // ---- Minimum Guarantee --------------------------------------------------
  // QC/PDI minimum guarantee = 600 parts/day for the first 3 months.
  MG: {
    qc_daily_parts: 600,
    guarantee_months: 3,
  },

  // ---- Approved manpower (the deployment baseline / minimum guarantee) -----
  // Actual daily manpower is compared against these; shortfalls are flagged.
  APPROVED_MANPOWER: [
    { category: 'LOADER',    label: 'Loaders',    approved: 4 },
    { category: 'UNLOADER',  label: 'Unloaders',  approved: 3 },
    { category: 'INSPECTOR', label: 'QC Inspectors', approved: 2 },
    { category: 'SUPERVISOR',label: 'Supervisor / Head', approved: 1 },
  ],

  // ---- Transport ----------------------------------------------------------
  VEHICLE_TYPES: ['19FT Truck', 'Tractor', 'Tempo', 'Other'],
  // Known route rates (used later when billing is enabled).
  TRANSPORT_RATES: [
    { from: 'JMC', to: 'VBCL',        vehicle: '19FT Truck', rate: 900 },
    { from: 'JMC', to: 'PANT NAGAR',  vehicle: '19FT Truck', rate: 15000 },
    { from: 'JMC', to: 'LUCKNOW',     vehicle: '19FT Truck', rate: 25000 },
    { from: 'JMC', to: 'VBCL',        vehicle: 'Tempo',      rate: 450 },
    { from: 'JMC', to: 'VBCL',        vehicle: 'Tractor',    rate: 450 },
  ],
  COMMON_LOCATIONS: ['JMC', 'VBCL', 'PANT NAGAR', 'LUCKNOW', 'AL'],

  // ---- Leave --------------------------------------------------------------
  LEAVE_TYPES: ['CL', 'SL', 'EL', 'LWP'], // Casual, Sick, Earned/Privilege, Leave Without Pay
  LEAVE_POLICY: { CL: 12, SL: 7, EL: 15, LWP: 0 }, // annual entitlement (days)

  // ---- PPM (production / quality number; lower is better) ------------------
  PPM_TARGET: 500,

  // ---- QC / PDI defect taxonomy -------------------------------------------
  // Categories an inspector tags a rejected part with. Drives the defect
  // Pareto in MIS. Editable later by an ADMIN (setting key 'defect_types').
  DEFECT_TYPES: ['DENT', 'SCRATCH', 'DIMENSION', 'MISSING_PART', 'WRONG_PART', 'QR_ISSUE', 'PAINT', 'BURR', 'OTHER'],

  // ---- Costs (monthly, INR) for internal P&L ------------------------------
  // transport_monthly = 0 means treat transport as pass-through (cost = transport revenue).
  COSTS: { manpower_monthly: 163000, overhead_monthly: 77000, transport_monthly: 0 },

  // ---- Finance (full P&L statement, setting key 'finance') ----------------
  // Drives the Finance page. Each cost line is tagged DIRECT or INDIRECT and is
  // admin-editable. Payroll and transport are deliberately NOT listed here —
  // the statement computes them: payroll from actual attendance, transport as
  // a pass-through of transport revenue. `overhead_monthly` above seeds the
  // starting INDIRECT line so the page opens with real numbers.
  //
  // Employer PF/ESI are the *company's* contributions, on top of the wages
  // paid. They are distinct from the employee deductions in calc.wageRow, which
  // are withheld from gross rather than added to cost.
  FINANCE: {
    cost_lines: [{ name: 'Overhead', amount: 77000, type: 'INDIRECT' }],
    employer_pf_pct: 13,       // % of earned basic
    employer_esi_pct: 3.25,    // % of (gross + OT)
    depreciation_monthly: 0,
    amortisation_monthly: 0,
    interest_monthly: 0,
    tax_pct: 0,                // % of PBT, charged only when PBT is positive
  },

  // ---- Invoice ------------------------------------------------------------
  INVOICE: { gst_pct: 0, gstin: '', bill_to: 'JMC Works Pvt. Ltd.', notes: 'Subject to 3-month review per LOI.' },
  // Bill QC at the guaranteed minimum (max of actual vs MG) per operating day.
  MG_BILLING: true,

  // ---- Email alerts -------------------------------------------------------
  // Admin-editable from Settings (stored under setting key 'alerts'). SMTP
  // transport itself is configured via env vars (SMTP_HOST/PORT/USER/PASS,
  // ALERT_FROM) — see .env.example. `recipients` is a comma-separated list.
  ALERTS: {
    enabled: false,
    recipients: '',          // "ops@drona.com, hq@drona.com"
    digest_hour: 2,          // local hour (0-23) the nightly digest is sent
    pnl_day_threshold: 20,   // only flag a negative P&L after this day-of-month
    pending_approvals_max: 3,// alert when submitted-but-unapproved days exceed this
    pending_mp_max: 1,       // alert when pending manpower requests exceed this
    doc_expiry_days: 45,     // alert on worker documents expiring within N days
    mg_short_days_max: 1,    // alert when QC days below MG exceed this
    // Daily operations summary email (separate from the threshold digest above).
    // Always sends when enabled — the dashboard rolled up for the prior day +
    // month-to-date — to its own recipient list.
    summary_enabled: false,
    summary_recipients: '',  // comma-separated; independent of `recipients`
    summary_hour: 0,         // local hour to send (0 = 12 AM / midnight)
  },

  // ---- Offer letter (generated after HQ approval) -------------------------
  // Editable by an ADMIN later from Settings (stored under setting key 'offer').
  OFFER: {
    company: 'Drona Logitech Private Limited',
    address: 'Drona ValueChain — Operations Office',
    city: 'Pant Nagar, Uttarakhand',
    email: '',
    phone: '',
    signatory_name: 'Authorised Signatory',
    signatory_title: 'HR & Operations, Drona ValueChain',
    probation_months: 3,
    notice_days: 30,
    notes: 'This offer is contingent on satisfactory verification of the documents submitted at onboarding. Employment is governed by the company’s standard terms of service.',
  },

  // ---- Roles --------------------------------------------------------------
  ROLES: {
    OPERATOR: 'Drona Operator',       // daily data entry
    JMC_APPROVER: 'JMC Approver',     // EOD approval of entries
    HQ: 'Drona HQ',                   // approves extra-manpower requests
    ADMIN: 'Drona Admin',             // manage rates, manpower, users
  },
};
