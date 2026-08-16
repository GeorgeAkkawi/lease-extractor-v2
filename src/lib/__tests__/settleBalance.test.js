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
  refundMonth, settleChoicesFor, settleSentence,
} from '../settle';
import {
  settleTenantBalance, getPropertyMonthlyRoll, listAdjustments, addAdjustment,
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
  // ⚠ NOT `billed − received`. On a year still running that would offer to write off rent
  // the tenant has every right not to have paid yet.
  it('counts only the months that have come due', () => {
    const row = { lease_id: 'l1', tenant_name: 'T', schedule: sched(1000), payments: [] };
    const s = tenantStanding({ row, year: Y, today: AUG });
    expect(s.billed).toBe(12000);       // the whole year is billed…
    expect(s.received).toBe(0);
    expect(s.closing).toBe(8000);       // …but only Jan–Aug is owed today
    expect(s.owes).toBe(8000);
    expect(s.inCredit).toBe(0);
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
    const cap = monthCapacity({ alloc, direction: 'credit', dueThrough: 8 });
    expect(cap[0]).toBe(0);                        // January is paid — nothing to forgive
    expect(cap[1]).toBe(1000);
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
    const out = spreadAcrossMonths({ capacity: monthCapacity({ alloc, direction: 'credit', dueThrough: 2 }), amount: 5000 });
    expect(out.placed).toBe(2000);
    expect(out.shortfall).toBe(3000);
  });

  it('leaves a charge uncapped — a charge only ever increases what a month owes', () => {
    const cap = monthCapacity({ alloc: { owed: Array(12).fill(0), coverage: Array(12).fill(0) }, direction: 'charge' });
    expect(spreadAcrossMonths({ capacity: cap, amount: 9999 }).rows).toEqual([{ month: 1, amount: 9999 }]);
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
    ]) expect(strings, `the sheet must say "${phrase}"`).toContain(phrase);
    for (const n of Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))) {
      const xml = await zip.file(n).async('string');
      expect(new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror')).toBeNull();
      expect(/state="frozen"/.test(xml)).toBe(false);
    }
  }, 30000);
});
