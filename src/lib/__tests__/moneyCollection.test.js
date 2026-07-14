// The cash-register tests (review item T-1): the penny-true monthly schedule,
// invoice creation/dedupe, and the invoice template's abatement credit. Runs against
// the demo mock (DEMO mode is forced by vite.config test env), which mirrors the live
// SQL — including the 0055 unique index (one live invoice per lease+year) and the ±5¢
// balance dust-clamp.
//
// Demo seed (store.js), year Y = the current year:
//   lease-1 (Bright Coffee, prop-1): inv-1 $78,100 — PAID IN FULL by one untagged payment.
//   lease-2 (City Dental,  prop-1): inv-2 $98,500 — unpaid.
//   lease-3 (Northwind,   prop-2): no invoice yet (draft-invoice creates it on demand).
import { describe, it, expect } from 'vitest';
import {
  ensureInvoice, upsertYearInvoice, listInvoices, createInvoice,
} from '../api';
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
