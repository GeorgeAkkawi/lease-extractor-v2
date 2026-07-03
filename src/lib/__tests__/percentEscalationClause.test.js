// Token-free replay of a lease whose rent escalation is stated ONLY in prose — no rent
// table. The New Hong Kong 2 lease (Harlem Pershing Plaza) prints a single "Monthly Base
// Rent: $1904.00" plus one sentence: "Base rent will increase annually by 2% and will be
// renegotiated in the 8th year." The bug: the extractor only understood period-by-period
// rent TABLES, so the 2% clause had nowhere to land and was silently dropped — the imported
// lease had zero escalations. The fix has the model read only the PERCENT (+ where it stops)
// and the code synthesize each year's step, compounded to the cent, exactly like a printed
// step-up schedule.
//
// This exercises the real functions the edge function + review form run — no AI calls.
import { rebuildRentSchedule, percentEscalations } from '../../../supabase/functions/_shared/rentSchedule.js';
import { buildEscalations } from '../api';

// A single base-rent row ($1,904/mo → $22,848/yr), a 10-year (120-mo) term, a 2%/yr prose
// formula that is renegotiated in the 8th year (month 84).
const ONE_ROW = [{ effective_date: null, months_from_start: 0, amount: 1904, period: 'per_month' }];
const EXPECTED = [23304.96, 23771.06, 24246.48, 24731.41, 25226.04, 25730.56]; // years 2–7, 2% compounded

describe('percentEscalations — prose 2%/yr formula, renegotiated in year 8', () => {
  const steps = percentEscalations(22848, 2, 120, 84);

  test('one step per lease year up to (not including) the renegotiation month', () => {
    expect(steps).toHaveLength(6);
    expect(steps.map((s) => s.months_from_start)).toEqual([12, 24, 36, 48, 60, 72]);
  });

  test('each step compounds 2% and rounds to the cent', () => {
    expect(steps.map((s) => s.new_base_rent)).toEqual(EXPECTED);
  });

  test('steps are undated percent steps carrying the rate', () => {
    steps.forEach((s) => {
      expect(s.effective_date).toBeNull();
      expect(s.escalation_type).toBe('percent');
      expect(s.escalation_value).toBe(2);
    });
  });

  test('no stop → steps run through the whole term (years 2–10)', () => {
    const full = percentEscalations(22848, 2, 120, null);
    expect(full.map((s) => s.months_from_start)).toEqual([12, 24, 36, 48, 60, 72, 84, 96, 108]);
  });

  test('a single-year term or missing horizon yields nothing', () => {
    expect(percentEscalations(22848, 2, 12, null)).toBeNull();
    expect(percentEscalations(22848, 2, null, null)).toBeNull();
    expect(percentEscalations(22848, 0, 120, null)).toBeNull();
  });
});

describe('rebuildRentSchedule — applies the formula only with no real rent table', () => {
  test('single rent row + prose formula → base rent + the 6 percent steps', () => {
    const out = rebuildRentSchedule({ rentSchedule: ONE_ROW, sqft: 0, modelEscalations: [], escalationPct: 2, escalationStopMonths: 84, termMonths: 120 });
    expect(out.baseRent).toBe(22848);
    expect(out.escalations.map((e) => e.new_base_rent)).toEqual(EXPECTED);
  });

  // The REAL New Hong Kong failure (verified in the stored extraction_raw): the lease states
  // its base rent TWICE — "$21.00 PSf" and "Monthly Base Rent: $1904.00" — and the model
  // returned BOTH as rows at offset 0. The duplicate was mistaken for a rent step (a bogus
  // escalation of $22,848 at month 0), which made escalations look non-empty and SUPPRESSED
  // the 2%/yr formula → the tab showed one meaningless step and zero real yearly increases.
  test('same base priced two ways at offset 0 ($/SF + $/mo) → collapses to one period, formula still fires', () => {
    const dupRows = [
      { effective_date: null, months_from_start: 0, amount: 21, period: 'per_sqft_year' }, // $21.00 PSf
      { effective_date: null, months_from_start: 0, amount: 1904, period: 'per_month' },    // $1,904/mo
    ];
    const out = rebuildRentSchedule({ rentSchedule: dupRows, sqft: 1088, modelEscalations: [], escalationPct: 2, escalationStopMonths: 84, termMonths: 120 });
    expect(out.baseRent).toBe(22848);
    expect(out.escalations).toHaveLength(6);
    expect(out.escalations.map((e) => e.new_base_rent)).toEqual(EXPECTED);
    expect(out.escalations.every((e) => e.escalation_type === 'percent')).toBe(true);
    expect(out.flag).toBeNull(); // the superseded $/SF row must not raise a false "missing sqft" flag
  });

  // Order-independence + the analyst-fed fallback path use the same collapse.
  test('duplicate offset-0 rows collapse regardless of order (and even with no sqft)', () => {
    const dupRows = [
      { effective_date: null, months_from_start: 0, amount: 1904, period: 'per_month' },
      { effective_date: null, months_from_start: 0, amount: 21, period: 'per_sqft_year' },
    ];
    const out = rebuildRentSchedule({ rentSchedule: dupRows, sqft: 0, modelEscalations: [], escalationPct: 2, escalationStopMonths: 84, termMonths: 120 });
    expect(out.baseRent).toBe(22848);
    expect(out.escalations.map((e) => e.new_base_rent)).toEqual(EXPECTED);
  });

  test('a printed multi-row table WINS — the prose percent is ignored (regression)', () => {
    const table = [
      { effective_date: null, months_from_start: 0, amount: 30525, period: 'per_year' },
      { effective_date: null, months_from_start: 12, amount: 31450, period: 'per_year' },
      { effective_date: null, months_from_start: 24, amount: 32375, period: 'per_year' },
    ];
    const out = rebuildRentSchedule({ rentSchedule: table, sqft: 0, modelEscalations: [], escalationPct: 2, escalationStopMonths: 84, termMonths: 120 });
    expect(out.baseRent).toBe(30525);
    // The table's own amounts, not compounded 2% steps.
    expect(out.escalations.map((e) => e.new_base_rent)).toEqual([31450, 32375]);
    expect(out.escalations.every((e) => e.escalation_type === 'manual')).toBe(true);
  });

  test('no prose formula → behaves exactly as before (single row, no steps)', () => {
    const out = rebuildRentSchedule({ rentSchedule: ONE_ROW, sqft: 0, modelEscalations: [] });
    expect(out.baseRent).toBe(22848);
    expect(out.escalations).toBeNull();
  });
});

describe('buildEscalations dates the synthesized steps off the confirmed start', () => {
  test('a June-1-2017 start → yearly steps 2018-06-01 … 2023-06-01 with the compounded rents', () => {
    const steps = percentEscalations(22848, 2, 120, 84);
    const dated = buildEscalations(22848, steps, '2017-06-01');
    expect(dated.map((e) => e.effective_date)).toEqual([
      '2018-06-01', '2019-06-01', '2020-06-01', '2021-06-01', '2022-06-01', '2023-06-01',
    ]);
    expect(dated.map((e) => e.new_base_rent)).toEqual(EXPECTED);
  });
});
