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

// A real, valid, one-page PDF — 1.7 kB, hand-built, no dependency — so the sandbox has an
// actual document to render and drag a signature onto. Without it the demo could not show
// drag-to-sign at all (there is no storage in DEMO mode, so `document_url` was null and the
// signing page fell straight to its "can't be shown" branch).
//
// It is lease-shaped on purpose: it carries a genuine signature block with two `By: ______`
// lines at PDF points (56, 420) and (320, 420), which is what makes "drop your signature on
// the signature line" a real thing to do in the demo rather than a click on blank paper.
export const DEMO_PDF_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwg' +
  'L1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2Ug' +
  'L1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAg' +
  'UiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5' +
  'cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggMTIxMiA+PgpzdHJlYW0K' +
  'QlQKL0YxIDE1IFRmCjEgMCAwIDEgNTYgNzgwIFRtCihTRUNPTkQgQU1FTkRNRU5UIFRPIExFQVNFKSBUagovRjEgMTAg' +
  'VGYKMSAwIDAgMSA1NiA3NDUgVG0KKE1hcGxlIFBsYXphIC0gU3VpdGUgMTIwKSBUagovRjEgMTAgVGYKMSAwIDAgMSA1' +
  'NiA3MTUgVG0KKFRoaXMgU2Vjb25kIEFtZW5kbWVudCB0byBMZWFzZSBpcyBlbnRlcmVkIGludG8gYXMgb2YgSmFudWFy' +
  'eSAxLCAyMDI2LCkgVGoKL0YxIDEwIFRmCjEgMCAwIDEgNTYgNzAwIFRtCihieSBhbmQgYmV0d2VlbiBBQ01FIEhPTERJ' +
  'TkdTIFwoIkxhbmRsb3JkIlwpIGFuZCBCUklHSFQgQ09GRkVFIENPLiBcKCJUZW5hbnQiXCkuKSBUagovRjEgMTAgVGYK' +
  'MSAwIDAgMSA1NiA2NjUgVG0KKDEuIFRFUk0uIFRoZSBUZXJtIGlzIGV4dGVuZGVkIHRocm91Z2ggRGVjZW1iZXIgMzEs' +
  'IDIwMzEuKSBUagovRjEgMTAgVGYKMSAwIDAgMSA1NiA2NDUgVG0KKDIuIEJBU0UgUkVOVC4gQmFzZSBSZW50IHNoYWxs' +
  'IGJlICQ2NiwwMDAuMDAgcGVyIGFubnVtLCBwYXlhYmxlIG1vbnRobHkuKSBUagovRjEgMTAgVGYKMSAwIDAgMSA1NiA2' +
  'MjUgVG0KKDMuIEFsbCBvdGhlciB0ZXJtcyBhbmQgY29uZGl0aW9ucyBvZiB0aGUgTGVhc2UgcmVtYWluIGluIGZ1bGwg' +
  'Zm9yY2UgYW5kIGVmZmVjdC4pIFRqCi9GMSAxMCBUZgoxIDAgMCAxIDU2IDU2MCBUbQooSU4gV0lUTkVTUyBXSEVSRU9G' +
  'LCB0aGUgcGFydGllcyBoYXZlIGV4ZWN1dGVkIHRoaXMgQW1lbmRtZW50LikgVGoKL0YxIDEwIFRmCjEgMCAwIDEgNTYg' +
  'NDkwIFRtCihMQU5ETE9SRDopIFRqCi9GMSAxMCBUZgoxIDAgMCAxIDU2IDQ3MCBUbQooQUNNRSBIT0xESU5HUykgVGoK' +
  'L0YxIDEwIFRmCjEgMCAwIDEgNTYgNDIwIFRtCihCeTogX19fX19fX19fX19fX19fX19fX19fX19fX19fXykgVGoKL0Yx' +
  'IDkgVGYKMSAwIDAgMSA1NiA0MDAgVG0KKE5hbWU6KSBUagovRjEgOSBUZgoxIDAgMCAxIDU2IDM4NSBUbQooRGF0ZTop' +
  'IFRqCi9GMSAxMCBUZgoxIDAgMCAxIDMyMCA0OTAgVG0KKFRFTkFOVDopIFRqCi9GMSAxMCBUZgoxIDAgMCAxIDMyMCA0' +
  'NzAgVG0KKEJSSUdIVCBDT0ZGRUUgQ08uKSBUagovRjEgMTAgVGYKMSAwIDAgMSAzMjAgNDIwIFRtCihCeTogX19fX19f' +
  'X19fX19fX19fX19fX19fX19fX19fXykgVGoKL0YxIDkgVGYKMSAwIDAgMSAzMjAgNDAwIFRtCihOYW1lOikgVGoKL0Yx' +
  'IDkgVGYKMSAwIDAgMSAzMjAgMzg1IFRtCihEYXRlOikgVGoKRVQKZW5kc3RyZWFtCmVuZG9iagp4cmVmCjAgNgowMDAw' +
  'MDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAw' +
  'MDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDMxMSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jv' +
  'b3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE1NzQKJSVFT0YK';

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
      // roof_separate (0097) is stated rather than left undefined, even though roofDisplay's
      // `!== false` reads a missing column as on: the seed is what the demo's screens are read
      // off, and a column the real table has NOT NULL should not be absent here.
      // Maple Plaza genuinely bills roof (roof line items + a roof-responsible lease); Oak
      // Center has no roof figure at all, which is the property the checkbox actually clears.
      { id: 'prop-1', owner_id: DEMO_USER.id, corporation_id: 'corp-1', name: 'Maple Plaza', address: '100 Maple St', building_sf: 5000, roof_separate: true },
      { id: 'prop-2', owner_id: DEMO_USER.id, corporation_id: 'corp-2', name: 'Oak Center', address: '250 Oak Ave', building_sf: 6000, roof_separate: true },
    ],
    leases: [
      // Bright Coffee pays typed ESTIMATED CAM/tax/roof (0060). Its year invoice inv-1
      // already exists, so the finances table's Difference runs off that billed snapshot
      // (est 9,000 + 7,500 + 1,600 = 18,100) vs the actual share (7,200 + 10,000 + 1,600
      // = 18,800) → a live "+$700 tenant owes", demoing the Reconcile flow. City Dental
      // stays estimate-free to demo the bill-actuals fallback.
      { id: 'lease-1', owner_id: DEMO_USER.id, property_id: 'prop-1', tenant_name: 'Bright Coffee Co.', tenant_email: 'sam@brightcoffee.example', tenant_contact_name: 'Sam Rivera', premises_address: '100 Maple St — Suite 120', square_footage: 2000, base_rent: 60000, lease_start: iso(Y - 2, 1, 1), lease_termination_date: iso(Y + 1, 12, 31), lease_terms: 'NNN lease, 5 year term.', share_override_pct: null, security_deposit: 10000, roof_responsible: true, no_renewal_option: false, est_cam_annual: 6500, est_tax_annual: 10000, est_roof_annual: 1500, est_confirmed_year: Y - 1, lease_text: leaseText['lease-1'], source: 'manual', extraction_status: 'reviewed' },
      { id: 'lease-2', owner_id: DEMO_USER.id, property_id: 'prop-1', tenant_name: 'City Dental', tenant_email: 'billing@citydental.example', tenant_email_2: 'dana.lee@citydental.example', tenant_contact_name: 'Dana Lee', premises_address: '100 Maple St — Suite 30', square_footage: 3000, base_rent: 84000, lease_start: iso(Y - 1, 6, 1), lease_termination_date: iso(2026, 5, 31), lease_terms: 'Includes one 5-year renewal option.', share_override_pct: null, roof_responsible: false, no_renewal_option: false, lease_text: leaseText['lease-2'], source: 'manual', extraction_status: 'reviewed', lease_file_id: 'lf-1' },
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
      // Carries its OWN year-by-year rents (0071) rather than a +%/yr formula — the shape
      // a lease actually prints, and the one the add-option dialog writes. They stay
      // hidden until the option is renewed, then become real dated rent steps. The
      // figures are the same 5%/yr climb the notes describe, so nothing about the
      // displayed rent or the confirm dialog moves.
      // The notice deadline carries the RULE the lease states (0072) as well as the date
      // it resolves to. Six months back from this lease's term end (2026-05-31) IS
      // 2025-11-30, so the date shown is unchanged — the row just now says why.
      { id: 'ren-1', owner_id: DEMO_USER.id, lease_id: 'lease-2', option_label: 'Option 1', notice_by_date: iso(2025, 11, 30), notice_lead_n: 6, notice_lead_unit: 'months', term_months: 60, new_rent: 90000, annual_escalation_pct: null, notes: 'Notice: six (6) months prior to expiration. Market-rate reset, then 5% annual increase.', status: 'pending',
        rent_schedule: [
          { months_from_option_start: 0, annual: 90000 },
          { months_from_option_start: 12, annual: 94500 },
          { months_from_option_start: 24, annual: 99225 },
          { months_from_option_start: 36, annual: 104186.25 },
          { months_from_option_start: 48, annual: 109395.56 },
        ] },
    ],
    expense_records: [
      { id: 'exp-1', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, taxes_total: 25000, cam_total: 18000, roof_total: 4000 },
      { id: 'exp-2', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y - 1, taxes_total: 22000, cam_total: 16000, roof_total: 0 },
      { id: 'exp-3', owner_id: DEMO_USER.id, property_id: 'prop-2', year: Y, taxes_total: 40000, cam_total: 30000, roof_total: 12000 },
      { id: 'exp-4', owner_id: DEMO_USER.id, property_id: 'prop-2', year: Y - 1, taxes_total: 36000, cam_total: 27000, roof_total: 10000 },
    ],
    // Three itemized lists share this table (0067 `kind`, widened by 0074): cam, tax,
    // roof. The roof lines re-sum to exactly the seeded expense_records figure above
    // (1,500 + 2,500 = 4,000), so the demo shows itemization WITHOUT moving a single
    // pinned total or tenant bill. TAXES are deliberately left un-itemized here: that
    // is the state the carry-forward guard exists for, it is what the demo's tax
    // section should show first, and expenseEntry.test.js pins it.
    // paid_date (0074) is set on most rows so the date column and the chronological
    // sort are visible; 'Security' is deliberately left undated to demo the honest
    // "—" a hand-typed figure gets, and that an undated line sorts last rather than
    // posing as January.
    cam_line_items: [
      { id: 'cam-1', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, kind: 'cam', label: 'Landscaping', amount: 8000, billable: true, paid_date: iso(Y, 4, 18), created_at: iso(Y, 1, 2) },
      { id: 'cam-2', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, kind: 'cam', label: 'Snow removal', amount: 4000, billable: true, paid_date: iso(Y, 1, 22), created_at: iso(Y, 1, 3) },
      { id: 'cam-3', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, kind: 'cam', label: 'Security', amount: 6000, billable: true, created_at: iso(Y, 1, 4) },
      // A "not billed to tenants" bucket (0064): itemized for the landlord's own
      // records, EXCLUDED from the CAM total — demos the second bucket family.
      { id: 'cam-4', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, kind: 'cam', label: 'Owner legal fees', amount: 1200, billable: false, paid_date: iso(Y, 2, 9), created_at: iso(Y, 1, 5) },
      // The roof, itemized (0074) — one repair and one replacement rather than the
      // single flat $4,000 that hid which was which.
      { id: 'roof-1', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, kind: 'roof', label: 'Apex Roofing — leak repair', amount: 1500, billable: true, paid_date: iso(Y, 5, 14), created_at: iso(Y, 1, 8) },
      { id: 'roof-2', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, kind: 'roof', label: 'Apex Roofing — section replacement', amount: 2500, billable: true, paid_date: iso(Y, 8, 27), created_at: iso(Y, 1, 9) },
      // OAK CENTER — the contract-derived rows (contract_id set) plus one hand-typed line.
      // Each auto row is EXACTLY contractAnnualCost(contract, year), so the first time the
      // year's Expenses page opens, syncContractCamItems finds them already correct and
      // writes nothing: prop-2's cam_total stays 30,000 (Y) / 27,000 (Y-1) and no tenant's
      // share, invoice or roll-up moves because contracts were seeded.
      //   Y   : svc-1 step 8,000 + svc-2 12,000×1.03 = 12,360 + janitorial 9,640 = 30,000
      //   Y-1 : svc-1 step 7,000 + svc-2 12,000              + janitorial  8,000 = 27,000
      { id: 'cam-5', owner_id: DEMO_USER.id, property_id: 'prop-2', year: Y, kind: 'cam', label: 'Snow removal — Arctic', amount: 8000, billable: true, contract_id: 'svc-1', created_at: iso(Y, 1, 2) },
      { id: 'cam-6', owner_id: DEMO_USER.id, property_id: 'prop-2', year: Y, kind: 'cam', label: 'Landscaping — GreenScape', amount: 12360, billable: true, contract_id: 'svc-2', created_at: iso(Y, 1, 2) },
      { id: 'cam-7', owner_id: DEMO_USER.id, property_id: 'prop-2', year: Y, kind: 'cam', label: 'Janitorial', amount: 9640, billable: true, paid_date: iso(Y, 3, 6), created_at: iso(Y, 1, 3) },
      { id: 'cam-8', owner_id: DEMO_USER.id, property_id: 'prop-2', year: Y - 1, kind: 'cam', label: 'Snow removal — Arctic', amount: 7000, billable: true, contract_id: 'svc-1', created_at: iso(Y - 1, 1, 2) },
      { id: 'cam-9', owner_id: DEMO_USER.id, property_id: 'prop-2', year: Y - 1, kind: 'cam', label: 'Landscaping — GreenScape', amount: 12000, billable: true, contract_id: 'svc-2', created_at: iso(Y - 1, 1, 2) },
      { id: 'cam-10', owner_id: DEMO_USER.id, property_id: 'prop-2', year: Y - 1, kind: 'cam', label: 'Janitorial', amount: 8000, billable: true, created_at: iso(Y - 1, 1, 3) },
    ],
    // Bucket records (0075) — the tax category a bucket rolls up to. Exactly ONE is
    // seeded, on purpose: it demos the "chosen" chip while Landscaping and Snow removal
    // fall back to Amlak's dashed defaults and Security — which has no honest default,
    // since a security service lands on Cleaning or Other depending on the CPA — shows
    // the gold "Set a tax category". All three states on one screen, and the gold one is
    // real money (the demo's $6,000) sitting in a bucket nobody has answered.
    expense_buckets: [
      { id: 'bkt-1', owner_id: DEMO_USER.id, label: 'Owner legal fees', category: 'legal', billable: false, capital_prone: false, created_at: iso(Y, 1, 5) },
    ],
    // Slice 4b — money that crossed prop-1's account and is NOT the building's income
    // or expense. Seeded because the new panels would otherwise render permanently
    // empty in demo and read as a bug. One of each kind, so "What actually stayed"
    // shows a real subtraction: NOI, less the $1,200 of not-billed legal fees already
    // seeded above, less these. The entity cost carries NO category on purpose — that
    // is the gold "Set a tax category" state, the same refusal 0075 makes.
    entity_ledger: [
      // `party` (0098) — who took it / who it came from. ent-1 and ent-2 are named; ent-3
      // deliberately carries NONE, because that is the state every IMPORTED row starts in
      // (a bank prints no payee on a cheque) and a demo where everything is already named
      // would hide the one the landlord actually has to act on. No row is added and no
      // amount moves: the seeded draw / contribution / cost totals are what several
      // "what actually stayed" tests assert, and colour is not worth re-baselining them.
      { id: 'ent-1', owner_id: DEMO_USER.id, corporation_id: 'corp-1', property_id: 'prop-1', year: Y, kind: 'draw', category: null, label: 'Owner distribution', party: 'Dana Whitfield', amount: 24000, txn_date: iso(Y, 3, 15), note: null, import_id: null, line_hash: null, created_at: iso(Y, 3, 15) },
      { id: 'ent-2', owner_id: DEMO_USER.id, corporation_id: 'corp-1', property_id: 'prop-1', year: Y, kind: 'cost', category: null, label: 'Illinois franchise tax', party: 'Illinois Secretary of State', amount: 1750, txn_date: iso(Y, 2, 1), note: null, import_id: null, line_hash: null, created_at: iso(Y, 2, 1) },
      { id: 'ent-3', owner_id: DEMO_USER.id, corporation_id: 'corp-1', property_id: 'prop-1', year: Y, kind: 'contribution', category: null, label: 'Capital call — roof work', party: null, amount: 5000, txn_date: iso(Y, 5, 20), note: null, import_id: null, line_hash: null, created_at: iso(Y, 5, 20) },
    ],
    // Slice 4c — income the property really received that no invoice knows about.
    // Three categories so the panel demos its grouping, and one row NAMES its tenant
    // (inc-1, City Dental's late fee) — the case the whole table exists for:
    // attribution without billing. City Dental's Ledger months must not move.
    other_income: [
      { id: 'inc-1', owner_id: DEMO_USER.id, property_id: 'prop-1', lease_id: 'lease-2', year: Y, category: 'late_fee', label: 'Late fee — March rent', amount: 250, txn_date: iso(Y, 3, 12), note: null, import_id: null, line_hash: null, created_at: iso(Y, 3, 12) },
      { id: 'inc-2', owner_id: DEMO_USER.id, property_id: 'prop-1', lease_id: null, year: Y, category: 'parking', label: 'Lot 2 monthly permits', amount: 1800, txn_date: iso(Y, 4, 1), note: null, import_id: null, line_hash: null, created_at: iso(Y, 4, 1) },
      { id: 'inc-3', owner_id: DEMO_USER.id, property_id: 'prop-1', lease_id: null, year: Y, category: 'utility', label: 'Water reimbursement', amount: 640, txn_date: iso(Y, 5, 9), note: null, import_id: null, line_hash: null, created_at: iso(Y, 5, 9) },
    ],
    // Slice 5a — things bought once and used for years. Every figure here divides
    // evenly on purpose, so the demo's yearly depreciation is a clean number a reader
    // can check by hand: the building's $936,000 basis over 39 years is exactly
    // $24,000/yr ($2,000/mo), the roof's $19,500 over 39 is $500, the parking lot's
    // $42,000 over 15 is $2,800. Dates are Y-relative so those figures stay stable as
    // the calendar moves.
    //
    // Three cases at once: a building placed in APRIL (so its first year is prorated to
    // 9 months and the whole-month convention is visible), a roof placed on January 1
    // (no proration), and — on prop-2 — a building with NO land allocation, which is
    // the gold "Set the land value" refusal. asset-1 also carries the accountant's own
    // accumulated figure through Y-3, which the schedule agrees with to the dollar.
    fixed_assets: [
      { id: 'asset-1', owner_id: DEMO_USER.id, property_id: 'prop-1', kind: 'building', description: 'Maple Plaza — structure', placed_in_service: iso(Y - 7, 4, 1), cost: 1190000, land_cost: 254000, useful_life_years: null, prior_accumulated: 114000, prior_accumulated_year: Y - 3, note: null, created_at: iso(Y - 7, 4, 1) },
      { id: 'asset-2', owner_id: DEMO_USER.id, property_id: 'prop-1', kind: 'improvement', description: 'Roof replacement', placed_in_service: iso(Y - 2, 1, 1), cost: 19500, land_cost: null, useful_life_years: null, prior_accumulated: null, prior_accumulated_year: null, note: null, created_at: iso(Y - 2, 1, 1) },
      { id: 'asset-3', owner_id: DEMO_USER.id, property_id: 'prop-1', kind: 'land_improvement', description: 'Parking lot resurfacing', placed_in_service: iso(Y - 4, 7, 1), cost: 42000, land_cost: null, useful_life_years: null, prior_accumulated: null, prior_accumulated_year: null, note: null, created_at: iso(Y - 4, 7, 1) },
      { id: 'asset-4', owner_id: DEMO_USER.id, property_id: 'prop-2', kind: 'building', description: 'Oak Center — structure', placed_in_service: iso(Y - 5, 1, 1), cost: 800000, land_cost: null, useful_life_years: null, prior_accumulated: null, prior_accumulated_year: null, note: null, created_at: iso(Y - 5, 1, 1) },
    ],
    financial_snapshots: [
      // snap-0 predates the Rent Ledger (no collection keys) — History renders "—"
      // for it; snap-1/snap-2 carry the frozen collection picture so the demo shows
      // a collection trend (94% → 96%).
      { id: 'snap-0', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y - 2, total_revenue: 138000, taxes_total: 20000, cam_total: 15000, roof_total: 0, total_sf: 5000, tax_psf: 4.0, cam_psf: 3.0, breakdown: [], snapshot_at: iso(Y - 2, 12, 31) },
      { id: 'snap-1', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y - 1, total_revenue: 144000, taxes_total: 22000, cam_total: 16000, roof_total: 0, total_sf: 5000, tax_psf: 4.4, cam_psf: 3.2, breakdown: [
        { tenant: 'Bright Coffee Co.', square_footage: 2000, base_rent: 60000, share_pct: 0.4, tax_amount: 8800, cam_amount: 6400, projected: 75200, collected: 75200, collection_rate: 1, collected_by_month: Array(12).fill(6266.67) },
        { tenant: 'City Dental', square_footage: 3000, base_rent: 84000, share_pct: 0.6, tax_amount: 13200, cam_amount: 9600, projected: 106800, collected: 95000, collection_rate: 0.89, collected_by_month: Array(12).fill(7916.67) },
      ], snapshot_at: iso(Y - 1, 12, 31) },
      { id: 'snap-2', owner_id: DEMO_USER.id, property_id: 'prop-1', year: Y, total_revenue: 144000, taxes_total: 25000, cam_total: 18000, roof_total: 4000, total_sf: 5000, tax_psf: 5.0, cam_psf: 3.6, breakdown: [
        { tenant: 'Bright Coffee Co.', square_footage: 2000, base_rent: 60000, share_pct: 0.4, tax_amount: 10000, cam_amount: 7200, projected: 78100, collected: 78100, collection_rate: 1, collected_by_month: Array(12).fill(6508.33) },
        { tenant: 'City Dental', square_footage: 3000, base_rent: 84000, share_pct: 0.6, tax_amount: 15000, cam_amount: 10800, projected: 98500, collected: 91500, collection_rate: 0.929, collected_by_month: Array(12).fill(7625) },
      ], snapshot_at: iso(Y, 12, 31) },
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
      // ── Policy history. Uploading a new policy over one already on file ARCHIVES the old
      // one rather than overwriting it (George, 2026-08-05), so a scope accumulates a row
      // per policy year. These two are what the year before looked like — a different
      // insurer and a lower limit on the building, and a certificate that did NOT name the
      // landlord on City Dental's. Archived rows are invisible to every alert, the email
      // sweep and the Ask snapshot: all of them filter `archived_at is null`.
      { id: 'ins-4', owner_id: DEMO_USER.id, party: 'landlord', property_id: 'prop-1', lease_id: null, insurer: 'Keystone Property & Casualty', coverage_amount: 1500000, premium_amount: 14200, expiry_date: iso(Y - 1, 5, 1), additional_insured: null, policy_text: policyText['prop-1'], storage_path: `${DEMO_USER.id}/keystone-${Y - 2}-certificate.pdf`, archived_at: iso(Y - 1, 4, 2), created_at: iso(Y - 2, 4, 1) },
      { id: 'ins-5', owner_id: DEMO_USER.id, party: 'tenant', property_id: 'prop-1', lease_id: 'lease-2', insurer: 'Summit Indemnity Group', coverage_amount: 500000, expiry_date: iso(Y - 1, 6, 1), additional_insured: false, policy_text: policyText['lease-2'], storage_path: null, archived_at: iso(Y - 1, 5, 20), created_at: iso(Y - 2, 6, 1) },
    ],
    // Two contracts on OAK CENTER (prop-2), never Maple Plaza (prop-1) — prop-1's CAM is
    // already itemized to exactly its cam_total and is the property every money test
    // hammers. The matching cam_line_items below (one per contract, per year) hold
    // prop-2's cam_total at its seeded figure, so seeding contracts moves no money:
    // syncContractCamItems finds the rows already correct and writes nothing.
    //
    // svc-1 is the whole point of this round — it auto-renews, and the deadline that
    // costs money is the CANCELLATION NOTICE, not the end date. notice_by_date is ~3
    // weeks out so the dashboard bell shows the "notice due" alert on load.
    // svc-2 is the other shape: monthly (×12) with a scalar escalation_pct and NO dated
    // steps, so the fallback path stays visible beside the dated one.
    service_contracts: [
      {
        id: 'svc-1', owner_id: DEMO_USER.id, property_id: 'prop-2', name: 'Snow removal — Arctic',
        service_type: 'snow_removal', vendor: 'Arctic Snow Services', vendor_email: 'billing@arcticsnow.example',
        amount: 8000, frequency: 'annual', escalation_pct: null,
        start_date: iso(Y - 2, 11, 1), end_date: iso(Y + 1, 10, 31),
        auto_renew: true, notice_days: 30, notice_by_date: soon, renewal_term_months: 12,
        cancel_notice_bucket: null, end_notice_bucket: null,
        // 0094 — the vendor carries insurance but the agreement never names the Owner on it.
        // FALSE, not null: the contract has been read and it genuinely does not require the
        // endorsement, which is what raises the warning and offers the letter.
        additional_insured: false,
        contract_text: [
          'SNOW REMOVAL SERVICE AGREEMENT',
          'By and between Acme Holdings LLC (the "Owner") and Arctic Snow Services (the "Contractor").',
          'Premises: Oak Center, 250 Oak Ave.',
          'Services: plowing and salting of the parking lot and walkways at a trigger depth of two (2) inches.',
          `Fee: $7,000.00 per season for the ${Y - 2}–${Y - 1} season, increasing to $8,000.00 per season effective November 1, ${Y}.`,
          `Term: Commencing ${fmtDate(iso(Y - 2, 11, 1))} and expiring ${fmtDate(iso(Y + 1, 10, 31))}.`,
          'Renewal: This Agreement renews automatically for successive twelve (12) month terms unless either party gives thirty (30) days written notice of cancellation prior to the expiration of the then-current term.',
          'Insurance: Contractor shall maintain commercial general liability insurance of not less than $1,000,000 per occurrence. No provision of this Agreement requires the Owner to be named as an additional insured.',
          'Excluded: hauling of accumulated snow off site, ice-melt applied at Owner’s request beyond two applications per event, and storm cleanup, each billed separately at the Contractor’s published rates.',
        ].join('\n'),
        storage_path: `${DEMO_USER.id}/arctic-snow-agreement.pdf`,
        extraction_raw: null, ai_confidence: null, ai_review: null,
        created_at: iso(Y - 2, 10, 15), updated_at: iso(Y - 2, 10, 15),
      },
      {
        id: 'svc-2', owner_id: DEMO_USER.id, property_id: 'prop-2', name: 'Landscaping — GreenScape',
        service_type: 'landscaping', vendor: 'GreenScape Inc.', vendor_email: 'ar@greenscape.example',
        amount: 1000, frequency: 'monthly', escalation_pct: 3,
        start_date: iso(Y - 1, 1, 1), end_date: null,
        auto_renew: null, notice_days: null, notice_by_date: null, renewal_term_months: null,
        cancel_notice_bucket: null, end_notice_bucket: null,
        // The compliant half of the pair, so the demo shows both answers side by side.
        additional_insured: true,
        contract_text: [
          'GROUNDS MAINTENANCE AGREEMENT',
          'By and between Acme Holdings LLC (the "Owner") and GreenScape Inc. (the "Contractor").',
          'Services: weekly mowing, seasonal planting, and leaf removal at Oak Center.',
          'Fee: $1,000.00 per month, increasing three percent (3%) on each anniversary of the commencement date.',
          'Insurance: Contractor shall name the Owner as an additional insured on its commercial general liability policy and furnish a certificate evidencing the same.',
          `Term: Commencing ${fmtDate(iso(Y - 1, 1, 1))} and continuing until cancelled by either party.`,
        ].join('\n'),
        storage_path: null,
        extraction_raw: null, ai_confidence: null, ai_review: null,
        created_at: iso(Y - 1, 1, 1), updated_at: iso(Y - 1, 1, 1),
      },
    ],
    // Dated fee steps (0091). DERIVED, never applied — nothing writes service_contracts.amount,
    // so `amount` stays the contract's own base and the step in effect for a year wins over it.
    // new_amount is in the contract's OWN frequency (svc-1 is annual, so these are annual).
    // The closing row at the ORIGINAL fee is what keeps Y-1 priced at $7,000 rather than
    // re-pricing the whole term at today's figure — the same reason a lease needs one.
    contract_escalations: [
      { id: 'cesc-1', owner_id: DEMO_USER.id, contract_id: 'svc-1', effective_date: iso(Y - 2, 11, 1), new_amount: 7000, escalation_type: 'manual', escalation_value: null, source: 'contract', note: 'Original season fee.', created_at: iso(Y - 2, 10, 15), updated_at: iso(Y - 2, 10, 15) },
      { id: 'cesc-2', owner_id: DEMO_USER.id, contract_id: 'svc-1', effective_date: iso(Y, 11, 1), new_amount: 8000, escalation_type: 'fixed', escalation_value: 1000, source: 'contract', note: null, created_at: iso(Y - 2, 10, 15), updated_at: iso(Y - 2, 10, 15) },
    ],
    // One corporation's annual state filing due ~3 weeks out, so the demo bell shows
    // the "Annual report due" 1-month alert on load. Northwind has none on file yet.
    annual_reports: [
      { id: 'ar-1', owner_id: DEMO_USER.id, corporation_id: 'corp-1', due_date: soon, last_filed_date: iso(Y - 1, 3, 15), docs: [], due_notice_bucket: null, created_at: iso(Y, 1, 1), updated_at: iso(Y, 1, 1) },
    ],
    // Two riders on City Dental, so the lease page's "Open rider" rows have something
    // to open and the Covers column has a real period to show. Deliberately kinds that
    // do NOT move the term (currentTermLabel only reads kind==='extension'), so seeding
    // them can't change the header the rest of the demo asserts.
    lease_addendums: [
      {
        id: 'add-1', owner_id: DEMO_USER.id, lease_id: 'lease-2', label: 'First Amendment to Lease',
        amendment_date: iso(Y - 2, 6, 30), effective_from: iso(Y - 2, 7, 1), effective_to: iso(Y + 1, 6, 30),
        kind: 'rent_change', summary: 'Base rent adjusted; all other terms unchanged.',
        storage_path: `${DEMO_USER.id}/first-amendment.pdf`,
        addendum_text: [
          'FIRST AMENDMENT TO LEASE',
          `This First Amendment is entered into as of ${fmtDate(iso(Y - 2, 6, 30))} between the Landlord and City Dental (the "Tenant").`,
          '1. RENT. Effective July 1, the Monthly Base Rent shall be increased to $7,000.00 per month.',
          '2. All other terms and conditions of the Lease remain in full force and effect.',
        ].join('\n'),
        extraction_raw: null, created_at: iso(Y - 2, 6, 30),
      },
      {
        id: 'add-2', owner_id: DEMO_USER.id, lease_id: 'lease-2', label: 'Signage Rider',
        amendment_date: iso(Y - 1, 3, 12), effective_from: iso(Y - 1, 4, 1), effective_to: null,
        kind: 'other', summary: 'Permits an exterior sign at Tenant’s expense.',
        storage_path: null,   // pasted in, not uploaded — demos the "no file" row
        addendum_text: [
          'SIGNAGE RIDER',
          'Tenant may install one (1) exterior sign on the storefront fascia, subject to Landlord’s prior written approval as to size and design.',
          'Tenant shall maintain the sign at its own expense and remove it at the expiration of the Term, repairing any damage.',
        ].join('\n'),
        extraction_raw: null, created_at: iso(Y - 1, 3, 12),
      },
    ],
    // Every uploaded file, kept and openable (0070). City Dental's lease has TWO saved
    // copies — the version history George asked for ("keep every version but allow
    // deletes") only reads as history when something actually has two.
    documents: [
      // signed_at (0092) designates the executed copy. One nullable column serves leases,
      // riders, contracts and policies, because they all file in this one registry.
      { id: 'doc-1', owner_id: DEMO_USER.id, entity_type: 'lease', entity_id: 'lease-2', storage_path: `${DEMO_USER.id}/city-dental-lease.pdf`, filename: 'city-dental-lease.pdf', bytes: 2_410_000, mime: 'application/pdf', label: null, note: null, signed_at: `${iso(Y - 1, 5, 20)}T12:00:00.000Z`, created_at: iso(Y - 1, 5, 20) },
      { id: 'doc-2', owner_id: DEMO_USER.id, entity_type: 'lease', entity_id: 'lease-2', storage_path: `${DEMO_USER.id}/city-dental-lease-scan.pdf`, filename: 'city-dental-lease.pdf', bytes: 2_380_000, mime: 'application/pdf', label: null, note: null, created_at: iso(Y - 2, 11, 2) },
      { id: 'doc-3', owner_id: DEMO_USER.id, entity_type: 'addendum', entity_id: 'add-1', storage_path: `${DEMO_USER.id}/first-amendment.pdf`, filename: 'first-amendment.pdf', bytes: 184_000, mime: 'application/pdf', label: 'First Amendment to Lease', note: null, created_at: iso(Y - 2, 6, 30) },
      { id: 'doc-4', owner_id: DEMO_USER.id, entity_type: 'insurance_policy', entity_id: 'ins-3', storage_path: `${DEMO_USER.id}/city-dental-coi.pdf`, filename: 'city-dental-coi.pdf', bytes: 96_000, mime: 'application/pdf', label: null, note: null, created_at: iso(Y - 1, 6, 1) },
      // The snow contract's executed copy — the "signed copy stored in the contracts tab"
      // George asked for, on the same registry and the same column as the lease's.
      { id: 'doc-5', owner_id: DEMO_USER.id, entity_type: 'service_contract', entity_id: 'svc-1', storage_path: `${DEMO_USER.id}/arctic-snow-agreement.pdf`, filename: 'arctic-snow-agreement-signed.pdf', bytes: 148_000, mime: 'application/pdf', label: null, note: null, signed_at: `${iso(Y - 2, 10, 15)}T12:00:00.000Z`, created_at: iso(Y - 2, 10, 15) },
    ],
    // Bank-statement import (0063): the register + the "always match" rules both
    // start empty; the demo Import button offers a bundled sample CSV instead.
    statement_imports: [],
    import_rules: [],
    // Receivables: one fully-paid invoice + one overdue, so AR has something to show.
    // Both invoices are BUILT FROM the lease + estimate/actual (the ledger and the invoice
    // read the same data, so they reconcile with no scaling):
    //   inv-1 Bright Coffee = base 60,000 + est CAM&tax 16,500 + est roof 1,500 = 78,000.
    //   inv-2 City Dental   = base 84,000 + actual share (0.6 × 25,000 tax + 0.6 × 18,000 CAM)
    //                       = 84,000 + 15,000 + 10,800 = 109,800  (monthly 9,150).
    invoices: [
      { id: 'inv-1', owner_id: DEMO_USER.id, lease_id: 'lease-1', property_id: 'prop-1', year: Y, issue_date: iso(Y, 1, 1), due_date: iso(Y, 1, 31), status: 'sent', base_rent_annual: 60000, cam_annual: 6500, tax_annual: 10000, roof_annual: 1500, total_amount: 78000, notes: null, created_at: iso(Y, 1, 1) },
      { id: 'inv-2', owner_id: DEMO_USER.id, lease_id: 'lease-2', property_id: 'prop-1', year: Y, issue_date: iso(Y, 1, 1), due_date: iso(Y, 1, 31), status: 'sent', base_rent_annual: 84000, cam_annual: 10800, tax_annual: 15000, roof_annual: 0, total_amount: 109800, notes: null, created_at: iso(Y, 1, 1) },
    ],
    // `source` is load-bearing, not decoration (0088): only a 'system' row — one the app
    // priced off the schedule — may be re-stamped when a billed figure moves. 'manual' and
    // 'import' rows are real money and are never re-priced.
    payments: [
      // Bright Coffee: one untagged lump that settles the whole 78,000 year exactly — the
      // Ledger's FIFO showcase (fills Jan→Dec, all ✓, no phantom credit).
      { id: 'pay-1', owner_id: DEMO_USER.id, invoice_id: 'inv-1', lease_id: 'lease-1', amount: 78000, paid_date: iso(Y, 2, 1), method: 'check', note: 'Paid in full', source: 'manual', created_at: iso(Y, 2, 1) },
      // City Dental: two full month-tagged checks (9,150 = the real monthly) + an untagged
      // partial, so the grid shows mixed states (Jan ✓ · Feb ✓ · Mar ◐ · rest open).
      // The two tagged ones are SYSTEM marks — the "mark paid" click — which is what makes
      // them the fixture for the re-stamp path in estimateResync.test.js.
      { id: 'pay-2', owner_id: DEMO_USER.id, invoice_id: 'inv-2', lease_id: 'lease-2', amount: 9150, paid_date: iso(Y, 1, 5), method: 'check', note: null, period_month: 1, source: 'system', created_at: iso(Y, 1, 5) },
      { id: 'pay-3', owner_id: DEMO_USER.id, invoice_id: 'inv-2', lease_id: 'lease-2', amount: 9150, paid_date: iso(Y, 2, 4), method: 'ach', note: null, period_month: 2, source: 'system', created_at: iso(Y, 2, 4) },
      { id: 'pay-4', owner_id: DEMO_USER.id, invoice_id: 'inv-2', lease_id: 'lease-2', amount: 4000, paid_date: iso(Y, 3, 10), method: 'check', note: 'Partial', source: 'manual', created_at: iso(Y, 3, 10) },
    ],
    lease_files: [
      // City Dental's cached AI read: the lease STATES an estimated CAM & tax figure
      // but no estimate is saved on the lease — so the Financials estimate editor
      // opens pre-filled "from the lease" ($12,000/yr = $4.00/SF over 3,000 SF).
      {
        id: 'lf-1', owner_id: DEMO_USER.id, lease_id: 'lease-2', file_name: 'city-dental-lease.pdf',
        extraction_raw: {
          est_cam_annual: { value: 12000, confidence: 0.88, source_quote: 'Tenant shall pay estimated CAM and tax charges of $4.00 per square foot per annum, reconciled annually', page: 4 },
        },
        created_at: iso(Y - 1, 5, 20),
      },
    ],
    // Starts empty; the auto-renewal engine populates this on load (e.g. City
    // Dental, whose term has passed and has a pending renewal option).
    notifications: [],
    // Lease/tenant lifecycle log (assignments, renewals, insurance requests…). One
    // seeded insurance request so the "Last requested" line + History page render in demo.
    history_events: [
      { id: 'hist-1', owner_id: DEMO_USER.id, property_id: 'prop-1', lease_id: 'lease-1', type: 'insurance_requested', description: 'Insurance certificate requested from Bright Coffee Co. → sam@brightcoffee.example', tenant_name: 'Bright Coffee Co.', event_date: iso(Y, 7, 15), meta: { to: 'sam@brightcoffee.example', subject: 'Certificate of insurance — Maple Plaza' }, created_at: iso(Y, 7, 15) },
    ],
    // One saved announcement, so the Announcements window opens with its template list
    // populated. Stored TOKENIZED — {date}/{property}/{business} — exactly as the live
    // table does, which is what lets the demo show a year-old notice reopening dated
    // today. See src/lib/announcementTokens.js.
    announcement_templates: [
      {
        id: 'anntpl-1',
        owner_id: DEMO_USER.id,
        name: 'Winter weather procedures',
        subject: 'Winter Weather Procedures — {property}',
        body: [
          '{business}',
          '{business_address}',
          '{business_contact}',
          '',
          '{date}',
          '',
          'All Tenants',
          '{property}',
          '',
          'RE: Winter Weather Procedures — {property}',
          '',
          'Dear Tenants,',
          '',
          'As the winter season approaches, we are writing to remind all tenants of the snow and ice procedures at {property}.',
          '',
          'Common areas and the parking lot will be cleared by our contractor. Please keep your own entrance clear and report any hazardous conditions to the office promptly.',
          '',
          'Please contact our office with any questions.',
          '',
          'Sincerely,',
          '{business}',
          '{business_contact}',
        ].join('\n'),
        ai_request: 'remind everyone about the snow and ice procedures for the winter',
        last_used_at: iso(Y - 1, 11, 3),
        created_at: iso(Y - 1, 11, 3),
        updated_at: iso(Y - 1, 11, 3),
      },
    ],

    // Three envelopes on Bright Coffee, one per state that shows something:
    //   env-3  SENT      — still out with the tenant. **This is the one you open at
    //                      /sign/env-3 to see the tenant's side and drag a signature onto
    //                      the document.** Without it the sandbox has nothing signable: the
    //                      other two are already past that point, so every signing link in
    //                      the demo answered "already handled" and drag-to-sign — the thing
    //                      George asked to be shown — could not be demonstrated at all.
    //   env-1  SIGNED    — waiting on the landlord's countersignature.
    //   env-2  EXECUTED  — signed by both and never applied.
    //
    // …plus two on the CONTRACTS side (0093), because until this round an envelope could
    // only ever belong to a lease and the contracts tab had no way to send anything:
    //   env-4  SENT      — the snow renewal, out with the VENDOR rather than a tenant.
    //   env-5  EXECUTED  — the grounds renewal, signed by both and not yet read. This is the
    //                      one that shows the prompt George asked for: *"only when its
    //                      countersigned the user should be prompted with extract info with
    //                      AI then it should upload."*
    //
    // ⚠ token_hash HOLDS THE ENVELOPE ID HERE. The demo has no crypto and no security
    // boundary; live stores ONLY sha256 of a 32-byte CSPRNG token (0085). Anyone reading
    // this as a template for the real thing has it exactly backwards.
    signature_envelopes: [
      {
        id: 'env-3', owner_id: DEMO_USER.id, lease_id: 'lease-1', contract_id: null, property_id: 'prop-1',
        renewal_option_id: null, purpose: 'extension', title: 'Third Amendment to Lease',
        storage_path: 'demo/third-amendment.pdf', filename: 'Third Amendment to Lease.pdf',
        doc_sha256: 'c4d9e2b70a15368fbe2c04a97d31856ef0b4a2c68d5e9137fa2b06c4d8e15937',
        message: 'Here’s the extension we discussed — sign at the bottom of page 1 and I’ll countersign.',
        // A month out, so the row shows a real countdown rather than a bare date.
        status: 'sent', expires_at: new Date(Date.now() + 26 * 86400000).toISOString(),
        sent_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        signed_at: null, countersigned_at: null, executed_at: null, applied_at: null,
        executed_path: null, certificate_path: null,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        updated_at: new Date(Date.now() - 2 * 86400000).toISOString(),
      },
      {
        id: 'env-1', owner_id: DEMO_USER.id, lease_id: 'lease-1', contract_id: null, property_id: 'prop-1',
        renewal_option_id: null, purpose: 'extension', title: 'Second Amendment to Lease',
        storage_path: 'demo/second-amendment.pdf', filename: 'Second Amendment to Lease.pdf',
        doc_sha256: 'a3f1c0de5b7290114e6d8c2f9a4b1d3e7c05f8a2b6d4e9c1370f5a8b2c4d6e80',
        message: 'Here is the extension we discussed — let me know if anything looks off.',
        status: 'signed', expires_at: iso(Y, 12, 31),
        sent_at: iso(Y, 6, 2), signed_at: iso(Y, 6, 4),
        countersigned_at: null, executed_at: null, applied_at: null,
        executed_path: null, certificate_path: null,
        created_at: iso(Y, 6, 2), updated_at: iso(Y, 6, 4),
      },
      {
        id: 'env-2', owner_id: DEMO_USER.id, lease_id: 'lease-1', contract_id: null, property_id: 'prop-1',
        renewal_option_id: null, purpose: 'other', title: 'Estoppel Certificate',
        storage_path: 'demo/estoppel.pdf', filename: 'Estoppel Certificate.pdf',
        doc_sha256: 'b7c2e91d40a83f5628d1097cba4e6f38025d7a9c1e4b8036f2a5c7d9e1b30462',
        message: null, status: 'executed', expires_at: iso(Y, 5, 30),
        sent_at: iso(Y, 4, 12), signed_at: iso(Y, 4, 14),
        countersigned_at: iso(Y, 4, 15), executed_at: iso(Y, 4, 15), applied_at: null,
        executed_path: 'demo/estoppel-signed.pdf', certificate_path: 'demo/estoppel-signed.pdf',
        created_at: iso(Y, 4, 12), updated_at: iso(Y, 4, 15),
      },
      // ── The contracts side (0093). lease_id is NULL and contract_id carries it; exactly
      // one of the two is set, which ck_env_one_owner enforces live and this seed obeys.
      {
        id: 'env-4', owner_id: DEMO_USER.id, lease_id: null, contract_id: 'svc-1', property_id: 'prop-2',
        renewal_option_id: null, purpose: 'service_contract',
        title: `Snow Removal Agreement — ${Y + 1}/${Y + 2} Renewal`,
        storage_path: 'demo/arctic-renewal.pdf', filename: 'Arctic Snow renewal.pdf',
        doc_sha256: 'd18b6f0a2c47e9315bd82f60a1c94e73f5028ab6cd31e947f0a2b58c6d13e4f9',
        message: 'Here’s the renewal for next season — same scope, the fee steps as we discussed.',
        status: 'sent', expires_at: new Date(Date.now() + 21 * 86400000).toISOString(),
        sent_at: new Date(Date.now() - 3 * 86400000).toISOString(),
        signed_at: null, countersigned_at: null, executed_at: null, applied_at: null,
        executed_path: null, certificate_path: null,
        created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
        updated_at: new Date(Date.now() - 3 * 86400000).toISOString(),
      },
      {
        id: 'env-5', owner_id: DEMO_USER.id, lease_id: null, contract_id: 'svc-2', property_id: 'prop-2',
        renewal_option_id: null, purpose: 'service_contract',
        title: 'Grounds Maintenance Agreement — Renewal',
        storage_path: 'demo/greenscape-renewal.pdf', filename: 'GreenScape renewal.pdf',
        doc_sha256: 'e5309a71cd8462fb03e7a15d9c48b620f7a3d05e1b96c4827fa0d63b5e19c847',
        message: null, status: 'executed', expires_at: iso(Y, 12, 31),
        sent_at: iso(Y, 5, 6), signed_at: iso(Y, 5, 8),
        countersigned_at: iso(Y, 5, 9), executed_at: iso(Y, 5, 9),
        // NOT applied — which is exactly the state that offers "Read the signed contract".
        applied_at: null,
        executed_path: 'demo/greenscape-renewal-signed.pdf',
        certificate_path: 'demo/greenscape-renewal-signed.pdf',
        created_at: iso(Y, 5, 6), updated_at: iso(Y, 5, 9),
      },
    ],
    envelope_signers: [
      // env-3's tenant row HOLDS THE LINK — token_hash is the envelope id in the demo only.
      // Live it is sha256 of 32 CSPRNG bytes (0085); anyone reading this as a template for
      // the real thing has it exactly backwards.
      { id: 'sgn-3t', owner_id: DEMO_USER.id, envelope_id: 'env-3', role: 'tenant',
        name: 'Sam Rivera', email: 'sam@brightcoffee.example', token_hash: 'env-3',
        consent_at: null, signed_at: null, typed_name: null, signature_path: null,
        place_page: null, place_x: null, place_y: null, place_w: null,
        ip: null, user_agent: null, created_at: new Date(Date.now() - 2 * 86400000).toISOString() },
      { id: 'sgn-3l', owner_id: DEMO_USER.id, envelope_id: 'env-3', role: 'landlord',
        name: 'Acme Holdings', email: 'leasing@acmeholdings.example', token_hash: null,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString() },
      { id: 'sgn-1t', owner_id: DEMO_USER.id, envelope_id: 'env-1', role: 'tenant',
        name: 'Sam Rivera', email: 'sam@brightcoffee.example', token_hash: 'env-1',
        consent_at: iso(Y, 6, 4), signed_at: iso(Y, 6, 4), typed_name: 'Sam Rivera',
        signature_path: 'signatures/env-1/tenant-demo.png', ip: '203.0.113.10',
        user_agent: 'Mozilla/5.0 (iPhone)', created_at: iso(Y, 6, 2) },
      { id: 'sgn-1l', owner_id: DEMO_USER.id, envelope_id: 'env-1', role: 'landlord',
        name: 'Acme Holdings', email: 'leasing@acmeholdings.example', token_hash: null,
        created_at: iso(Y, 6, 2) },
      { id: 'sgn-2t', owner_id: DEMO_USER.id, envelope_id: 'env-2', role: 'tenant',
        name: 'Sam Rivera', email: 'sam@brightcoffee.example', token_hash: 'env-2',
        consent_at: iso(Y, 4, 14), signed_at: iso(Y, 4, 14), typed_name: 'Sam Rivera',
        signature_path: 'signatures/env-2/tenant-demo.png', ip: '203.0.113.10',
        user_agent: 'Mozilla/5.0 (Macintosh)', created_at: iso(Y, 4, 12) },
      { id: 'sgn-2l', owner_id: DEMO_USER.id, envelope_id: 'env-2', role: 'landlord',
        name: 'Acme Holdings', email: 'leasing@acmeholdings.example', token_hash: null,
        typed_name: 'Acme Holdings', signed_at: iso(Y, 4, 15), consent_at: iso(Y, 4, 15),
        created_at: iso(Y, 4, 12) },
      // ⚠ THE COUNTERPARTY ROW IS STILL role='tenant' ON A CONTRACT ENVELOPE. 0085's check
      // constraint allows exactly ('tenant','landlord'), and widening it would touch the
      // unauthenticated sign-envelope path — the one place in this project where a schema
      // change is genuinely expensive. The role names the SIDE, not the kind of person: the
      // row that holds the link, and the row that countersigns. The UI says "vendor".
      { id: 'sgn-4t', owner_id: DEMO_USER.id, envelope_id: 'env-4', role: 'tenant',
        name: 'Arctic Snow Services', email: 'billing@arcticsnow.example', token_hash: 'env-4',
        consent_at: null, signed_at: null, typed_name: null, signature_path: null,
        place_page: null, place_x: null, place_y: null, place_w: null,
        ip: null, user_agent: null, created_at: new Date(Date.now() - 3 * 86400000).toISOString() },
      { id: 'sgn-4l', owner_id: DEMO_USER.id, envelope_id: 'env-4', role: 'landlord',
        name: 'Acme Holdings', email: 'leasing@acmeholdings.example', token_hash: null,
        created_at: new Date(Date.now() - 3 * 86400000).toISOString() },
      { id: 'sgn-5t', owner_id: DEMO_USER.id, envelope_id: 'env-5', role: 'tenant',
        name: 'GreenScape Inc.', email: 'ar@greenscape.example', token_hash: 'env-5',
        consent_at: iso(Y, 5, 8), signed_at: iso(Y, 5, 8), typed_name: 'Dana Ruiz',
        signature_path: 'signatures/env-5/tenant-demo.png', ip: '198.51.100.24',
        user_agent: 'Mozilla/5.0 (Windows NT 10.0)', created_at: iso(Y, 5, 6) },
      { id: 'sgn-5l', owner_id: DEMO_USER.id, envelope_id: 'env-5', role: 'landlord',
        name: 'Acme Holdings', email: 'leasing@acmeholdings.example', token_hash: null,
        typed_name: 'Acme Holdings', signed_at: iso(Y, 5, 9), consent_at: iso(Y, 5, 9),
        created_at: iso(Y, 5, 6) },
    ],
    envelope_events: [
      { id: 'evt-3a', owner_id: DEMO_USER.id, envelope_id: 'env-3', kind: 'created', actor: 'landlord', at: new Date(Date.now() - 2 * 86400000).toISOString() },
      { id: 'evt-3b', owner_id: DEMO_USER.id, envelope_id: 'env-3', kind: 'sent', actor: 'landlord', at: new Date(Date.now() - 2 * 86400000).toISOString() },
      { id: 'evt-1a', owner_id: DEMO_USER.id, envelope_id: 'env-1', kind: 'created', actor: 'landlord', at: iso(Y, 6, 2) },
      { id: 'evt-1b', owner_id: DEMO_USER.id, envelope_id: 'env-1', kind: 'sent', actor: 'landlord', at: iso(Y, 6, 2) },
      { id: 'evt-1c', owner_id: DEMO_USER.id, envelope_id: 'env-1', kind: 'viewed', actor: 'tenant', at: iso(Y, 6, 3), ip: '203.0.113.10' },
      { id: 'evt-1d', owner_id: DEMO_USER.id, envelope_id: 'env-1', kind: 'consented', actor: 'tenant', at: iso(Y, 6, 4), ip: '203.0.113.10' },
      { id: 'evt-1e', owner_id: DEMO_USER.id, envelope_id: 'env-1', kind: 'signed', actor: 'tenant', at: iso(Y, 6, 4), ip: '203.0.113.10' },
      { id: 'evt-4a', owner_id: DEMO_USER.id, envelope_id: 'env-4', kind: 'created', actor: 'landlord', at: new Date(Date.now() - 3 * 86400000).toISOString() },
      { id: 'evt-4b', owner_id: DEMO_USER.id, envelope_id: 'env-4', kind: 'sent', actor: 'landlord', at: new Date(Date.now() - 3 * 86400000).toISOString() },
      { id: 'evt-5a', owner_id: DEMO_USER.id, envelope_id: 'env-5', kind: 'created', actor: 'landlord', at: iso(Y, 5, 6) },
      { id: 'evt-5b', owner_id: DEMO_USER.id, envelope_id: 'env-5', kind: 'sent', actor: 'landlord', at: iso(Y, 5, 6) },
      { id: 'evt-5c', owner_id: DEMO_USER.id, envelope_id: 'env-5', kind: 'signed', actor: 'tenant', at: iso(Y, 5, 8), ip: '198.51.100.24' },
      { id: 'evt-5d', owner_id: DEMO_USER.id, envelope_id: 'env-5', kind: 'countersigned', actor: 'landlord', at: iso(Y, 5, 9) },
      { id: 'evt-5e', owner_id: DEMO_USER.id, envelope_id: 'env-5', kind: 'executed', actor: 'system', at: iso(Y, 5, 9) },
    ],
  };
}
