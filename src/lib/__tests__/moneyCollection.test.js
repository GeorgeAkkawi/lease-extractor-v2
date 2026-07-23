// The cash-register tests (review item T-1): the penny-true monthly schedule,
// invoice creation/dedupe, and the invoice template's abatement credit. Runs against
// the demo mock (DEMO mode is forced by vite.config test env), which mirrors the live
// SQL — including the 0055 unique index (one live invoice per lease+year) and the ±5¢
// balance dust-clamp.
//
// Demo seed (store.js), year Y = the current year:
//   lease-1 (Bright Coffee, prop-1): inv-1 $78,100 — PAID IN FULL by one untagged payment.
//   lease-2 (City Dental,  prop-1): inv-2 $98,500 — Jan+Feb tagged ($8,208.33 each)
//     plus a $4,000 UNTAGGED partial (pools onto March), $78,083.34 still owed.
//   lease-3 (Northwind,   prop-2): no invoice yet (draft-invoice creates it on demand).
import { describe, it, expect } from 'vitest';
import {
  ensureInvoice, upsertYearInvoice, listInvoices, createInvoice,
  markMonthPaid, unmarkMonthPaid, markMonthPaidAllTenants,
  getMonthlyRent, getYearInvoice, listPayments, getPropertyMonthlyRoll,
} from '../api';
import { allocatePayments } from '../ledger';
import { monthlyScheduleForYear } from '../abatement';
import { buildInvoice } from '../invoiceTemplate';
import { currentYear } from '../format';

const Y = currentYear();
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

describe('monthly schedule is penny-true', () => {
  it('12 months sum exactly to the annual total ($98,500 case)', () => {
    const sched = monthlyScheduleForYear({ year: Y, annualBaseRent: 98500 });
    for (let m = 1; m <= 11; m++) expect(sched[m].owed).toBe(8208.33);
    expect(sched[12].owed).toBe(8208.37); // the last month absorbs the rounding cents
    const sum = round2(Object.values(sched).reduce((s, c) => s + c.owed, 0));
    expect(sum).toBe(98500);
  });

  it('owed + credits reconcile to base + other with an abatement in play', () => {
    const abatements = [{ start_date: `${Y}-01-01`, end_date: `${Y}-03-31`, kind: 'free' }];
    const sched = monthlyScheduleForYear({ year: Y, annualBaseRent: 100000, otherAnnual: 500, abatements });
    const owed = Object.values(sched).reduce((s, c) => s + c.owed, 0);
    const credit = Object.values(sched).reduce((s, c) => s + c.credit, 0);
    // Everything billed + everything credited = everything charged, to the cent.
    expect(round2(owed + credit)).toBe(100500);
    expect(sched[1].abated).toBe(true);
    expect(sched[4].abated).toBe(false);
  });
});

