// "N mo behind" waits for the month to END (George, 2026-08-13: "it should only say its one
// month behind after the month has passed since bank statements are given at the end of each
// month").
//
// ⚠ THE DISTINCTION THIS FILE EXISTS TO PIN: `monthsBehind` waits, `owesToDate` does NOT.
// Rent falls due on the 1st, so an unpaid running month IS owed — a balance that hid it
// would be wrong in the opposite direction, and it is what ties `owesToDate` to arStatus's
// `amountBehind` to the cent (see the PARITY test in ledger.test.js). What waits is the
// ACCUSATION, because the bank statement that would settle the month does not exist yet.
import { describe, it, expect } from 'vitest';
import { allocatePayments, ledgerRowSummary, monthClosedForLogging } from '../ledger';

const flat = (n) => Array(12).fill(n);
const summary = (today, payments = []) => ledgerRowSummary({
  year: 2026,
  owedByMonth: flat(1000),
  allocation: allocatePayments({ owedByMonth: flat(1000), payments }),
  today,
});

describe('monthsBehind — a month is behind only once it has ended', () => {
  it('does not count the month still running', () => {
    // Mid-June: Jan–May have ended and are unpaid; June is due but still on.
    const row = summary(new Date(2026, 5, 15, 12));
    expect(row.monthsBehind).toBe(5);
    // …and the balance still counts June, deliberately — six due months at $1,000.
    expect(row.owesToDate).toBe(6000);
  });

  it('counts it once the month is over', () => {
    // ⚠ The boundary is LOCAL NOON on the 1st, not midnight — every month comparison in
    // ledger.js is noon-anchored (`monthStart`) so a timezone or DST shift can never move a
    // month by a day. Half a day's lag on a monthly signal is the price, and introducing a
    // second date convention to save it would be the more expensive mistake.
    expect(summary(new Date(2026, 5, 30, 23, 59)).monthsBehind).toBe(5);
    expect(summary(new Date(2026, 6, 1, 11, 0)).monthsBehind).toBe(5);
    expect(summary(new Date(2026, 6, 1, 12, 1)).monthsBehind).toBe(6);
  });

  it('no grace beyond the month end — George asked for the boundary itself', () => {
    // The statement REMINDER waits 7 more days (monthClosedForLogging's graceDays), and
    // that stays its own rule. This one fires on July 1.
    expect(monthClosedForLogging(2026, 6, new Date(2026, 6, 1, 12), 0)).toBe(true);
    expect(monthClosedForLogging(2026, 6, new Date(2026, 6, 1, 12), 7)).toBe(false);
  });

  it('a month with money on it is never behind, ended or not', () => {
    const row = summary(new Date(2026, 6, 15, 12), [
      { amount: 400, period_month: 3, paid_date: '2026-03-05' }, // short, but money arrived
    ]);
    // Jan, Feb, Apr, May, Jun ended and are empty. March has money; July is still running.
    expect(row.monthsBehind).toBe(5);
  });

  it('a past fiscal year is judged in full', () => {
    const row = ledgerRowSummary({
      year: 2025, owedByMonth: flat(1000),
      allocation: allocatePayments({ owedByMonth: flat(1000), payments: [] }),
      today: new Date(2026, 5, 15, 12),
    });
    expect(row.monthsBehind).toBe(12);
    expect(row.owesToDate).toBe(12000);
  });
});
