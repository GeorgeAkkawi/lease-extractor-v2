// Re-filing a payment onto a different month, or onto none (George, 2026-08-13: "some
// tenants may pay in the month before for rent — there should be an option to record a
// payment for the following or previous month", and "if a tenant is over paying where does
// that go").
//
// Until now the only correction was Undo the month and retype, which throws away the paid
// date, the note and the import provenance a bank statement needs to reconcile against the
// month later. `updatePayment` moves the tag and touches nothing else.
import { describe, it, expect } from 'vitest';
import { markMonthPaid, updatePayment, listPayments, ensureInvoice } from '../api';
import { allocatePayments } from '../ledger';
import { currentYear } from '../format';

const Y = currentYear();
const flat = (n) => Array(12).fill(n);

const payFor = async (month, amount) => {
  await markMonthPaid('lease-1', 'prop-1', Y, month, { amount, source: 'manual' });
  const inv = await ensureInvoice('lease-1', 'prop-1', Y);
  const all = await listPayments(inv.id);
  return all.find((p) => Number(p.period_month) === month);
};

describe('updatePayment — moving a payment between months', () => {
  it('re-tags the month, and the grid follows', async () => {
    const p = await payFor(7, 6500);
    expect(Number(p.period_month)).toBe(7);

    await updatePayment(p.id, { period_month: 6 });
    const inv = await ensureInvoice('lease-1', 'prop-1', Y);
    const moved = (await listPayments(inv.id)).find((x) => x.id === p.id);
    expect(Number(moved.period_month)).toBe(6);

    // The tag always wins in the allocation, so June settles and July re-opens.
    const a = allocatePayments({ owedByMonth: flat(6500), payments: [moved] });
    expect(a.settled[5]).toBe(true);
    expect(a.settled[6]).toBe(false);
  });

  it('⚠ leaves `source` alone — moving money is not re-pricing it', async () => {
    // 0088: only a 'system' row may be re-priced by resyncYearBillingToEstimate. If a move
    // restamped source, a real cheque would become re-pricable and a later change to a
    // billed figure would delete it and write an amount nobody received.
    const p = await payFor(9, 6500);
    expect(p.source).toBe('manual');
    await updatePayment(p.id, { period_month: 10 });
    const inv = await ensureInvoice('lease-1', 'prop-1', Y);
    const moved = (await listPayments(inv.id)).find((x) => x.id === p.id);
    expect(moved.source).toBe('manual');
    // …and the amount, the date and the note are the same record, not a new one.
    expect(Number(moved.amount)).toBe(Number(p.amount));
    expect(moved.paid_date).toBe(p.paid_date);
    expect(moved.id).toBe(p.id);
  });

  it('untagging lets an overpayment reach the months after it', () => {
    // THE CASE GEORGE ASKED ABOUT. A payment tagged to a month settles that month at
    // whatever arrived and stops — so $9,000 on a $6,500 month leaves $2,500 going nowhere:
    // not to April, and not into the credit figure either.
    const settledJanFeb = [
      { id: 'a', amount: 6500, period_month: 1, paid_date: `${Y}-01-05` },
      { id: 'b', amount: 6500, period_month: 2, paid_date: `${Y}-02-05` },
    ];
    const tagged = [...settledJanFeb, { id: 'p1', amount: 9000, period_month: 3, paid_date: `${Y}-03-05` }];
    const a = allocatePayments({ owedByMonth: flat(6500), payments: tagged });
    expect(a.received[2]).toBe(9000);
    expect(a.settled[3]).toBe(false);   // April untouched by the excess
    expect(a.credit).toBe(0);           // and it is not a credit either

    // Untagged, the same money pools. ⚠ The pool fills each month's REMAINING need from
    // JANUARY onward — not from the payment's own month — so with Jan and Feb already
    // settled by their tags it lands on March, then April. That is exactly what the
    // confirm dialog promises ("from January onward, this month included"), and it is why
    // the dialog says it rather than implying the money simply moves forward one month.
    const untagged = [...settledJanFeb, { id: 'p1', amount: 9000, period_month: null, paid_date: `${Y}-03-05` }];
    const b = allocatePayments({ owedByMonth: flat(6500), payments: untagged });
    expect(b.poolDraw[0]).toBe(0);      // Jan is settled by its tag — the pool skips it
    expect(b.poolDraw[2]).toBe(6500);   // March
    expect(b.poolDraw[3]).toBe(2500);   // …and the excess reaches April
    expect(b.states[3]).toBe('partial');
  });

  it('a true remainder after December becomes the credit owed back', () => {
    const a = allocatePayments({
      owedByMonth: flat(1000),
      payments: [{ id: 'p1', amount: 13000, period_month: null, paid_date: `${Y}-01-05` }],
    });
    expect(a.states.every((s) => s === 'covered')).toBe(true);
    expect(a.credit).toBe(1000);
  });
});
