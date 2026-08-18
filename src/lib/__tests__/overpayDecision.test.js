// A surplus is not revenue until the landlord says it is — and a shortfall can be billed
// on a month of their choosing.
//
// George, 2026-08-17: *"those shortage and overpayments shouldnt be recorded live until the
// user confirms them — only then should they be written into the live revenue count as money
// made. because if theres an overpayment one month a user might want to roll it forward to
// the next month (this should be an option)"* and *"also should be an option to send shortages
// to overcharge the next month."*
//
// ⚠ THE DEFECT UNDERNEATH IT, and why this file exists at all. `allocatePayments` settles a
// tagged month at whatever arrived, with no cap and no rollover — deliberately, because the
// landlord SAID that cheque was for that month. But the surplus then had nowhere to be: it
// raises no `credit` (only an untagged lump pools), never reaches `inCredit`, and is invisible
// to `settleTenantBalance`. The live income-and-expenses sheet counted it as that month's
// revenue with nobody ever asked.
//
// Everything here runs against the real write paths on the demo store, not against fixtures
// of what the writes are imagined to do.
import { describe, it, expect } from 'vitest';
import {
  splitPayment, carryMonthShortfall, getPropertyMonthlyRoll, listPayments, listAdjustments,
  recordPayment, ensureInvoice, listAlertStates, upsertAlertState,
} from '../api';
import { allocatePayments, monthExcess, overpayKey } from '../ledger';
import { adjustmentKindInfo, pnlDestination } from '../adjustments';
import { buildIncomeExpense, billedRowsFromRoll } from '../incomeExpense';
import { currentYear } from '../format';

const Y = currentYear();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const rowFor = async (propertyId, leaseId) =>
  (await getPropertyMonthlyRoll(propertyId, Y)).find((r) => r.lease_id === leaseId);

const allocFor = (r) =>
  allocatePayments({ owedByMonth: r.schedule, payments: r.payments, adjustments: r.adjustments });

// ── monthExcess ───────────────────────────────────────────────────────────────

describe('monthExcess — cash no bill accounts for', () => {
  const alloc = (owed, received, settled) => ({ owed, received, settled });
  const twelve = (v) => Array(12).fill(v);

  it('reports only what a SETTLED month took beyond its bill', () => {
    const o = twelve(1000); const r = twelve(1000); const s = twelve(true);
    r[2] = 1500;
    expect(monthExcess(alloc(o, r, s))[2]).toBe(500);
    expect(monthExcess(alloc(o, r, s)).filter((n) => n > 0)).toHaveLength(1);
  });

  // ⚠ THE GUARD THAT SAYS WHY. An unsettled month draws only from the pool, and `poolDraw` is
  // capped at that month's remaining need — so it can never overshoot. Only a TAG can.
  it('never reports an unsettled month, whatever the arrays say', () => {
    const o = twelve(1000); const r = twelve(1000); const s = twelve(false);
    r[2] = 1500;
    expect(monthExcess(alloc(o, r, s))[2]).toBe(0);
  });

  // Money tagged to a month the lease bills nothing for is cash no bill accounts for — the
  // same question in a starker form, not a special case to wave through.
  it('counts a month with no bill at all as entirely unapplied', () => {
    const o = twelve(0); const r = twelve(0); const s = twelve(false);
    r[5] = 800; s[5] = true;
    expect(monthExcess(alloc(o, r, s))[5]).toBe(800);
  });

  it('is silent on a month that behaves, to the cent', () => {
    expect(monthExcess(alloc(twelve(1000), twelve(1000), twelve(true)))).toEqual(twelve(0));
    expect(monthExcess()).toEqual(twelve(0));
  });
});

// ── The key ───────────────────────────────────────────────────────────────────

describe('overpayKey', () => {
  it('carries the cents, so a changed surplus is a different question', () => {
    expect(overpayKey('l1', 2026, 3, 850)).toBe('overpay:l1:2026:3:85000');
    expect(overpayKey('l1', 2026, 3, 850)).not.toBe(overpayKey('l1', 2026, 3, 950));
    // …and a different month or tenant never collides with it.
    expect(overpayKey('l1', 2026, 4, 850)).not.toBe(overpayKey('l1', 2026, 3, 850));
    expect(overpayKey('l2', 2026, 3, 850)).not.toBe(overpayKey('l1', 2026, 3, 850));
  });
});

