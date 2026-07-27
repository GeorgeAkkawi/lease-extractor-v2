// The bank-statement reminder's month selection — pure, no backend.
//
// George's report (2026-07-27): the Overview filled with "tenant behind on rent"
// notifications. Two things were wrong. The app judged a month the moment it began,
// but his bank statement only arrives once the month CLOSES — so there was nothing to
// log yet, and nobody was actually late. And it raised one alert per tenant, so a
// single forgotten upload read as a dozen accusations. These tests pin the fix: a month
// is only considered once it has ended (plus a grace for the statement to arrive), and
// any money at all on the property proves the month was logged.
//
// The complementary case (George, same day: "yes i would like to still have an alert for
// a tenant who is missing on the month the user has imported") is at the bottom: once the
// month IS imported, an absent tenant is a real gap worth naming.
import { describe, test, expect } from 'vitest';
import { monthClosedForLogging, unloggedMonths, missingOnImportedMonths, allocatePayments } from '../ledger';

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

describe('a tenant missing from a month that WAS imported', () => {
  const TODAY = new Date('2026-07-27T12:00:00'); // Jan–Jun closed
  const paidThrough = (through) => {
    const r = Array(12).fill(0);
    for (let m = 1; m <= through; m++) r[m - 1] = 6500;
    return r;
  };
  // June's statement is in. Two tenants are in it; one isn't.
  const ROWS = [
    { lease_id: 'a', tenant_name: 'Bright Coffee', owed: FULL_YEAR, received: paidThrough(6) },
    { lease_id: 'b', tenant_name: 'City Dental', owed: FULL_YEAR, received: paidThrough(6) },
    { lease_id: 'c', tenant_name: 'Michuacana', owed: FULL_YEAR, received: paidThrough(5) },
  ];

  test('names the tenant, the month and the outstanding amount', () => {
    const out = missingOnImportedMonths({ year: 2026, rows: ROWS, importedMonths: [6], today: TODAY });
    expect(out).toEqual([{ lease_id: 'c', tenant_name: 'Michuacana', months: [6], amount: 6500 }]);
  });

  test('ONE entry per tenant however many months they are missing', () => {
    const out = missingOnImportedMonths({ year: 2026, rows: ROWS, importedMonths: [4, 5, 6], today: TODAY });
    expect(out).toHaveLength(1);
    expect(out[0].months).toEqual([6]); // Michuacana is only absent from June
  });

  test('a month that was NOT imported is silent — hand-ticking one box accuses nobody', () => {
    // Every month has SOME money (the tenants above), but nothing was imported. This is
    // the guard that stops one manual ✓ turning into an alert for every other tenant.
    expect(missingOnImportedMonths({ year: 2026, rows: ROWS, importedMonths: [], today: TODAY })).toEqual([]);
  });

  test('an imported month still running is silent until it closes', () => {
    // A statement imported mid-July covers a partial period — an absent tenant may simply
    // not have paid yet.
    const rows = [{ lease_id: 'c', tenant_name: 'Michuacana', owed: FULL_YEAR, received: paidThrough(6) }];
    expect(missingOnImportedMonths({ year: 2026, rows, importedMonths: [7], today: TODAY })).toEqual([]);
  });

  test('a month the tenant is not billed for is never "missing"', () => {
    const midYear = { lease_id: 'd', tenant_name: 'Sunrise Yoga', owed: [0, 0, 0, 0, 0, 0, 6500, 6500, 6500, 6500, 6500, 6500], received: Array(12).fill(0) };
    expect(missingOnImportedMonths({ year: 2026, rows: [midYear], importedMonths: [5, 6], today: TODAY })).toEqual([]);
  });

  test('a short payment is not a missing one — that difference lives on the grid', () => {
    const short = Array(12).fill(0);
    short[5] = 100; // paid something in June, just not enough
    const rows = [{ lease_id: 'c', tenant_name: 'Michuacana', owed: FULL_YEAR, received: short }];
    expect(missingOnImportedMonths({ year: 2026, rows, importedMonths: [6], today: TODAY })).toEqual([]);
  });

  test('the two reminders can never both fire for the same month', () => {
    // An imported month has money on it by definition, so it is never "unlogged".
    const imported = [6];
    const unlogged = unloggedMonths({ year: 2026, rows: ROWS, today: TODAY });
    const missing = missingOnImportedMonths({ year: 2026, rows: ROWS, importedMonths: imported, today: TODAY });
    const missingMonths = new Set(missing.flatMap((m) => m.months));
    expect(unlogged.filter((m) => missingMonths.has(m))).toEqual([]);
  });

  test('several missing months sum their outstanding rent', () => {
    const rows = [{ lease_id: 'c', tenant_name: 'Michuacana', owed: FULL_YEAR, received: paidThrough(3) }];
    const out = missingOnImportedMonths({ year: 2026, rows, importedMonths: [4, 5, 6], today: TODAY });
    expect(out[0].months).toEqual([4, 5, 6]);
    expect(out[0].amount).toBe(19500);
  });
});
