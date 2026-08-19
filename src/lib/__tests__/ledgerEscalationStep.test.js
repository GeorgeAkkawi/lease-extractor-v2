// escalationStepMonths: detect a mid-year BASE-RENT step-up so the Rent Ledger can flag
// a scheduled escalation (George, 2026-07-23: Ricki's-Lyons + Sam Nails have applied
// mid-2026 steps, so their two different monthly box values are BOTH correct — the cue
// makes that read as the intended raise, not a mismatch). Pure, derived from the same
// {schedule, comp} the boxes are painted from, so a cue from it can never disagree.
import { describe, it, expect } from 'vitest';
import { escalationStepMonths } from '../ledger';

// Build {schedule, comp} from a 12-length per-month base array, mirroring
// buildLeaseSchedule (owed/outsideTerm/abated) + componentizeSchedule (base/camTax/roof).
// A month listed in `outside`/`abated` gets that flag (and outside → base 0 / owed 0).
function build(bases, { camTax = 0, roof = 0, outside = [], abated = [] } = {}) {
  const schedule = {};
  const comp = {};
  for (let m = 1; m <= 12; m++) {
    const isOutside = outside.includes(m);
    const base = isOutside ? 0 : (bases[m - 1] || 0);
    schedule[m] = { owed: isOutside ? 0 : base + camTax + roof, outsideTerm: isOutside, abated: abated.includes(m) };
    comp[m] = { base, camTax, roof };
  }
  return { schedule, comp };
}

const months = (steps) => steps.map((s) => s.month);

describe('escalationStepMonths', () => {
  it("flags a mid-year step at the crossing month (Ricki's shape → May)", () => {
    // Jan–Apr base $2,316.09, May–Dec $2,362.41 (an applied 2026-05-01 escalation),
    // combined CAM & tax $786.67/mo.
    const { schedule, comp } = build(
      [...Array(4).fill(2316.09), ...Array(8).fill(2362.41)],
      { camTax: 786.67 }
    );
    const steps = escalationStepMonths({ schedule, comp });
    expect(months(steps)).toEqual([5]);
    expect(steps[0].base).toBe(2362.41);
    expect(steps[0].prevBase).toBe(2316.09);
    // owed carries the full monthly figure (base + CAM & tax) — what the box + note show.
    expect(steps[0].owed).toBe(3149.08);
  });

  it('flags one month later for a June step (Sam Nails shape)', () => {
    const { schedule, comp } = build(
      [...Array(5).fill(3306.08), ...Array(7).fill(3360.20)],
      { camTax: 800 }
    );
    expect(months(escalationStepMonths({ schedule, comp }))).toEqual([6]);
  });

  it('returns [] for a uniform lease (Hong Kong — no 2026 step)', () => {
    const { schedule, comp } = build(Array(12).fill(2144.21), { camTax: 705.39 });
    expect(escalationStepMonths({ schedule, comp })).toEqual([]);
  });

  // ⚠ THE ONE THAT SHIPPED WRONG, and it announced a raise on two real leases that have none.
  // George, 2026-08-18: *"why does it say there are rent escalations for beauty and barber and
  // infinite mobile on the ledger in december when there isnt"* — and there wasn't. Neither
  // lease has an escalation row dated December; the December CELL was four cents bigger.
  //
  // `buildLeaseSchedule` rounds each month to the cent and folds the year's leftover onto the
  // LAST in-term month so the twelve sum to the issued invoice exactly; `componentizeSchedule`
  // derives base as the REMAINDER, so the fold lands entirely on December's base. The old guard
  // was `> prevBase + 0.02`, described as cents-safe — the fold is 4¢, twice that. A detector
  // whose tolerance is smaller than the rounding it has to survive will always fire eventually.
  //
  // Both figures below are the real ones off FY 2026 production.
  it('does NOT call December’s penny-fold a rent step', () => {
    // beauty and barber shop — $45,001 invoice over twelve $3,750.08 months, 4¢ left over.
    const bb = build([...Array(11).fill(2650.08), 2650.12], { camTax: 1100 });
    expect(escalationStepMonths(bb)).toEqual([]);

    // Infinite Mobile — a REAL 1 July step, and the same 4¢ fold on December. The July step
    // must survive; only the fold may be ignored, or the fix has broken the feature.
    const im = build(
      [...Array(6).fill(1811.42), ...Array(5).fill(2395.42), 2395.46],
      { camTax: 904.58 }
    );
    expect(months(escalationStepMonths(im))).toEqual([7]);
  });

  // The floor has to clear the rounding of twelve months and nothing more. A dollar a month is
  // already far below the smallest raise anyone writes into a lease — but it is a threshold, so
  // it is pinned rather than left to be re-guessed.
  it('flags a raise of a dollar a month, and ignores anything under it', () => {
    const under = build([...Array(6).fill(2000), ...Array(6).fill(2000.99)], { camTax: 500 });
    expect(escalationStepMonths(under)).toEqual([]);
    const at = build([...Array(6).fill(2000), ...Array(6).fill(2001)], { camTax: 500 });
    expect(months(escalationStepMonths(at))).toEqual([7]);
  });

  it('does NOT flag a mid-year lease start (prior month out of term, base 0 → X)', () => {
    // Jul-start tenant: Jan–Jun outside term, then a flat $3,000 base Jul–Dec.
    const { schedule, comp } = build(
      [0, 0, 0, 0, 0, 0, ...Array(6).fill(3000)],
      { camTax: 500, outside: [1, 2, 3, 4, 5, 6] }
    );
    expect(escalationStepMonths({ schedule, comp })).toEqual([]);
  });

  it('does NOT flag an abatement ending (abated month base 0 → X)', () => {
    // Jan–Mar fully free (base 0), then $3,000 base Apr–Dec.
    const { schedule, comp } = build(
      [0, 0, 0, ...Array(9).fill(3000)],
      { camTax: 400, abated: [1, 2, 3] }
    );
    expect(escalationStepMonths({ schedule, comp })).toEqual([]);
  });

  it('flags every step when a lease raises twice in one year', () => {
    const { schedule, comp } = build([
      ...Array(3).fill(2000), ...Array(5).fill(2050), ...Array(4).fill(2100),
    ]);
    expect(months(escalationStepMonths({ schedule, comp }))).toEqual([4, 9]);
  });

  it('does NOT flag a base-rent DECREASE (increases only)', () => {
    const { schedule, comp } = build([...Array(6).fill(2100), ...Array(6).fill(2000)]);
    expect(escalationStepMonths({ schedule, comp })).toEqual([]);
  });

  it('is cents-safe — a sub-2¢ rounding wobble is not a step', () => {
    const { schedule, comp } = build([...Array(6).fill(2000), ...Array(6).fill(2000.01)]);
    expect(escalationStepMonths({ schedule, comp })).toEqual([]);
  });

  it('handles missing input without throwing', () => {
    expect(escalationStepMonths({})).toEqual([]);
    expect(escalationStepMonths()).toEqual([]);
  });
});
