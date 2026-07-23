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
import { describe, it, expect } from 'vitest';
import {
  resyncYearBillingToEstimate, updateLease, getYearInvoice, getMonthlyRent,
  recordPayment, ensureInvoice,
} from '../api';
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

  it('leaves a bank-imported or manually-noted month untouched — only re-stamps system marks', async () => {
    const invId = (await getYearInvoice('lease-2', Y)).id;
    // A real deposit tagged to March (bank import) and a noted wire in April — both at
    // amounts that are NOT the estimate-based owed. These must survive a resync so a
    // genuine short/over payment still trues up at reconcile.
    await recordPayment({ invoice_id: invId, lease_id: 'lease-2', amount: 8000, paid_date: `${Y}-03-04`, method: 'check', note: null, period_month: 3, import_id: 'imp-1' });
    await recordPayment({ invoice_id: invId, lease_id: 'lease-2', amount: 8100, paid_date: `${Y}-04-04`, method: 'ach', note: 'wire ref 55', period_month: 4 });

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
