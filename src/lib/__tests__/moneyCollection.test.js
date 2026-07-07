// The cash-register tests (review item T-1): invoice creation/dedupe, month
// marking, penny-exact reconciliation, bulk mark-all, AR aging, and the invoice
// template's abatement credit. Runs against the demo mock (DEMO mode is forced by
// vite.config test env), which mirrors the live SQL — including the 0055 unique
// index (one live invoice per lease+year) and the ±5¢ balance dust-clamp.
//
// Demo seed (store.js), year Y = the current year:
//   lease-1 (Bright Coffee, prop-1): inv-1 $78,100 — PAID IN FULL by one untagged payment.
//   lease-2 (City Dental,  prop-1): inv-2 $98,500 — unpaid. 98,500/12 = $8,208.33…,
//     the penny-leak shape that used to leave a permanent 4¢ balance.
//   lease-3 (Northwind,   prop-2): no invoice yet (draft-invoice creates it on demand).
import { describe, it, expect } from 'vitest';
import {
  ensureInvoice, upsertYearInvoice, markMonthPaid, unmarkMonthPaid,
  markMonthPaidAllTenants, getMonthlyRent, getYearInvoice,
  listInvoices, listPayments, createInvoice, summarizeAR,
} from '../api';
import { monthlyScheduleForYear } from '../abatement';
import { buildInvoice } from '../invoiceTemplate';
import { buildAlerts } from '../alerts';
import { buildPaymentReminderEmail } from '../emailTemplates';
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

describe('marking months paid', () => {
  it('bulk mark-all pays only tenants who still owe (settled invoices are skipped)', async () => {
    // lease-1's invoice is already paid in full by ONE untagged payment — the bulk
    // action must not bill it 12 more months. lease-2 genuinely owes January.
    const res = await markMonthPaidAllTenants('prop-1', Y, 1);
    expect(res).toEqual({ paid: 1, skipped: 1, total: 2 });
    expect((await listPayments('inv-1')).length).toBe(1); // untouched
    // Re-running the same month pays no one twice.
    const again = await markMonthPaidAllTenants('prop-1', Y, 1);
    expect(again.paid).toBe(0);
  });

  it('marking the same month twice records exactly one payment', async () => {
    await markMonthPaid('lease-2', 'prop-1', Y, 1); // January was just paid by the bulk action
    const jan = (await listPayments('inv-2')).filter((p) => Number(p.period_month) === 1);
    expect(jan.length).toBe(1);
  });

  it('paying all 12 months settles the invoice EXACTLY — no phantom cents', async () => {
    for (let m = 2; m <= 12; m++) await markMonthPaid('lease-2', 'prop-1', Y, m);
    const payments = await listPayments('inv-2');
    expect(payments.length).toBe(12);
    const total = round2(payments.reduce((s, p) => s + Number(p.amount), 0));
    expect(total).toBe(98500); // 11 × $8,208.33 + $8,208.37
    const inv = await getYearInvoice('lease-2', Y);
    expect(Number(inv.balance)).toBe(0);
    expect(inv.display_status).toBe('paid');
  });

  it('un-marking a month re-opens exactly that share', async () => {
    await unmarkMonthPaid('lease-2', Y, 12);
    const inv = await getYearInvoice('lease-2', Y);
    expect(round2(Number(inv.balance))).toBe(8208.37);
    expect(inv.display_status).toBe('partial');
    // …and the bulk action now sees the balance and collects it again.
    const res = await markMonthPaidAllTenants('prop-1', Y, 12);
    expect(res.paid).toBe(1);
    expect(Number((await getYearInvoice('lease-2', Y)).balance)).toBe(0);
  });

  it("getMonthlyRent's annual equals the invoice total", async () => {
    const data = await getMonthlyRent('lease-2', Y);
    expect(round2(data.annual)).toBe(98500);
    expect(Object.keys(data.byMonth).length).toBe(12);
  });
});

describe('AR aging (summarizeAR)', () => {
  it('buckets balances by how overdue the due date is and skips draft/void/paid', () => {
    const today = new Date(`${Y}-07-07T12:00:00`);
    const rows = [
      { display_status: 'sent', balance: 100, due_date: `${Y}-08-01` },   // not due yet → current
      { display_status: 'overdue', balance: 50, due_date: `${Y}-06-20` }, // 17 days late → ≤30
      { display_status: 'partial', balance: 25, due_date: `${Y}-05-15` }, // 53 days late → ≤60
      { display_status: 'overdue', balance: 10, due_date: `${Y}-01-31` }, // 157 days late → 90+
      { display_status: 'draft', balance: 999, due_date: `${Y}-01-01` },  // drafts never count
      { display_status: 'void', balance: 999, due_date: `${Y}-01-01` },   // voids never count
      { display_status: 'paid', balance: 0, due_date: `${Y}-01-01` },     // nothing owed
    ];
    expect(summarizeAR(rows, today)).toEqual({
      outstanding: 185,
      count: 4,
      buckets: { current: 100, d30: 50, d60: 25, d90: 10 },
    });
  });
});

describe('overdue-invoice alert → payment reminder email', () => {
  it('the alert carries the balance + year, and the letter states them', () => {
    const now = new Date(`${Y}-07-07T12:00:00`);
    const data = {
      leases: [{ id: 'L1', tenant_name: 'City Dental', property_id: 'P1', is_active: true }],
      escalations: [], renewals: [], contracts: [],
      properties: [{ id: 'P1', name: 'Maple Plaza', corporation_id: 'C1' }],
      insurance: [],
      invoices: [{ lease_id: 'L1', property_id: 'P1', year: Y, due_date: `${Y}-01-31`, balance: 98500 }],
    };
    const alert = buildAlerts(data, undefined, now).find((a) => a.focus === 'invoice');
    expect(alert).toBeTruthy();
    expect(alert.balance).toBe(98500);
    expect(alert.invoice_year).toBe(Y);

    const email = buildPaymentReminderEmail({
      business: null, tenant_name: 'City Dental', contact_name: 'Dana Lee',
      tenant_email: 'billing@citydental.example', propertyName: 'Maple Plaza',
      year: alert.invoice_year, balance: alert.balance, dueDate: alert.date,
    });
    expect(email.subject).toContain('Payment Reminder');
    expect(email.body).toContain('$98,500.00');
    expect(email.body).toContain(`January 31, ${Y}`);
    expect(email.to).toBe('billing@citydental.example');
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
