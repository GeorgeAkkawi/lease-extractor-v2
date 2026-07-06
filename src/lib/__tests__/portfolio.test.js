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

  test('inactive leases are excluded', () => {
    const data = base();
    data.leases.push({ id: 'l3', tenant_name: 'Old Tenant', property_id: 'p1', is_active: false });
    const snap = buildPortfolioSnapshot(data);
    expect(snap.tenant_count).toBe(2);
    expect(tenant(snap, 'Old Tenant')).toBeUndefined();
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

  test('the built snapshot carries the same fingerprint', () => {
    const d = base();
    const snap = buildPortfolioSnapshot(d);
    expect(snap.fingerprint).toBe(
      snapshotFingerprint({ leases: d.leases, insurance: d.insurance, contracts: d.contracts })
    );
  });
});

describe('normalizeQuestion — one cache key per question', () => {
  test('lowercases, trims, collapses whitespace', () => {
    expect(normalizeQuestion('  Who   OWES\tmoney? ')).toBe('who owes money?');
    expect(normalizeQuestion(null)).toBe('');
  });
});
