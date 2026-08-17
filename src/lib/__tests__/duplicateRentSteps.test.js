// George, 2026-08-17, looking at the beauty and barber shop lease: "see how it says two
// values for june 2025? … it read the monthly value and the yearly value as two different
// numbers which they are becaue they are off by 4 cents. if this happens it should flag and
// tell the user that number is off and have them choose what theyd like to do just for the
// sake of the software not flagging it every time."
//
// The figures below are the real rows out of production, not invented ones. The addendum
// says "$31,801.00 annually or $2,650.08 monthly" — and $2,650.08 × 12 = $31,800.96.
import { describe, it, expect } from 'vitest';
import { duplicateRentSteps, rentDupKey } from '../escalations';

const LEASE = '1abd522d-70e9-4849-8e6f-0b29c45afe71';

// The lease as stored: nine applied steps, two of them on 2025-06-01.
const REAL = [
  { id: 'e1', effective_date: '2005-01-01', new_base_rent: 16585.8, status: 'applied' },
  { id: 'e5', effective_date: '2009-01-01', new_base_rent: 19386, status: 'applied' },
  { id: 'e6', effective_date: '2020-06-01', new_base_rent: 24200, status: 'applied' },
  { id: 'monthly', effective_date: '2025-06-01', new_base_rent: 31800.96, status: 'applied' },
  { id: 'annual', effective_date: '2025-06-01', new_base_rent: 31801, status: 'applied' },
];

describe('duplicateRentSteps — the four cents on June 2025', () => {
  it('finds exactly one flagged date, and it is the one with two steps', () => {
    const d = duplicateRentSteps(REAL, { leaseId: LEASE });
    expect(d).toHaveLength(1);
    expect(d[0].date).toBe('2025-06-01');
    expect(d[0].rows.map((r) => r.id)).toEqual(['annual', 'monthly']); // highest first
  });

  it('states the gap as four cents', () => {
    expect(duplicateRentSteps(REAL, { leaseId: LEASE })[0].spread).toBe(0.04);
  });

  it('recognises it as one rent rounded two ways, and says what the month is', () => {
    // This is the whole diagnosis: not "four cents apart" but "the same $2,650.08 a month".
    const [dup] = duplicateRentSteps(REAL, { leaseId: LEASE });
    expect(dup.kind).toBe('rounding');
    expect(dup.monthly).toBe(2650.08);
  });

  it('calls a genuine disagreement a conflict, and offers no monthly reassurance', () => {
    // $2,650.00 vs $2,650.08 — twelve dollars a year apart. One of them is simply wrong.
    const [dup] = duplicateRentSteps(
      [
        { id: 'a', effective_date: '2025-06-01', new_base_rent: 31800, status: 'applied' },
        { id: 'b', effective_date: '2025-06-01', new_base_rent: 31801, status: 'applied' },
      ],
      { leaseId: LEASE },
    );
    expect(dup.kind).toBe('conflict');
    expect(dup.monthly).toBeNull();
    expect(dup.spread).toBe(1);
  });
});

describe('duplicateRentSteps — "keep both" has to actually stop the asking', () => {
  it('drops a date the landlord has answered', () => {
    const dismissed = new Set([rentDupKey(LEASE, '2025-06-01')]);
    expect(duplicateRentSteps(REAL, { leaseId: LEASE, dismissed })).toEqual([]);
  });

  it('keys the decision per lease AND per date, so one answer never silences another', () => {
    expect(rentDupKey(LEASE, '2025-06-01')).toBe(`rent_dup:${LEASE}:2025-06-01`);
    // Another lease's June 2025 is a different question.
    const dismissed = new Set([rentDupKey('some-other-lease', '2025-06-01')]);
    expect(duplicateRentSteps(REAL, { leaseId: LEASE, dismissed })).toHaveLength(1);
  });
});

describe('duplicateRentSteps — what it stays quiet about', () => {
  it('says nothing about an ordinary schedule where every date is used once', () => {
    expect(duplicateRentSteps(REAL.filter((e) => e.id !== 'monthly'), { leaseId: LEASE })).toEqual([]);
  });

  it('ignores rows with no date or no rent rather than pairing them up', () => {
    const rows = [
      { id: 'a', effective_date: null, new_base_rent: 1000 },
      { id: 'b', effective_date: null, new_base_rent: 2000 },
      { id: 'c', effective_date: '2025-06-01', new_base_rent: null },
      { id: 'd', effective_date: '2025-06-01', new_base_rent: null },
    ];
    expect(duplicateRentSteps(rows, { leaseId: LEASE })).toEqual([]);
  });

  it('handles an empty or missing list without throwing', () => {
    expect(duplicateRentSteps([], { leaseId: LEASE })).toEqual([]);
    expect(duplicateRentSteps(undefined)).toEqual([]);
  });
});
