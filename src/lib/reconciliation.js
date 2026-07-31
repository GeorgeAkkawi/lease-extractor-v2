// Estimated CAM/tax vs actual — the shared reconciliation math (0060).
//
// During the year the tenant pays the lease's typed ESTIMATE for CAM / tax / roof
// (the true CAM is only known when the year closes); the app tracks the ACTUAL
// share in the background. This module is the one source of truth for:
//   • billedComponents(share)  — what the tenant is billed this year
//                                (estimate-preferred per component; mirrors the
//                                draft-invoice edge function exactly), and
//   • reconcileFigures(...)    — the year-end estimate-vs-actual comparison the
//                                live Difference column AND the Reconcile action
//                                both use, so they can never disagree.
//
// Pure code, no I/O — unit-tested in __tests__/reconciliation.test.js.

// Balances within ±5¢ are rounding dust, not money owed (same convention as the
// 0055 v_invoice_balances clamp).
export const RECON_DUST = 0.05;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// The figures the tenant is billed for `share`'s year: each component uses the
// lease's estimate when one is typed, else the actual share (so a lease with no
// estimates bills exactly as before). CAM and property tax are billed together as
// one combined "CAM & tax" estimate — `camTax` is that single figure the landlord
// enters and the tenant is billed. (Storage keeps the two columns: a combined
// estimate is saved as est_cam_annual = the whole figure with est_tax_annual = 0,
// so `cam + tax` is always the combined amount; older leases with the two entered
// separately still sum correctly.) Roof stays its own separate line and only ever
// bills to a roof-responsible tenant, estimate or not.
export function billedComponents(share) {
  // GROSS LEASE (0073) — the flat rent already INCLUDES taxes & CAM, so the tenant's
  // share is carved OUT of it rather than added on top. George's rule: the actual
  // pro-rata share IS their CAM & tax; base = flat rent − that share; the total is
  // the flat rent, always. So as the year's actuals are entered the split shifts but
  // the figure the tenant pays never moves — the flat deposit keeps settling exactly.
  // Estimates are never read here: an estimate answers "what should we bill ahead of
  // the actual?", which a gross lease never asks.
  if (share.lease_type === 'gross') {
    const flat = round2(share.base_rent || 0);
    const roofA = share.roof_responsible ? round2(share.roof_amt || 0) : 0;
    const camA = round2(Number(share.cam_amount || 0) + Number(share.tax_amount || 0));
    // The flat rent is the ceiling. If the share ever exceeds it the landlord is
    // absorbing the excess — components clamp so base floors at 0 instead of going
    // negative (which would break the base + camTax + roof === owed invariant).
    const roof = Math.min(roofA, flat);
    const camTax = Math.min(camA, round2(flat - roof));
    const base = round2(flat - camTax - roof);
    return {
      cam: round2(camTax), tax: 0, camTax: round2(camTax), roof: round2(roof),
      base, total: flat,
      // Dormant by construction: no estimate is billed, so the Difference column,
      // ⚖ Reconcile and the carried-over banner all stay quiet even if stale est_*
      // values are still sitting on the row.
      anyEstimate: false,
      gross: true,
      clamped: round2(camA + roofA) > flat + RECON_DUST,
    };
  }
  const cam = share.est_cam_annual != null ? Number(share.est_cam_annual) : Number(share.cam_amount || 0);
  const tax = share.est_tax_annual != null ? Number(share.est_tax_annual) : Number(share.tax_amount || 0);
  const roof = share.roof_responsible
    ? (share.est_roof_annual != null ? Number(share.est_roof_annual) : Number(share.roof_amt || 0))
    : 0;
  const anyEstimate =
    share.est_cam_annual != null ||
    share.est_tax_annual != null ||
    (!!share.roof_responsible && share.est_roof_annual != null);
  const base = round2(share.base_rent || 0);
  return {
    cam: round2(cam), tax: round2(tax), camTax: round2(cam + tax), roof: round2(roof),
    base, total: round2(base + cam + tax + roof),
    anyEstimate, gross: false, clamped: false,
  };
}

// The tenant's ACTUAL share of the year's expenses (what reconciliation trues up to).
export function actualComponents(share) {
  return {
    cam: round2(share.cam_amount || 0),
    tax: round2(share.tax_amount || 0),
    roof: share.roof_responsible ? round2(share.roof_amt || 0) : 0,
  };
}

// Estimate-vs-actual for one tenant-year.
//   share — the v_tenant_shares row (actuals + current estimate fields)
// The estimate side is the tenant's CURRENT typed estimate (billedComponents — the
// exact figure the Finances "Estimated" column shows and that draft-invoice bills),
// so on screen Estimated − Actual always equals the Difference, and the Reconcile
// settlement matches what the landlord sees. Reconciliation is only meaningful once
// an estimate is typed; with none, est == actual (its plain actual share) → nothing
// owed, and the UI keeps the whole estimated/difference view dormant.
// Returns { est, actual, estTotal, actualTotal, diff, direction, lines } where
// diff = actual − estimate (> 0 ⇒ the tenant owes the shortfall; < 0 ⇒ the
// landlord owes the tenant a refund; within ±5¢ ⇒ even).
export function reconcileFigures({ share }) {
  const { cam, tax, roof } = billedComponents(share);
  const est = { cam, tax, roof };
  const actual = actualComponents(share);

  // CAM and property tax reconcile together as ONE combined "CAM & tax" line — the
  // landlord bills a single combined estimate, so they true up as a single figure.
  const estCamTax = round2(est.cam + est.tax);
  const actualCamTax = round2(actual.cam + actual.tax);
  const lines = [
    { key: 'camtax', label: 'CAM & tax', est: estCamTax, actual: actualCamTax, diff: round2(actualCamTax - estCamTax) },
  ];
  // Roof rides the same treatment but stays its own separate line — and only for
  // a roof-responsible tenant (or when a roof figure was actually billed).
  if (share.roof_responsible || est.roof > 0) {
    lines.push({ key: 'roof', label: 'Roof', est: est.roof, actual: actual.roof, diff: round2(actual.roof - est.roof) });
  }

  const estTotal = round2(lines.reduce((s, l) => s + l.est, 0));
  const actualTotal = round2(lines.reduce((s, l) => s + l.actual, 0));
  const diff = round2(actualTotal - estTotal);
  const direction = Math.abs(diff) <= RECON_DUST ? 'even' : diff > 0 ? 'tenant_owes' : 'landlord_owes';

  return { est, actual, estTotal, actualTotal, diff, direction, lines };
}
