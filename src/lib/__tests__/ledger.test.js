// The Rent Ledger's money math (ledger.js) — the payment↔month allocation the grid
// paints from, the base | CAM&tax | roof component split, and the row summary. Plus
// the two relationship tests against arStatus: parity when no tags exist, and the
// documented divergence when a tag parks money on a not-yet-due month (WHY the
// allocation — not arStatus — is the single source for everything the page shows).
import { describe, it, expect } from 'vitest';
import { allocatePayments, componentizeSchedule, ledgerRowSummary, owedArray } from '../ledger';
import { buildLeaseSchedule } from '../leaseSchedule';
import { monthsBehindForInvoice } from '../arStatus';

const flat = (n) => Array(12).fill(n);
const pay = (amount, opts = {}) => ({ amount, paid_date: opts.paid_date || '2026-01-15', period_month: opts.month ?? null });

describe('allocatePayments', () => {
  it('an untagged lump that runs out mid-June reads Jan–May covered, Jun partial, Jul–Dec open', () => {
    const a = allocatePayments({ owedByMonth: flat(1000), payments: [pay(5500)] });
    expect(a.states.slice(0, 5)).toEqual(['covered', 'covered', 'covered', 'covered', 'covered']);
    expect(a.states[5]).toBe('partial');
    expect(a.coverage[5]).toBe(500);
    expect(a.states.slice(6)).toEqual(['open', 'open', 'open', 'open', 'open', 'open']);
    expect(a.credit).toBe(0);
    expect(a.totalPaid).toBe(5500);
  });

  it('a tagged payment covers ITS month, not the earliest open one', () => {
    const a = allocatePayments({ owedByMonth: flat(1000), payments: [pay(1000, { month: 3 })] });
    expect(a.states[2]).toBe('covered');
    expect(a.states[0]).toBe('open');
    expect(a.states[1]).toBe('open');
  });

  it('two payments tagged the SAME month sum (check + Zelle in one month)', () => {
    const a = allocatePayments({
      owedByMonth: flat(1000),
      payments: [pay(400, { month: 2 }), pay(600, { month: 2, paid_date: '2026-02-20' })],
    });
    expect(a.tagged[1]).toBe(1000);
    expect(a.states[1]).toBe('covered');
  });

  it('tagged and untagged mix: the pool fills around the tagged months', () => {
    // March tagged; a 2,000 lump covers Jan + Feb (the earliest residual need).
    const a = allocatePayments({
      owedByMonth: flat(1000),
      payments: [pay(1000, { month: 3 }), pay(2000, { paid_date: '2026-01-02' })],
    });
    expect(a.states.slice(0, 3)).toEqual(['covered', 'covered', 'covered']);
    expect(a.states[3]).toBe('open');
  });

  it('overpayment past month 12 becomes credit (owed to the tenant)', () => {
    const a = allocatePayments({ owedByMonth: flat(1000), payments: [pay(13000)] });
    expect(a.states.every((s) => s === 'covered')).toBe(true);
    expect(a.credit).toBe(1000);
  });

  it("a tag on a month that owes nothing can't invent a charge — the money pools instead", () => {
    const owed = [0, 0, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]; // Jan–Feb pre-tenancy
    const a = allocatePayments({ owedByMonth: owed, payments: [pay(1000, { month: 1 })] });
    expect(a.coverage[0]).toBe(0);
    expect(a.states[0]).toBe(null);
    expect(a.states[2]).toBe('covered'); // the pooled money lands on the first real month
  });

  it("a tagged month's excess rolls forward to the next open charges (prepayment), only then credit", () => {
    const a = allocatePayments({ owedByMonth: flat(1000), payments: [pay(3000, { month: 1 })] });
    expect(a.coverage[0]).toBe(1000); // never above the month's owed
    expect(a.states.slice(0, 3)).toEqual(['covered', 'covered', 'covered']);
    expect(a.credit).toBe(0);
  });

  it('accepts a buildLeaseSchedule map as owedByMonth', () => {
    const sched = {};
    for (let m = 1; m <= 12; m++) sched[m] = { owed: 500, outsideTerm: false };
    expect(owedArray(sched)).toEqual(flat(500));
  });
});

