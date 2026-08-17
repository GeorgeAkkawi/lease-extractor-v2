// Slice 4 — the year-end position, and the four ways to settle it.
//
// George, 2026-08-16: *"How do we convey credits or debits at the end of the year? when those
// debits are conveyed how do we dismiss them/reconcile them."*
//
// ⚠ THE THREE THINGS THAT BITE, and they are what most of this file pins:
//   1. The per-month cap stays. A credit larger than a month's bill makes `owed` negative,
//      which reads as "unbilled" everywhere downstream and drops the excess out of the year.
//      A settlement SPREADS instead — and if the months cannot absorb it, it is REFUSED with
//      a figure, never placed halfway and reported as done.
//   2. Carry-forward is two rows in two years. Writing only the one that charges next January
//      leaves the tenant billed twice; writing only the one that clears this year loses the
//      money outright.
//   3. A refund lands on the month that HOLDS the credit, not on December by default —
//      otherwise it opens a false gap on a month the tenant never owed anything for.
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import {
  tenantStanding, propertyStandings, spreadAcrossMonths, monthCapacity,
  refundMonth, settleChoicesFor, settleSentence, isBroughtForward, isSettlementRow, settledAs,
} from '../settle';
import {
  settleTenantBalance, undoSettlement, getPropertyMonthlyRoll, listAdjustments, addAdjustment,
  closeYear, reopenYear, ensureInvoice, recordPayment,
} from '../api';
import { allocatePayments, componentizeSchedule } from '../ledger';
import { currentYear } from '../format';

const saved = [];
vi.mock('../download', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, saveWorkbook: (buf, filename) => { saved.push({ buf, filename }); return 'blob:test'; } };
});
const { buildIncomeExpense } = await import('../incomeExpense');
const { downloadIncomeExpenseXlsx } = await import('../incomeExpenseExcel');

const Y = currentYear();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const sched = (owedPerMonth) => Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [i + 1, { full: owedPerMonth, owed: owedPerMonth, abated: 0, credit: 0, kind: 'full', outsideTerm: false }])
);
// Mid-August, so months 1–8 have come due and 9–12 have not.
const AUG = new Date(`${Y}-08-16T12:00:00`);

