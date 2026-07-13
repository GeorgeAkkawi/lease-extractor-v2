// The "Ask Amlak" portfolio snapshot. Pure JS — no network, no AI. Replays the
// real use cases George asked for: "which tenants have insurance on file and which
// don't?", "who owes money?", "which properties have service contracts?".
import {
  buildPortfolioSnapshot,
  snapshotToText,
  snapshotFingerprint,
  normalizeQuestion,
} from '../portfolio';

const TODAY = '2026-07-06';

// One property, two tenants: City Dental (no tenant insurance, a pending renewal
// option, nothing owed) and Bright Coffee (insured, owes $1,250, no option).
const base = () => ({
  corporations: [{ id: 'c1', name: 'Acme Holdings' }],
  properties: [{ id: 'p1', name: 'Pershing Plaza', address: '100 Main St', corporation_id: 'c1', building_sf: 13750 }],
  leases: [
    { id: 'l1', tenant_name: 'City Dental', property_id: 'p1', square_footage: 1200, base_rent: 48000, lease_start: '2021-05-01', lease_termination_date: '2026-05-31', is_active: true, updated_at: '2026-06-01' },
    { id: 'l2', tenant_name: 'Bright Coffee Co.', property_id: 'p1', square_footage: 900, base_rent: 36000, lease_start: '2022-01-01', lease_termination_date: '2027-12-31', is_active: true, updated_at: '2026-05-01' },
  ],
  insurance: [
    { id: 'i1', party: 'landlord', property_id: 'p1', lease_id: null, insurer: 'Granite Mutual', expiry_date: '2026-12-01', archived_at: null, updated_at: '2026-04-01' },
    { id: 'i2', party: 'tenant', property_id: 'p1', lease_id: 'l2', insurer: 'Harbor Casualty', expiry_date: '2027-03-01', archived_at: null, updated_at: '2026-04-15' },
    // Archived tenant policy on l1 — must be ignored (l1 counts as uninsured).
    { id: 'i3', party: 'tenant', property_id: 'p1', lease_id: 'l1', insurer: 'Old Co', expiry_date: '2025-01-01', archived_at: '2026-01-01', updated_at: '2025-01-01' },
  ],
  contracts: [
    { id: 'k1', property_id: 'p1', service_type: 'landscaping', vendor: 'GreenCo', amount: 12000, frequency: 'annual', end_date: '2027-01-01', updated_at: '2026-03-01' },
  ],
  renewals: [
    { lease_id: 'l1', status: 'pending' },
    { lease_id: 'l2', status: 'applied' },
  ],
  balances: [
    { lease_id: 'l2', balance: 1250, display_status: 'overdue' },
    { lease_id: 'l1', balance: 0, display_status: 'paid' },
    { lease_id: 'l2', balance: 500, display_status: 'draft' }, // draft never counts as owed
  ],
  today: TODAY,
});

const tenant = (snap, name) =>
  snap.properties.flatMap((p) => p.tenants).find((t) => t.tenant === name);

