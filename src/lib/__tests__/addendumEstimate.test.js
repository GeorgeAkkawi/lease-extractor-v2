// A rider that re-states the CAM & tax the tenant pays.
//
// George added a rider to a tenant whose only CAM/tax statement is a summary block —
//
//     Monthly Figures
//        Base Rent:                  $2,650.08
//        Real Estate Taxes & CAM:    $1,100.00
//        ----------------------------------------
//        Total                       $3,750.08 Monthly rent
//
// — and the estimate "didn't extract correctly". It couldn't: extract-addendum had no
// field for an expense estimate at all, so the figure was read and silently dropped
// (the same shape as the prose-escalation bug of 2026-07-03 — no model can output what
// the form can't hold). These tests pin the two halves of the fix: the shared math the
// edge function runs on the rider's own wording, and applyAddendum writing the result
// onto the lease the way the whole app bills from.
import { describe, it, expect, beforeEach } from 'vitest';
import { estimateAnnualsFrom } from '../../../supabase/functions/_shared/rentSchedule.js';
import {
  createCorporation, createProperty, createLease, createAddendum, applyAddendum,
  getLease, listHistoryEvents,
} from '../api';
import { billedComponents } from '../reconciliation';

// Pin "today" so est_confirmed_year doesn't depend on the wall clock.
const TODAY = new Date('2026-07-01T12:00:00');
const FY = TODAY.getFullYear();

const row = (charge, amount, period, quote = '') =>
  ({ charge, amount, period, confidence: 0.9, source_quote: quote });

describe('the rider’s CAM & tax figure, annualized in code', () => {
  // The whole point of reading RAW + basis: $1,100.00/mo is EXACTLY $13,200.00/yr.
  // Entering it as a $/SF rate instead (13,200 / 1,077 = 12.2563… typed as 12.26)
  // lands $4.02 high — which is what the live lease actually held.
  it('a monthly "Real Estate Taxes & CAM" line becomes the exact annual figure', () => {
    const out = estimateAnnualsFrom(
      [row('combined', 1100, 'per_month', 'Real Estate Taxes & CAM:      $1,100.00')],
      1077
    );
    expect(out.cam).toBe(13200);
    expect(out.tax).toBeNull();
    expect(out.quotes.cam).toContain('$1,100.00');
    // The $/SF round-trip a landlord would otherwise type by hand is NOT exact.
    expect(Number((13200 / 1077).toFixed(2)) * 1077).toBeCloseTo(13204.02, 2);
  });

  it('separate CAM and tax lines each land on their own charge', () => {
    const out = estimateAnnualsFrom([row('cam', 700, 'per_month'), row('tax', 400, 'per_month')], 1077);
    expect(out.cam).toBe(8400);
    expect(out.tax).toBe(4800);
  });

  it('a $/SF-stated rider estimate uses the lease’s square footage', () => {
    expect(estimateAnnualsFrom([row('cam', 12.26, 'per_sqft_year')], 1077).cam).toBe(13204.02);
  });
});

describe('applyAddendum — the rider’s estimate becomes what the tenant is billed', () => {
  let leaseId;
  let propertyId;

  beforeEach(async () => {
    const corp = await createCorporation('NASA Property, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: '3904 S Harlem Ave', building_sf: 13750 });
    propertyId = prop.id;
    const lease = await createLease({
      property_id: prop.id, tenant_name: 'beauty and barber shop',
      square_footage: 1077, base_rent: 31800.96,
      lease_start: '2004-01-01', lease_termination_date: '2030-05-31',
    });
    leaseId = lease.id;
  });

  const applyRider = (estimates, extra = {}) =>
    createAddendum({ lease_id: leaseId, label: '4th Addendum to Lease', amendment_date: '2025-01-25', kind: 'extension' })
      .then((add) => applyAddendum(add, { escalations: [], renewals: [], estimates, ...extra }, TODAY));

  it('stores the combined figure the app bills from, and confirms it for this year', async () => {
    await applyRider({ camTaxAnnual: 13200, roofAnnual: null, effectiveDate: '2025-06-01' });
    const lease = await getLease(leaseId);
    // The merged convention (2026-07-20): the WHOLE figure on cam, tax zeroed — so
    // cam + tax reads back as exactly what the rider stated, to the cent.
    expect(Number(lease.est_cam_annual)).toBe(13200);
    expect(Number(lease.est_tax_annual)).toBe(0);
    expect(Number(lease.est_cam_annual || 0) + Number(lease.est_tax_annual || 0)).toBe(13200);
    expect(Number(lease.est_confirmed_year)).toBe(FY);
  });

  // What the tenant is BILLED comes from billedComponents (estimate-preferred), the one
  // function the invoice, the Ledger boxes and the reconcile all read. Before the rider
  // this tenant billed the raw actual share; after it, the rider's figure.
  it('the estimate the rider sets is what the tenant is billed, not the actual share', async () => {
    const actuals = { cam_amount: 9500, tax_amount: 4000, roof_amt: 0, roof_responsible: false };
    const before = await getLease(leaseId);
    expect(billedComponents({ ...before, ...actuals }).camTax).toBe(13500); // the actual share
    expect(billedComponents({ ...before, ...actuals }).anyEstimate).toBe(false);

    await applyRider({ camTaxAnnual: 13200, roofAnnual: null, effectiveDate: null });
    const after = await getLease(leaseId);
    expect(billedComponents({ ...after, ...actuals }).camTax).toBe(13200); // the rider's figure
    expect(billedComponents({ ...after, ...actuals }).anyEstimate).toBe(true);
  });

  it('records it on the building’s history with the figure', async () => {
    await applyRider({ camTaxAnnual: 13200, roofAnnual: null, effectiveDate: '2025-06-01' });
    const events = await listHistoryEvents(propertyId);
    const ev = events.find((e) => e.type === 'estimate_set');
    expect(ev).toBeTruthy();
    expect(ev.description).toContain('$13,200.00');
    expect(ev.tenant_name).toBe('beauty and barber shop');
  });

  it('a roof-only rider leaves an existing CAM & tax estimate alone', async () => {
    await applyRider({ camTaxAnnual: 13200, roofAnnual: null, effectiveDate: null });
    await applyRider({ camTaxAnnual: null, roofAnnual: 900, effectiveDate: null });
    const lease = await getLease(leaseId);
    expect(Number(lease.est_roof_annual)).toBe(900);
    expect(Number(lease.est_cam_annual)).toBe(13200); // not wiped
  });

  it('a rider that states no estimate changes nothing', async () => {
    await applyRider(undefined);
    const lease = await getLease(leaseId);
    expect(lease.est_cam_annual ?? null).toBeNull();
    const events = await listHistoryEvents(propertyId);
    expect(events.some((e) => e.type === 'estimate_set')).toBe(false);
  });
});