describe('where a tenant stands', () => {
  // ⚠ TWO FIGURES, TWO QUESTIONS. `closing` is the receivable and counts every month that has
  // fallen DUE (rent falls on the 1st, so August counts on 16 August). `owes` is what can be
  // ACTED on and waits for the month to END — because the bank statement that would settle
  // August does not exist yet. Collapsing them is what put "owes $X · Settle up…" on every
  // tenant on the 1st of every month (George: "why does it say every tenant owes something?").
  it('separates the receivable from what can be acted on', () => {
    const row = { lease_id: 'l1', tenant_name: 'T', schedule: sched(1000), payments: [] };
    const s = tenantStanding({ row, year: Y, today: AUG });
    expect(s.billed).toBe(12000);       // the whole year is billed…
    expect(s.received).toBe(0);
    expect(s.closing).toBe(8000);       // …Jan–Aug has fallen due…
    expect(s.owes).toBe(7000);          // …and only Jan–Jul has ENDED
    expect(s.provisional).toBe(1000);   // August, stated rather than hidden
    expect(s.judgedThrough).toBe(7);
    expect(s.inCredit).toBe(0);
    // The receivable still exists, so a year-end statement must report it.
    expect(s.openBalance).toBe(true);
  });

  // The case that made George ask. Nothing is wrong with this tenant.
  it('shows NOTHING to act on for a tenant whose only gap is the month still running', () => {
    const paid = Array.from({ length: 7 }, (_, i) => ({
      id: `p${i}`, amount: 1000, period_month: i + 1, paid_date: `${Y}-${String(i + 1).padStart(2, '0')}-03`,
    }));
    const row = { lease_id: 'l1', tenant_name: 'T', schedule: sched(1000), payments: paid };
    const s = tenantStanding({ row, year: Y, today: AUG });
    expect(s.owes).toBe(0);
    expect(s.settled).toBe(true);          // → no balance chip, no Settle up
    expect(s.provisional).toBe(1000);      // August is genuinely owed…
    expect(s.closing).toBe(1000);          // …and still on the receivable
    expect(s.openBalance).toBe(true);      // → the workbook and close-year still report it
  });

  // ⚠ A PAST YEAR HAS NO RUNNING MONTH, so the two figures coincide — which is when a
  // settlement normally happens, and why the split costs nothing at year end.
  it('reads the same both ways once the year is over', () => {
    const row = { lease_id: 'l1', tenant_name: 'T', schedule: sched(1000), payments: [] };
    const s = tenantStanding({ row, year: Y - 1, today: AUG });
    expect(s.closing).toBe(12000);
    expect(s.owes).toBe(12000);
    expect(s.provisional).toBe(0);
    expect(s.judgedThrough).toBe(12);
  });

  // ⚠ CREDIT DOES NOT WAIT. Money you are already holding is not an accusation — refunding it
  // needs no month to close. Only the owing side asserts something about someone else.
  it('does not make a credit wait for a month to end', () => {
    const row = {
      lease_id: 'l1', tenant_name: 'T', schedule: sched(1000),
      payments: [{ id: 'lump', amount: 13000, paid_date: `${Y}-08-03` }],
    };
    const s = tenantStanding({ row, year: Y, today: AUG });
    expect(s.inCredit).toBe(1000);
    expect(s.settled).toBe(false);
    expect(settleChoicesFor(s).find((c) => c.key === 'refund').ok).toBe(true);
  });

  it('reads an overpayment as credit, not as a negative debt by another name', () => {
    const row = {
      lease_id: 'l1', tenant_name: 'T', schedule: sched(1000),
      payments: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, amount: 1000, period_month: i + 1, paid_date: `${Y}-${String(i + 1).padStart(2, '0')}-03` }))
        .concat([{ id: 'extra', amount: 600, paid_date: `${Y}-06-03` }]),
    };
    const s = tenantStanding({ row, year: Y, today: AUG });
    expect(s.owes).toBe(0);
    expect(s.inCredit).toBe(600);
    expect(s.closing).toBe(-600);
  });

  // The pool fills every month's need before any of it survives as credit, so the two can
  // never both be non-zero. If that ever changes, `closing` stops being a single number.
  it('never reports arrears and credit at the same time', async () => {
    const roll = await getPropertyMonthlyRoll('prop-1', Y);
    const { rows } = propertyStandings({ roll, year: Y });
    expect(rows.length).toBeGreaterThan(0);
    for (const s of rows) expect(s.owes > 0 && s.inCredit > 0).toBe(false);
  });

  it('offers only the choices that apply, and says why the others do not', () => {
    const owing = settleChoicesFor({ owes: 4150, inCredit: 0 });
    expect(owing.find((c) => c.key === 'writeoff').ok).toBe(true);
    expect(owing.find((c) => c.key === 'refund').ok).toBe(false);
    expect(owing.find((c) => c.key === 'refund').why).toMatch(/no credit to refund/);
    const ahead = settleChoicesFor({ owes: 0, inCredit: 600 });
    expect(ahead.find((c) => c.key === 'refund').ok).toBe(true);
    expect(ahead.find((c) => c.key === 'writeoff').ok).toBe(false);
    // Only ONE of the four moves the year's income, and the dialog reads it off the registry
    // rather than deciding again.
    expect(owing.filter((c) => c.movesIncome).map((c) => c.key)).toEqual(['writeoff']);
  });
});

