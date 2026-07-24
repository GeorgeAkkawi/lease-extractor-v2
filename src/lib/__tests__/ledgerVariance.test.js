// The payment difference the Rent Ledger shows: `billed` (what the LEASE says for the
// year) beside `collected`, and `variance` (how far the deposits landed from the bill
// across the months already paid). A sibling of ledger.test.js so that file's two pinned
// forward-only `projected` cases stay byte-identical.
//
// Why this exists: `projected` is forward-only — a settled month is frozen at the cheque
// that settled it — so a tenant billed $5,025.25/mo who actually deposits $5,324 read a
// plain ✓ and 100% collected, with the difference nowhere on the page. That was right
// when every ✓ came from a click recorded at exactly the owed amount; it stopped being
// right the moment real bank deposits started landing.
import { describe, it, expect } from 'vitest';
import { allocatePayments, ledgerRowSummary } from '../ledger';

const flat = (n) => Array(12).fill(n);
const pay = (amount, opts = {}) => ({ amount, paid_date: opts.paid_date || '2026-01-15', period_month: opts.month ?? null });
// Every month of 2026 has come due from here, so nothing is skipped as "not yet due".
const AFTER = new Date('2027-02-01T12:00:00');
const summarize = (owedByMonth, payments, today = AFTER) => {
  const allocation = allocatePayments({ owedByMonth, payments });
  return { alloc: allocation, ...ledgerRowSummary({ year: 2026, owedByMonth, allocation, today }) };
};

describe('billed — what the lease says, whatever came in', () => {
  it('is the sum of owed and does not move with receipts', () => {
    const owed = flat(5025.25);
    expect(summarize(owed, []).billed).toBe(60303);
    // Twelve deposits at the real (higher) figure: billed is unchanged, projected is not.
    const over = Array.from({ length: 12 }, (_, i) => pay(5324, { month: i + 1 }));
    const s = summarize(owed, over);
    expect(s.billed).toBe(60303);
    expect(s.projected).toBe(63888); // forward-only, frozen at what was received
    expect(s.collected).toBe(63888);
  });

  it('a mid-year lease bills only its own months', () => {
    const owed = [0, 0, 0, 0, 0, 0, 2716, 2716, 2716, 2716, 2716, 2716];
    expect(summarize(owed, []).billed).toBe(16296);
  });
});

describe('variance — the difference across the months already paid', () => {
  it('is negative when the deposits came in under the bill', () => {
    // Five Points' real shape: billed 5,025.25, deposits 5,324 — except one short month.
    const owed = flat(5025.25);
    const s = summarize(owed, [pay(4376, { month: 1 })]);
    expect(s.variance).toBe(-649.25);
  });

  it('is positive when they came in over', () => {
    const s = summarize(flat(5025.25), [pay(5324, { month: 1 }), pay(5324, { month: 2 })]);
    expect(s.variance).toBe(597.5);
  });

  it('is exactly 0 for a month marked at the owed amount — the whole hand-marked ledger', () => {
    const owed = flat(9150);
    const marks = Array.from({ length: 12 }, (_, i) => pay(9150, { month: i + 1 }));
    const s = summarize(owed, marks);
    expect(s.variance).toBe(0);
    expect(s.billed).toBe(s.projected);
  });

  it('an untagged lump can never manufacture a variance — it draws each month\'s exact need', () => {
    expect(summarize(flat(1000), [pay(12000)]).variance).toBe(0);
    expect(summarize(flat(1000), [pay(5500)]).variance).toBe(0); // part-covered months too
  });

  it('an unpaid month is silent here — owesToDate and monthsBehind already report it', () => {
    const s = summarize(flat(1000), []);
    expect(s.variance).toBe(0);
    expect(s.owesToDate).toBe(12000);
    expect(s.monthsBehind).toBe(12);
  });

  it('a not-yet-due month contributes nothing, even when settled', () => {
    // Standing in February 2026, a December payment is recorded but December isn't due.
    const feb = new Date('2026-02-10T12:00:00');
    const s = summarize(flat(1000), [pay(1500, { month: 12 })], feb);
    expect(s.variance).toBe(0);
  });

  it('rounding dust is not a difference — 12¢ across the year reads 0 in the UI threshold', () => {
    const s = summarize(flat(1000), [pay(1000.12, { month: 1 })]);
    expect(s.variance).toBe(0.12);
    expect(Math.abs(s.variance) > 0.5).toBe(false); // below the chip's threshold
  });
});

// George's Infinite Mobile: a lease that starts 2026-07-01, so FY2026 bills nothing
// Jan–Jun — yet its May and June deposits are real money that arrived in May and June.
// His instruction was explicit: bill it as the month chosen on the statement breakdown.
describe('a brand-new tenant\'s pre-lease deposits stay on the months they arrived', () => {
  const owed = [0, 0, 0, 0, 0, 0, 2716, 2716, 2716, 2716, 2716, 2716];
  const deposits = [pay(2716, { month: 5, paid_date: '2026-05-29' }), pay(2716, { month: 6, paid_date: '2026-06-30' })];

  it('May and June read "received, not billed" — July is not quietly settled', () => {
    const { alloc } = summarize(owed, deposits);
    expect(alloc.states[4]).toBe('unbilled');
    expect(alloc.states[5]).toBe('unbilled');
    expect(alloc.received[4]).toBe(2716);
    expect(alloc.states[6]).toBe('open'); // July — untouched
    expect(alloc.credit).toBe(0);
  });

  it('unbilled receipts never inflate the year total', () => {
    const s = summarize(owed, deposits);
    expect(s.billed).toBe(16296);
    expect(s.projected).toBe(16296); // nothing settled a billed month yet
    expect(s.variance).toBe(0);
    expect(s.collected).toBe(5432);  // the money is still counted as collected
  });
});
