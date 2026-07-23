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
