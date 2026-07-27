// The bank-statement reminder's month selection — pure, no backend.
//
// George's report (2026-07-27): the Overview filled with "tenant behind on rent"
// notifications. Two things were wrong. The app judged a month the moment it began,
// but his bank statement only arrives once the month CLOSES — so there was nothing to
// log yet, and nobody was actually late. And it raised one alert per tenant, so a
// single forgotten upload read as a dozen accusations. These tests pin the fix: a month
// is only considered once it has ended (plus a grace for the statement to arrive), and
// any money at all on the property proves the month was logged.
import { describe, test, expect } from 'vitest';
import { monthClosedForLogging, unloggedMonths, allocatePayments } from '../ledger';

// One tenant at $6,500/mo, billed every month of 2026.
const FULL_YEAR = Array(12).fill(6500);
const noMoney = { owed: FULL_YEAR, received: Array(12).fill(0) };

describe('a month is only judged once it has closed', () => {
  test('the month in progress is never raised — the statement does not exist yet', () => {
    // Deep into July with nothing recorded all year. July must stay silent.
    const months = unloggedMonths({ year: 2026, rows: [noMoney], today: new Date('2026-07-27T12:00:00') });
    expect(months).not.toContain(7);
    expect(months).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('a week into the month is still too early (the old bug, replayed)', () => {
    // The previous alert flagged a month 7 days after its 1st. On 2026-07-08 that made
    // every tenant "1 month behind" for a July nobody could have logged yet.
    expect(monthClosedForLogging(2026, 7, new Date('2026-07-08T12:00:00'))).toBe(false);
  });

  test('the grace runs from month END, so June opens for logging on July 8', () => {
    expect(monthClosedForLogging(2026, 6, new Date('2026-07-05T12:00:00'))).toBe(false);
    expect(monthClosedForLogging(2026, 6, new Date('2026-07-08T12:00:00'))).toBe(true);
  });

  test('a longer grace pushes it out; zero grace opens it the day the month ends', () => {
    expect(monthClosedForLogging(2026, 6, new Date('2026-07-08T12:00:00'), 21)).toBe(false);
    expect(monthClosedForLogging(2026, 6, new Date('2026-07-22T12:00:00'), 21)).toBe(true);
    expect(monthClosedForLogging(2026, 6, new Date('2026-07-01T12:00:00'), 0)).toBe(true);
  });

  test('December rolls into the next year, and a future year is never closed', () => {
    expect(monthClosedForLogging(2026, 12, new Date('2027-01-08T12:00:00'))).toBe(true);
    expect(monthClosedForLogging(2026, 12, new Date('2026-12-31T12:00:00'))).toBe(false);
    expect(monthClosedForLogging(2027, 1, new Date('2026-07-27T12:00:00'))).toBe(false);
  });

  test('a nonsense month or year is simply not closed', () => {
    const t = new Date('2026-07-27T12:00:00');
    expect(monthClosedForLogging(2026, 0, t)).toBe(false);
    expect(monthClosedForLogging(2026, 13, t)).toBe(false);
    expect(monthClosedForLogging(null, 6, t)).toBe(false);
  });
});

describe('any money on the property means the month was logged', () => {
  const TODAY = new Date('2026-07-27T12:00:00'); // Jan–Jun closed

  test('a month with a recorded payment drops out of the list', () => {
    const received = Array(12).fill(0);
    received[2] = 6500; // March logged
    const months = unloggedMonths({ year: 2026, rows: [{ owed: FULL_YEAR, received }], today: TODAY });
    expect(months).toEqual([1, 2, 4, 5, 6]);
  });

  test('ONE tenant paying is enough — the statement covered the whole property', () => {
    // Nine tenants, only one with money on June. The statement was clearly imported, so
    // June is logged. Whether the other eight paid is the Ledger grid's job to show.
    const quiet = Array.from({ length: 8 }, () => noMoney);
    const paid = { owed: FULL_YEAR, received: [0, 0, 0, 0, 0, 6500, 0, 0, 0, 0, 0, 0] };
    expect(unloggedMonths({ year: 2026, rows: [...quiet, paid], today: TODAY })).not.toContain(6);
  });

  test('an untagged lump counts for every month it FIFO-fills', () => {
    // Bright Coffee's shape: one cheque, no month tag. allocatePayments spreads it
    // Jan→ until it runs out, so only the months it does NOT reach need logging.
    const alloc = allocatePayments({
      owedByMonth: FULL_YEAR,
      payments: [{ amount: 19500, paid_date: '2026-01-09', period_month: null }], // 3 months' worth
    });
    expect(unloggedMonths({ year: 2026, rows: [{ owed: FULL_YEAR, received: alloc.received }], today: TODAY }))
      .toEqual([4, 5, 6]);
  });

  test('a month the property bills nothing is never raised', () => {
    // Mid-year lease start: Jan–Jun out of term, so there is nothing to log.
    const midYear = { owed: [0, 0, 0, 0, 0, 0, 6500, 6500, 6500, 6500, 6500, 6500], received: Array(12).fill(0) };
    expect(unloggedMonths({ year: 2026, rows: [midYear], today: TODAY })).toEqual([]);
  });

  test('sub-cent dust is not money', () => {
    const received = Array(12).fill(0);
    received[5] = 0.01;
    expect(unloggedMonths({ year: 2026, rows: [{ owed: FULL_YEAR, received }], today: TODAY })).toContain(6);
  });

  test('no leases at all → nothing to remind about', () => {
    expect(unloggedMonths({ year: 2026, rows: [], today: TODAY })).toEqual([]);
    expect(unloggedMonths({})).toEqual([]);
  });
});
