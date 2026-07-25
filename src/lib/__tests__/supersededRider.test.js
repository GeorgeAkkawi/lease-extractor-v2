// Token-free replay of George's real Denny's "THIRD ADDENDUM TO THE LEASE" through the
// FIXED rent-schedule pipeline. No AI calls — the model read the document correctly; the
// bug was that nothing downstream knew an amendment RECITES the clause it replaces.
//
// The rider reads:
//   "Number 4 of the agreement reads 'The Monthly Base Rent … shall be increased to
//    $12,595 beginning June 1, 2023 to April 31, 2028.'"      ← the clause being REPLACED
//   "This will be changed to … $12,595 beginning July 1, 2023 to April 31, 2033."  ← governs
//   "Extending the lease for an additional 5 years at the $12,595 Monthly rate."
//
// So there is ONE rent ($12,595/mo = $151,140/yr) commencing July 1 2023 — not two periods.
// Both figures being identical is precisely what made the quotation look like a rent table
// row. With a CHANGED rent the same shape writes a false step into rent_escalations dated a
// month early, and effective_rent then misreports that fiscal year forever.

import { rebuildRentSchedule, addMonths, realIsoDate } from '../../../supabase/functions/_shared/rentSchedule.js';

// The two rows exactly as the rent call now returns them, with the flag the model sets.
const QUOTED = { effective_date: '2023-06-01', amount: 12595, period: 'per_month', superseded: true };
const OPERATIVE = { effective_date: '2023-07-01', amount: 12595, period: 'per_month', superseded: false };

// What the edge function does with the model's rows before handing them to the rebuild.
const live = (rows) => rows.filter((r) => r.superseded !== true);

describe('Denny\'s rider — a quoted clause is not a rent period', () => {
  test('the superseded row is filtered out: one rent, starting July 1', () => {
    const out = rebuildRentSchedule({ rentSchedule: live([QUOTED, OPERATIVE]), sqft: 0 });
    expect(out.baseRent).toBe(151140);        // 12,595 × 12, computed in code
    expect(out.baseDate).toBe('2023-07-01');  // the OPERATIVE date, not the quoted June 1
    expect(out.escalations).toBeNull();       // a single period → no steps at all
  });

  test('the safety net: even if the flag is MISSED, the no-op dedupe kills the phantom step', () => {
    // The model failing to set superseded is the realistic residual risk, so the dedupe is
    // a second line of defence — not a substitute for the flag. It collapses the pair to
    // one period, but note the honest limitation it CANNOT fix: the surviving date is the
    // quoted June 1, a month early. Only the flag gets the date right.
    const out = rebuildRentSchedule({
      rentSchedule: [{ ...QUOTED, superseded: false }, OPERATIVE],
      sqft: 0,
    });
    expect(out.baseRent).toBe(151140);
    expect(out.escalations).toEqual([]);      // [] — priced, and no step survived
    expect(out.baseDate).toBe('2023-06-01');  // documented imperfection of the fallback
  });

  test('the same shape with a CHANGED rent — the case that corrupts rent history', () => {
    // "the rent was $10,000; it will be changed to $12,595." Unflagged, this writes a
    // $151,140 step dated 2023-07-01 on top of a $120,000 base. Flagged, it's one rent.
    const rows = [
      { effective_date: '2023-06-01', amount: 10000, period: 'per_month', superseded: true },
      OPERATIVE,
    ];
    const naive = rebuildRentSchedule({ rentSchedule: rows.map((r) => ({ ...r, superseded: false })), sqft: 0 });
    expect(naive.baseRent).toBe(120000);                      // the OLD rent as base — wrong
    expect(naive.escalations).toHaveLength(1);                // and a phantom step

    const fixed = rebuildRentSchedule({ rentSchedule: live(rows), sqft: 0 });
    expect(fixed.baseRent).toBe(151140);
    expect(fixed.baseDate).toBe('2023-07-01');
    expect(fixed.escalations).toBeNull();
  });
});