describe('buildPortfolioSnapshot — facts across tenants/insurance/contracts', () => {
  test('counts and per-tenant insurance-on-file flag', () => {
    const snap = buildPortfolioSnapshot(base());
    expect(snap.property_count).toBe(1);
    expect(snap.tenant_count).toBe(2);

    const city = tenant(snap, 'City Dental');
    const bright = tenant(snap, 'Bright Coffee Co.');
    // Archived policy ignored → City Dental reads as uninsured.
    expect(city.insurance_on_file).toBe(false);
    expect(city.insurer).toBeNull();
    expect(bright.insurance_on_file).toBe(true);
    expect(bright.insurer).toBe('Harbor Casualty');
    expect(bright.insurance_expiry).toBe('2027-03-01');
    expect(bright.insurance_expired).toBe(false);
  });

  test('renewal option and balance owed per tenant', () => {
    const snap = buildPortfolioSnapshot(base());
    expect(tenant(snap, 'City Dental').has_renewal_option).toBe(true); // pending
    expect(tenant(snap, 'Bright Coffee Co.').has_renewal_option).toBe(false); // applied
    expect(tenant(snap, 'City Dental').balance_owed).toBe(0);
    expect(tenant(snap, 'Bright Coffee Co.').balance_owed).toBe(1250); // draft excluded
  });

  test('tenants sorted soonest lease end first; carries ids for click-through', () => {
    const snap = buildPortfolioSnapshot(base());
    const names = snap.properties[0].tenants.map((t) => t.tenant);
    expect(names).toEqual(['City Dental', 'Bright Coffee Co.']); // 2026 before 2027
    const city = tenant(snap, 'City Dental');
    expect(city.tenant_id).toBe('l1');
    expect(city.propId).toBe('p1');
    expect(city.corpId).toBe('c1');
  });

  test('landlord insurance and service contracts surface at the property', () => {
    const p = buildPortfolioSnapshot(base()).properties[0];
    expect(p.landlord_insurance.on_file).toBe(true);
    expect(p.landlord_insurance.insurer).toBe('Granite Mutual');
    expect(p.service_contracts).toHaveLength(1);
    expect(p.service_contracts[0].vendor).toBe('GreenCo');
    expect(p.service_contracts[0].expired).toBe(false);
  });

  test('expiry flags flip once the date has passed', () => {
    const snap = buildPortfolioSnapshot({ ...base(), today: '2028-01-01' });
    expect(tenant(snap, 'Bright Coffee Co.').insurance_expired).toBe(true);
    expect(snap.properties[0].landlord_insurance.expired).toBe(true);
    expect(snap.properties[0].service_contracts[0].expired).toBe(true);
  });

  test('holdover (inactive) leases are INCLUDED and flagged', () => {
    // George's rule: an outdated tenant still occupies its space and owes rent until
    // he removes it, so Ask Amlak must be able to answer about it — flagged as held over.
    const data = base();
    data.leases.push({ id: 'l3', tenant_name: 'Old Tenant', property_id: 'p1', is_active: false, lease_termination_date: '2024-01-01' });
    const snap = buildPortfolioSnapshot(data);
    expect(snap.tenant_count).toBe(3);
    const old = tenant(snap, 'Old Tenant');
    expect(old).toBeDefined();
    expect(old.holdover).toBe(true);
    expect(tenant(snap, 'City Dental').holdover).toBe(false);
    // and the text flags it so the model can say "held over"
    expect(snapshotToText(snap)).toContain('HELD OVER');
  });
});

// A richer fixture exercising the new facts (roof, lease terms, contact, this year's
// billed CAM/tax share, next rent step, free-rent, additional insured, occupancy,
// annual-report dates).
const rich = () => {
  const d = base();
  d.leases[0].roof_responsible = true;            // City Dental (l1) pays roof
  d.leases[0].lease_terms = 'NNN lease, 5 yr';
  d.leases[0].tenant_contact_name = 'Dr. Smith';
  d.leases[0].tenant_email = 'dr@city.example';
  d.leases[0].premises_address = 'Suite 30';
  d.insurance[1].additional_insured = true;       // Bright Coffee (l2) cert names landlord
  d.escalations = [
    { lease_id: 'l2', effective_date: '2027-01-01', status: 'scheduled', new_base_rent: 39000 },  // the "next"
    { lease_id: 'l2', effective_date: '2025-01-01', status: 'applied', new_base_rent: 36000 },     // past/applied — ignored
    { lease_id: 'l2', effective_date: '2028-06-01', status: 'scheduled', new_base_rent: 41000 },   // past the 2027-12-31 term end — gated out
  ];
  d.abatements = [
    { lease_id: 'l1', kind: 'free', start_date: '2026-06-01', end_date: '2026-09-30' }, // active as of TODAY
    { lease_id: 'l1', kind: 'free', start_date: '2020-01-01', end_date: '2020-06-30' }, // ended — ignored
  ];
  d.shares = [
    { lease_id: 'l1', property_id: 'p1', cam_amount: 3000, tax_amount: 2000, roof_amt: 500, base_rent: 48000 },
  ];
  d.totals = [
    { property_id: 'p1', occupancy: 0.8, vacant_sf: 2000, total_revenue: 84000 },
  ];
  d.annualReports = [
    { corporation_id: 'c1', due_date: '2026-09-01', last_filed_date: '2025-09-01' },
  ];
  return d;
};

