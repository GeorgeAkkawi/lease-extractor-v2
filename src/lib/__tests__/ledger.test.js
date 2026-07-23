// The Rent Ledger's money math (ledger.js) — the payment↔month allocation the grid
// paints from, the base | CAM&tax | roof component split, and the row summary. Plus
// the two relationship tests against arStatus: parity when no tags exist, and the
// documented divergence when a tag parks money on a not-yet-due month (WHY the
// allocation — not arStatus — is the single source for everything the page shows).
import { describe, it, expect } from 'vitest';
import { allocatePayments, componentizeSchedule, ledgerRowSummary, owedArray, representativeMonth } from '../ledger';
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

  it("a tagged month settles at the received amount — excess does NOT roll forward (only untagged lumps prepay)", () => {
    const a = allocatePayments({ owedByMonth: flat(1000), payments: [pay(3000, { month: 1 })] });
    expect(a.settled[0]).toBe(true);
    expect(a.received[0]).toBe(3000); // the real dollars received that month
    expect(a.coverage[0]).toBe(1000); // coverage is bill-shaped (= owed) so gap math reads 0
    expect(a.states[0]).toBe('covered');
    expect(a.states.slice(1, 3)).toEqual(['open', 'open']); // no rollover — Feb/Mar stay open
    expect(a.credit).toBe(0); // and the excess is NOT parked as credit either
  });

  it('accepts a buildLeaseSchedule map as owedByMonth', () => {
    const sched = {};
    for (let m = 1; m <= 12; m++) sched[m] = { owed: 500, outsideTerm: false };
    expect(owedArray(sched)).toEqual(flat(500));
  });
});

