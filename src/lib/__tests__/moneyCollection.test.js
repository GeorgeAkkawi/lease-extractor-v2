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

describe('AR summary (summarizeAR) — months behind, not 30/60/90 aging', () => {
  it('counts tenants behind on rent (annual invoices) + overdue reconciliations, skips draft/void/paid', () => {
    const today = new Date(`${Y}-07-07T12:00:00`); // 7 calendar months have come due
    const rows = [
      // A — behind: full-year annual bill, nothing paid → ~7 months' rent overdue (2+ bucket).
      { lease_id: 'A', display_status: 'sent', kind: 'annual', year: Y, total_amount: 98500, amount_paid: 0, balance: 98500, due_date: `${Y}-08-01` },
      // B — on track: paid the 7 months due so far of a $24k/yr bill; a balance remains but isn't behind.
      { lease_id: 'B', display_status: 'partial', kind: 'annual', year: Y, total_amount: 24000, amount_paid: 14000, balance: 10000, due_date: `${Y}-08-01` },
      // C — 1 month behind: paid 6 of the 7 months due ($1k/mo).
      { lease_id: 'C', display_status: 'partial', kind: 'annual', year: Y, total_amount: 12000, amount_paid: 6000, balance: 6000, due_date: `${Y}-08-01` },
      // D — an overdue year-end reconciliation (a lump true-up past its due date → severe bucket).
      { lease_id: 'D', display_status: 'overdue', kind: 'reconciliation', year: Y, total_amount: 700, amount_paid: 0, balance: 700, due_date: `${Y}-01-31` },
      { display_status: 'draft', kind: 'annual', year: Y, total_amount: 999, amount_paid: 0, balance: 999, due_date: `${Y}-01-01` }, // drafts never count
      { display_status: 'void', kind: 'annual', year: Y, total_amount: 999, amount_paid: 0, balance: 999, due_date: `${Y}-01-01` },  // voids never count
      { lease_id: 'E', display_status: 'paid', kind: 'annual', year: Y, total_amount: 12000, amount_paid: 12000, balance: 0, due_date: `${Y}-01-01` }, // settled
    ];
    // amountBehind: A = round2(98500/12 × 7) = 57458.33; C = 1000; D = 700 → 59158.33.
    // toMatchObject tolerates the new `detail` list while pinning the aggregates unchanged.
    expect(summarizeAR(rows, today)).toMatchObject({
      outstanding: 115200, // 98500 + 10000 + 6000 + 700 (every owing balance, behind or not)
      count: 4,
      tenantsBehind: 3, // A, C, D (B is caught up)
      amountBehind: 59158.33,
      byMonthsBehind: { m1: 1, m2plus: 2 }, // C is 1 month; A (7 mo) + D (recon) are severe
    });
  });

  it('the detail list names each owing tenant, carries its FY + kind, and leads with the most behind', () => {
    const today = new Date(`${Y}-07-07T12:00:00`);
    const rows = [
      { id: 'i-B', lease_id: 'B', display_status: 'partial', kind: 'annual', year: Y, total_amount: 24000, amount_paid: 14000, balance: 10000, due_date: `${Y}-08-01` }, // caught up
      { id: 'i-C', lease_id: 'C', display_status: 'partial', kind: 'annual', year: Y, total_amount: 12000, amount_paid: 6000, balance: 6000, due_date: `${Y}-08-01` },  // 1 month behind
      { id: 'i-A', lease_id: 'A', display_status: 'sent', kind: 'annual', year: Y, total_amount: 98500, amount_paid: 0, balance: 98500, due_date: `${Y}-08-01` },         // 7 months behind
      { id: 'i-D', lease_id: 'D', display_status: 'overdue', kind: 'reconciliation', year: Y, total_amount: 700, amount_paid: 0, balance: 700, due_date: `${Y}-01-31` },   // recon overdue
    ];
    const info = {
      A: { tenant_name: 'Alpha Co', occupancyStartIso: null },
      B: { tenant_name: 'Bravo LLC', occupancyStartIso: null },
      C: { tenant_name: 'Charlie Inc', occupancyStartIso: null },
      D: { tenant_name: 'Delta PC', occupancyStartIso: null },
    };
    const { detail } = summarizeAR(rows, today, info);
    expect(detail).toHaveLength(4);
    // Sorted most-behind first: A (7 mo) → D (recon, 1) / C (1 mo) → B (not behind, last).
    expect(detail[0]).toMatchObject({ lease_id: 'A', tenant_name: 'Alpha Co', year: Y, kind: 'annual', behind: true, monthsBehind: 7 });
    expect(detail[detail.length - 1]).toMatchObject({ lease_id: 'B', tenant_name: 'Bravo LLC', behind: false });
    const recon = detail.find((d) => d.lease_id === 'D');
    expect(recon).toMatchObject({ isReconciliation: true, kind: 'reconciliation', behind: true, amountBehind: 700 });
    // Every owing invoice appears with its tenant name + FY tag.
    expect(detail.map((d) => d.tenant_name).sort()).toEqual(['Alpha Co', 'Bravo LLC', 'Charlie Inc', 'Delta PC']);
    expect(detail.every((d) => d.year === Y)).toBe(true);
  });
});

describe('behind-on-rent alert → payment reminder email', () => {
  it('the alert states how many months behind + the amount, and the letter reflects it', () => {
    const now = new Date(`${Y}-07-07T12:00:00`); // 7 months have come due
    const data = {
      leases: [{ id: 'L1', tenant_name: 'City Dental', property_id: 'P1', is_active: true }],
      escalations: [], renewals: [], contracts: [],
      properties: [{ id: 'P1', name: 'Maple Plaza', corporation_id: 'C1' }],
      insurance: [],
      // A full-year annual invoice, nothing paid → behind on the months that have come due.
      invoices: [{ lease_id: 'L1', property_id: 'P1', year: Y, due_date: `${Y}-01-31`, balance: 98500, total_amount: 98500, amount_paid: 0, kind: 'annual' }],
    };
    const alert = buildAlerts(data, undefined, now).find((a) => a.focus === 'invoice');
    expect(alert).toBeTruthy();
    expect(alert.title).toContain('Behind on rent');
    expect(alert.balance).toBe(98500);
    expect(alert.invoice_year).toBe(Y);
    expect(alert.months_behind).toBe(7);
    expect(alert.amount_behind).toBe(57458.33);

    const email = buildPaymentReminderEmail({
      business: null, tenant_name: 'City Dental', contact_name: 'Dana Lee',
      tenant_email: 'billing@citydental.example', propertyName: 'Maple Plaza',
      year: alert.invoice_year, balance: alert.balance, dueDate: alert.date,
      monthsBehind: alert.months_behind, amountBehind: alert.amount_behind,
    });
    expect(email.subject).toContain('Rent Reminder');
    expect(email.body).toContain('7 months behind on rent');
    expect(email.body).toContain('$57,458.33');
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