describe('one live invoice per lease + year (0055 unique index)', () => {
  it('inserting a duplicate live invoice raises 23505', async () => {
    await expect(
      createInvoice({ lease_id: 'lease-2', property_id: 'prop-1', year: Y, status: 'sent', total_amount: 1 })
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('ensureInvoice returns the existing invoice instead of creating another', async () => {
    const inv = await ensureInvoice('lease-2', 'prop-1', Y);
    expect(inv.id).toBe('inv-2');
    expect((await listInvoices('lease-2')).length).toBe(1);
  });

  it('upsertYearInvoice creates once, then refreshes in place — never duplicates', async () => {
    const figures = (total) => ({
      lease_id: 'lease-3', property_id: 'prop-2', year: Y,
      issue_date: `${Y}-01-01`, due_date: `${Y}-01-31`,
      base_rent_annual: total, cam_annual: 0, tax_annual: 0, roof_annual: 0,
      abatement_annual: 0, total_amount: total,
    });
    const first = await upsertYearInvoice(figures(120000));
    expect(first.updated).toBe(false);
    const second = await upsertYearInvoice(figures(125000)); // "Save to receivables" clicked again
    expect(second.updated).toBe(true);
    expect(second.invoice.id).toBe(first.invoice.id);
    const invoices = await listInvoices('lease-3');
    expect(invoices.length).toBe(1);
    expect(Number(invoices[0].total_amount)).toBe(125000);
  });
});

describe('marking months paid (the ledger write path)', () => {
  it('bulk mark-all pays only tenants who still owe — lump-settled and tagged months are skipped', async () => {
    // lease-1 is settled by ONE untagged lump — the bulk action must not bill it 12
    // more months. lease-2's May is genuinely uncovered (its $4,000 partial already
    // pooled onto March), so only City Dental collects.
    const res = await markMonthPaidAllTenants('prop-1', Y, 5);
    expect(res).toEqual({ paid: 1, skipped: 1, total: 2 });
    expect((await listPayments('inv-1')).length).toBe(1); // untouched
    // Re-running the same month pays no one twice.
    const again = await markMonthPaidAllTenants('prop-1', Y, 5);
    expect(again.paid).toBe(0);
  });

  it('marking the same month twice records exactly one payment', async () => {
    await markMonthPaid('lease-2', 'prop-1', Y, 5); // May was just paid by the bulk action
    const may = (await listPayments('inv-2')).filter((p) => Number(p.period_month) === 5);
    expect(may.length).toBe(1);
  });

  it('a pool-partial month is topped up by its GAP, and the year settles EXACTLY — no phantom cents', async () => {
    // City Dental's monthly is now the data figure 9,150 (base 84,000 + actual share 25,800,
    // over 12). March is partially covered by the untagged $4,000 — the bulk action records
    // only the $5,150 gap, then the remaining open months collect the full 9,150. Every dollar
    // lands once and the year settles to the 109,800 the lease + expenses build.
    for (const m of [3, 4, 6, 7, 8, 9, 10, 11, 12]) await markMonthPaidAllTenants('prop-1', Y, m);
    const payments = await listPayments('inv-2');
    const mar = payments.filter((p) => Number(p.period_month) === 3);
    expect(mar.length).toBe(1);
    expect(Number(mar[0].amount)).toBe(5150); // the gap (9,150 − 4,000), not the full month
    const total = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
    expect(total).toBe(109800);
    const inv = await getYearInvoice('lease-2', Y);
    expect(Number(inv.balance)).toBe(0);
    expect(inv.display_status).toBe('paid');
  });

  it('un-marking a month re-opens exactly that share', async () => {
    await unmarkMonthPaid('lease-2', Y, 12);
    const inv = await getYearInvoice('lease-2', Y);
    expect(round2(Number(inv.balance))).toBe(9150);
    expect(inv.display_status).toBe('partial');
    // …and the bulk action sees the gap and collects it again.
    const res = await markMonthPaidAllTenants('prop-1', Y, 12);
    expect(res.paid).toBe(1);
    expect(Number((await getYearInvoice('lease-2', Y)).balance)).toBe(0);
  });

  it("getMonthlyRent's annual builds from the data (base + share) and reconciles to the invoice", async () => {
    const data = await getMonthlyRent('lease-2', Y);
    expect(round2(data.annual)).toBe(109800); // 84,000 base + 25,800 actual CAM&tax share
    expect(Object.keys(data.byMonth).length).toBe(12);
    expect(Array.isArray(data.payments)).toBe(true);
    expect(data.payments.length).toBeGreaterThan(12); // 12 tagged + the untagged partial
  });

  it('the bulk action SKIPS a settled-short month — "paid = paid" is never auto-topped-up', async () => {
    // Re-open June, then record only PART of it (a short tagged payment). Under paid=paid
    // June now reads settled, so the bulk "✓ all" must leave it exactly as recorded — never
    // silently top a month the landlord already marked, whatever the amount.
    await unmarkMonthPaid('lease-2', Y, 6);
    await markMonthPaid('lease-2', 'prop-1', Y, 6, { amount: 5000 });
    const res = await markMonthPaidAllTenants('prop-1', Y, 6);
    expect(res.paid).toBe(0); // Dental settled-short (skipped) + Bright long-settled (skipped)
    const june = (await listPayments('inv-2')).filter((p) => Number(p.period_month) === 6);
    expect(june).toHaveLength(1);
    expect(Number(june[0].amount)).toBe(5000); // not topped up to 9,150
  });

  it('a top-up records a SECOND same-month payment; the allocation settles the month at the sum', async () => {
    // June is settled-short at 5,000 (from the test above). The ledger top-up records the
    // remaining 4,150 as an ADDITIONAL same-month payment — bypassing the idempotence guard.
    await markMonthPaid('lease-2', 'prop-1', Y, 6, { amount: 4150, additional: true });
    const june = (await listPayments('inv-2')).filter((p) => Number(p.period_month) === 6);
    expect(june).toHaveLength(2);
    expect(round2(june.reduce((s, p) => s + Number(p.amount), 0))).toBe(9150);
    // The allocation sums the two same-month tags → June reads settled at the full 9,150.
    const row = (await getPropertyMonthlyRoll('prop-1', Y)).find((r) => r.lease_id === 'lease-2');
    const alloc = allocatePayments({ owedByMonth: row.schedule, payments: row.payments });
    expect(alloc.settled[5]).toBe(true);
    expect(round2(alloc.received[5])).toBe(9150);
    // Without `additional`, a same-month mark stays an idempotent no-op (no 3rd payment).
    await markMonthPaid('lease-2', 'prop-1', Y, 6, { amount: 9999 });
    expect((await listPayments('inv-2')).filter((p) => Number(p.period_month) === 6)).toHaveLength(2);
  });
});

describe('invoice template', () => {
  it('shows the abatement as a credit line and nets the AMOUNT DUE', () => {
    const text = buildInvoice({
      business: null, tenant: 'Testco', year: Y, tax_year: Y - 1,
      square_footage: 1000, base_rent_annual: 12000, cam_annual: 1200,
      tax_annual: 600, roof_annual: 0, abatement_annual: 1000,
      today: `${Y}-01-01`, due: `${Y}-01-31`,
    });
    expect(text).toContain('Rent abatement (credit)');
    const dueLine = text.split('\n').find((l) => l.startsWith('AMOUNT DUE'));
    expect(dueLine).toContain('$12,800.00'); // 12,000 + 1,200 + 600 − 1,000
  });
});
