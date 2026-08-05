// resyncYearBillingToEstimate: an estimate change must flow through to the year's
// invoice AND the system-recorded "mark paid" months — the tenant pays base rent +
// the CAM & tax ESTIMATE all year; the ACTUAL only enters at year-end ⚖ Reconcile
// (George, 2026-07-23: "everything up to reconciliation uses the estimate figure").
// Otherwise an invoice generated before the estimate was typed keeps billing the old
// actual-based figure and the ledger boxes stay stale (reading $4,795 while the left
// rail projects $5,300).
//
// Runs against the demo mock (forced by the vite test env), which mirrors the live
// SQL: v_tenant_shares (estimate-preferred), the 0060 kind-scoped unique invoice
// index, and the ±5¢ balance dust-clamp. Demo seed (store.js), year Y = the current
// year:
//   lease-2 (City Dental, prop-1): inv-2 — Jan+Feb tagged SYSTEM marks ($9,150 each,
//     note null, no import_id) + a $4,000 UNTAGGED partial. No estimate → bills actuals.
//   lease-4 (Sunrise Yoga, prop-2): mid-year start (Jul 1), NO invoice yet.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  resyncYearBillingToEstimate, updateLease, getYearInvoice, getMonthlyRent,
  recordPayment, ensureInvoice, markMonthPaid,
  isYearClosed, resyncLeaseBilling, resyncPropertyBilling,
  upsertExpenseRecord, createEscalation, deleteEscalation, listEscalations,
  applyEscalation, applyAddendum, createAddendum, deleteAddendum, getLease, getPropertyMonthlyRoll,
} from '../api';
import { supabase } from '../supabaseClient';
import { currentYear } from '../format';

const Y = currentYear();
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const amt = (byMonth, m) => byMonth[m]?.amount ?? null;

