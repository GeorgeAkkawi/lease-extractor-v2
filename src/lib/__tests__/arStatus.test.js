// The calendar-aware receivables model (receivables audit). Three pure pieces working
// together, all tested here:
//   • occupancyStart / monthlyBases (escalations.js) — WHICH months a lease covers and
//     the base rate in effect each month.
//   • monthlyScheduleForYear (abatement.js) — the per-month owed schedule, term-aware.
//   • monthsBehindForInvoice / inTermMonths / monthsDueByNow (arStatus.js) — "is this
//     tenant behind on rent, and by how many months?" — replacing 30/60/90 aging.
import { describe, it, expect } from 'vitest';
import { occupancyStart, monthlyBases } from '../escalations';
import { monthlyScheduleForYear } from '../abatement';
import { inTermMonths, monthsDueByNow, monthsBehindForInvoice } from '../arStatus';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const sumOwed = (s) => round2(Object.values(s).reduce((a, c) => a + c.owed, 0));

describe('occupancyStart — new tenancy vs renewed-in-place', () => {
  it('a NEW mid-year tenancy (only applied step is AT the start) → the lease start', () => {
    // Infinite Mobile shape: lease_start 2026-07-01, its only applied step is at the start.
    const occ = occupancyStart(
      { lease_start: '2026-07-01' },
      [{ status: 'applied', effective_date: '2026-07-01', new_base_rent: 36000 }],
    );
    expect(occ).toBe('2026-07-01'); // Jan–Jun 2026 are before the tenancy
  });

  it('a RENEWED-in-place lease (applied steps BEFORE the current start) → the earliest step', () => {
    // Ricki's shape: a catch-up renewal moved lease_start to the current term (2024), but the
    // ledger still carries steps from the original 2015 occupancy — so it owes the full year.
    const occ = occupancyStart(
      { lease_start: '2024-05-01' },
      [
        { status: 'applied', effective_date: '2015-05-01', new_base_rent: 22800 },
        { status: 'applied', effective_date: '2020-05-01', new_base_rent: 25173 },
      ],
    );
    expect(occ).toBe('2015-05-01'); // proof of earlier occupancy → not a mid-year move-in
  });

  it('an old lease with no start and no steps → null (bills the full year, unchanged)', () => {
    expect(occupancyStart({}, [])).toBe(null);
    expect(occupancyStart({ lease_start: null }, [{ status: 'scheduled', effective_date: '2026-01-01' }])).toBe(null);
  });
});

describe('monthlyBases — a mid-year rent step blends the year', () => {
  it('bills the old rate before the step and the new rate after (era-aware)', () => {
    // base_rent (current era) = 26000; an applied step at July 1 = 26000. A historical year's
    // pre-step months read the ledger's prior rate (24000).
    const esc = [
      { status: 'applied', effective_date: '2024-01-01', new_base_rent: 24000 },
      { status: 'applied', effective_date: '2026-07-01', new_base_rent: 26000 },
    ];
    const bases = monthlyBases(esc, 26000, 2026);
    // Jan–Jun 2026 → 24000 (prior applied step); Jul–Dec → 26000 (current era = base_rent).
    expect(bases.slice(0, 6)).toEqual([24000, 24000, 24000, 24000, 24000, 24000]);
    expect(bases.slice(6)).toEqual([26000, 26000, 26000, 26000, 26000, 26000]);
  });

  it('no applied steps → every month uses the base rent', () => {
    expect(monthlyBases([], 60000, 2026)).toEqual(Array(12).fill(60000));
  });
});

describe('monthlyScheduleForYear — term-aware', () => {
  it('a July-start lease owes only Jul–Dec; Jan–Jun are outside the term, annual halves', () => {
    const s = monthlyScheduleForYear({ year: 2026, annualBaseRent: 36000, occupancyStartIso: '2026-07-01' });
    for (let m = 1; m <= 6; m++) {
      expect(s[m].outsideTerm).toBe(true);
      expect(s[m].owed).toBe(0);
    }
    for (let m = 7; m <= 12; m++) {
      expect(s[m].outsideTerm).toBe(false);
      expect(s[m].owed).toBe(3000); // 36000/12
    }
    expect(sumOwed(s)).toBe(18000); // a half-year, not the full 36000
  });

  it('holdover months AFTER term end stay owed (rent collects until removal)', () => {
    // Occupancy started years ago; nothing zeroes the later months — a full year owed.
    const s = monthlyScheduleForYear({ year: 2026, annualBaseRent: 24000, occupancyStartIso: '2020-01-01' });
    expect(Object.values(s).every((c) => !c.outsideTerm)).toBe(true);
    expect(sumOwed(s)).toBe(24000);
  });

  it('blends a mid-year step with monthlyBases, penny-true', () => {
    const bases = monthlyBases(
      [{ status: 'applied', effective_date: '2024-01-01', new_base_rent: 24000 },
       { status: 'applied', effective_date: '2026-07-01', new_base_rent: 26000 }],
      26000, 2026);
    const s = monthlyScheduleForYear({ year: 2026, annualBaseRent: 26000, monthlyBases: bases });
    expect(s[1].owed).toBe(2000);  // 24000/12
    expect(s[7].owed).toBe(2166.67); // 26000/12
    // 6 months at 2000 + 6 at 2166.67 (penny-folded) = the year's true blended total.
    expect(sumOwed(s)).toBe(round2(6 * 2000 + 6 * (26000 / 12)));
  });

  it('a mid-year start with a leading free month: Jan–Jun "—", Jul free, Aug–Dec owed', () => {
    const s = monthlyScheduleForYear({
      year: 2026, annualBaseRent: 36000, occupancyStartIso: '2026-07-01',
      abatements: [{ start_date: '2026-07-01', end_date: '2026-07-31', kind: 'free' }],
    });
    expect(s[6].outsideTerm).toBe(true);
    expect(s[7].abated).toBe(true);
    expect(s[7].owed).toBe(0);      // free first month of occupancy
    expect(s[8].owed).toBe(3000);
    expect(sumOwed(s)).toBe(15000); // 5 paid months of the 6-month occupancy
  });
});