describe('the spread — the per-month cap, restated as capacity', () => {
  it('fills earliest first and never exceeds a month’s own outstanding', () => {
    const alloc = allocatePayments({ owedByMonth: sched(1000), payments: [{ id: 'p', amount: 1000, period_month: 1, paid_date: `${Y}-01-03` }] });
    const cap = monthCapacity({ alloc, direction: 'credit', basis: 'ended', year: Y, today: AUG });
    expect(cap[0]).toBe(0);                        // January is paid — nothing to forgive
    expect(cap[1]).toBe(1000);
    expect(cap[7]).toBe(0);                        // August has not ENDED
    expect(cap[8]).toBe(0);                        // September has not come due
    const out = spreadAcrossMonths({ capacity: cap, amount: 2500 });
    expect(out.rows).toEqual([{ month: 2, amount: 1000 }, { month: 3, amount: 1000 }, { month: 4, amount: 500 }]);
    expect(out.placed).toBe(2500);
    expect(out.shortfall).toBe(0);
  });

  // ⚠ RETURNED, NEVER SWALLOWED. The alternative is a landlord clicking "write it off",
  // watching the balance move partway, and being told nothing about the rest.
  it('reports a shortfall rather than placing what it can and calling it done', () => {
    const alloc = allocatePayments({ owedByMonth: sched(1000), payments: [] });
    const feb = new Date(`${Y}-03-02T12:00:00`);   // only Jan and Feb have ended
    const out = spreadAcrossMonths({
      capacity: monthCapacity({ alloc, direction: 'credit', basis: 'ended', year: Y, today: feb }), amount: 5000,
    });
    expect(out.placed).toBe(2000);
    expect(out.shortfall).toBe(3000);
  });

  it('leaves a charge uncapped — a charge only ever increases what a month owes', () => {
    const cap = monthCapacity({
      alloc: { owed: Array(12).fill(0), coverage: Array(12).fill(0) }, direction: 'charge', year: Y, today: AUG,
    });
    expect(spreadAcrossMonths({ capacity: cap, amount: 9999 }).rows).toEqual([{ month: 1, amount: 9999 }]);
  });

  // ⚠ THE OTHER QUESTION, not a loosening. A credit carried into next year lands on months
  // that have not happened — which is the entire point of carrying it.
  it('lets a credit land on future months when the basis is what was billed', () => {
    const alloc = allocatePayments({ owedByMonth: sched(1000), payments: [] });
    const ended = monthCapacity({ alloc, direction: 'credit', basis: 'ended', year: Y, today: AUG });
    const billed = monthCapacity({ alloc, direction: 'credit', basis: 'billed' });
    expect(ended[11]).toBe(0);      // December has not ended
    expect(billed[11]).toBe(1000);  // …but it is billed, so a carried credit can sit there
  });

  it('puts a refund on the month that HOLDS the money, not on December', () => {
    const alloc = allocatePayments({
      owedByMonth: sched(1000),
      payments: [{ id: 'a', amount: 1000, period_month: 1, paid_date: `${Y}-01-03` }, { id: 'b', amount: 1000, period_month: 3, paid_date: `${Y}-03-03` }],
    });
    expect(refundMonth(alloc)).toBe(3);
    // Nothing received anywhere → December, the year's own end.
    expect(refundMonth(allocatePayments({ owedByMonth: sched(1000), payments: [] }))).toBe(12);
  });
});