describe('resyncYearBillingToEstimate', () => {
  it('no live invoice → no-op, creates nothing (lease-4 has none yet)', async () => {
    expect(await getYearInvoice('lease-4', Y)).toBeNull();
    const res = await resyncYearBillingToEstimate('lease-4', 'prop-2', Y);
    expect(res).toEqual({ invoice: null, monthsResynced: 0 });
    expect(await getYearInvoice('lease-4', Y)).toBeNull(); // still nothing
  });

  it('raising the estimate moves the invoice AND the system-marked months (lease-2)', async () => {
    // Combined CAM & tax estimate of $30,000 (whole figure in est_cam, tax 0).
    await updateLease('lease-2', { est_cam_annual: 30000, est_tax_annual: 0 });
    const res = await resyncYearBillingToEstimate('lease-2', 'prop-1', Y);
    expect(res.monthsResynced).toBe(2); // Jan + Feb

    const inv = await getYearInvoice('lease-2', Y);
    expect(inv.base_rent_annual).toBe(84000);
    expect(inv.cam_annual).toBe(30000);
    expect(inv.tax_annual).toBe(0);
    expect(round2(inv.total_amount)).toBe(114000); // 84,000 + 30,000

    const { byMonth, payments } = await getMonthlyRent('lease-2', Y);
    expect(amt(byMonth, 1)).toBe(9500); // 114,000 / 12
    expect(amt(byMonth, 2)).toBe(9500);
    // The untagged $4,000 partial is left in the pool, untouched.
    expect(payments.some((p) => !p.period_month && round2(p.amount) === 4000)).toBe(true);
  });

  it('is idempotent — a second resync moves nothing', async () => {
    const res = await resyncYearBillingToEstimate('lease-2', 'prop-1', Y);
    expect(res.monthsResynced).toBe(0);
    const { byMonth } = await getMonthlyRent('lease-2', Y);
    expect(amt(byMonth, 1)).toBe(9500);
  });

  it('leaves a bank-imported or hand-recorded month untouched — only re-stamps system marks', async () => {
    const invId = (await getYearInvoice('lease-2', Y)).id;
    // A real deposit tagged to March (bank import) and a hand-recorded wire in April — both at
    // amounts that are NOT the estimate-based owed. These must survive a resync so a
    // genuine short/over payment still trues up at reconcile.
    //
    // The import needs no `source`: recordPayment defaults an import_id-bearing row to
    // 'import' precisely so this can't be forgotten. 'manual' IS stated, because a human
    // typing a figure leaves nothing to infer it from — which is the bug 0088 fixed, where a
    // blank note was read as "the app made this up" and the cheque was overwritten.
    await recordPayment({ invoice_id: invId, lease_id: 'lease-2', amount: 8000, paid_date: `${Y}-03-04`, method: 'check', note: null, period_month: 3, import_id: 'imp-1' });
    await recordPayment({ invoice_id: invId, lease_id: 'lease-2', amount: 8100, paid_date: `${Y}-04-04`, method: 'ach', note: 'wire ref 55', period_month: 4, source: 'manual' });

    // Raise the estimate again → new monthly owed = (84,000 + 36,000)/12 = 10,000.
    await updateLease('lease-2', { est_cam_annual: 36000, est_tax_annual: 0 });
    const res = await resyncYearBillingToEstimate('lease-2', 'prop-1', Y);
    expect(res.monthsResynced).toBe(2); // only the Jan + Feb system marks moved

    const { byMonth } = await getMonthlyRent('lease-2', Y);
    expect(amt(byMonth, 1)).toBe(10000);
    expect(amt(byMonth, 2)).toBe(10000);
    expect(amt(byMonth, 3)).toBe(8000); // bank import — untouched
    expect(amt(byMonth, 4)).toBe(8100); // manually noted — untouched
  });

  // The regression 0088 exists for. Before it, provenance was inferred as "no import_id and
  // no note" — and the two ways a landlord records a REAL amount (the Ledger cell click and
  // the month panel's "Record $X received") both leave the note null. So a cheque he typed
  // was deleted and replaced with money that never arrived, after which no bank statement
  // could ever reconcile against that month again.
  it('never rewrites a payment the landlord typed, even with no note on it', async () => {
    const invId = (await getYearInvoice('lease-2', Y)).id;
    // Exactly the shape MonthDetailPanel's "Record $X received" writes: an amount, no note,
    // no import. Deliberately NOT the estimate-based owed, so the old guard would have moved it.
    await recordPayment({
      invoice_id: invId, lease_id: 'lease-2', amount: 7777.77, paid_date: `${Y}-05-06`,
      method: 'check', note: null, period_month: 5, source: 'manual',
    });
    await updateLease('lease-2', { est_cam_annual: 48000, est_tax_annual: 0 });
    await resyncYearBillingToEstimate('lease-2', 'prop-1', Y);

    const { byMonth } = await getMonthlyRent('lease-2', Y);
    expect(amt(byMonth, 5)).toBe(7777.77); // the figure he entered, to the cent
    expect(amt(byMonth, 1)).toBe(11000);   // …while the system marks still follow (132,000/12)
  });

  it('markMonthPaid records a click as system and a stated receipt as manual', async () => {
    const before = (await getMonthlyRent('lease-2', Y)).payments.map((p) => p.id);
    // The Ledger grid's click — the app pricing the month off the schedule.
    await markMonthPaid('lease-2', 'prop-1', Y, 6, { amount: 500 });
    // The month panel's "Record $X received" — the landlord saying money arrived.
    await markMonthPaid('lease-2', 'prop-1', Y, 7, { amount: 500, source: 'manual' });

    const added = (await getMonthlyRent('lease-2', Y)).payments.filter((p) => !before.includes(p.id));
    expect(added.find((p) => p.period_month === 6).source).toBe('system');
    expect(added.find((p) => p.period_month === 7).source).toBe('manual');
  });

  it('prorates a mid-year lease: invoice total equals the sum of the (unequal) months', async () => {
    // Sunrise Yoga starts Jul 1 → owes Jul–Dec only. Combined CAM & tax estimate $6,000.
    await updateLease('lease-4', { est_cam_annual: 6000, est_tax_annual: 0 });
    const created = await ensureInvoice('lease-4', 'prop-2', Y); // create the (prorated) year invoice
    // Simulate two stale system marks at a flat wrong amount.
    await recordPayment({ invoice_id: created.id, lease_id: 'lease-4', amount: 5000, paid_date: `${Y}-08-02`, method: 'check', note: null, period_month: 8 });
    await recordPayment({ invoice_id: created.id, lease_id: 'lease-4', amount: 5000, paid_date: `${Y}-09-02`, method: 'check', note: null, period_month: 9 });

    await resyncYearBillingToEstimate('lease-4', 'prop-2', Y);
    const inv = await getYearInvoice('lease-4', Y);
    // 6 in-term months: base 6×$3,000 = $18,000 + CAM 6×$500 = $3,000 → $21,000.
    expect(inv.base_rent_annual).toBe(18000);
    expect(inv.cam_annual).toBe(3000);
    expect(round2(inv.total_amount)).toBe(21000);

    const { byMonth, annual } = await getMonthlyRent('lease-4', Y);
    expect(amt(byMonth, 8)).toBe(3500); // $3,000 base + $500 CAM
    expect(amt(byMonth, 9)).toBe(3500);
    expect(amt(byMonth, 1)).toBeNull(); // Jan is before the tenancy — never billed
    // Invoice total ties to the sum of the monthly boxes (George's "box == left rail").
    expect(round2(annual)).toBe(round2(inv.total_amount));
  });
});