// ── splitPayment ──────────────────────────────────────────────────────────────
//
// ⚠ prop-2, NOT prop-1. The demo seed carries a `financial_snapshots` row for prop-1's CURRENT
// year, so that property is CLOSED and every write here refuses — correctly. Writing these
// against it proved the guard and nothing else. prop-2 is the open one, which is why
// settleBalance.test.js uses it too.
//
// The seed has no tagged over-payment anywhere, so each test writes its own: that shape is the
// whole point of the feature and its absence from the seed is exactly why it went unnoticed.

describe('splitPayment — the surplus moves, not the cheque', () => {
  it('moves only the excess, and the two halves still add to the cheque', async () => {
    // ⚠ lease-3, and MAY MUST BILL SOMETHING. lease-4's May bills $0 (its term starts later),
    // so a cheque tagged there is entirely surplus and `splitPayment` correctly refuses it as
    // the whole payment — which tests the guard, not the split.
    const inv = await ensureInvoice('lease-3', 'prop-2', Y);
    const before0 = await rowFor('prop-2', 'lease-3');
    const mayOwed = round2(Number(before0.schedule[5].owed) || 0);
    expect(mayOwed).toBeGreaterThan(0);
    const pay = await recordPayment({
      invoice_id: inv.id, lease_id: 'lease-3', amount: round2(mayOwed + 2850), paid_date: `${Y}-05-03`,
      method: 'check', period_month: 5, source: 'manual',
    });
    const before = await rowFor('prop-2', 'lease-3');
    const excess = round2(monthExcess(allocFor(before))[4]);
    expect(excess, 'May must genuinely be over-paid for this to test anything').toBeGreaterThan(0);

    const res = await splitPayment(pay.id, { amount: excess, toMonth: 6, propertyId: 'prop-2', year: Y });
    expect(res.refused, JSON.stringify(res)).toBeFalsy();

    const after = await listPayments(inv.id);
    const original = after.find((p) => p.id === pay.id);
    const split = after.find((p) => p.id === res.payment.id);
    expect(round2(original.amount + split.amount)).toBeCloseTo(round2(mayOwed + 2850), 2);
    expect(Number(split.period_month)).toBe(6);
    expect(split.paid_date).toBe(`${Y}-05-03`);
    // ⚠ `source` COPIED, NEVER LEFT TO THE DEFAULT (0088). The mock applies no defaults, so an
    // unstated source is undefined here and 'system' live — and the re-stamp guard reads the
    // two oppositely. A real cheque's halves must both stay real.
    expect(split.source).toBe('manual');
    expect(original.source).toBe('manual');

    // May is square again and June has the money.
    const rebuilt = await rowFor('prop-2', 'lease-3');
    const a = allocFor(rebuilt);
    expect(monthExcess(a)[4]).toBe(0);
    expect(a.received[5]).toBeCloseTo(excess, 2);
  });

  it('refuses to swallow the whole cheque, or to write a month that is not one', async () => {
    const inv = await ensureInvoice('lease-4', 'prop-2', Y);
    const pay = await recordPayment({
      invoice_id: inv.id, lease_id: 'lease-4', amount: 500, paid_date: `${Y}-07-03`,
      method: 'check', period_month: 7, source: 'manual',
    });
    // Moving all of it is `updatePayment`'s job and leaves no zero-amount ghost behind.
    const whole = await splitPayment(pay.id, { amount: 500, toMonth: 8 });
    expect(whole.refused).toBe(true);
    expect(whole.reason).toBe('whole');
    expect(await splitPayment(pay.id, { amount: 100, toMonth: 13 })).toMatchObject({ refused: true, reason: 'month' });
    expect(await splitPayment(pay.id, { amount: 0, toMonth: 8 })).toMatchObject({ refused: true, reason: 'zero' });
    // …and nothing was written by any of the three.
    const rows = await listPayments(inv.id);
    expect(rows.find((p) => p.id === pay.id).amount).toBe(500);
  });

  // ⚠ NOTHING IS CLOSED OR REOPENED HERE. prop-1 carries a snapshot for the current year on
  // the seed, so it IS a closed year — and a test that closes one itself proves only that its
  // own setup ran. A bill already sent must not move under the landlord.
  it('refuses in a closed year, in the same words every other write uses', async () => {
    const inv = await ensureInvoice('lease-2', 'prop-1', Y);
    const pay = await recordPayment({
      invoice_id: inv.id, lease_id: 'lease-2', amount: 4000, paid_date: `${Y}-02-03`,
      method: 'check', period_month: 2, source: 'manual',
    });
    const res = await splitPayment(pay.id, { amount: 100, toMonth: 3, propertyId: 'prop-1', year: Y });
    expect(res.refused).toBe(true);
    expect(res.reason).toBe('closed');
    expect(res.message).toContain('Reopen it first');
    expect((await listPayments(inv.id)).find((p) => p.id === pay.id).amount).toBe(4000);

    // …and the same refusal on the other write, from the same lock.
    expect(await carryMonthShortfall({
      leaseId: 'lease-2', propertyId: 'prop-1', year: Y, fromMonth: 2, toMonth: 3, amount: 100,
    })).toMatchObject({ refused: true, reason: 'closed' });
  });
});

