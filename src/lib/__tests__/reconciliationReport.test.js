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

// ── The three things this sheet used to get wrong in front of a tenant (2026-08-22) ────────

// ⚠ ITEMIZING IS OPTIONAL, AND THE SECTION STILL HAS TO ADD UP. Taxes are commonly entered as
// one flat figure (the demo seeds them that way on purpose), and CAM can be. With no line items
// the scaling fraction is 0, so the itemized loop emitted nothing — while the bold TOTAL ACTUAL
// EXPENSES printed underneath it is struck from the SHARE and therefore carried the money in
// full. On the demo's own Bright Coffee the four printed lines summed to $8,800 under a stated
// total of $18,800, with nothing on the sheet saying where the other $10,000 went.
describe('shapeTenantReport — an un-itemized kind still gets a line', () => {
  const sum = (t) => Math.round(t.itemsActual.reduce((n, i) => n + i.annual, 0) * 100) / 100;
  const footer = (t) => Math.round((t.actualCamTax + t.actualRoof) * 100) / 100;

  it('names the flat tax total instead of dropping it', () => {
    const t = shapeTenantReport({ share, camItems, taxItems: [], roofTotal: 0, buildingSf: 10000, roll: null, renewals, property: {}, year: 2026 });
    const tax = t.itemsActual.find((i) => i.kind === 'tax');
    expect(tax).toBeTruthy();
    expect(tax.label).toMatch(/not itemized/);
    expect(tax.annual).toBe(8000);
    expect(sum(t)).toBe(footer(t));
  });

  it('does the same for a flat CAM total', () => {
    const t = shapeTenantReport({ share, camItems: [], taxItems, roofTotal: 0, buildingSf: 10000, roll: null, renewals, property: {}, year: 2026 });
    const cam = t.itemsActual.find((i) => i.kind === 'cam');
    expect(cam.label).toMatch(/not itemized/);
    expect(cam.annual).toBe(4300);
    expect(sum(t)).toBe(footer(t));
  });

  it('the itemized lines tie to their own printed total even with BOTH entered flat', () => {
    const t = shapeTenantReport({ share, camItems: [], taxItems: [], roofTotal: 0, buildingSf: 10000, roll: null, renewals, property: {}, year: 2026 });
    expect(sum(t)).toBe(footer(t));
    expect(sum(t)).toBe(12300);
  });
});

// ⚠ THE BASE IS PRORATED LIKE EVERYTHING ELSE ON THE SHEET. `effective_rent` is an annual RATE
// that prorates neither end of a term, so a tenant commencing mid-year read a Base rent row
// whose Annual was the full year beside twelve monthly cells summing to half of it — and both
// TOTAL OWED rows quoted a year the tenant never had.
describe('shapeTenantReport — base rent is prorated to the term', () => {
  // A July commencement: six months out of term, six in, at 36,000/yr.
  const schedule = {};
  for (let m = 1; m <= 12; m++) schedule[m] = m < 7 ? { owed: 0, outsideTerm: true } : { owed: 3000 };
  const midYear = { ...share, base_rent: 36000, est_cam_annual: 0, est_tax_annual: 0, cam_amount: 0, tax_amount: 0 };
  const roll = { schedule, factor: 1, camTaxAnnual: 0, roofAnnual: 0, camTaxByMonth: null, roofByMonth: null, adjustments: [] };

  const t = shapeTenantReport({ share: midYear, camItems: [], taxItems: [], roofTotal: 0, buildingSf: 10000, roll, renewals: [], property: {}, year: 2026 });

  it('the Annual figure equals the twelve months beside it', () => {
    const months = Math.round(t.base.monthly.reduce((n, v) => n + v, 0) * 100) / 100;
    expect(months).toBeGreaterThan(0);
    expect(t.base.annual).toBe(months);
    expect(t.base.annual).toBeLessThan(36000);
  });

  it('says it is prorated, and keeps the lease’s own rate available', () => {
    expect(t.base.prorated).toBe(true);
    expect(t.base.inTerm).toBe(6);
    expect(t.base.rate).toBe(36000);
  });

  it('TOTAL OWED no longer counts a full year for a half-year tenant', () => {
    expect(t.totalOwedEst).toBe(t.base.annual);
    expect(t.totalOwedActual).toBe(t.base.annual);
    // …and the settlement itself is unchanged, because base cancels on both sides.
    expect(t.variance).toBe(0);
  });

  it('a full-year tenant is untouched', () => {
    const full = {};
    for (let m = 1; m <= 12; m++) full[m] = { owed: 3450.25 };
    const ft = shapeTenantReport({
      share, camItems, taxItems, roofTotal: 0, buildingSf: 10000,
      roll: { schedule: full, factor: 1, camTaxAnnual: 0, roofAnnual: 0, camTaxByMonth: null, roofByMonth: null, adjustments: [] },
      renewals, property: {}, year: 2026,
    });
    expect(ft.base.prorated).toBe(false);
    expect(ft.base.inTerm).toBe(12);
  });
});
