// Token-free replay of the Wingstop lease's LEASE-YEAR rent table (no printed dates) through
// the real code. The lease (Five Points Wings) sets commencement by a formula ("120 days
// after delivery" / "when the tenant opens"), so it prints NO start, end, or step dates — the
// rent table is labeled "Year 1 … Year 6". The bug: the model was forced to invent calendar
// dates anchored to the May-2012 signing date (and got them off by a year). The fix reads the
// schedule as RELATIVE (months_from_start) and dates the steps off the start the user confirms.
//
// This exercises the exact functions the edge function + review form run — no AI calls.
import { rebuildRentSchedule } from '../../../supabase/functions/_shared/rentSchedule.js';
import { buildEscalations } from '../api';

// The §3(f) table, as the fixed SUPPLEMENT prompt should return it: per-year amounts with an
// offset from the term start, no calendar dates.
const WINGSTOP_ROWS = [
  { effective_date: null, months_from_start: 0,  amount: 30525, period: 'per_year' }, // Year 1
  { effective_date: null, months_from_start: 12, amount: 30525, period: 'per_year' }, // Year 2
  { effective_date: null, months_from_start: 24, amount: 31450, period: 'per_year' }, // Year 3
  { effective_date: null, months_from_start: 36, amount: 32375, period: 'per_year' }, // Year 4
  { effective_date: null, months_from_start: 48, amount: 33300, period: 'per_year' }, // Year 5
  { effective_date: null, months_from_start: 60, amount: 34225, period: 'per_year' }, // Year 6
];

describe('rebuildRentSchedule — relative (lease-year) mode', () => {
  const out = rebuildRentSchedule({ rentSchedule: WINGSTOP_ROWS, sqft: 0, modelEscalations: [] });

  test('earliest offset becomes base rent; no baseDate', () => {
    expect(out.baseRent).toBe(30525);
    expect(out.baseDate).toBeNull();
  });

  test('later years become undated steps carrying their month offset', () => {
    expect(out.escalations).toHaveLength(5);
    expect(out.escalations.map((e) => [e.months_from_start, e.new_base_rent])).toEqual([
      [12, 30525],
      [24, 31450],
      [36, 32375],
      [48, 33300],
      [60, 34225],
    ]);
    out.escalations.forEach((e) => {
      expect(e.effective_date).toBeNull();
      expect(e.escalation_type).toBe('manual');
    });
  });

  test('no missing-sqft flag (all rows are per_year)', () => {
    expect(out.flag).toBeNull();
  });
});

describe('buildEscalations — anchoring relative steps to a confirmed start', () => {
  const rebuilt = rebuildRentSchedule({ rentSchedule: WINGSTOP_ROWS, sqft: 0, modelEscalations: [] });

  test('anchored to a real start, steps get correct dates (no off-by-one)', () => {
    const rows = buildEscalations(30525, rebuilt.escalations, '2012-09-01');
    expect(rows.map((r) => [r.effective_date, r.new_base_rent])).toEqual([
      ['2013-09-01', 30525],
      ['2014-09-01', 31450],
      ['2015-09-01', 32375],
      ['2016-09-01', 33300],
      ['2017-09-01', 34225],
    ]);
  });

  test('with no anchor, undated relative steps are dropped (never crash the save)', () => {
    expect(buildEscalations(30525, rebuilt.escalations)).toEqual([]);
  });

  test('anchoring clamps to end-of-month (Jan 31 + 1 month → Feb 29 in a leap year)', () => {
    const rows = buildEscalations(20000, [{ effective_date: null, months_from_start: 1, new_base_rent: 21000 }], '2020-01-31');
    expect(rows).toHaveLength(1);
    expect(rows[0].effective_date).toBe('2020-02-29');
  });
});

describe('rebuildRentSchedule — dated mode is unchanged by the relative path', () => {
  test('a schedule with real dates still dates its steps (not treated as relative)', () => {
    const out = rebuildRentSchedule({
      rentSchedule: [
        { effective_date: '2021-01-01', months_from_start: null, amount: 24000, period: 'per_year' },
        { effective_date: '2022-01-01', months_from_start: null, amount: 25000, period: 'per_year' },
      ],
      sqft: 0,
      modelEscalations: [],
    });
    expect(out.baseRent).toBe(24000);
    expect(out.baseDate).toBe('2021-01-01');
    expect(out.escalations).toEqual([
      { effective_date: '2022-01-01', escalation_type: 'manual', escalation_value: null, new_base_rent: 25000 },
    ]);
  });

  test('if ANY row is dated, undated rows are dropped (not relative mode)', () => {
    const out = rebuildRentSchedule({
      rentSchedule: [
        { effective_date: '2021-01-01', months_from_start: null, amount: 24000, period: 'per_year' },
        { effective_date: null, months_from_start: 12, amount: 25000, period: 'per_year' },
      ],
      sqft: 0,
      modelEscalations: [],
    });
    expect(out.baseRent).toBe(24000);
    expect(out.baseDate).toBe('2021-01-01');
    expect(out.escalations).toBeNull(); // the undated row can't be scheduled, and it's not relative mode
  });
});
