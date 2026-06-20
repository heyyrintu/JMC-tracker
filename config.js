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

  // ---- Costs (monthly, INR) for internal P&L ------------------------------
  // transport_monthly = 0 means treat transport as pass-through (cost = transport revenue).
  COSTS: { manpower_monthly: 163000, overhead_monthly: 77000, transport_monthly: 0 },

  // ---- Invoice ------------------------------------------------------------
  INVOICE: { gst_pct: 0, gstin: '', bill_to: 'JMC Works Pvt. Ltd.', notes: 'Subject to 3-month review per LOI.' },
  // Bill QC at the guaranteed minimum (max of actual vs MG) per operating day.
  MG_BILLING: true,

  // ---- Roles --------------------------------------------------------------
  ROLES: {
    OPERATOR: 'Drona Operator',       // daily data entry
    JMC_APPROVER: 'JMC Approver',     // EOD approval of entries
    HQ: 'Drona HQ',                   // approves extra-manpower requests
    ADMIN: 'Drona Admin',             // manage rates, manpower, users
  },
};