describe('settleTenantBalance — against the real write path', () => {
  // ⚠ prop-2 THROUGHOUT, and that is not arbitrary. The demo seeds prop-1's CURRENT fiscal
  // year as closed (`snap-2`, store.js) — which is itself worth knowing — so every write
  // against it is refused by the same guard this file tests separately. prop-2 carries no
  // snapshot, so the refusals it does produce are the ones being asserted.
  //   lease-3 Northwind Books — owes $102,000 · lease-4 Sunrise Yoga — owes $7,944.44
  //   (a July start, so a genuine part-year term)

  it('writes off across the unpaid months and stops the balance showing', async () => {
    const id = 'lease-4';
    const before = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === id);
    const start = tenantStanding({ row: before, year: Y });
    expect(start.owes).toBeGreaterThan(0);

    const res = await settleTenantBalance({ leaseId: id, propertyId: 'prop-2', year: Y, choice: 'writeoff' });
    expect(res.refused).toBeFalsy();
    expect(res.amount).toBe(start.owes);
    expect(res.months.length).toBeGreaterThan(0);

    const written = (await listAdjustments({ leaseId: id, year: Y })).filter((a) => a.kind === 'writeoff');
    expect(round2(written.reduce((s, a) => s + Number(a.amount), 0))).toBe(round2(-start.owes));
    // ⚠ EVERY MONTH STAYS NON-NEGATIVE. A credit past the month's own bill is the failure
    // this whole design exists to avoid — it reads as "unbilled" everywhere downstream.
    const after = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === id);
    for (let m = 1; m <= 12; m++) expect(Number(after.schedule[m].owed)).toBeGreaterThanOrEqual(-0.005);
    expect(tenantStanding({ row: after, year: Y }).owes).toBeLessThanOrEqual(0.005);
    // And the invariant the whole Ledger rests on still holds afterwards.
    const comp = componentizeSchedule({
      schedule: after.schedule, factor: after.factor, camTaxAnnual: after.camTaxAnnual,
      roofAnnual: after.roofAnnual, camTaxByMonth: after.camTaxByMonth, roofByMonth: after.roofByMonth,
      adjustments: after.adjustments,
    });
    for (let m = 1; m <= 12; m++) {
      const c = comp[m];
      expect(round2(c.base + c.camTax + c.roof + c.adj)).toBeCloseTo(round2(Number(after.schedule[m].owed)), 2);
    }
  });

  it('refuses a second settlement on a balance that is already square', async () => {
    const res = await settleTenantBalance({ leaseId: 'lease-4', propertyId: 'prop-2', year: Y, choice: 'writeoff' });
    expect(res.refused).toBe(true);
    expect(res.reason).toBe('settled');
    expect(res.message).toMatch(/nothing to settle/);
  });

  // ⚠ ORDER MATTERS HERE: lease-3 still owes at this point in the file, which is the whole
  // point of the assertion. Moved above the carry-forward test, which clears it.
  it('refuses a refund when the tenant owes money rather than the other way round', async () => {
    const res = await settleTenantBalance({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, choice: 'refund' });
    expect(res.refused).toBe(true);
    expect(res.reason).toBe('not_applicable');
    expect(res.message).toMatch(/no credit to refund/);
  });

  // ⚠ TWO ROWS IN TWO YEARS. One alone either loses the money or bills it twice.
  it('carries a balance forward into next January AND clears the year it came from', async () => {
    const id = 'lease-3';
    const before = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === id);
    const start = tenantStanding({ row: before, year: Y });
    expect(start.owes).toBeGreaterThan(0);

    const res = await settleTenantBalance({ leaseId: id, propertyId: 'prop-2', year: Y, choice: 'carry' });
    expect(res.refused).toBeFalsy();
    expect(res.carriedTo).toBe(Y + 1);

    const thisYear = (await listAdjustments({ leaseId: id, year: Y })).filter((a) => a.kind === 'opening');
    const nextYear = (await listAdjustments({ leaseId: id, year: Y + 1 })).filter((a) => a.kind === 'opening');
    expect(round2(thisYear.reduce((s, a) => s + Number(a.amount), 0))).toBe(round2(-start.owes));
    expect(nextYear).toHaveLength(1);
    expect(Number(nextYear[0].amount)).toBe(round2(start.owes));
    expect(Number(nextYear[0].month)).toBe(1);
    // This year is cleared…
    const after = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === id);
    expect(tenantStanding({ row: after, year: Y }).owes).toBeLessThanOrEqual(0.005);
    // …and next January carries it. The pair is `pnlRow: null` on both sides, so the revenue
    // stays in the year that billed it and only the receivable moves.
    const next = (await getPropertyMonthlyRoll('prop-2', Y + 1)).find((r) => r.lease_id === id);
    expect(round2(Number(next.schedule[1].owed) - Number(next.schedule[2].owed))).toBeCloseTo(round2(start.owes), 2);
  });

  it('records a refund on the month holding the credit, and settles it exactly', async () => {
    const id = 'lease-4';
    const row = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === id);
    // Overpay the whole year with ONE untagged payment: an untagged lump pools, fills each
    // month's remaining need from January, and whatever is left over IS the credit. (A tagged
    // payment settles its own month at whatever arrived with no rollover, so it can never
    // produce one — which is exactly why the refund case needs the pool.)
    const annual = round2(Object.values(row.schedule).reduce((s, c) => s + (Number(c.owed) || 0), 0));
    const inv = await ensureInvoice(id, 'prop-2', Y);
    await recordPayment({
      invoice_id: inv.id, lease_id: id, amount: round2(annual + 500),
      paid_date: `${Y}-07-05`, method: 'other', source: 'manual',
    });
    const withCredit = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === id);
    const standing = tenantStanding({ row: withCredit, year: Y });
    expect(standing.inCredit).toBe(500);

    const res = await settleTenantBalance({ leaseId: id, propertyId: 'prop-2', year: Y, choice: 'refund' });
    expect(res.refused).toBeFalsy();
    const refunds = (await listAdjustments({ leaseId: id, year: Y })).filter((a) => a.kind === 'refund');
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].amount)).toBe(500);
    // ⚠ ON THE MONTH THAT HOLDS THE MONEY. July is the last month that received any, so the
    // pool settles the refund charge there and the credit goes to zero — rather than opening
    // a false gap on a December the tenant never owed anything for.
    expect(Number(refunds[0].month)).toBe(refundMonth(standing.alloc));
    const after = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === id);
    const settled = tenantStanding({ row: after, year: Y });
    expect(settled.inCredit).toBeLessThanOrEqual(0.005);
    expect(settled.owes).toBeLessThanOrEqual(0.005);
  });

  // ⚠ A CLOSED YEAR IS A BILL ALREADY SENT. Settling under a snapshot leaves the snapshot and
  // the live figures disagreeing, which is the whole reason `yearLockState` exists.
  it('refuses a closed year, and says how to proceed', async () => {
    await closeYear('prop-2', Y);
    try {
      const res = await settleTenantBalance({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, choice: 'writeoff' });
      expect(res.refused).toBe(true);
      expect(res.reason).toBe('closed');
      expect(res.message).toMatch(/Reopen it first/);
      // The same refusal the ordinary adjustment path makes — one rule, two doors.
      const adj = await addAdjustment({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, month: 3, kind: 'fee', amount: 50 });
      expect(adj.refused).toBe(true);
      expect(adj.reason).toBe('closed');
    } finally {
      await reopenYear('prop-2', Y);
    }
  });

  // ⚠ AND A CARRY-FORWARD CHECKS *NEXT* YEAR TOO. The balance has nowhere to land in a year
  // already frozen, and discovering that after this year was cleared would lose the money.
  it('refuses to carry into a year that is already closed', async () => {
    await closeYear('prop-2', Y + 1);
    try {
      const res = await settleTenantBalance({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, choice: 'carry' });
      expect(res.refused).toBe(true);
      expect(res.reason).toMatch(/next_closed|settled/);
    } finally {
      await reopenYear('prop-2', Y + 1);
    }
  });

  it('leaves it open without writing anything', async () => {
    const res = await settleTenantBalance({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y + 1, choice: 'leave' });
    expect(res.refused).toBeFalsy();
    expect(res.wrote).toEqual([]);
    expect(settleSentence({ choice: 'leave' })).toBe('left open');
  });
});