// ── carryMonthShortfall ───────────────────────────────────────────────────────

describe('carryMonthShortfall — billing a shortfall on a later month', () => {
  it('writes BOTH sides, so the year earns the same and only the month moves', async () => {
    const before = await rowFor('prop-2', 'lease-3');
    const janOwed = round2(Number(before.schedule[1].owed) || 0);
    const febOwed = round2(Number(before.schedule[2].owed) || 0);

    const res = await carryMonthShortfall({
      leaseId: 'lease-3', propertyId: 'prop-2', year: Y, fromMonth: 1, toMonth: 2, amount: 1200,
    });
    expect(res.refused).toBeFalsy();
    expect(res.rows).toHaveLength(2);

    // ⚠ HALF A PAIR LOSES THE MONEY. One row clears January, the other bills February; the
    // amounts are equal and opposite so the year's total is untouched.
    const adjs = (await listAdjustments({ leaseId: 'lease-3', year: Y })).filter((a) => a.kind === 'carry');
    expect(round2(adjs.reduce((s, a) => s + Number(a.amount), 0))).toBe(0);
    expect(adjs.find((a) => Number(a.month) === 1).amount).toBe(-1200);
    expect(adjs.find((a) => Number(a.month) === 2).amount).toBe(1200);

    const after = await rowFor('prop-2', 'lease-3');
    expect(round2(Number(after.schedule[1].owed))).toBeCloseTo(round2(janOwed - 1200), 2);
    expect(round2(Number(after.schedule[2].owed))).toBeCloseTo(round2(febOwed + 1200), 2);
  });

  // ⚠ `pnlRow: 'rent'`, NOT null, AND IT IS THE WHOLE ACCOUNTING DECISION. `opening` is null
  // because a balance crossing a YEAR was another year's income. This crosses a month inside
  // one year: give it a null pnlRow and every carry quietly deletes its own revenue.
  it('leaves the year’s income exactly where it was', async () => {
    const roll = await getPropertyMonthlyRoll('prop-2', Y);
    const b = billedRowsFromRoll(roll);
    const mine = b.rent.find((r) => r.lease_id === 'lease-3');
    // January is down and February is up by the same figure, and the row's own total is not.
    expect(round2(mine.byMonth[1] - mine.byMonth[0])).toBeGreaterThan(0);
    expect(adjustmentKindInfo('carry').pnlRow).toBe('rent');
    expect(pnlDestination('carry').row).toBe('Rent');
    expect(pnlDestination('carry').earned).toBe(true);
    // And it is never offered as a free-text charge — half a pair is worse than none.
    expect(adjustmentKindInfo('carry').manual).toBe(false);
  });

  it('refuses to move more than the month bills, or onto itself', async () => {
    expect(await carryMonthShortfall({
      leaseId: 'lease-3', propertyId: 'prop-2', year: Y, fromMonth: 3, toMonth: 3, amount: 100,
    })).toMatchObject({ refused: true, reason: 'same_month' });
    const tooMuch = await carryMonthShortfall({
      leaseId: 'lease-3', propertyId: 'prop-2', year: Y, fromMonth: 3, toMonth: 4, amount: 999999,
    });
    expect(tooMuch.refused).toBe(true);
    expect(tooMuch.reason).toBe('negative');
    expect(tooMuch.message).toContain('there is not that much on it to move');
  });
});

