// Token-free replay of the Gzim Mila lease's $/SF rent table through the FIXED rebuild.
// No AI / Anthropic calls — this exercises the exact code the edge function runs
// (imported from the shared module) so the arithmetic is the real thing, not a copy.
//
// The bug: Years 4-5 are written ONLY as a $/SF rate ($16.17, $16.97/sf). The AI handed
// over dollar amounts it multiplied itself ($17,478.72, $18,499.92) — inconsistent (they
// imply 1,081 and 1,090 sf, not the lease's 1,077). The fix has the AI return the raw
// rate and the CODE multiply, so the steps land exactly on $17,415.09 / $18,276.69.

import { annualRentFrom, rebuildRentSchedule } from '../../../supabase/functions/_shared/rentSchedule.js';

const SQFT = 1077;

describe('annualRentFrom', () => {
  test('per_sqft_year multiplies by square footage, to the cent', () => {
    expect(annualRentFrom(16.17, 'per_sqft_year', SQFT)).toBe(17415.09);
    expect(annualRentFrom(16.97, 'per_sqft_year', SQFT)).toBe(18276.69);
    expect(annualRentFrom(15.4, 'per_sqft_year', SQFT)).toBe(16585.8);
  });

  test('per_month annualizes ×12; per_year passes through', () => {
    expect(annualRentFrom(1382, 'per_month', SQFT)).toBe(16584);
    expect(annualRentFrom(1615.5, 'per_month', SQFT)).toBe(19386);
    expect(annualRentFrom(19386, 'per_year', SQFT)).toBe(19386);
  });

  test('a $/SF rate with no square footage is unusable (null), never guessed', () => {
    expect(annualRentFrom(16.17, 'per_sqft_year', 0)).toBeNull();
    expect(annualRentFrom(0, 'per_year', SQFT)).toBeNull();
    expect(annualRentFrom(20, 'unknown', SQFT)).toBeNull();
  });
});

describe('rebuildRentSchedule — Gzim Mila $/SF table', () => {
  // As the FIXED prompt should return it: Year 1 has a printed monthly dollar, Years 4-5
  // only a $/SF rate, plus the exercised option-period monthly from the Second Addendum.
  const rentSchedule = [
    { effective_date: '2004-01-01', amount: 1382, period: 'per_month' },      // Yr1 printed $/mo
    { effective_date: '2005-01-01', amount: 15.4, period: 'per_sqft_year' },  // Yr2 $/SF
    { effective_date: '2006-01-01', amount: 15.4, period: 'per_sqft_year' },  // Yr3 $/SF
    { effective_date: '2007-01-01', amount: 16.17, period: 'per_sqft_year' }, // Yr4 $/SF
    { effective_date: '2008-01-01', amount: 16.97, period: 'per_sqft_year' }, // Yr5 $/SF
    { effective_date: '2009-01-01', amount: 1615.5, period: 'per_month' },    // option $/mo
  ];

  test('base + every step compute exactly from the raw rates', () => {
    const { baseRent, escalations, flag } = rebuildRentSchedule({ rentSchedule, sqft: SQFT });
    expect(baseRent).toBe(16584); // earliest period ($1,382/mo)
    const byDate = Object.fromEntries(escalations.map((e) => [e.effective_date, e.new_base_rent]));
    expect(byDate['2007-01-01']).toBe(17415.09); // was wrongly $17,478.72
    expect(byDate['2008-01-01']).toBe(18276.69); // was wrongly $18,499.92
    expect(byDate['2009-01-01']).toBe(19386);
    expect(flag).toBeNull(); // no model escalations passed → nothing to diverge from
  });

  test('flags when the model\'s own math diverges from the exact figure', () => {
    // The main call handed over the BAD pre-computed dollars; the code computes the right
    // ones from the raw rate — the gap must raise the review flag.
    const modelEscalations = [
      { effective_date: '2007-01-01', escalation_type: 'manual', new_base_rent: 17478.72 },
      { effective_date: '2008-01-01', escalation_type: 'manual', new_base_rent: 18499.92 },
    ];
    const { flag } = rebuildRentSchedule({ rentSchedule, sqft: SQFT, modelEscalations });
    expect(flag).not.toBeNull();
    expect(flag.reason).toBe('model_math_divergence');
    expect(flag.diverged.map((d) => d.effective_date).sort()).toEqual(['2007-01-01', '2008-01-01']);
  });

  test('does not flag when the model math agrees within rounding tolerance', () => {
    const modelEscalations = [
      { effective_date: '2007-01-01', escalation_type: 'manual', new_base_rent: 17415 }, // ~9¢ off
      { effective_date: '2008-01-01', escalation_type: 'manual', new_base_rent: 18277 },
    ];
    const { flag } = rebuildRentSchedule({ rentSchedule, sqft: SQFT, modelEscalations });
    expect(flag).toBeNull();
  });

  test('flags $/SF rows that cannot be resolved for want of a square footage', () => {
    const { baseRent, flag } = rebuildRentSchedule({ rentSchedule, sqft: 0 });
    // The $/mo rows still resolve; the $/SF rows drop out and are surfaced.
    expect(baseRent).toBe(16584);
    expect(flag).not.toBeNull();
    expect(flag.reason).toBe('missing_sqft_for_psf');
    expect(flag.unresolved.length).toBe(4);
  });
});