describe('componentizeSchedule', () => {
  // Real end-to-end shape: $98,500 gross base (the classic penny case — 8,208.33/mo
  // rounds 4¢ short across the year), $12,000 CAM&tax, December fully free. The
  // abatement fold lands the year's rounding cents on DECEMBER — the free month —
  // whose owed stays > 0 because CAM/taxes never abate.
  const built = buildLeaseSchedule({
    year: 2026,
    grossBase: 98500,
    otherAnnual: 12000,
    abatements: [{ kind: 'free', start_date: '2026-12-01', end_date: '2026-12-31' }],
    escalations: [],
    leaseStart: '2020-01-01',
    invoiceTotal: null,
  });

  it('components sum EXACTLY to owed for every month — including the free December carrying fold-cents', () => {
    const comp = componentizeSchedule({ schedule: built.schedule, factor: built.factor, camTaxAnnual: 12000, roofAnnual: 0 });
    for (let m = 1; m <= 12; m++) {
      const c = comp[m];
      const owed = built.schedule[m].owed;
      expect(Math.round((c.base + c.camTax + c.roof) * 100)).toBe(Math.round(owed * 100));
    }
    // December really did catch the fold (owed ≠ a clean 1,000.00)
    expect(built.schedule[12].abated).toBe(true);
    expect(built.schedule[12].owed).not.toBe(1000);
  });

  it('a free month forces base $0 — CAM&tax absorbs the whole owed, fold-cents included', () => {
    const comp = componentizeSchedule({ schedule: built.schedule, factor: built.factor, camTaxAnnual: 12000, roofAnnual: 0 });
    expect(comp[12].base).toBe(0);
    expect(comp[12].camTax).toBe(built.schedule[12].owed);
  });

  it('a normal month reads base-as-remainder', () => {
    const comp = componentizeSchedule({ schedule: built.schedule, factor: built.factor, camTaxAnnual: 12000, roofAnnual: 0 });
    expect(comp[3].camTax).toBe(1000);
    expect(comp[3].base).toBe(built.schedule[3].owed - 1000);
  });

  it('CAM&tax + roof are capped so base never goes negative', () => {
    const sched = { 1: { owed: 800, outsideTerm: false } };
    for (let m = 2; m <= 12; m++) sched[m] = { owed: 0, outsideTerm: true };
    const comp = componentizeSchedule({ schedule: sched, factor: 1, camTaxAnnual: 9600, roofAnnual: 2400 }); // 800 + 200 monthly > 800 owed
    expect(comp[1].roof).toBe(200);
    expect(comp[1].camTax).toBe(600); // trimmed to fit
    expect(comp[1].base).toBe(0);
    expect(comp[1].base + comp[1].camTax + comp[1].roof).toBe(800);
  });

  it('outside-term months are all zeros', () => {
    const sched = { 1: { owed: 0, outsideTerm: true }, 2: { owed: 1000, outsideTerm: false } };
    for (let m = 3; m <= 12; m++) sched[m] = { owed: 1000, outsideTerm: false };
    const comp = componentizeSchedule({ schedule: sched, factor: 1, camTaxAnnual: 1200 });
    expect(comp[1]).toEqual({ base: 0, camTax: 0, roof: 0 });
  });
});

describe('ledgerRowSummary vs arStatus — the single-derivation rule', () => {
  const today = new Date(2026, 5, 15, 12); // June 15 → Jan–Jun due
  const invRow = { year: 2026, kind: 'annual', total_amount: 12000, balance: null, due_date: null };

  it('PARITY: with no month tags the two agree on the dollars behind', () => {
    const owed = flat(1000);
    const payments = [pay(4500)];
    const alloc = allocatePayments({ owedByMonth: owed, payments });
    const row = ledgerRowSummary({ year: 2026, owedByMonth: owed, allocation: alloc, today });
    const ar = monthsBehindForInvoice(
      { ...invRow, amount_paid: 4500, balance: 7500 },
      { owedByMonth: owed },
      today
    );
    expect(row.owesToDate).toBe(ar.amountBehind); // 1,500 both ways
    expect(row.owesToDate).toBe(1500);
    expect(row.monthsBehind).toBe(2); // May partial + June open
    expect(row.collected).toBe(4500);
  });

  it('DIVERGENCE: a December tag while March sits open — the allocation is the single source', () => {
    // The tenant explicitly tagged a payment to December (not yet due). The grid must
    // honor the tag (December covered, spring open). arStatus's paid-scalar FIFO would
    // spend that same money on the earliest months — naming different months AND
    // different dollars. Every figure the page shows therefore derives from the
    // allocation; arStatus is only the legacy no-schedule fallback.
    const owed = flat(1000);
    const payments = [pay(1000, { month: 12 })];
    const alloc = allocatePayments({ owedByMonth: owed, payments });
    expect(alloc.states[11]).toBe('covered');
    const row = ledgerRowSummary({ year: 2026, owedByMonth: owed, allocation: alloc, today });
    const ar = monthsBehindForInvoice(
      { ...invRow, amount_paid: 1000, balance: 11000 },
      { owedByMonth: owed },
      today
    );
    expect(row.owesToDate).toBe(6000); // all six due months uncovered
    expect(ar.amountBehind).toBe(5000); // FIFO silently spent the tag on January
    expect(row.owesToDate).not.toBe(ar.amountBehind);
  });

  it('credit + settled flags: an overpaid year reads settled=false with the credit shown', () => {
    const owed = flat(1000);
    const alloc = allocatePayments({ owedByMonth: owed, payments: [pay(12500)] });
    const row = ledgerRowSummary({ year: 2026, owedByMonth: owed, allocation: alloc, today });
    expect(row.owesToDate).toBe(0);
    expect(row.credit).toBe(500);
    expect(row.settled).toBe(false);
  });

  it('a fully-paid-to-date tenant is settled', () => {
    const owed = flat(1000);
    const alloc = allocatePayments({ owedByMonth: owed, payments: [pay(12000)] });
    const row = ledgerRowSummary({ year: 2026, owedByMonth: owed, allocation: alloc, today });
    expect(row.owesToDate).toBe(0);
    expect(row.credit).toBe(0);
    expect(row.settled).toBe(true);
  });
});