// ⚠ RUNS LAST, over the store the tests above have already settled into: Sunrise Yoga written
// off, Northwind Books carried into next January. Without that ordering the demo seed carries
// no settlement at all and every assertion here would pass over an empty case.
describe('what the workbook says once balances have been settled', () => {
  it('bills the carried balance and then takes it back out before Total earned', async () => {
    const pkg = await buildIncomeExpense('corp-2', Y);
    const oak = pkg.properties.find((p) => p.name === 'Oak Center');
    // Money in still equals the Ledger month for month — the whole promise of the sheet, and
    // the thing a null-pnlRow kind would have broken silently.
    expect(round2(oak.rent + oak.camTaxBilled + oak.roofBilled + oak.charges + oak.carried + oak.otherIncome))
      .toBeCloseTo(oak.billedTotal, 2);
    // …and Total earned excludes it, because a write-off IS this year's loss while a balance
    // brought forward is another year's income.
    expect(oak.earned).toBeCloseTo(round2(oak.billedTotal + oak.trueUp - oak.carried), 2);
    expect(oak.net).toBeCloseTo(round2(oak.earned - oak.expenseTotals.spent), 2);
    // The write-off went to `charges` (it reduces revenue) and the carry-forward to `carried`
    // (it does not). Getting that pair the wrong way round is the whole accounting judgement.
    expect(oak.chargeRows.some((r) => r.key === 'writeoff')).toBe(true);
    expect(oak.carriedRows.some((r) => r.key === 'opening')).toBe(true);
    expect(oak.chargeRows.some((r) => r.key === 'opening')).toBe(false);
  });

  it('prints Where each tenant stands, and it opens', async () => {
    saved.length = 0;
    await downloadIncomeExpenseXlsx({ corporationId: 'corp-2', corporationName: 'Northwind', year: Y });
    const zip = await JSZip.loadAsync(saved[0].buf);
    const strings = await zip.file('xl/sharedStrings.xml').async('string');
    for (const phrase of [
      'Where each tenant stands',
      'Closing balance',
      'Brought forward and refunds',
      'Less brought forward and refunds',
      'A positive closing balance is money the tenant still owes',
      // ⚠ THE ACCRUAL-TO-CASH BRIDGE, and the reason "leave it open" was invisible: the three
      // settlements are deliberately different, and the one that moves NOTHING left the sheet
      // printing "Total earned" with no hint that a slice of it never arrived.
      'of which still uncollected at year end',
      // ⚠ AND WHAT WAS DECIDED. A closing balance of zero cannot tell a collected year from a
      // forgiven one — opposite facts, identical figure.
      'Settled as',
      'what was decided about it: written off',
    ]) expect(strings, `the sheet must say "${phrase}"`).toContain(phrase);
    for (const n of Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))) {
      const xml = await zip.file(n).async('string');
      expect(new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror')).toBeNull();
      expect(/state="frozen"/.test(xml)).toBe(false);
    }
  }, 30000);
});