describe('buildPortfolioSnapshot — enriched facts', () => {
  test('roof responsibility (the reported gap) is now a fact', () => {
    const snap = buildPortfolioSnapshot(rich());
    expect(tenant(snap, 'City Dental').roof_billed).toBe(true);
    expect(tenant(snap, 'Bright Coffee Co.').roof_billed).toBe(false);
    const text = snapshotToText(snap);
    expect(text).toContain('Roof expenses billed to tenant: YES');
  });

  test('this year\'s billed CAM/tax share + total from the shares view', () => {
    const city = tenant(buildPortfolioSnapshot(rich()), 'City Dental');
    expect(city.billed_cam).toBe(3000);
    expect(city.billed_tax).toBe(2000);
    expect(city.billed_roof).toBe(500);
    // total = base 48000 + cam 3000 + tax 2000 + roof 500
    expect(city.billed_total).toBe(53500);
  });

  test('next scheduled rent step respects the committed term end', () => {
    const bright = tenant(buildPortfolioSnapshot(rich()), 'Bright Coffee Co.');
    expect(bright.next_step).toEqual({ date: '2027-01-01', amount: 39000 }); // not the 2028 one past term end
  });

  test('active free-rent window surfaces (ended ones ignored)', () => {
    const city = tenant(buildPortfolioSnapshot(rich()), 'City Dental');
    expect(city.free_rent).toEqual({ kind: 'free', start: '2026-06-01', end: '2026-09-30', active: true });
  });

  test('additional-insured flag + contact facts', () => {
    const snap = buildPortfolioSnapshot(rich());
    expect(tenant(snap, 'Bright Coffee Co.').additional_insured).toBe('yes');
    const city = tenant(snap, 'City Dental');
    expect(city.contact_name).toBe('Dr. Smith');
    expect(city.suite).toBe('Suite 30');
  });

  test('property occupancy/vacancy/revenue from the totals view', () => {
    const p = buildPortfolioSnapshot(rich()).properties[0];
    expect(p.occupancy).toBe(0.8);
    expect(p.vacant_sf).toBe(2000);
    expect(p.annual_revenue).toBe(84000);
  });

  test('corporations carry annual-report dates', () => {
    const snap = buildPortfolioSnapshot(rich());
    const acme = snap.corporations.find((c) => c.name === 'Acme Holdings');
    expect(acme.annual_report_due).toBe('2026-09-01');
    expect(acme.has_annual_report).toBe(true);
    expect(snapshotToText(snap)).toContain('annual report due 2026-09-01');
  });
});

describe('snapshotToText — compact evidence the model reads', () => {
  test('includes each tenant plus insurance / contract / owed facts', () => {
    const text = snapshotToText(buildPortfolioSnapshot(base()));
    expect(text).toContain('Pershing Plaza');
    expect(text).toContain('City Dental');
    expect(text).toContain('NONE on file'); // City Dental uninsured
    expect(text).toContain('Harbor Casualty'); // Bright Coffee insurer
    expect(text).toContain('GreenCo'); // contract
    expect(text).toContain('Owes: $1,250');
  });
});

