// Token-free tests for the contract → CAM pipeline and the per-building-SF share math.
// Pure helpers (contracts.js) plus the DEMO_MODE in-memory client for the DB paths — no
// AI / Anthropic calls, deterministic.

import { DEMO_MODE } from '../supabaseClient';
import { contractCoversYear, contractAnnualCost } from '../contracts';
import {
  createCorporation, createProperty, createLease, upsertExpenseRecord,
  addServiceContract, syncContractCamItems, listCamLineItems, getExpenseRecord, getTenantShares,
  getPropertyTotals,
} from '../api';

beforeAll(() => { expect(DEMO_MODE).toBe(true); });

describe('contracts.js pure helpers', () => {
  test('coversYear: dated term, undated (always on), one-time only in its start year', () => {
    const dated = { frequency: 'annual', start_date: '2024-01-01', end_date: '2026-12-31' };
    expect(contractCoversYear(dated, 2023)).toBe(false);
    expect(contractCoversYear(dated, 2024)).toBe(true);
    expect(contractCoversYear(dated, 2026)).toBe(true);
    expect(contractCoversYear(dated, 2027)).toBe(false);

    const undated = { frequency: 'annual' };
    expect(contractCoversYear(undated, 2020)).toBe(true);
    expect(contractCoversYear(undated, 2099)).toBe(true);

    const oneTime = { frequency: 'one-time', start_date: '2021-06-01' };
    expect(contractCoversYear(oneTime, 2021)).toBe(true);
    expect(contractCoversYear(oneTime, 2022)).toBe(false);
  });

  test('annualCost: monthly ×12, yearly compounding, one-time, no-start flat', () => {
    const annual = { amount: 10000, frequency: 'annual', escalation_pct: 3, start_date: '2020-01-01' };
    expect(contractAnnualCost(annual, 2020)).toBe(10000);
    expect(contractAnnualCost(annual, 2021)).toBe(10300);
    expect(contractAnnualCost(annual, 2022)).toBe(10609);

    const monthly = { amount: 1000, frequency: 'monthly', escalation_pct: 0, start_date: '2022-01-01' };
    expect(contractAnnualCost(monthly, 2023)).toBe(12000);

    const oneTime = { amount: 5000, frequency: 'one-time', start_date: '2021-06-01' };
    expect(contractAnnualCost(oneTime, 2021)).toBe(5000);
    expect(contractAnnualCost(oneTime, 2022)).toBe(0);

    const noStart = { amount: 8000, frequency: 'annual', escalation_pct: 5 }; // no start_date → flat
    expect(contractAnnualCost(noStart, 2030)).toBe(8000);
  });
});

describe('syncContractCamItems (DEMO)', () => {
  test('creates one escalated CAM row per contract, idempotent, and re-sums the CAM total', async () => {
    const corp = await createCorporation('Sync Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Sync Plaza', address: 'X', building_sf: 10000 });
    await addServiceContract({ property_id: prop.id, name: 'Landscaping', amount: 12000, frequency: 'annual', escalation_pct: 10, start_date: '2024-01-01' });

    // 2026 is two years past 2024 → 12000 × 1.1² = 14520.
    await syncContractCamItems(prop.id, 2026);
    let items = await listCamLineItems(prop.id, 2026);
    const auto = items.filter((i) => i.contract_id);
    expect(auto.length).toBe(1);
    expect(Number(auto[0].amount)).toBe(14520);
    expect((await getExpenseRecord(prop.id, 2026)).cam_total).toBe(14520);

    // Running again must not duplicate the row (contract_id de-dupes).
    await syncContractCamItems(prop.id, 2026);
    items = await listCamLineItems(prop.id, 2026);
    expect(items.filter((i) => i.contract_id).length).toBe(1);

    // A different fiscal year carries its own escalated amount (base year → 12000).
    await syncContractCamItems(prop.id, 2024);
    const y24 = (await listCamLineItems(prop.id, 2024)).filter((i) => i.contract_id);
    expect(Number(y24[0].amount)).toBe(12000);
  });
});

