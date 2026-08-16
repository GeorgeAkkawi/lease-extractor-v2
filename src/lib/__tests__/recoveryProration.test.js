// A tenant reimburses the part of the year they were actually here (George, 2026-08-16:
// "the monthly numbers are way off … none of the rents match").
//
// THE GAP THIS PINS. `v_tenant_shares` states a tenant's share of the FULL year's expenses,
// and ⚖ Reconcile has always settled them at `inTerm/12` of it (reconciliation.js:242-249,
// via inTermMonths). `recoveryFractions` summed the view raw. So a tenant who moved in on
// 1 July was REPORTED as reimbursing a whole year's CAM while being BILLED for half of it —
// and because `recovered` is subtracted from what the year cost you, the overstatement landed
// directly on the bottom line of the "What it cost you" table and the Income-and-expenses
// workbook alike.
//
// ⚠ ONLY THE START PRORATES. Months after term end keep their full weight, matching
// reconciliation.js:216 and abatement.js:101 exactly: a lease past its end date with the
// tenant still in it is a HOLDOVER (`is_active === false`), not a vacancy — the app has no
// move-out record, bills them on, and raises it as a high risk. Prorating the end here would
// quietly delete real revenue from a tenant who is still in the building.
import { describe, it, expect } from 'vitest';
import { recoveryFractions, recoverabilityRows } from '../recoverability';
import { inTermByLease, inTermMonths } from '../leaseSchedule';

const Y = 2026;
const expense = { cam_total: 10000, taxes_total: 0, roof_total: 0 };
const shares = [
  { lease_id: 'full', cam_amount: 4000 },
  { lease_id: 'half', cam_amount: 6000 },
];
const camItem = [{ kind: 'cam', label: 'Landscaping', amount: 10000 }];

describe('recoveryFractions — weighed by the months in term', () => {
  it('counts a mid-year tenant for the months they were here', () => {
    const raw = recoveryFractions({ shares, expense });
    expect(raw.cam).toBeCloseTo(1, 6);          // (4000 + 6000) / 10000 — the old answer

    const weighed = recoveryFractions({ shares, expense, inTermByLease: { full: 12, half: 6 } });
    expect(weighed.cam).toBeCloseTo(0.7, 6);    // (4000 + 6000×0.5) / 10000
  });

  it('reaches the bottom line — this is the figure that was overstated', () => {
    const before = recoverabilityRows({ items: camItem, shares, expense });
    expect(before.totals.recovered).toBe(10000);
    expect(before.totals.net).toBe(0);          // "the tenants covered all of it"

    const after = recoverabilityRows({
      items: camItem, shares, expense, inTermByLease: { full: 12, half: 6 },
    });
    expect(after.totals.recovered).toBe(7000);
    expect(after.totals.net).toBe(3000);        // $3,000 of it was actually yours
    // The row still ties as displayed: spent = recovered + net, to the cent.
    expect(after.totals.spent).toBe(after.totals.recovered + after.totals.net);
  });

  it('⚠ no map supplied → unchanged to the cent, and NOT zeroed', () => {
    // The guard this exists for: Number(null) is 0, not NaN, so a Number.isFinite check
    // alone reads "no map" as "in term for zero months" and silently zeroes every recovery
    // on the property. That is exactly what the first draft of this did.
    expect(recoveryFractions({ shares, expense }).cam).toBeCloseTo(1, 6);
    expect(recoveryFractions({ shares, expense, inTermByLease: null }).cam).toBeCloseTo(1, 6);
    expect(recoveryFractions({ shares, expense, inTermByLease: {} }).cam).toBeCloseTo(1, 6);
    // A lease genuinely in term for 0 months still weighs 0 — the one case not swallowed.
    expect(recoveryFractions({ shares, expense, inTermByLease: { full: 12, half: 0 } }).cam)
      .toBeCloseTo(0.4, 6);
  });

  it('still reports null, never 0, when nothing was spent on a kind', () => {
    const fr = recoveryFractions({ shares, expense: {}, inTermByLease: { full: 12, half: 6 } });
    expect(fr).toEqual({ tax: null, cam: null, roof: null });
  });
});

describe('inTermByLease — one definition, borrowed not copied', () => {
  it('is inTermMonths per share, keyed by lease', () => {
    const map = inTermByLease({
      year: Y,
      shares: [{ lease_id: 'a', lease_start: '2026-07-01' }, { lease_id: 'b', lease_start: '2020-01-01' }],
      escByLease: {},
    });
    expect(map).toEqual({ a: 6, b: 12 });
    expect(map.a).toBe(inTermMonths({ year: Y, leaseStart: '2026-07-01' }));
  });

  it('⚠ reads the escalations, so a renewed tenant is not treated as brand new', () => {
    // A catch-up renewal moves lease_start FORWARD. occupancyStart pulls it back to the
    // earliest APPLIED step — read lease_start alone and a tenant of ten years gets their
    // recovery prorated to a couple of months.
    const escByLease = { a: [{ status: 'applied', effective_date: '2021-03-01', new_base_rent: 50000 }] };
    expect(inTermByLease({ year: Y, shares: [{ lease_id: 'a', lease_start: '2026-11-01' }], escByLease }))
      .toEqual({ a: 12 });
    // Without them, the same lease reads as a two-month tenancy.
    expect(inTermByLease({ year: Y, shares: [{ lease_id: 'a', lease_start: '2026-11-01' }], escByLease: {} }))
      .toEqual({ a: 2 });
  });

  it('⚠ does NOT prorate the end of the term — a holdover is still in the building', () => {
    // The lease ran out in May and the tenant never left. abatement.js zeroes months before
    // the tenancy and never after, on purpose; this must agree with it, because the invoice
    // does too. Nothing here even receives a termination date.
    expect(inTermByLease({
      year: Y, shares: [{ lease_id: 'a', lease_start: '2019-01-01', lease_termination_date: '2026-05-31' }],
    })).toEqual({ a: 12 });
  });

  it('skips a share with no lease id rather than writing an undefined key', () => {
    expect(inTermByLease({ year: Y, shares: [{ cam_amount: 100 }] })).toEqual({});
    expect(inTermByLease()).toEqual({});
  });
});