describe('no-op rent steps', () => {
  test('three periods at the same rent produce ZERO steps, not two', () => {
    const out = rebuildRentSchedule({
      rentSchedule: [
        { effective_date: '2024-01-01', amount: 60000, period: 'per_year', superseded: false },
        { effective_date: '2025-01-01', amount: 60000, period: 'per_year', superseded: false },
        { effective_date: '2026-01-01', amount: 60000, period: 'per_year', superseded: false },
      ],
      sqft: 0,
    });
    expect(out.baseRent).toBe(60000);
    expect(out.escalations).toEqual([]);
  });

  test('a one-cent move is a real step — dedupe never swallows a genuine change', () => {
    const out = rebuildRentSchedule({
      rentSchedule: [
        { effective_date: '2024-01-01', amount: 60000, period: 'per_year', superseded: false },
        { effective_date: '2025-01-01', amount: 60000.01, period: 'per_year', superseded: false },
      ],
      sqft: 0,
    });
    expect(out.escalations).toHaveLength(1);
    expect(out.escalations[0].new_base_rent).toBe(60000.01);
  });

  test('a no-op followed by a real rise keeps the rise, at its own date', () => {
    const out = rebuildRentSchedule({
      rentSchedule: [
        { effective_date: '2024-01-01', amount: 5000, period: 'per_month', superseded: false },
        { effective_date: '2025-01-01', amount: 5000, period: 'per_month', superseded: false },
        { effective_date: '2026-01-01', amount: 5500, period: 'per_month', superseded: false },
      ],
      sqft: 0,
    });
    expect(out.baseRent).toBe(60000);
    expect(out.escalations).toEqual([
      { effective_date: '2026-01-01', escalation_type: 'manual', escalation_value: null, new_base_rent: 66000 },
    ]);
  });

  test('the [] vs null contract — callers read them differently', () => {
    // null = "we priced nothing, keep the model's own rows" (extract-lease reads
    // `if (rebuilt.escalations)`); [] = "we priced them and there are genuinely none".
    const noSteps = rebuildRentSchedule({ rentSchedule: [{ effective_date: '2024-01-01', amount: 5000, period: 'per_month' }], sqft: 0 });
    expect(noSteps.escalations).toBeNull();

    const allNoOp = rebuildRentSchedule({
      rentSchedule: [
        { effective_date: '2024-01-01', amount: 5000, period: 'per_month' },
        { effective_date: '2025-01-01', amount: 5000, period: 'per_month' },
      ],
      sqft: 0,
    });
    expect(allNoOp.escalations).toEqual([]);
  });

  test('a printed table of equal rents still beats a prose percent formula', () => {
    // tableRowCount stays at the PRE-dedupe row count, so two printed periods (even if
    // equal) keep the "a real table wins" rule intact and the 2%/yr prose is not applied.
    const out = rebuildRentSchedule({
      rentSchedule: [
        { effective_date: '2024-01-01', amount: 60000, period: 'per_year' },
        { effective_date: '2025-01-01', amount: 60000, period: 'per_year' },
      ],
      sqft: 0,
      escalationPct: 2,
      termMonths: 60,
    });
    expect(out.escalations).toEqual([]); // NOT four synthesized 2% steps
  });

  test('RELATIVE mode is untouched — Wingstop\'s Year 1 = Year 2 is a real lease', () => {
    // The real Wingstop table prices Year 1 and Year 2 both at $30,525; relativeRentSchedule
    // pins that step. Equal consecutive periods genuinely occur, and nothing in the rider
    // lane reaches relative mode, so the dedupe is deliberately dated-mode only.
    const out = rebuildRentSchedule({
      rentSchedule: [
        { effective_date: null, months_from_start: 0, amount: 30525, period: 'per_year' },
        { effective_date: null, months_from_start: 12, amount: 30525, period: 'per_year' },
      ],
      sqft: 0,
    });
    expect(out.escalations).toHaveLength(1);
    expect(out.escalations[0].months_from_start).toBe(12);
  });
});

describe('addMonths — an extension stated as a LENGTH', () => {
  test('Denny\'s: 5 more years off the current end lands on the printed date', () => {
    // The rider prints "April 31, 2033" — a date that does not exist — so computing it is
    // the only way to get a usable one. 2028-04-30 + 60 months = 2033-04-30.
    expect(addMonths('2028-04-30', 60)).toBe('2033-04-30');
  });

  test('clamps into a shorter month instead of spilling into the next one', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); // leap year
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
    expect(addMonths('2025-08-31', 6)).toBe('2026-02-28');
  });

  test('refuses anything that is not a real ISO date or count', () => {
    expect(addMonths(null, 12)).toBeNull();
    expect(addMonths('2033-04-31', 12)).toBeNull(); // the impossible date itself
    expect(addMonths('April 31, 2033', 12)).toBeNull();
    expect(addMonths('2028-04-30', 'five')).toBeNull();
  });
});

describe('realIsoDate — the guard that stops an impossible date reaching Postgres', () => {
  test('a date that parses but does not exist is refused', () => {
    // The whole point: `new Date('2033-04-31T12:00:00')` is NOT NaN — it rolls to May 1 —
    // so a shape regex plus an isNaN check waves it through, and the save then dies with
    // `date/time field value out of range: "2033-04-31"`.
    expect(realIsoDate('2033-04-31')).toBeNull();
    expect(realIsoDate('2025-02-29')).toBeNull(); // 2025 isn't a leap year
    expect(realIsoDate('2025-06-31')).toBeNull();
  });
  test('real dates pass, including the edges', () => {
    expect(realIsoDate('2033-04-30')).toBe('2033-04-30');
    expect(realIsoDate('2024-02-29')).toBe('2024-02-29'); // 2024 is
    expect(realIsoDate(' 2026-12-31 ')).toBe('2026-12-31');
  });
  test('prose, blanks and non-strings are refused', () => {
    expect(realIsoDate('April 31, 2033')).toBeNull();
    expect(realIsoDate('')).toBeNull();
    expect(realIsoDate(null)).toBeNull();
    expect(realIsoDate(20330431)).toBeNull();
  });
});
