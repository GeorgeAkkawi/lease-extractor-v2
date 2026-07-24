// The year-end reconciliation report data (behind the downloadable Excel).
//  A) shapeTenantReport — pure: itemized actuals reconcile to the tenant's share, the
//     variance ties to reconcileFigures, insights + lease-terms read off the same data.
//  B) buildReconciliationReport — runs end-to-end against the demo mock.
import { describe, it, expect } from 'vitest';
import { shapeTenantReport, buildReconciliationReport } from '../reconciliationData';
import { currentYear } from '../format';

const share = {
  lease_id: 'l1',
  tenant_name: 'City Dental',
  square_footage: 2000,
  share_pct: 0.2,
  base_rent: 41403,
  cam_amount: 4300,
  tax_amount: 8000,
  roof_amt: 0,
  roof_responsible: false,
  est_cam_annual: 12000, // combined CAM & tax estimate (the 7/20 convention)
  est_tax_annual: 0,
  est_roof_annual: null,
  lease_start: '2020-01-01',
  lease_termination_date: '2025-12-31',
  lease_terms: 'NNN; 3% escalations',
};
const camItems = [
  { label: 'Janitorial', amount: 5000, billable: true },
  { label: 'Snow removal', amount: 16500, billable: true },
];
const taxItems = [{ label: 'Cook County', amount: 40000 }];
const renewals = [{ option_label: 'Option 1', term_months: 60, new_rent: 50000, notes: 'FMV', notice_by_date: '2025-06-01' }];

describe('shapeTenantReport', () => {
  const t = shapeTenantReport({ share, camItems, taxItems, roofTotal: 0, buildingSf: 10000, roll: null, renewals, property: { name: 'Maple Plaza', address: '1 Main St' }, year: 2026 });

  it('reads base rent + estimate + actual', () => {
    expect(t.base.annual).toBe(41403);
    expect(t.estCamTax).toBe(12000);
    expect(t.actualCamTax).toBe(12300); // 4300 + 8000
  });

  it('itemizes the ACTUALS as the tenant’s pro-rata share, summing to the actual', () => {
    const byLabel = Object.fromEntries(t.itemsActual.map((i) => [i.label, i.annual]));
    // camFrac = 4300/21500 = 0.2, taxFrac = 8000/40000 = 0.2
    expect(byLabel['Janitorial']).toBe(1000);
    expect(byLabel['Snow removal']).toBe(3300);
    expect(byLabel['Cook County']).toBe(8000);
    const sum = t.itemsActual.reduce((s, i) => s + i.annual, 0);
    expect(sum).toBe(t.actualCamTax + t.actualRoof); // reconciles to the actual side
  });

  it('computes the total-level variance + direction', () => {
    expect(t.totalOwedEst).toBe(53403);   // 41403 + 12000
    expect(t.totalOwedActual).toBe(53703); // 41403 + 12300
    expect(t.variance).toBe(300);
    expect(t.direction).toBe('tenant_owes');
  });

  it('generates a plain-English insight naming who owes', () => {
    expect(t.insights.some((s) => /tenant owes \$300\.00/.test(s))).toBe(true);
  });

  it('builds a lease-terms reference (initial term + options)', () => {
    expect(t.terms[0].term).toBe('Initial term');
    expect(t.terms[0].baseRentAnnual).toBe(41403);
    expect(t.terms[0].months).toBe(72); // 2020-01-01 → 2025-12-31 ≈ 72 months
    expect(t.terms[1].term).toBe('Option 1');
    expect(t.terms[1].months).toBe(60);
    expect(t.terms[1].baseRentAnnual).toBe(50000);
  });

  it('falls back to the actual share when no estimate is set', () => {
    const noEst = shapeTenantReport({ share: { ...share, est_cam_annual: null, est_tax_annual: null }, camItems, taxItems, roofTotal: 0, buildingSf: 10000, roll: null, renewals: [], property: {}, year: 2026 });
    // With no estimate, est == actual → nothing to settle.
    expect(noEst.anyEstimate).toBe(false);
    expect(noEst.insights.some((s) => /No CAM & tax estimate/.test(s))).toBe(true);
  });
});

describe('buildReconciliationReport (demo mock)', () => {
  it('assembles one shaped entry per tenant from live data', async () => {
    const report = await buildReconciliationReport({ propertyId: 'prop-1', year: currentYear() });
    expect(report.property).toBeTruthy();
    expect(report.tenants.length).toBeGreaterThan(0);
    const first = report.tenants[0];
    expect(typeof first.tenant_name).toBe('string');
    expect(typeof first.base.annual).toBe('number');
    expect(Array.isArray(first.insights)).toBe(true);
    expect(Array.isArray(first.terms)).toBe(true);
    expect(first.base.monthly).toHaveLength(12);
  });
});
