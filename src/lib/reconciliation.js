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
import { camTaxAdjustmentTotal } from './adjustments';

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

// ---- The estimate, month by month (0089) ------------------------------------------------
// The exact twin of monthlyBases (escalations.js), for CAM & tax and roof instead of rent.
//
// George, 2026-08-04: *"the previous months aren't affected and shouldn't be reconciled at the
// new figures because they would be part of the old lease."* A rent change had somewhere to
// live — rent_escalations is a ledger of dated facts. The estimate did not: it is one scalar
// on the lease, so raising it in August silently re-priced January.
//
// THE ERA RULE, identical to monthlyBases so the two can't drift: the LIVE scalar is
// authoritative for the current era (the segment at or after the latest dated row), and the
// ledger answers for any earlier segment. A month before every row falls back to the live
// figure — the same bounded degradation monthlyBases documents, and it is why a change writes
// a CLOSING row carrying the old figure rather than only a boundary row.
//
//   estimates — lease_estimates rows for this lease: { effective_date, cam_tax_annual, roof_annual }
//   share     — the v_tenant_shares row (billedComponents supplies the live era)
// Returns { camTax: number[12], roof: number[12] } — ANNUAL rates in effect that month, the
// same convention monthlyBases uses, so callers divide by 12 exactly as they already do.
//
// ⚠ An EMPTY ledger returns the live figure for all twelve months, which is byte-for-byte the
// behaviour that existed before 0089. That is what makes the table shippable without a
// migration of every existing lease.
export function monthlyEstimates(estimates, share, year) {
  const live = billedComponents(share);
  const flat = (v) => Array(12).fill(round2(v));
  // A GROSS lease bills no estimate at all — the components are carved out of the flat rent
  // (billedComponents above) — so a dated estimate ledger has nothing to say about it.
  if (live.gross) return { camTax: flat(live.camTax), roof: flat(live.roof) };

  const rowsFor = (key) => (Array.isArray(estimates) ? estimates : [])
    .filter((e) => e && e[key] != null && e.effective_date)
    .map((e) => ({ t: estDate(e.effective_date), v: round2(Number(e[key]) || 0) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);

  const series = (key, liveValue) => {
    const rows = rowsFor(key);
    if (!rows.length) return flat(liveValue);
    const maxT = rows[rows.length - 1].t;
    const out = [];
    for (let m = 1; m <= 12; m++) {
      const ref = new Date(year, m - 1, 1, 12).getTime(); // first of the month, local noon
      const prior = rows.filter((r) => r.t <= ref);
      if (!prior.length) { out.push(round2(liveValue)); continue; }
      const latest = prior[prior.length - 1];
      // Latest applicable row IS the globally-latest → the current era → the live scalar wins.
      // Otherwise a later row supersedes it → historical segment → read the ledger.
      out.push(latest.t === maxT ? round2(liveValue) : latest.v);
    }
    return out;
  };

  return {
    camTax: series('cam_tax_annual', live.camTax),
    // A tenant who isn't roof-responsible is billed no roof, whatever any row says.
    roof: share.roof_responsible ? series('roof_annual', live.roof) : flat(0),
  };
}

// The whole year's estimate as ONE annual figure, summing the twelve monthly rates. This is
// what a mid-year change actually means for the year: eight months at the old figure and four
// at the new is not "the new figure", and billing it as such is what re-priced settled months.
export const annualFromMonthly = (byMonth) =>
  round2((byMonth || []).reduce((s, v) => s + (Number(v) || 0) / 12, 0));

function estDate(d) {
  if (!d) return NaN;
  const s = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d;
  return new Date(s).getTime();
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
// ⚠ `adjustments` — the year's lease_adjustments rows (0082). A CAM & tax CORRECTION
// means the tenant has ALREADY been billed that much more (or less) CAM this year, so it
// belongs on the estimate side. Leave it out and ⚖ Reconcile trues up as though they
// hadn't been — charging the same dollars twice. Only camtax-kind rows count (a late fee
// or a base correction is not CAM), and an unrecognized kind deliberately doesn't offset.
// Returns { est, actual, estTotal, actualTotal, diff, direction, lines, camTaxAdjust }
// where diff = actual − estimate (> 0 ⇒ the tenant owes the shortfall; < 0 ⇒ the
// landlord owes the tenant a refund; within ±5¢ ⇒ even).
// ⚠ `estimates` + `year` (0089) — the lease_estimates ledger. Without them the estimate side
// is today's scalar applied to all twelve months, which is what silently mis-settled a year
// whose estimate moved part way through: eight months billed at $54,000/yr and four at
// $60,000/yr is not "$60,000 billed", and truing up as though it were is wrong by the whole
// difference, in the direction of refunding money that was never collected. Omitting them is
// still safe — an absent or empty ledger produces exactly the old figures.
// `monthly` is the already-computed { camTax, roof } pair for callers that hold it (the Ledger
// roll builds it per lease anyway) — passing it rather than the raw rows guarantees the
// reconcile settles against the very same months the ledger priced, not a second derivation.
export function reconcileFigures({ share, adjustments = null, estimates = null, monthly = null, year = null }) {
  const { cam, tax, roof } = billedComponents(share);
  const actual = actualComponents(share);
  const camTaxAdjust = camTaxAdjustmentTotal(adjustments);

  // What was actually billed across the year, month by month, collapsed back to one annual
  // figure. Identical to `cam + tax` whenever nothing was dated, so the common path is
  // unchanged to the cent.
  const y = Number(year) || new Date().getFullYear();
  const byMonth = (monthly?.camTax && monthly?.roof) ? monthly : monthlyEstimates(estimates, share, y);
  const segCamTax = annualFromMonthly(byMonth.camTax);
  const segRoof = annualFromMonthly(byMonth.roof);
  // Keep the stored cam/tax split untouched unless the ledger genuinely moved the figure —
  // a legacy lease with the two entered separately keeps reporting them separately. When it
  // DID move, the combined figure goes on `cam` with `tax` zeroed, which is the convention
  // every other writer and reader of these columns already follows.
  const moved = Math.abs(segCamTax - round2(cam + tax)) > RECON_DUST;
  const est = moved
    ? { cam: segCamTax, tax: 0, roof: segRoof }
    : { cam, tax, roof: Math.abs(segRoof - roof) > RECON_DUST ? segRoof : roof };

  // CAM and property tax reconcile together as ONE combined "CAM & tax" line — the
  // landlord bills a single combined estimate, so they true up as a single figure.
  const estCamTax = round2(round2(est.cam + est.tax) + camTaxAdjust);
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

  return { est, actual, estTotal, actualTotal, diff, direction, lines, camTaxAdjust };
}
