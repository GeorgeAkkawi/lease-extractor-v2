// The CAM & tax estimate, month by month (0089).
//
// George, 2026-08-04: *"the rent might change mid way through the year due to a new lease…
// but the CAM is recalculated. the previous months aren't affected and shouldn't be reconciled
// at the new figures because they would be part of the old lease."*
//
// A rent change had a dated ledger (rent_escalations) and the estimate did not — it was one
// scalar on the lease. So raising it in August re-priced January retroactively, and the
// year-end ⚖ Reconcile settled the WHOLE year at whatever figure happened to be on the lease
// when the landlord clicked, making the true-up wrong by (Δestimate × the months billed at the
// old figure) in the direction of refunding money that was never collected.
//
// The load-bearing property, asserted first: an EMPTY ledger reproduces the old behaviour
// exactly. That is what let this ship without migrating a single existing lease.

import { describe, it, expect } from 'vitest';
import {
  monthlyEstimates, annualFromMonthly, billedComponents, reconcileFigures,
} from '../reconciliation';

// A net lease billing a $12,000/yr combined CAM & tax estimate, no roof responsibility.
const SHARE = {
  base_rent: 84000, est_cam_annual: 12000, est_tax_annual: 0, est_roof_annual: null,
  cam_amount: 9000, tax_amount: 5000, roof_amt: 3000, roof_responsible: false,
  lease_type: null, lease_start: '2024-01-01',
};
const Y = 2026;

describe('monthlyEstimates', () => {
  it('with NO ledger, every month reads the lease’s scalar — the old behaviour, unchanged', () => {
    for (const empty of [null, undefined, []]) {
      const m = monthlyEstimates(empty, SHARE, Y);
      expect(m.camTax).toEqual(Array(12).fill(12000));
      expect(annualFromMonthly(m.camTax)).toBe(12000);
      expect(m.roof).toEqual(Array(12).fill(0)); // not roof-responsible
    }
  });

  it('splits the year at the change — the earlier months keep the OLD figure', () => {
    // The pair a mid-year change writes: a closing row carrying what the old lease charged,
    // and a boundary row at the new lease's start. The live scalar (12,000) is the new one.
    const ledger = [
      { effective_date: '2024-01-01', cam_tax_annual: 6000 },
      { effective_date: '2026-07-01', cam_tax_annual: 12000 },
    ];
    const m = monthlyEstimates(ledger, SHARE, Y);
    expect(m.camTax.slice(0, 6)).toEqual(Array(6).fill(6000));  // Jan–Jun, the old lease
    expect(m.camTax.slice(6)).toEqual(Array(6).fill(12000));    // Jul–Dec, the new one
    // Six months at each is $9,000 for the year — not the $12,000 a flat reading gives.
    expect(annualFromMonthly(m.camTax)).toBe(9000);
  });

  it('needs the CLOSING row — a boundary row alone still leaves January on the new figure', () => {
    // Exactly the trap monthlyBases documents: a month with no EARLIER row falls back to the
    // live scalar, because the old rate isn't recoverable once the scalar moved.
    const m = monthlyEstimates([{ effective_date: '2026-07-01', cam_tax_annual: 12000 }], SHARE, Y);
    expect(m.camTax[0]).toBe(12000);
    expect(annualFromMonthly(m.camTax)).toBe(12000);
  });

  it('ignores a row dated in the future and a row that says nothing about CAM', () => {
    const m = monthlyEstimates([
      { effective_date: '2024-01-01', cam_tax_annual: 6000 },
      { effective_date: '2027-03-01', cam_tax_annual: 30000 }, // next year — not this one
      { effective_date: '2026-04-01', cam_tax_annual: null, roof_annual: 500 }, // roof-only
    ], SHARE, Y);
    // The 2027 row is the globally-latest, so it never becomes "the current era" for 2026 —
    // every month of 2026 sits in the 6,000 segment.
    expect(m.camTax).toEqual(Array(12).fill(6000));
  });

  it('says nothing about a GROSS lease — its expenses are carved out of the flat rent', () => {
    const gross = { ...SHARE, lease_type: 'gross' };
    const live = billedComponents(gross);
    const m = monthlyEstimates([{ effective_date: '2026-07-01', cam_tax_annual: 99999 }], gross, Y);
    expect(m.camTax).toEqual(Array(12).fill(live.camTax));
  });

  it('bills no roof to a tenant who isn’t roof-responsible, whatever a row says', () => {
    const m = monthlyEstimates([{ effective_date: '2026-01-01', roof_annual: 4000 }], SHARE, Y);
    expect(m.roof).toEqual(Array(12).fill(0));
    const responsible = { ...SHARE, roof_responsible: true, est_roof_annual: 2000 };
    const r = monthlyEstimates([
      { effective_date: '2024-01-01', roof_annual: 4000 },
      { effective_date: '2026-07-01', roof_annual: 2000 },
    ], responsible, Y);
    expect(r.roof.slice(0, 6)).toEqual(Array(6).fill(4000));
    expect(r.roof.slice(6)).toEqual(Array(6).fill(2000));
  });
});

describe('the year-end reconcile settles against what was BILLED', () => {
  // The actual share is 9,000 CAM + 5,000 tax = 14,000.
  it('with no ledger, it settles against the annual estimate exactly as before', () => {
    const fig = reconcileFigures({ share: SHARE, year: Y });
    expect(fig.estTotal).toBe(12000);
    expect(fig.actualTotal).toBe(14000);
    expect(fig.diff).toBe(2000);
    expect(fig.direction).toBe('tenant_owes');
  });

  it('with a mid-year change, it settles against the two segments, not the new figure', () => {
    const ledger = [
      { effective_date: '2024-01-01', cam_tax_annual: 6000 },
      { effective_date: '2026-07-01', cam_tax_annual: 12000 },
    ];
    const fig = reconcileFigures({ share: SHARE, estimates: ledger, year: Y });
    // Six months at 6,000/yr + six at 12,000/yr = 9,000 billed, so the tenant owes 5,000 —
    // not the 2,000 that reading the whole year at today's figure produced. The 3,000
    // difference is money the tenant was billed at the old rate and would have been quietly
    // credited back.
    expect(fig.estTotal).toBe(9000);
    expect(fig.diff).toBe(5000);
    expect(fig.direction).toBe('tenant_owes');
    // The combined figure rides on `cam` with tax zeroed — the storage convention.
    expect(fig.est.cam).toBe(9000);
    expect(fig.est.tax).toBe(0);
  });

  it('accepts the ledger’s months directly, so it can’t disagree with the Ledger grid', () => {
    const monthly = { camTax: [...Array(6).fill(6000), ...Array(6).fill(12000)], roof: Array(12).fill(0) };
    const fig = reconcileFigures({ share: SHARE, monthly, year: Y });
    expect(fig.estTotal).toBe(9000);
  });

  it('still offsets a CAM & tax correction on the estimate side', () => {
    const ledger = [
      { effective_date: '2024-01-01', cam_tax_annual: 6000 },
      { effective_date: '2026-07-01', cam_tax_annual: 12000 },
    ];
    const fig = reconcileFigures({
      share: SHARE, estimates: ledger, year: Y,
      adjustments: [{ month: 3, kind: 'camtax', amount: 400 }],
    });
    // The tenant was already billed $400 more, so the shortfall shrinks by it — the
    // segmentation must not have knocked the 0082 offset out.
    expect(fig.estTotal).toBe(9400);
    expect(fig.diff).toBe(4600);
  });
});