// ── End to end: the live workbook ─────────────────────────────────────────────

describe('the live workbook holds a surplus back until it is answered for', () => {
  it('keeps it out of every figure, names it, and lets it in on confirmation', async () => {
    const inv = await ensureInvoice('lease-3', 'prop-2', Y);
    const row0 = await rowFor('prop-2', 'lease-3');
    const owedSep = round2(Number(row0.schedule[9].owed) || 0);
    expect(owedSep).toBeGreaterThan(0);
    await recordPayment({
      invoice_id: inv.id, lease_id: 'lease-3', amount: round2(owedSep + 2500), paid_date: `${Y}-10-04`,
      method: 'check', period_month: 10, source: 'manual',
    });

    const held = (await buildIncomeExpense('corp-2', Y, { basis: 'live' }))
      .properties.find((p) => p.id === 'prop-2');
    // Scoped to the row, not the property total — other tenants on prop-2 may be holding
    // surpluses of their own from the tests above, and a total would pass on either.
    const mine = held.unappliedRows.find((r) => r.lease_id === 'lease-3' && r.month === 10);
    expect(mine?.amount).toBeCloseTo(2500, 2);
    expect(held.unapplied).toBeGreaterThanOrEqual(2500);
    // ⚠ IN NONE OF THE FIGURES — that is the instruction, and this is it in one assertion.
    const octRent = held.rentRows.find((r) => r.lease_id === 'lease-3')?.byMonth[9] || 0;
    const octCam = held.camTaxRows.find((r) => r.lease_id === 'lease-3')?.byMonth[9] || 0;
    const octRoof = held.roofRows.find((r) => r.lease_id === 'lease-3')?.byMonth[9] || 0;
    expect(round2(octRent + octCam + octRoof)).toBeCloseTo(owedSep, 2);

    // …and it is NAMED, because a figure withheld with nothing said about it is
    // indistinguishable from one the app lost.
    const pkg = await buildIncomeExpense('corp-2', Y, { basis: 'live' });
    const flag = pkg.flags.find((f) => f.includes('beyond what that month billed'));
    expect(flag).toContain('Oct $2,500.00');
    expect(flag).toContain('Ledger');

    // Now answer for it. The same key the month panel writes.
    await upsertAlertState({ alert_key: overpayKey('lease-3', Y, 10, 2500), dismissed: true });
    expect((await listAlertStates()).some((s) => s.dismissed)).toBe(true);
    const released = (await buildIncomeExpense('corp-2', Y, { basis: 'live' }))
      .properties.find((p) => p.id === 'prop-2');
    expect(released.unappliedRows.some((r) => r.lease_id === 'lease-3' && r.month === 10)).toBe(false);
    const after = released.rentRows.find((r) => r.lease_id === 'lease-3')?.byMonth[9] || 0;
    expect(round2(after)).toBeCloseTo(round2(octRent + 2500), 2);
  });

  // The projected basis is a statement of the BILL, so a payment cannot change it either way.
  it('changes nothing at all on the projected basis', async () => {
    const p = (await buildIncomeExpense('corp-2', Y)).properties.find((x) => x.id === 'prop-2');
    expect(p.unapplied).toBe(0);
    expect(p.unappliedRows).toEqual([]);
  });
});