describe('snapshotFingerprint — flips when the portfolio changes', () => {
  test('stable regardless of row order', () => {
    const d = base();
    const a = snapshotFingerprint({ leases: d.leases, insurance: d.insurance, contracts: d.contracts });
    const b = snapshotFingerprint({ leases: [d.leases[1], d.leases[0]], insurance: [...d.insurance].reverse(), contracts: d.contracts });
    expect(a).toBe(b);
  });

  test('flips on an edit, an addition, and a removal', () => {
    const d = base();
    const f0 = snapshotFingerprint({ leases: d.leases, insurance: d.insurance, contracts: d.contracts });
    // edit: a policy's updated_at bumps
    const editedIns = d.insurance.map((p) => (p.id === 'i2' ? { ...p, updated_at: '2026-09-09' } : p));
    expect(snapshotFingerprint({ leases: d.leases, insurance: editedIns, contracts: d.contracts })).not.toBe(f0);
    // add: a new contract
    const moreContracts = [...d.contracts, { id: 'k2', property_id: 'p1', updated_at: '2026-08-01' }];
    expect(snapshotFingerprint({ leases: d.leases, insurance: d.insurance, contracts: moreContracts })).not.toBe(f0);
    // remove: drop a lease
    expect(snapshotFingerprint({ leases: [d.leases[0]], insurance: d.insurance, contracts: d.contracts })).not.toBe(f0);
  });

  test('flips when a payment changes who owes money (no updated_at involved)', () => {
    const d = base();
    const f0 = snapshotFingerprint({ leases: d.leases, insurance: d.insurance, contracts: d.contracts, balances: d.balances });
    // Bright Coffee pays its $1,250 → the open balance disappears. The cached
    // "who owes money?" answer must stop matching even though no lease/policy/contract changed.
    const paidUp = d.balances.map((b) => (b.balance === 1250 ? { ...b, balance: 0, display_status: 'paid' } : b));
    expect(snapshotFingerprint({ leases: d.leases, insurance: d.insurance, contracts: d.contracts, balances: paidUp })).not.toBe(f0);
    // …and a draft's figure changing never flips it (drafts don't count as owed).
    const draftBump = d.balances.map((b) => (b.display_status === 'draft' ? { ...b, balance: 900 } : b));
    expect(snapshotFingerprint({ leases: d.leases, insurance: d.insurance, contracts: d.contracts, balances: draftBump })).toBe(f0);
  });

  test('the built snapshot carries the same fingerprint (balances included)', () => {
    const d = base();
    const snap = buildPortfolioSnapshot(d);
    expect(snap.fingerprint).toBe(
      snapshotFingerprint({ leases: d.leases, insurance: d.insurance, contracts: d.contracts, balances: d.balances })
    );
  });

  test('bumped to v4 (kills every v3-era cached answer)', () => {
    expect(snapshotFingerprint({}).startsWith('v4|')).toBe(true);
  });

  test('flips when a new source changes — escalation, abatement, annual report, or expense', () => {
    const f0 = snapshotFingerprint({});
    // a scheduled rent step appears
    expect(snapshotFingerprint({ escalations: [{ lease_id: 'l1', updated_at: '2026-08-01' }] })).not.toBe(f0);
    // a free-rent window is added
    expect(snapshotFingerprint({ abatements: [{ lease_id: 'l1', updated_at: '2026-08-01' }] })).not.toBe(f0);
    // an annual report date changes
    expect(snapshotFingerprint({ annualReports: [{ corporation_id: 'c1', updated_at: '2026-08-01' }] })).not.toBe(f0);
    // an expense edit re-splits the CAM/tax share (value-based, no updated_at)
    expect(snapshotFingerprint({ shares: [{ lease_id: 'l1', cam_amount: 3000, tax_amount: 2000 }] })).not.toBe(f0);
    expect(snapshotFingerprint({ shares: [{ lease_id: 'l1', cam_amount: 9999, tax_amount: 2000 }] }))
      .not.toBe(snapshotFingerprint({ shares: [{ lease_id: 'l1', cam_amount: 3000, tax_amount: 2000 }] }));
  });
});

describe('normalizeQuestion — one cache key per question', () => {
  test('lowercases, trims, collapses whitespace', () => {
    expect(normalizeQuestion('  Who   OWES\tmoney? ')).toBe('who owes money?');
    expect(normalizeQuestion(null)).toBe('');
  });
});