// ── The logical path between the two years, and the way back ───────────────────────────
//
// George, 2026-08-16: *"if an over or undercharge is rolled through to a following year or
// month how does that show is there a logical path for that stuff?"*
//
// The carry worked from the day it shipped and nothing joined its halves: `settleTenantBalance`
// passed no memo, so next January carried a large anonymous adjustment and the money simply
// appeared. And the only way back was deleting rows one at a time from the month panel — which
// for a carry means finding rows in TWO years and knowing that you have to. Miss the second and
// the tenant is cleared in one year and charged in the other, and each screen reads as correct.
//
// ⚠ THESE RUN LAST ON PURPOSE. The undo takes lease-3's carry-forward back apart, which the
// workbook assertions above depend on existing.
describe('a settlement names its other end, and can be taken back whole', () => {
  it('writes a memo on every row saying which year the money went to or came from', async () => {
    const here = (await listAdjustments({ leaseId: 'lease-3', year: Y })).filter((a) => a.kind === 'opening');
    const there = (await listAdjustments({ leaseId: 'lease-3', year: Y + 1 })).filter((a) => a.kind === 'opening');
    expect(here.length).toBeGreaterThan(0);
    expect(there).toHaveLength(1);
    for (const a of here) expect(a.memo).toBe(`Carried forward to FY ${Y + 1}`);
    expect(there[0].memo).toBe(`Brought forward from FY ${Y}`);

    // ⚠ THE MEMO IS THE ONLY THING TELLING THE TWO APART. Both rows are `kind: 'opening'`, and
    // their signs flip with the direction of the balance — so a chip that read the kind, or the
    // sign, would call the year that PAID the balance the year that RECEIVED it.
    expect(here.every((a) => !isBroughtForward(a))).toBe(true);
    expect(isBroughtForward(there[0])).toBe(true);
    expect(here.every(isSettlementRow) && isSettlementRow(there[0])).toBe(true);
  });

  it('undoes both years in one action, and the balance comes back', async () => {
    const carried = Number(
      (await listAdjustments({ leaseId: 'lease-3', year: Y + 1 })).find((a) => a.kind === 'opening').amount
    );
    expect(carried).toBeGreaterThan(0);

    const res = await undoSettlement({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y });
    expect(res.refused).toBeFalsy();
    expect(res.years).toEqual([Y, Y + 1]);
    expect(res.removed).toBeGreaterThan(1);

    expect((await listAdjustments({ leaseId: 'lease-3', year: Y })).filter((a) => a.kind === 'opening')).toHaveLength(0);
    expect((await listAdjustments({ leaseId: 'lease-3', year: Y + 1 })).filter((a) => a.kind === 'opening')).toHaveLength(0);

    // The balance is back — the same figure that was carried, which is the point of an undo
    // rather than a partial reversal that leaves the tenant somewhere in between.
    const after = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === 'lease-3');
    expect(tenantStanding({ row: after, year: Y }).owes).toBeCloseTo(carried, 2);
    // …and next January no longer charges it.
    const next = (await getPropertyMonthlyRoll('prop-2', Y + 1)).find((r) => r.lease_id === 'lease-3');
    expect(round2(Number(next.schedule[1].owed) - Number(next.schedule[2].owed))).toBeCloseTo(0, 2);
  });

  it('says so rather than pretending, when there is nothing left to undo', async () => {
    const again = await undoSettlement({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y });
    expect(again.refused).toBe(true);
    expect(again.reason).toBe('gone');
    expect(again.message).toMatch(/already been undone/);

    const never = await undoSettlement({ leaseId: 'lease-5', propertyId: 'prop-2', year: Y });
    expect(never.refused).toBe(true);
    expect(never.reason).toBe('none');
  });

  // ⚠ REACHABLE FROM EITHER SIDE. A carry-forward's other half sits in the following year, and
  // that is the year the landlord is often looking at when they notice it — so asking to undo
  // from FY+1 has to find the settlement that was MADE in FY.
  it('finds the settlement from the receiving year too', async () => {
    const res = await settleTenantBalance({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, choice: 'carry' });
    expect(res.refused).toBeFalsy();
    const fromNextYear = await undoSettlement({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y + 1 });
    expect(fromNextYear.refused).toBeFalsy();
    expect(fromNextYear.years).toEqual([Y, Y + 1]);
  });

  // ⚠ HALF AN UNDO IS WORSE THAN NONE, so a closed year on either side refuses the whole thing.
  it('refuses when a year holding part of the settlement is closed', async () => {
    const made = await settleTenantBalance({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, choice: 'carry' });
    expect(made.refused).toBeFalsy();
    await closeYear('prop-2', Y + 1);
    const res = await undoSettlement({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y });
    expect(res.refused).toBe(true);
    expect(res.reason).toBe('closed');
    expect(res.message).toMatch(new RegExp(`FY ${Y + 1} is closed`));
    // Nothing moved.
    expect((await listAdjustments({ leaseId: 'lease-3', year: Y + 1 })).filter((a) => a.kind === 'opening')).toHaveLength(1);
    await reopenYear('prop-2', Y + 1);
  });
});