describe('per-building-SF share math (DEMO v_tenant_shares)', () => {
  test('CAM/tax split over building_sf when set (vacant share stays with landlord)', async () => {
    const corp = await createCorporation('SF Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'SF Plaza', address: 'Y', building_sf: 10000 });
    const lease = await createLease({ property_id: prop.id, tenant_name: 'Shop A', square_footage: 2000, base_rent: 40000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31' });
    await createLease({ property_id: prop.id, tenant_name: 'Shop B', square_footage: 3000, base_rent: 60000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31' });
    await upsertExpenseRecord({ property_id: prop.id, year: 2026, taxes_total: 5000, cam_total: 10000, roof_total: 0 });

    const shares = await getTenantShares(prop.id, 2026);
    const a = shares.find((s) => s.lease_id === lease.id);
    // 2000 / 10000 = 0.2 (not 2000/5000 = 0.4) — the 5,000 SF of vacant space isn't billed to tenants.
    expect(a.share_pct).toBeCloseTo(0.2, 6);
    expect(a.cam_amount).toBeCloseTo(2000, 6);
    expect(a.tax_amount).toBeCloseTo(1000, 6);
  });

  test('falls back to leased-SF split when building_sf is not set', async () => {
    const corp = await createCorporation('NoSF Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'NoSF Plaza', address: 'Z' }); // no building_sf
    const lease = await createLease({ property_id: prop.id, tenant_name: 'Shop C', square_footage: 2000, base_rent: 40000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31' });
    await createLease({ property_id: prop.id, tenant_name: 'Shop D', square_footage: 3000, base_rent: 60000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31' });
    await upsertExpenseRecord({ property_id: prop.id, year: 2026, taxes_total: 5000, cam_total: 10000, roof_total: 0 });

    const shares = await getTenantShares(prop.id, 2026);
    const c = shares.find((s) => s.lease_id === lease.id);
    // 2000 / 5000 leased = 0.4 → the old behaviour until a building size is entered.
    expect(c.share_pct).toBeCloseTo(0.4, 6);
    expect(c.cam_amount).toBeCloseTo(4000, 6);
  });
});

describe('property summary $/SF rates (DEMO v_property_totals — 0043)', () => {
  test('tax_psf/cam_psf divide by building_sf when set (match the per-tenant bills)', async () => {
    const corp = await createCorporation('Totals Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Totals Plaza', address: 'Y2', building_sf: 10000 });
    await createLease({ property_id: prop.id, tenant_name: 'A', square_footage: 2000, base_rent: 40000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31' });
    await createLease({ property_id: prop.id, tenant_name: 'B', square_footage: 3000, base_rent: 60000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31' });
    await upsertExpenseRecord({ property_id: prop.id, year: 2026, taxes_total: 5000, cam_total: 10000, roof_total: 0 });

    const t = await getPropertyTotals(prop.id, 2026);
    // Divided by building 10,000 (not leased 5,000): cam 10000/10000 = 1.0, tax 5000/10000 = 0.5.
    expect(t.cam_psf).toBeCloseTo(1.0, 6);
    expect(t.tax_psf).toBeCloseTo(0.5, 6);
  });

  test('falls back to leased SF when building_sf is not set', async () => {
    const corp = await createCorporation('Totals NoSF Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Totals NoSF Plaza', address: 'Z2' }); // no building_sf
    await createLease({ property_id: prop.id, tenant_name: 'C', square_footage: 2000, base_rent: 40000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31' });
    await createLease({ property_id: prop.id, tenant_name: 'D', square_footage: 3000, base_rent: 60000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31' });
    await upsertExpenseRecord({ property_id: prop.id, year: 2026, taxes_total: 5000, cam_total: 10000, roof_total: 0 });

    const t = await getPropertyTotals(prop.id, 2026);
    // Divided by leased 5,000: cam 10000/5000 = 2.0, tax 5000/5000 = 1.0.
    expect(t.cam_psf).toBeCloseTo(2.0, 6);
    expect(t.tax_psf).toBeCloseTo(1.0, 6);
  });
});

// An "outdated / needs-extension" tenant (past term end → is_active=false) still
// occupies its space and still owes rent until the landlord removes it, so the summary
// counts it FULLY — matching the Leases page (migration 0049). Billing $/SF cards stay
// on the ACTIVE leased SF so they keep matching the per-tenant bills.
describe('property summary counts outdated tenants as occupied (DEMO v_property_totals — 0049)', () => {
  test('outdated lease counts in total_sf / vacant / occupancy / revenue; billing $/SF unchanged', async () => {
    const corp = await createCorporation('Outdated Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Outdated Plaza', address: 'OD1', building_sf: 10000 });
    // Active tenant: 2,000 SF, $40,000/yr.
    await createLease({ property_id: prop.id, tenant_name: 'Active Tenant', square_footage: 2000, base_rent: 40000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31' });
    // Outdated tenant (term ended in the past → backfill flags is_active=false): 3,000 SF, $30,000/yr.
    await createLease({ property_id: prop.id, tenant_name: 'Outdated Tenant', square_footage: 3000, base_rent: 30000, lease_start: '2018-01-01', lease_termination_date: '2020-12-31' });
    await upsertExpenseRecord({ property_id: prop.id, year: 2026, taxes_total: 5000, cam_total: 10000, roof_total: 0 });

    const t = await getPropertyTotals(prop.id, 2026);
    // Occupied space counts BOTH tenants (5,000 of 10,000) — the outdated tenant is NOT vacant.
    expect(t.total_sf).toBe(5000);
    expect(t.vacant_sf).toBe(5000);
    expect(t.occupancy).toBeCloseTo(0.5, 6);
    // Rent roll includes the outdated tenant's rent: 40,000 + 30,000.
    expect(t.total_revenue).toBeCloseTo(70000, 6);
    // Billing $/SF still divides by the WHOLE building (10,000) — unchanged, matches the bills.
    expect(t.cam_psf).toBeCloseTo(1.0, 6);
    expect(t.tax_psf).toBeCloseTo(0.5, 6);
  });

  test('with no building size: occupancy uses ALL leases, but billing $/SF uses ACTIVE leased SF', async () => {
    const corp = await createCorporation('Outdated NoSF Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Outdated NoSF Plaza', address: 'OD2' }); // no building_sf
    await createLease({ property_id: prop.id, tenant_name: 'Active', square_footage: 2000, base_rent: 40000, lease_start: '2024-01-01', lease_termination_date: '2030-12-31' });
    await createLease({ property_id: prop.id, tenant_name: 'Outdated', square_footage: 3000, base_rent: 30000, lease_start: '2018-01-01', lease_termination_date: '2020-12-31' });
    await upsertExpenseRecord({ property_id: prop.id, year: 2026, taxes_total: 4000, cam_total: 8000, roof_total: 0 });

    const t = await getPropertyTotals(prop.id, 2026);
    // Display building falls back to ALL leased SF (5,000) → fully occupied, no vacancy.
    expect(t.total_sf).toBe(5000);
    expect(t.building_sf).toBe(5000);
    expect(t.vacant_sf).toBe(0);
    expect(t.occupancy).toBeCloseTo(1, 6);
    // Billing $/SF still divides by ACTIVE leased SF (2,000), matching the per-tenant bills.
    expect(t.cam_psf).toBeCloseTo(8000 / 2000, 6); // 4.0
    expect(t.tax_psf).toBeCloseTo(4000 / 2000, 6); // 2.0
  });
});