describe('inTermMonths / monthsDueByNow', () => {
  it('inTermMonths — full year when occupancy is unknown; only covered months otherwise', () => {
    expect(inTermMonths(2026, null)).toBe(12);
    expect(inTermMonths(2026, '2026-07-01')).toBe(6); // Jul–Dec
    expect(inTermMonths(2026, '2026-01-01')).toBe(12);
  });

  it('monthsDueByNow — a past FY = all covered months; a future FY = 0; mid-year = elapsed', () => {
    expect(monthsDueByNow(2025, null, new Date('2026-06-15T12:00:00'))).toBe(12); // last year, all due
    expect(monthsDueByNow(2027, null, new Date('2026-06-15T12:00:00'))).toBe(0);  // next year, nothing due
    expect(monthsDueByNow(2026, null, new Date('2026-06-15T12:00:00'))).toBe(6);  // Jan–Jun have started
    expect(monthsDueByNow(2026, '2026-07-01', new Date('2026-09-15T12:00:00'))).toBe(3); // Jul,Aug,Sep
  });
});

describe('monthsBehindForInvoice', () => {
  const today = new Date('2026-07-07T12:00:00'); // 7 months have come due in 2026

  it('on-track: expected-by-now is fully paid → not behind', () => {
    const r = monthsBehindForInvoice(
      { kind: 'annual', year: 2026, total_amount: 12000, amount_paid: 7000, balance: 5000 },
      {}, today);
    expect(r.behind).toBe(false);
    expect(r.monthsBehind).toBe(0);
    expect(r.monthsDue).toBe(7);
  });

  it('1 month behind: paid 6 of 7 months due', () => {
    const r = monthsBehindForInvoice(
      { kind: 'annual', year: 2026, total_amount: 12000, amount_paid: 6000, balance: 6000 },
      {}, today);
    expect(r.behind).toBe(true);
    expect(r.monthsBehind).toBe(1);
    expect(r.amountBehind).toBe(1000);
  });

  it('several months behind: nothing paid on a full-year bill', () => {
    const r = monthsBehindForInvoice(
      { kind: 'annual', year: 2026, total_amount: 12000, amount_paid: 0, balance: 12000 },
      {}, today);
    expect(r.monthsBehind).toBe(7); // all 7 months that have come due
    expect(r.amountBehind).toBe(7000);
  });

  it('a lump-sum annual payer (paid in full) is never behind even before year end', () => {
    const r = monthsBehindForInvoice(
      { kind: 'annual', year: 2026, total_amount: 12000, amount_paid: 12000, balance: 0 },
      {}, today);
    expect(r.behind).toBe(false);
  });

  it('a mid-year (July-start) tenant is only judged on the months it actually owes', () => {
    // Occupancy Jul 1 → by Jul 7, exactly 1 month (July) has come due. Nothing paid → 1 behind,
    // NOT 7 — Jan–Jun were never owed. total is the prorated half-year (6 months × 3000).
    const r = monthsBehindForInvoice(
      { kind: 'annual', year: 2026, total_amount: 18000, amount_paid: 0, balance: 18000 },
      { occupancyStartIso: '2026-07-01' }, today);
    expect(r.monthsDue).toBe(1);
    expect(r.monthsBehind).toBe(1);
    expect(r.amountBehind).toBe(3000); // one month of the $3,000/mo prorated rent
  });

  it('a future fiscal year is never behind (no month has come due)', () => {
    const r = monthsBehindForInvoice(
      { kind: 'annual', year: 2027, total_amount: 12000, amount_paid: 0, balance: 12000 },
      {}, today);
    expect(r.behind).toBe(false);
    expect(r.monthsDue).toBe(0);
  });

  it('a reconciliation invoice keeps the plain past-the-due-date test', () => {
    const overdue = monthsBehindForInvoice(
      { kind: 'reconciliation', year: 2026, total_amount: 700, amount_paid: 0, balance: 700, due_date: '2026-03-01' },
      {}, today);
    expect(overdue.isReconciliation).toBe(true);
    expect(overdue.behind).toBe(true);
    expect(overdue.amountBehind).toBe(700);

    const notYetDue = monthsBehindForInvoice(
      { kind: 'reconciliation', year: 2026, total_amount: 700, amount_paid: 0, balance: 700, due_date: '2026-12-01' },
      {}, today);
    expect(notYetDue.behind).toBe(false); // due date hasn't passed
  });

  it('a rounding-dust balance (≤5¢) is not "behind"', () => {
    const r = monthsBehindForInvoice(
      { kind: 'annual', year: 2026, total_amount: 12000, amount_paid: 6999.97, balance: 0.03 },
      {}, today);
    expect(r.behind).toBe(false);
  });
});