// ── Round 3: the year boundary ─────────────────────────────────────────────────────────
//
// George: *"where in amlak does this show? only at fiscal year close or per line item? … is
// there information transfer between fiscal years?"* Closing a year is the one moment a
// settlement exists for, and until now it only WARNED about the balances — a landlord was left
// with a problem and no instrument, since the snapshot it writes is the very thing that refuses
// Settle up afterwards.
//
// ⚠ THE ORDER IS THE WHOLE THING: SETTLE, THEN SNAPSHOT. The snapshot is the lock.
describe('closing a year over open balances', () => {
  it('settles first and snapshots second, so the frozen figures are the settled ones', async () => {
    // Give Northwind a real balance again (the block above left it carried).
    await undoSettlement({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y });
    const before = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === 'lease-3');
    const owed = tenantStanding({ row: before, year: Y }).owes;
    expect(owed).toBeGreaterThan(0);

    const snap = await closeYear('prop-2', Y, { settleOpen: 'carry' });
    expect(snap.settlement.choice).toBe('carry');
    expect(snap.settlement.refused).toHaveLength(0);
    expect(snap.settlement.done.some((d) => d.label === 'Northwind Books' && Math.abs(d.amount - owed) < 0.01)).toBe(true);

    // ⚠ THE MONTH STILL RUNNING DOES NOT GO, AND THE REPORT SAYS SO. A settlement acts on
    // months that have ENDED — nothing has yet told you whether August was paid — so closing
    // a year mid-year leaves that month behind, frozen under the snapshot. `left` is what
    // makes the difference legible instead of looking like a rounding remainder.
    const carried = snap.settlement.done.find((d) => d.label === 'Northwind Books');
    const stand = tenantStanding({ row: before, year: Y });
    expect(carried.left).toBeCloseTo(stand.provisional, 2);

    // ⚠ THE SNAPSHOT RECORDS THE POSITION IT IS FREEZING, not the one from before the
    // settlement — the roll is re-read after the writes. A snapshot built from the earlier
    // read would freeze a balance that had already been moved out of the year.
    const row = snap.breakdown.find((b) => b.tenant === 'Northwind Books');
    expect(round2(stand.closing - row.closing_balance)).toBeCloseTo(owed, 2);
    expect(row.closing_balance).toBeCloseTo(stand.provisional, 2);
    expect(row.settled_as).toBe('carried forward');
    // …and the money really is in the next year.
    const next = (await getPropertyMonthlyRoll('prop-2', Y + 1)).find((r) => r.lease_id === 'lease-3');
    expect(round2(Number(next.schedule[1].owed) - Number(next.schedule[2].owed))).toBeCloseTo(owed, 2);

    await reopenYear('prop-2', Y);
    await undoSettlement({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y });
  });

  // ⚠ A CLOSING BALANCE OF ZERO CANNOT TELL A COLLECTED YEAR FROM A FORGIVEN ONE. `settled_as`
  // is the field that survives reopening the year in 2029 and asking what happened.
  it('records what was DECIDED, not only the figure', async () => {
    const snap = await closeYear('prop-2', Y);          // no option — freeze as it stands
    expect(snap.settlement).toBeUndefined();
    const left = snap.breakdown.find((b) => b.tenant === 'Northwind Books');
    expect(left.closing_balance).toBeGreaterThan(0);
    expect(left.settled_as).toBe('left open');
    // Sunrise was written off earlier in this file and later refunded an overpayment, and the
    // snapshot says BOTH — the same tenant reads $0 owing either way, which is exactly why the
    // words are needed, and why picking a single winner would hide half of what happened.
    const off = snap.breakdown.find((b) => b.tenant === 'Sunrise Yoga Studio');
    expect(off.settled_as).toBe('written off · refunded');
    expect(Math.abs(off.closing_balance)).toBeLessThanOrEqual(0.05);
    await reopenYear('prop-2', Y);
  });

  // ⚠ A BULK ACTION THAT SWALLOWS ITS REFUSALS FREEZES A BALANCE THE LANDLORD BELIEVES THEY
  // SETTLED. `settleTenantBalance` refuses for real reasons; each one comes back named.
  it('names what it could not settle, and closes the year anyway', async () => {
    await closeYear('prop-2', Y + 1);                    // nowhere for the balance to land
    const snap = await closeYear('prop-2', Y, { settleOpen: 'carry' });
    expect(snap.settlement.done).toHaveLength(0);
    expect(snap.settlement.refused.some((r) => r.label === 'Northwind Books' && new RegExp(`FY ${Y + 1} is closed`).test(r.message))).toBe(true);
    // The year still closed, and the frozen row states the balance is open rather than
    // implying it was dealt with.
    expect(snap.breakdown.find((b) => b.tenant === 'Northwind Books').settled_as).toBe('left open');
    await reopenYear('prop-2', Y);
    await reopenYear('prop-2', Y + 1);
  });
});

