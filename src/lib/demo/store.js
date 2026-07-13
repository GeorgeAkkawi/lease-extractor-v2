// Seeded in-memory data for demo mode. IDs are fixed so links are stable.
import { currentYear, fmtDate } from '../format';

const Y = currentYear();
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
// An escalation ~3 weeks out so the recommendation card shows on load.
const soon = (() => {
  const dt = new Date();
  dt.setDate(dt.getDate() + 21);
  return dt.toISOString().slice(0, 10);
})();
// ~3 weeks in the PAST — a lapsed tenant certificate, so the demo shows the red
// "Expired" badge + the "Request renewed certificate" flow.
const lapsed = (() => {
  const dt = new Date();
  dt.setDate(dt.getDate() - 21);
  return dt.toISOString().slice(0, 10);
})();

export const DEMO_USER = { id: 'demo-user', email: 'demo@local' };

export function seed() {
  // Cached plain-text copies of each lease, as if saved at intake. The per-tenant
  // AI assistant reads these (no PDF re-parsing). Dates use the platform format.
  const leaseText = {
    'lease-1': [
      'COMMERCIAL LEASE AGREEMENT',
      'Tenant: Bright Coffee Co.  Contact: Sam Rivera.',
      'Premises: Suite 100, approximately 2,000 rentable square feet at Maple Plaza, 100 Maple St.',
      'Base Rent: $60,000.00 per annum ($30.00 per square foot), payable in equal monthly installments of $5,000.00.',
      `Term: Five (5) years commencing ${fmtDate(iso(Y - 2, 1, 1))} and expiring ${fmtDate(iso(Y + 1, 12, 31))}.`,
      'Lease Type: Triple net (NNN). Tenant pays its pro-rata share of property taxes, CAM, and insurance.',
      'Annual Adjustment: Base Rent shall increase by three percent (3%) on the upcoming anniversary date.',
      'Roof & Structure: Tenant is responsible for its pro-rata share of roof expenses, allocated by square footage.',
      'Renewal: This lease contains no option to renew or extend.',
    ].join('\n'),
    'lease-2': [
      'COMMERCIAL LEASE AGREEMENT',
      'Tenant: City Dental.  Contact: Dana Lee.',
      'Premises: Suite 120, approximately 3,000 rentable square feet at Maple Plaza.',
      'Base Rent: $84,000.00 per annum ($28.00 per square foot), payable monthly.',
      `Term: Commencing ${fmtDate(iso(Y - 1, 6, 1))} and expiring ${fmtDate('2026-05-31')}.`,
      'Lease Type: Modified gross.',
      `Renewal: Tenant shall have one (1) option to renew for five (5) years (Option 1) at a market-rate reset, upon written notice no later than ${fmtDate('2025-11-30')}.`,
      'Maintenance: Landlord maintains the roof and building structure.',
    ].join('\n'),
    'lease-3': [
      'COMMERCIAL LEASE AGREEMENT',
      'Tenant: Northwind Books.  Contact: Jordan Pak.',
      'Premises: approximately 5,000 rentable square feet at Oak Center, 250 Oak Ave.',
      'Base Rent: $125,000.00 per annum, payable monthly.',
      `Term: Commencing ${fmtDate(iso(Y - 3, 1, 1))} and expiring ${fmtDate(soon)}.`,
      'CAM: By written agreement, Tenant pays forty percent (40%) of common-area maintenance (in lieu of pro-rata by square footage).',
      'Renewal: This lease contains no option to renew or extend; any new term must be separately negotiated.',
    ].join('\n'),
  };
  // Cached insurance copies (landlord building policy per property; tenant COI per lease).
  const policyText = {
    'prop-1': [
      'COMMERCIAL PROPERTY & LIABILITY POLICY',
      'Named insured: Acme Holdings LLC (landlord).  Property: Maple Plaza, 100 Maple St.',
      'Insurer: Granite Mutual Insurance Company.',
      'Commercial General Liability — each occurrence: $2,000,000; general aggregate: $4,000,000.',
      'Property coverage: building at replacement cost (special form); deductible $10,000.',
      `Policy period: ${fmtDate(iso(Y, 4, 1))} to ${fmtDate(soon)}.`,
    ].join('\n'),
    'lease-1': [
      'CERTIFICATE OF LIABILITY INSURANCE',
      'Named insured: Bright Coffee Co. (tenant), Suite 100, Maple Plaza.',
      'Insurer: Harbor Casualty Insurance.',
      'Commercial General Liability — each occurrence: $1,000,000; general aggregate: $2,000,000.',
      'Deductible: $2,500 per occurrence.',
      `Policy period: ${fmtDate(iso(Y, 7, 1))} to ${fmtDate(soon)}.`,
      'Additional insured: none listed on this certificate.',
    ].join('\n'),
    'lease-2': [
      'CERTIFICATE OF LIABILITY INSURANCE',
      'Named insured: City Dental (tenant), Suite 120, Maple Plaza.',
      'Insurer: Summit Indemnity Group.',
      'Commercial General Liability — each occurrence: $1,000,000; general aggregate: $2,000,000.',
      `Policy period: ${fmtDate(iso(Y - 1, 6, 1))} to ${fmtDate(lapsed)} (EXPIRED).`,
      'Additional insured: Acme Holdings LLC (landlord) per the lease.',
    ].join('\n'),
  };

  return {
    corporations: [
      {
        id: 'corp-1', owner_id: DEMO_USER.id, name: 'Acme Holdings', created_at: iso(Y, 1, 1),
        address: '100 Maple St, Suite 500, Springfield, IL 62701',
        contact_email: 'leasing@acmeholdings.example',
        contact_phone: '(555) 240-1180',
      },
      {
        id: 'corp-2', owner_id: DEMO_USER.id, name: 'Northwind Group', created_at: iso(Y, 1, 1),
        address: '4400 Oak Ave, Portland, OR 97204',
        contact_email: 'office@northwindgroup.example',
        contact_phone: '(555) 661-3300',
      },
    ],
    properties: [
      { id: 'prop-1', owner_id: DEMO_USER.id, corporation_id: 'corp-1', name: 'Maple Plaza', address: '100 Maple St', building_sf: 5000 },
      { id: 'prop-2', owner_id: DEMO_USER.id, corporation_id: 'corp-2', name: 'Oak Center', address: '250 Oak Ave', building_sf: 6000 },
    ],
    leases: [
      // Bright Coffee pays typed ESTIMATED CAM/tax/roof (0060). Its year invoice inv-1
      // already exists, so the finances table's Difference runs off that billed snapshot
      // (est 9,000 + 7,500 + 1,600 = 18,100) vs the actual share (7,200 + 10,000 + 1,600
      // = 18,800) → a live "+$700 tenant owes", demoing the Reconcile flow. City Dental
      // stays estimate-free to demo the bill-actuals fallback.
      { id: 'lease-1', owner_id: DEMO_USER.id, property_id: 'prop-1', tenant_name: 'Bright Coffee Co.', tenant_email: 'sam@brightcoffee.example', tenant_contact_name: 'Sam Rivera', premises_address: '100 Maple St — Suite 120', square_footage: 2000, base_rent: 60000, lease_start: iso(Y - 2, 1, 1), lease_termination_date: iso(Y + 1, 12, 31), lease_terms: 'NNN lease, 5 year term.', share_override_pct: null, roof_responsible: true, no_renewal_option: false, est_cam_annual: 6500, est_tax_annual: 10000, est_roof_annual: 1500, lease_text: leaseText['lease-1'], source: 'manual', extraction_status: 'reviewed' },
      { id: 'lease-2', owner_id: DEMO_USER.id, property_id: 'prop-1', tenant_name: 'City Dental', tenant_email: 'billing@citydental.example', tenant_email_2: 'dana.lee@citydental.example', tenant_contact_name: 'Dana Lee', premises_address: '100 Maple St — Suite 30', square_footage: 3000, base_rent: 84000, lease_start: iso(Y - 1, 6, 1), lease_termination_date: iso(2026, 5, 31), lease_terms: 'Includes one 5-year renewal option.', share_override_pct: null, roof_responsible: false, no_renewal_option: false, lease_text: leaseText['lease-2'], source: 'manual', extraction_status: 'reviewed' },
      // Ends soon with no renewal option on file → demonstrates the "lease ending —
      // no renewal" reminder, and the manual no-renewal flag set to confirmed.
      { id: 'lease-3', owner_id: DEMO_USER.id, property_id: 'prop-2', tenant_name: 'Northwind Books', tenant_email: 'accounts@northwindbooks.example', tenant_contact_name: 'Jordan Pak', premises_address: '250 Oak Ave — Unit 2', square_footage: 5000, base_rent: 125000, lease_start: iso(Y - 3, 1, 1), lease_termination_date: soon, lease_terms: 'Tenant pays 40% of CAM by agreement.', share_override_pct: 0.4, roof_responsible: false, no_renewal_option: true, lease_text: leaseText['lease-3'], source: 'ai_extracted', extraction_status: 'reviewed', ai_confidence: { square_footage: 0.99, base_rent: 0.97, lease_termination_date: 0.72, lease_terms: 0.6 } },
      // A MID-YEAR-START tenant (moved in July 1 of the current year) so the sandbox shows a
      // calendar-aware tracker: Jan–Jun read "—" (before the tenancy — not owed, not billed),
      // its year invoice is prorated to the 6 months it covers, and it only counts as "behind"
      // on months that have actually come due. Shares the 40% CAM override so it doesn't
      // disturb Northwind's reconciliation demo (both keep fixed override shares).
      { id: 'lease-4', owner_id: DEMO_USER.id, property_id: 'prop-2', tenant_name: 'Sunrise Yoga Studio', tenant_email: 'hello@sunriseyoga.example', tenant_contact_name: 'Priya Anand', premises_address: '250 Oak Ave — Unit 5', square_footage: 1000, base_rent: 36000, lease_start: iso(Y, 7, 1), lease_termination_date: iso(Y + 3, 6, 30), lease_terms: 'New tenancy commencing mid-year.', share_override_pct: null, roof_responsible: false, no_renewal_option: false, lease_text: 'COMMERCIAL LEASE AGREEMENT\nTenant: Sunrise Yoga Studio. Premises: Unit 5, approximately 1,000 rentable square feet at Oak Center.\nBase Rent: $36,000.00 per annum, payable monthly.', source: 'manual', extraction_status: 'reviewed' },
    ],
    rent_escalations: [
      // esc-1 is in the future → shows as an advance reminder; auto-applies on its date.
      { id: 'esc-1', owner_id: DEMO_USER.id, lease_id: 'lease-1', effective_date: soon, escalation_type: 'percent', escalation_value: 3, new_base_rent: 61800, status: 'scheduled' },
      // esc-2 already applied earlier — lease-3 base rent (125000) reflects it.
      { id: 'esc-2', owner_id: DEMO_USER.id, lease_id: 'lease-3', effective_date: iso(Y - 1, 1, 1), escalation_type: 'fixed', escalation_value: 5000, new_base_rent: 125000, status: 'applied', applied_at: iso(Y - 1, 1, 1) },
    ],
    renewal_options: [
      { id: 'ren-1', owner_id: DEMO_USER.id, lease_id: 'lease-2', option_label: 'Option 1', notice_by_date: iso(2025, 11, 30), term_months: 60, new_rent: 90000, annual_escalation_pct: 5, notes: 'Market-rate reset, then 5% annual increase.', status: 'pending' },
    ],
    expense_records: [
      { id: 'exp-1', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, taxes_total: 25000, cam_total: 18000, roof_total: 4000 },
      { id: 'exp-2', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y - 1, taxes_total: 22000, cam_total: 16000, roof_total: 0 },
      { id: 'exp-3', owner_id: DEMO_USER.id, property_id: 'prop-2', year: Y, taxes_total: 40000, cam_total: 30000, roof_total: 12000 },
      { id: 'exp-4', owner_id: DEMO_USER.id, property_id: 'prop-2', year: Y - 1, taxes_total: 36000, cam_total: 27000, roof_total: 10000 },
    ],
    cam_line_items: [
      { id: 'cam-1', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, label: 'Landscaping', amount: 8000, created_at: iso(Y, 1, 2) },
      { id: 'cam-2', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, label: 'Snow removal', amount: 4000, created_at: iso(Y, 1, 3) },
      { id: 'cam-3', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, label: 'Security', amount: 6000, created_at: iso(Y, 1, 4) },
    ],
    financial_snapshots: [
      { id: 'snap-0', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y - 2, total_revenue: 138000, taxes_total: 20000, cam_total: 15000, roof_total: 0, total_sf: 5000, tax_psf: 4.0, cam_psf: 3.0, breakdown: [], snapshot_at: iso(Y - 2, 12, 31) },
      { id: 'snap-1', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y - 1, total_revenue: 144000, taxes_total: 22000, cam_total: 16000, roof_total: 0, total_sf: 5000, tax_psf: 4.4, cam_psf: 3.2, breakdown: [], snapshot_at: iso(Y - 1, 12, 31) },
      { id: 'snap-2', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, total_revenue: 144000, taxes_total: 25000, cam_total: 18000, roof_total: 4000, total_sf: 5000, tax_psf: 5.0, cam_psf: 3.6, breakdown: [], snapshot_at: iso(Y, 12, 31) },
    ],
    expired_leases: [
      { id: 'exp-1', owner_id: DEMO_USER.id, property_id: 'prop-1', tenant_name: 'Riverside Tailors', sf: 1500, base_rent: 42000, lease_start: iso(Y - 6, 1, 1), lease_end: iso(Y - 1, 12, 31), status: 'Vacated', note: 'Did not renew; space re-leased to City Dental.', lease_text: ['COMMERCIAL LEASE AGREEMENT', 'Tenant: Riverside Tailors. Premises: Suite 110, approximately 1,500 rentable square feet at Maple Plaza.', 'Base Rent: $42,000.00 per annum, payable monthly.', `Term: Commencing ${fmtDate(iso(Y - 6, 1, 1))} and expiring ${fmtDate(iso(Y - 1, 12, 31))}.`, 'Lease Type: Modified gross.', 'Renewal: One (1) three-year option; tenant elected not to renew.'].join('\n') },
      { id: 'exp-2', owner_id: DEMO_USER.id, property_id: 'prop-1', tenant_name: 'Maple Hardware', sf: 2000, base_rent: 54000, lease_start: iso(Y - 8, 6, 1), lease_end: iso(Y - 2, 5, 31), status: 'Renewed', note: 'Renewed early as Bright Coffee Co.', lease_text: ['COMMERCIAL LEASE AGREEMENT', 'Tenant: Maple Hardware. Premises: Suite 100, approximately 2,000 rentable square feet at Maple Plaza.', 'Base Rent: $54,000.00 per annum, payable monthly.', `Term: Commencing ${fmtDate(iso(Y - 8, 6, 1))} and expiring ${fmtDate(iso(Y - 2, 5, 31))}.`, 'Lease Type: Triple net (NNN).', 'Renewal: Renegotiated early; space recommenced under a new lease.'].join('\n') },
      { id: 'exp-3', owner_id: DEMO_USER.id, property_id: 'prop-2', tenant_name: 'Old Town Press', sf: 3000, base_rent: 66000, lease_start: iso(Y - 7, 1, 1), lease_end: iso(Y - 3, 12, 31), status: 'Terminated', note: 'Early termination for non-payment.', lease_text: ['COMMERCIAL LEASE AGREEMENT', 'Tenant: Old Town Press. Premises: approximately 3,000 rentable square feet at Oak Center.', 'Base Rent: $66,000.00 per annum, payable monthly.', `Term: Commencing ${fmtDate(iso(Y - 7, 1, 1))} and expiring ${fmtDate(iso(Y - 3, 12, 31))}.`, 'Default: Lease terminated early for non-payment per the default provisions.'].join('\n') },
    ],
    insurance_policies: [
      // Expiries set near-term so the bell shows the expiring-insurance reminders.
      { id: 'ins-1', owner_id: DEMO_USER.id, party: 'landlord', property_id: 'prop-1', lease_id: null, insurer: 'Granite Mutual Insurance', coverage_amount: 2000000, expiry_date: soon, additional_insured: false, policy_text: policyText['prop-1'], storage_path: null, created_at: iso(Y, 4, 1) },
      // Bright Coffee's cert doesn't name the landlord — drives the "not listed as
      // additional insured" pop-up + red banner in demo.
      { id: 'ins-2', owner_id: DEMO_USER.id, party: 'tenant', property_id: 'prop-1', lease_id: 'lease-1', insurer: 'Harbor Casualty', coverage_amount: 1000000, expiry_date: soon, additional_insured: false, policy_text: policyText['lease-1'], storage_path: null, created_at: iso(Y, 7, 1) },
      // City Dental's certificate has already lapsed — drives the red "Expired" badge and
      // the "Request renewed certificate" flow in demo.
      { id: 'ins-3', owner_id: DEMO_USER.id, party: 'tenant', property_id: 'prop-1', lease_id: 'lease-2', insurer: 'Summit Indemnity Group', coverage_amount: 1000000, expiry_date: lapsed, additional_insured: true, policy_text: policyText['lease-2'], storage_path: null, created_at: iso(Y - 1, 6, 1) },
    ],
    // Starts empty — the landlord adds contracts via the Contracts tab.
    service_contracts: [],
    // One corporation's annual state filing due ~3 weeks out, so the demo bell shows
    // the "Annual report due" 1-month alert on load. Northwind has none on file yet.
    annual_reports: [
      { id: 'ar-1', owner_id: DEMO_USER.id, corporation_id: 'corp-1', due_date: soon, last_filed_date: iso(Y - 1, 3, 15), docs: [], due_notice_bucket: null, created_at: iso(Y, 1, 1), updated_at: iso(Y, 1, 1) },
    ],
    // Starts empty — the landlord records riders/amendments per lease.
    lease_addendums: [],
    // Receivables: one fully-paid invoice + one overdue, so AR has something to show.
    invoices: [
      { id: 'inv-1', owner_id: DEMO_USER.id, lease_id: 'lease-1', property_id: 'prop-1', year: Y, issue_date: iso(Y, 1, 1), due_date: iso(Y, 1, 31), status: 'sent', base_rent_annual: 60000, cam_annual: 9000, tax_annual: 7500, roof_annual: 1600, total_amount: 78100, notes: null, created_at: iso(Y, 1, 1) },
      { id: 'inv-2', owner_id: DEMO_USER.id, lease_id: 'lease-2', property_id: 'prop-1', year: Y, issue_date: iso(Y, 1, 1), due_date: iso(Y, 1, 31), status: 'sent', base_rent_annual: 84000, cam_annual: 8000, tax_annual: 6500, roof_annual: 0, total_amount: 98500, notes: null, created_at: iso(Y, 1, 1) },
    ],
    payments: [
      { id: 'pay-1', owner_id: DEMO_USER.id, invoice_id: 'inv-1', lease_id: 'lease-1', amount: 78100, paid_date: iso(Y, 2, 1), method: 'check', note: 'Paid in full', created_at: iso(Y, 2, 1) },
    ],
    lease_files: [],
    // Starts empty; the auto-renewal engine populates this on load (e.g. City
    // Dental, whose term has passed and has a pending renewal option).
    notifications: [],
    // Lease/tenant lifecycle log (assignments, renewals, insurance requests…). One
    // seeded insurance request so the "Last requested" line + History page render in demo.
    history_events: [
      { id: 'hist-1', owner_id: DEMO_USER.id, property_id: 'prop-1', lease_id: 'lease-1', type: 'insurance_requested', description: 'Insurance certificate requested from Bright Coffee Co. → sam@brightcoffee.example', tenant_name: 'Bright Coffee Co.', event_date: iso(Y, 7, 15), meta: { to: 'sam@brightcoffee.example', subject: 'Certificate of insurance — Maple Plaza' }, created_at: iso(Y, 7, 15) },
    ],
  };
}