// The stored invoice is a frozen copy; the Financials breakdown and the Ledger grid
// build UP from live data. So anything that FEEDS billing — square footage, roof
// responsibility, a rent step, an expense total, the building size — used to move the
// screens while the invoice stayed put, and everything reading that invoice (balances,
// Outstanding, the alerts' owed-by-month) went quietly stale. These pin the carry-
// through, and the two properties that make automating it safe.
//
// prop-2 (Oak Center) is the open-year property: building 6,000 SF · FY expenses
// taxes $40,000 / CAM $30,000 / roof $12,000 · lease-3 Northwind (5,000 SF, 40% share
// override, term ends ~3 weeks out so its year is prorated) · lease-4 Sunrise Yoga
// (1,000 SF = 1/6 of the building, starts Jul 1 → exactly 6 in-term months, so its
// figures are date-stable). prop-1 carries a snapshot for the current year (snap-2),
// which makes it the closed-year case.
describe('automatic follow-through — the invoice can no longer drift', () => {
  const TAXES = 40000;
  const CAM = 30000;
  const ROOF = 12000;
  const setExpenses = (cam) => upsertExpenseRecord({ property_id: 'prop-2', year: Y, taxes_total: TAXES, cam_total: cam, roof_total: ROOF });

  beforeAll(async () => {
    // Bill ACTUALS on Sunrise Yoga (the earlier block left a $6,000 combined estimate
    // on it, which is estimate-preferred and so wouldn't follow an expense change).
    await updateLease('lease-4', { est_cam_annual: null, est_tax_annual: null, est_roof_annual: null });
    await ensureInvoice('lease-3', 'prop-2', Y);
    await setExpenses(CAM);
    await resyncPropertyBilling('prop-2', Y); // normalise both invoices to the live figures
  });

  it('knows which years are closed', async () => {
    expect(await isYearClosed('prop-1', Y)).toBe(true); // snap-2
    expect(await isYearClosed('prop-2', Y)).toBe(false);
    expect(await isYearClosed('prop-2', Y + 5)).toBe(false);
  });

  it('a CLOSED year is left exactly as it was — a bill already sent does not move', async () => {
    const before = await getYearInvoice('lease-2', Y);
    await updateLease('lease-2', { square_footage: 4000 }); // would re-split the share
    try {
      expect((await resyncLeaseBilling('lease-2', 'prop-1', Y)).skipped).toBe('closed');
      expect((await resyncPropertyBilling('prop-1', Y)).skipped).toBe('closed');
      const after = await getYearInvoice('lease-2', Y);
      expect(after.total_amount).toBe(before.total_amount);
      expect(after.cam_annual).toBe(before.cam_annual);
    } finally {
      await updateLease('lease-2', { square_footage: 3000 });
    }
  });

  it('a lease billing field carries through to that lease’s invoice', async () => {
    // Baseline: 6 in-term months → ratio ½. CAM 30,000 × 1/6 = 5,000 → 2,500;
    // tax 40,000 × 1/6 = 6,666.67 → 3,333.34 (the annual share is rounded to the cent
    // before the term ratio is applied, exactly as draft-invoice does it);
    // base 36,000 → 18,000.
    const before = await getYearInvoice('lease-4', Y);
    expect(before.cam_annual).toBe(2500);
    expect(before.tax_annual).toBe(3333.34);
    expect(before.base_rent_annual).toBe(18000);

    await updateLease('lease-4', { square_footage: 2000 }); // 1/6 → 2/6 of the building
    try {
      expect((await resyncLeaseBilling('lease-4', 'prop-2', Y)).invoice).toBeTruthy();
      const after = await getYearInvoice('lease-4', Y);
      expect(after.cam_annual).toBe(5000);    // 30,000 × 2/6 × ½
      expect(after.tax_annual).toBe(6666.67); // 40,000 × 2/6 × ½
      expect(after.base_rent_annual).toBe(18000); // the rent itself did not change
      expect(round2(after.total_amount)).toBe(29666.67);
    } finally {
      await updateLease('lease-4', { square_footage: 1000 });
      await resyncLeaseBilling('lease-4', 'prop-2', Y);
    }
  });

  it('roof responsibility carries through — it decides whether roof bills at all', async () => {
    expect((await getYearInvoice('lease-4', Y)).roof_annual).toBe(0);
    await updateLease('lease-4', { roof_responsible: true });
    try {
      await resyncLeaseBilling('lease-4', 'prop-2', Y);
      expect((await getYearInvoice('lease-4', Y)).roof_annual).toBe(1000); // 12,000 × 1/6 × ½
    } finally {
      await updateLease('lease-4', { roof_responsible: false });
      await resyncLeaseBilling('lease-4', 'prop-2', Y);
    }
    expect((await getYearInvoice('lease-4', Y)).roof_annual).toBe(0);
  });

  it('a rent step that has taken effect re-prices the invoice', async () => {
    // The end state EscalationScheduleEditor produces once backfillLeaseToToday has
    // applied a past-dated step: the ledger row is applied and the lease's base rent
    // has moved with it.
    const esc = await createEscalation({
      lease_id: 'lease-4', effective_date: `${Y}-07-01`, escalation_type: 'manual',
      escalation_value: null, new_base_rent: 48000, status: 'applied',
    });
    await updateLease('lease-4', { base_rent: 48000 });
    try {
      await resyncLeaseBilling('lease-4', 'prop-2', Y);
      // 6 in-term months at $48,000/yr → $24,000 (was $18,000 at $36,000/yr).
      expect((await getYearInvoice('lease-4', Y)).base_rent_annual).toBe(24000);
    } finally {
      await deleteEscalation(esc.id);
      await updateLease('lease-4', { base_rent: 36000 });
      await resyncLeaseBilling('lease-4', 'prop-2', Y);
    }
    expect((await listEscalations('lease-4')).length).toBe(0);
    expect((await getYearInvoice('lease-4', Y)).base_rent_annual).toBe(18000);
  });

  // ⚠ The one above proves the resync WORKS when something calls it. This proves the most
  // routine money event in the app actually does. applyEscalation — the nightly sweep and the
  // on-load catch-up — moved base_rent and stopped, so every lease with an annual step drifted
  // from its own invoice for the rest of the year, every year.
  it('a step coming due rebuilds the invoice on its own, with nobody calling the resync', async () => {
    await ensureInvoice('lease-4', 'prop-2', Y);
    const before = (await getYearInvoice('lease-4', Y)).base_rent_annual;
    const esc = await createEscalation({
      lease_id: 'lease-4', effective_date: `${Y}-07-01`, escalation_type: 'manual',
      escalation_value: null, new_base_rent: 48000, status: 'scheduled',
    });
    try {
      await applyEscalation({ ...esc, lease_id: 'lease-4' }); // exactly what the sweep does
      expect(Number((await getLease('lease-4')).base_rent)).toBe(48000);
      // 6 in-term months at $48,000/yr → $24,000. Nothing here called a resync.
      expect((await getYearInvoice('lease-4', Y)).base_rent_annual).toBe(24000);
      expect((await getYearInvoice('lease-4', Y)).base_rent_annual).not.toBe(before);
    } finally {
      await deleteEscalation(esc.id);
      await updateLease('lease-4', { base_rent: 36000 });
      await resyncLeaseBilling('lease-4', 'prop-2', Y);
    }
  });

  it('a rider that changes the RENT rebuilds the invoice, not only one that changes the size', async () => {
    await ensureInvoice('lease-4', 'prop-2', Y);
    const add = await createAddendum({
      lease_id: 'lease-4', label: 'Rent Amendment', amendment_date: `${Y}-06-15`,
      kind: 'rent', summary: null,
    });
    try {
      // A rider stating a new rent from 1 July — no size change, which is all the old
      // condition looked at.
      await applyAddendum(add, {
        escalations: [{ effective_date: `${Y}-07-01`, escalation_type: 'manual', new_base_rent: 60000 }],
      }, new Date(`${Y}-08-04T12:00:00`));
      expect((await getYearInvoice('lease-4', Y)).base_rent_annual).toBe(30000); // 6 mo @ 60,000
    } finally {
      await supabase.from('rent_escalations').delete().eq('addendum_id', add.id);
      await deleteAddendum(add.id);
      await updateLease('lease-4', { base_rent: 36000 });
      await resyncLeaseBilling('lease-4', 'prop-2', Y);
    }
  });

  // The backstop for everything the JS carry-throughs can't reach — above all the NIGHTLY SQL
  // sweep (apply_due_escalations, 0024/0047), which moves base_rent server-side where no JS
  // runs at all. Rather than a second implementation of the billing math in Postgres, the
  // Ledger measures the gap between what the lease says and what the bill was built at.
  it('the Ledger reports an invoice that has fallen behind the lease, and Rebuild closes it', async () => {
    await ensureInvoice('lease-4', 'prop-2', Y);
    const clean = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === 'lease-4');
    expect(clean.drift).toBe(0); // in step to begin with

    // Exactly the state the nightly job leaves behind: an applied step and a moved base
    // rent, with nothing having touched the invoice.
    const esc = await createEscalation({
      lease_id: 'lease-4', effective_date: `${Y}-07-01`, escalation_type: 'manual',
      escalation_value: null, new_base_rent: 48000, status: 'applied',
    });
    await updateLease('lease-4', { base_rent: 48000 });
    try {
      const behind = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === 'lease-4');
      expect(behind.drift).toBe(6000); // 6 months × (48,000 − 36,000)/12
      expect(behind.invoiceTotal).toBeLessThan(behind.drift + behind.invoiceTotal);

      await resyncLeaseBilling('lease-4', 'prop-2', Y); // what the Rebuild button calls
      const fixed = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === 'lease-4');
      expect(fixed.drift).toBe(0);
    } finally {
      await deleteEscalation(esc.id);
      await updateLease('lease-4', { base_rent: 36000 });
      await resyncLeaseBilling('lease-4', 'prop-2', Y);
    }
  });

  it('a PROPERTY figure moves EVERY tenant’s invoice, not just the one being edited', async () => {
    const b3 = await getYearInvoice('lease-3', Y);
    const b4 = await getYearInvoice('lease-4', Y);
    await setExpenses(CAM * 2); // the CAM total is billed pro-rata to everyone
    try {
      const res = await resyncPropertyBilling('prop-2', Y);
      expect(res.leases).toBe(2); // both tenants' invoices followed
      // Sunrise Yoga is date-stable: 60,000 × 1/6 × ½.
      expect((await getYearInvoice('lease-4', Y)).cam_annual).toBe(5000);
      expect((await getYearInvoice('lease-4', Y)).cam_annual).toBe(round2(b4.cam_annual * 2));
      // Northwind's year is prorated against a rolling term end, so pin the doubling
      // rather than an absolute figure — the relationship is what matters.
      const a3 = await getYearInvoice('lease-3', Y);
      expect(a3.cam_annual).toBeCloseTo(b3.cam_annual * 2, 1);
      expect(a3.tax_annual).toBe(b3.tax_annual); // taxes untouched → so is the tax line
    } finally {
      await setExpenses(CAM);
      await resyncPropertyBilling('prop-2', Y);
    }
    expect((await getYearInvoice('lease-4', Y)).cam_annual).toBe(b4.cam_annual);
  });

  it('still never rewrites a bank-imported or hand-recorded payment', async () => {
    const invId = (await getYearInvoice('lease-4', Y)).id;
    await recordPayment({ invoice_id: invId, lease_id: 'lease-4', amount: 1234.56, paid_date: `${Y}-10-04`, method: 'ach', note: null, period_month: 10, import_id: 'imp-auto' });
    await recordPayment({ invoice_id: invId, lease_id: 'lease-4', amount: 2345.67, paid_date: `${Y}-11-04`, method: 'ach', note: 'wire ref 99', period_month: 11, source: 'manual' });
    await setExpenses(CAM * 3);
    try {
      await resyncPropertyBilling('prop-2', Y);
      const { byMonth } = await getMonthlyRent('lease-4', Y);
      expect(amt(byMonth, 10)).toBe(1234.56); // bank import — a recorded fact
      expect(amt(byMonth, 11)).toBe(2345.67); // manually noted
    } finally {
      await setExpenses(CAM);
      await resyncPropertyBilling('prop-2', Y);
    }
  });
});