describe('settledAs — what was decided about the year', () => {
  const row = (kinds) => ({
    adjustmentRows: kinds.map((k, i) => ({ id: `a${i}`, kind: k.kind, amount: k.amount ?? -100, memo: k.memo ?? null })),
  });
  it('reads the decision off the rows the settlement wrote', () => {
    expect(settledAs({ row: row([{ kind: 'writeoff' }]), closing: 0 })).toBe('written off');
    expect(settledAs({ row: row([{ kind: 'opening', memo: `Carried forward to FY ${Y + 1}` }]), closing: 0 })).toBe('carried forward');
    expect(settledAs({ row: row([{ kind: 'refund' }]), closing: 0 })).toBe('refunded');
  });
  it('states both when a balance was settled two ways', () => {
    expect(settledAs({
      row: row([{ kind: 'writeoff' }, { kind: 'opening', memo: `Carried forward to FY ${Y + 1}` }]),
      closing: 0,
    })).toBe('written off · carried forward');
  });
  // ⚠ A BALANCE THAT ARRIVED IS LAST YEAR'S DECISION. Counting it would report every receiving
  // year as "carried forward" when nothing at all was decided in it.
  it('ignores a balance brought forward INTO the year', () => {
    const r = row([{ kind: 'opening', amount: 5000, memo: `Brought forward from FY ${Y - 1}` }]);
    expect(settledAs({ row: r, closing: 5000 })).toBe('left open');
    expect(settledAs({ row: r, closing: 0 })).toBe('square');
  });
  it('distinguishes a year with nothing to decide from one left open', () => {
    expect(settledAs({ row: { adjustmentRows: [] }, closing: 0 })).toBe('square');
    expect(settledAs({ row: { adjustmentRows: [] }, closing: 4150 })).toBe('left open');
    // A charge typed on a month is not a settlement and must not read as one.
    expect(settledAs({ row: row([{ kind: 'fee', amount: 250 }]), closing: 250 })).toBe('left open');
  });
});