describe('the "paid = paid" settled-month model', () => {
  it('a tagged SHORT payment still settles its month (covered), and the shortfall never hits the badge', () => {
    // Owed 1,000; the tenant tagged only 700 to March. "Paid = paid": March reads covered,
    // 700 is the received dollars, and March is NOT counted as a month-behind (money came in).
    const a = allocatePayments({ owedByMonth: flat(1000), payments: [pay(700, { month: 3 })] });
    expect(a.settled[2]).toBe(true);
    expect(a.states[2]).toBe('covered');
    expect(a.received[2]).toBe(700);
    expect(a.coverage[2]).toBe(1000); // bill-shaped → gap 0
    const today = new Date(2026, 5, 15, 12); // Jan–Jun due
    const row = ledgerRowSummary({ year: 2026, owedByMonth: flat(1000), allocation: a, today });
    expect(row.owesToDate).toBe(5000); // Jan,Feb,Apr,May,Jun open (March settled → 0)
    // March had money → not "behind"; the five zero-received due months are.
    expect(row.monthsBehind).toBe(5);
  });

  it('the untagged pool skips a settled month entirely', () => {
    // Feb is settled by a tag; a 2,000 lump must fill Jan + Mar (NOT top up Feb).
    const a = allocatePayments({
      owedByMonth: flat(1000),
      payments: [pay(1000, { month: 2 }), pay(2000, { paid_date: '2026-01-02' })],
    });
    expect(a.settled[1]).toBe(true);
    expect(a.poolDraw[1]).toBe(0);
    expect(a.states.slice(0, 3)).toEqual(['covered', 'covered', 'covered']);
    expect(a.states[3]).toBe('open'); // the lump ran out after Jan+Mar
  });

  it('Σ received + credit === totalPaid (the money invariant)', () => {
    const a = allocatePayments({
      owedByMonth: flat(1000),
      payments: [pay(1500, { month: 1 }), pay(3000, { paid_date: '2026-02-01' })],
    });
    const sumReceived = a.received.reduce((s, n) => s + n, 0);
    expect(Math.round((sumReceived + a.credit) * 100) / 100).toBe(a.totalPaid);
    expect(a.totalPaid).toBe(4500);
  });

  it('projected is FORWARD-ONLY: a settled month is frozen at what was received when owed later changes', () => {
    // Jan settled at 1,000. Now the estimate rises so every unsettled month owes 1,200.
    // Jan stays frozen at 1,000; the projected year total moves only on the 11 open months.
    const owed = [1000, ...Array(11).fill(1200)];
    const a = allocatePayments({ owedByMonth: owed, payments: [pay(1000, { month: 1 })] });
    const row = ledgerRowSummary({ year: 2026, owedByMonth: owed, allocation: a, today: new Date(2026, 11, 31, 12) });
    expect(row.projected).toBe(1000 + 1200 * 11); // 14,200 — Jan frozen, not re-priced to 1,200
    expect(row.collected).toBe(1000);
  });

  it('a fully settled year reads exactly 100% even if the tags were short of the current estimate', () => {
    // Every month tagged (settled) at 900 while the current owed is 1,000. Paid = paid →
    // projected freezes to the received 900s, so the rate is 1.0, not 0.9.
    const pays = [];
    for (let m = 1; m <= 12; m++) pays.push(pay(900, { month: m, paid_date: `2026-${String(m).padStart(2, '0')}-05` }));
    const a = allocatePayments({ owedByMonth: flat(1000), payments: pays });
    const row = ledgerRowSummary({ year: 2026, owedByMonth: flat(1000), allocation: a, today: new Date(2026, 11, 31, 12) });
    expect(a.states.every((s) => s === 'covered')).toBe(true);
    expect(row.projected).toBe(10800); // 12 × 900 received
    expect(row.collected).toBe(10800);
    expect(row.rate).toBe(1);
    expect(row.monthsBehind).toBe(0);
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

describe('base builds UP from the lease, never backwards from a stale invoice (George, 2026-07-21)', () => {
  // Infinite Mobile's real shape: base $28,745.04/yr, a mid-year July-1 start (6 owed months),
  // and an $10,855 CAM&tax estimate. Its issued invoice ($18,280.99) is STALE — billed off the
  // old actuals before the estimate was typed. The ledger must build from the lease + estimate
  // (NO invoiceTotal), so the base reads the lease's real $2,395.42/mo, not a residual squeezed
  // to fit the stale invoice (which produced the wrong $2,211.65 George caught).
  const base = 28745.04;
  const estCamTax = 10855;
  const built = buildLeaseSchedule({
    year: 2026, grossBase: base, otherAnnual: estCamTax, abatements: [], escalations: [],
    leaseStart: '2026-07-01', // NO invoiceTotal — projection mode
  });

  it('factor stays 1 and the schedule totals the DATA gross, not the stale invoice', () => {
    expect(built.factor).toBe(1);
    expect(built.owedMonths).toBe(6); // Jul–Dec
    // 6 months × (base/12 + estCamTax/12) = 6 × (2,395.42 + 904.58) = 19,800.02 — NOT 18,280.99.
    expect(Math.round(built.annual * 100) / 100).toBeCloseTo(19800.02, 2);
  });

  it('the base line is the lease constant $2,395.42/mo — never the scaled $2,211.65', () => {
    const comp = componentizeSchedule({ schedule: built.schedule, factor: built.factor, camTaxAnnual: estCamTax, roofAnnual: 0 });
    // Jul–Nov hold at exactly the lease's per-month rent; December carries the year's ≤3¢
    // rounding fold as base-remainder (2,395.44) — still the constant, never the scaled bug.
    for (let m = 7; m <= 11; m++) {
      expect(comp[m].base).toBe(2395.42);
      expect(comp[m].camTax).toBe(904.58);
    }
    expect(comp[12].base).toBeGreaterThanOrEqual(2395.42);
    expect(comp[12].base).toBeLessThanOrEqual(2395.45);
    for (let m = 7; m <= 12; m++) expect(comp[m].base).not.toBe(2211.65); // the old scaled-residual bug
    // A pre-tenancy month owes nothing.
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
    // Only June is genuinely behind (nothing received); May got a $500 partial → it feeds
    // owesToDate but not the "months behind" badge.
    expect(row.monthsBehind).toBe(1);
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

describe('representativeMonth — the identity sub-line reads the CURRENT rent, not a year-average', () => {
  // George, 2026-07-23: Sam Nails' sub-line read "$4,137/mo" (annual ÷ 12, a blend of the
  // pre/post-step months) while the boxes read $4,106.08 then $4,160.20 — a headline that
  // matches no box. The sub-line must track the representative month so it ties the boxes.
  // Sam Nails 2026: Jan–May $4,106.08, Jun–Dec $4,160.20 (an applied June escalation).
  const samNails = [...Array(5).fill(4106.08), ...Array(7).fill(4160.20)];
  const yearAvg = samNails.reduce((a, b) => a + b, 0) / 12; // ≈ 4137.65

  it('picks the current month in the current FY (post-step) — headline ≠ the misleading average', () => {
    const m = representativeMonth({ owedByMonth: samNails, isCurrentFy: true, curMonth: 7 });
    expect(m).toBe(7);
    // The headline the sub-line now shows = that month's box, NOT the year-average.
    expect(samNails[m - 1]).toBe(4160.20);
    expect(Math.round(samNails[m - 1] * 100)).not.toBe(Math.round(yearAvg * 100));
  });

  it('the headline ties its own base·CAM&tax breakdown AND that month\'s box', () => {
    // Build the schedule/comp the page derives from (owed = base + est CAM&tax, no roof).
    const schedule = {};
    for (let i = 0; i < 12; i++) schedule[i + 1] = { owed: samNails[i] };
    // Sam Nails est CAM & tax = $16,800/yr → $1,400/mo; base steps underneath it.
    const comp = componentizeSchedule({ schedule, camTaxAnnual: 16800 });
    const repM = representativeMonth({ owedByMonth: samNails, schedule, isCurrentFy: true, curMonth: 7 });
    const rep = comp[repM];
    // base + camTax + roof === owed === the box (componentizeSchedule's binding invariant).
    expect(rep.base + rep.camTax + rep.roof).toBeCloseTo(samNails[repM - 1], 2);
    expect(rep.camTax).toBe(1400);
    expect(rep.base).toBe(2760.20); // $33,122.40 ÷ 12 — the post-step base
  });

  it('shows the current rent BEFORE a mid-year step too (current month pre-step)', () => {
    const m = representativeMonth({ owedByMonth: samNails, isCurrentFy: true, curMonth: 3 });
    expect(m).toBe(3);
    expect(samNails[m - 1]).toBe(4106.08); // the pre-step rate they pay right now
  });

  it('a non-current FY reads the first billed month (its starting rate)', () => {
    expect(representativeMonth({ owedByMonth: samNails, isCurrentFy: false, curMonth: 7 })).toBe(1);
  });

  it('skips out-of-term months on a mid-year lease (first billed month, not a $0 box)', () => {
    // Jul-start tenant: Jan–Jun out of term (owed 0), Jul–Dec billed.
    const owed = [0, 0, 0, 0, 0, 0, ...Array(6).fill(3300)];
    // Current month (June) is out of term → falls through to the first billed month (July).
    expect(representativeMonth({ owedByMonth: owed, isCurrentFy: true, curMonth: 6 })).toBe(7);
    // Once in term, the current month wins.
    expect(representativeMonth({ owedByMonth: owed, isCurrentFy: true, curMonth: 9 })).toBe(9);
  });

  it('skips an abated current month, and returns 0 when nothing is billed', () => {
    const owed = flat(2000);
    const schedule = { 7: { owed: 2000, abated: true } };
    // July is abated → first non-abated billed month.
    expect(representativeMonth({ owedByMonth: owed, schedule, isCurrentFy: true, curMonth: 7 })).toBe(1);
    // Fully unbilled (vacant / all-abated) → 0, so the caller falls back to its own monthly.
    expect(representativeMonth({ owedByMonth: flat(0), isCurrentFy: true, curMonth: 7 })).toBe(0);
    expect(representativeMonth({})).toBe(0);
  });
});
