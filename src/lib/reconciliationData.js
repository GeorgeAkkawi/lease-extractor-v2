// Year-end reconciliation report data — the live figures behind the downloadable
// Excel (reconciliationExcel.js). No AI, no arithmetic in a model: it reads the same
// tenant-share rows, itemized expenses, and reconciliation math the Financials
// per-tenant breakdown already shows on screen, so the workbook can never disagree
// with the app.
//
// One honest mapping the app's model forces: the ESTIMATE is a single combined figure
// per tenant (est_cam_annual carries the whole CAM & tax estimate; roof separate) —
// there is no per-item estimate. So the report ITEMIZES the ACTUALS (each CAM bucket,
// each tax line, roof) as the tenant's pro-rata share, shows the estimate as the
// combined figure, and computes variance at the total level via reconcileFigures.

import {
  getProperty, getTenantShares, listCamLineItems, listTaxLineItems,
  getExpenseRecord, getPropertyMonthlyRoll, listRenewals,
} from './api';
import { reconcileFigures, billedComponents } from './reconciliation';
import { componentizeSchedule } from './ledger';
import { adjustmentKindInfo } from './adjustments';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Whole-month term length from a day span (robust to either expiration convention).
function termMonths(start, end) {
  if (!start || !end) return null;
  const s = new Date(`${start}T12:00:00`);
  const e = new Date(`${end}T12:00:00`);
  if (isNaN(s) || isNaN(e) || e < s) return null;
  return Math.round((e - s) / 86400000 / (365.25 / 12));
}

// Shape ONE tenant's reconciliation report from its live rows. Pure — no I/O — so it's
// unit-testable with fixtures. Returns everything the Excel sheet renders.
//   share       — the v_tenant_shares row (actuals + estimate fields)
//   camItems    — the property's billable CAM line items [{label, amount, billable}]
//   taxItems    — the property's tax line items [{label, amount}]
//   roofTotal   — the property's roof_total (expense record)
//   buildingSf  — the property's building square footage (0 if unknown)
//   roll        — this lease's getPropertyMonthlyRoll row (for the monthly base) or null
//   renewals    — the lease's renewal_options rows
//   property    — { name, address }
export function shapeTenantReport({ share, camItems = [], taxItems = [], roofTotal = 0, buildingSf = 0, roll = null, renewals = [], adjustments = [], property = {}, year }) {
  const sqft = Number(share.square_footage) || 0;
  const sharePct = Number(share.share_pct) || (buildingSf > 0 ? sqft / buildingSf : 0);
  // Settle against the months the LEDGER priced, not against today's scalar spread over the
  // whole year (0089) — the roll already carries them, so the two can't disagree.
  // ⚠ And against the months the tenant was actually HERE. The roll's schedule is the very
  // object the invoice prorated by, so counting its in-term months here needs no second
  // derivation and no extra query. A report built without a roll keeps the full-year basis.
  const inTerm = roll?.schedule
    ? Object.values(roll.schedule).filter((c) => !c.outsideTerm).length
    : 12;
  const fig = reconcileFigures({
    share, adjustments, year, inTerm,
    monthly: roll?.camTaxByMonth && roll?.roofByMonth
      ? { camTax: roll.camTaxByMonth, roof: roll.roofByMonth }
      : null,
  });
  const est = billedComponents(share);
  // ⚠ The PRORATED actuals, straight off the settlement — not a second call to
  // actualComponents. The itemized lines below scale by actual ÷ property total, so taking
  // the un-prorated figure here would print lines that don't sum to what was settled, and
  // `variance = fig.diff` (asserted below) would quietly stop holding for a part-year tenant.
  const actual = fig.actual;
  // The rent as BILLED: the lease's base for a net tenant; on a gross lease the flat
  // rent LESS the expense share carved out of it, so base + expenses still totals the
  // flat rent the tenant actually pays (est.base is that carve).
  const baseAnnual = est.base;

  // Monthly base — escalation-aware from the ledger's own schedule when we have it.
  let monthlyBase = Array(12).fill(round2(baseAnnual / 12));
  if (roll?.schedule) {
    const comp = componentizeSchedule({ schedule: roll.schedule, factor: roll.factor, camTaxAnnual: roll.camTaxAnnual, roofAnnual: roll.roofAnnual, camTaxByMonth: roll.camTaxByMonth, roofByMonth: roll.roofByMonth, adjustments: roll.adjustments });
    monthlyBase = Array.from({ length: 12 }, (_, i) => round2(Number(comp[i + 1]?.base) || 0));
  }

  // Itemized ACTUALS as the tenant's share. Scale each item by the tenant's effective
  // fraction (actual share ÷ property total) so the lines sum to the tenant's actual
  // component even under a per-lease share override.
  const camTotal = camItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const taxTotal = taxItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const camFrac = camTotal > 0 ? actual.cam / camTotal : 0;
  const taxFrac = taxTotal > 0 ? actual.tax / taxTotal : 0;
  const itemsActual = [];
  for (const it of taxItems) {
    const annual = round2((Number(it.amount) || 0) * taxFrac);
    if (annual > 0.005) itemsActual.push({ label: it.label || 'Property tax', kind: 'tax', annual, psf: sqft > 0 ? annual / sqft : null });
  }
  for (const it of camItems) {
    const annual = round2((Number(it.amount) || 0) * camFrac);
    if (annual > 0.005) itemsActual.push({ label: it.label || 'CAM', kind: 'cam', annual, psf: sqft > 0 ? annual / sqft : null });
  }
  if (share.roof_responsible && actual.roof > 0.005) {
    itemsActual.push({ label: 'Roof', kind: 'roof', annual: round2(actual.roof), psf: sqft > 0 ? actual.roof / sqft : null });
  }

  // The estimate side carries the year's CAM & tax CORRECTIONS (0082) — the same figure
  // reconcileFigures uses, so this sheet can never disagree with the on-screen Difference.
  const estCamTax = round2(round2(fig.est.cam + fig.est.tax) + (Number(fig.camTaxAdjust) || 0));
  const actualCamTax = round2(actual.cam + actual.tax);
  const estRoof = fig.est.roof;
  const actualRoof = round2(actual.roof);
  const totalOwedEst = round2(baseAnnual + estCamTax + estRoof);
  const totalOwedActual = round2(baseAnnual + actualCamTax + actualRoof);
  const variance = round2(totalOwedActual - totalOwedEst); // = fig.diff (base cancels)

  // Plain-English insights, keyed off the same reconcile direction the app uses.
  const insights = [];
  if (est.anyEstimate) {
    if (fig.direction === 'even') {
      insights.push(`CAM & tax came in on estimate — nothing to settle for ${year}.`);
    } else if (fig.direction === 'tenant_owes') {
      insights.push(`CAM & tax actuals ran ${money(fig.diff)} above the estimate — the tenant owes ${money(fig.diff)}.`);
    } else {
      insights.push(`CAM & tax came in ${money(Math.abs(fig.diff))} under the estimate — refund ${money(Math.abs(fig.diff))} to the tenant.`);
    }
    // The single largest line-level swing, for context.
    const camTaxDiff = round2(actualCamTax - estCamTax);
    if (Math.abs(camTaxDiff) > 0.5) {
      insights.push(`CAM & tax: billed ${money(estCamTax)} estimated vs ${money(actualCamTax)} actual (${camTaxDiff < 0 ? money(Math.abs(camTaxDiff)) + ' under' : money(camTaxDiff) + ' over'}).`);
    }
    if (share.roof_responsible && Math.abs(actualRoof - estRoof) > 0.5) {
      const rd = round2(actualRoof - estRoof);
      insights.push(`Roof: billed ${money(estRoof)} estimated vs ${money(actualRoof)} actual (${rd < 0 ? money(Math.abs(rd)) + ' under' : money(rd) + ' over'}).`);
    }
  } else if (est.gross) {
    insights.push(`Gross lease — CAM & taxes are included in the flat rent of ${money(Number(share.base_rent) || 0)}. The itemized share below is carved OUT of that rent, not billed on top, so there is nothing to settle at year end.`);
    if (est.clamped) {
      insights.push('This tenant’s expense share exceeds the flat rent — the rent is the ceiling, so the excess is absorbed by the landlord and the base rent shows as $0.');
    }
  } else {
    insights.push('No CAM & tax estimate was set for this tenant — the actual share below is what they owe for the year.');
  }

  // Lease-terms reference: the committed term + each renewal option.
  const terms = [{
    term: 'Initial term',
    description: share.lease_terms || '',
    start: share.lease_start || null,
    end: share.lease_termination_date || null,
    months: termMonths(share.lease_start, share.lease_termination_date),
    baseRentAnnual: baseAnnual,
    notes: '',
  }];
  (renewals || []).forEach((ro, i) => {
    terms.push({
      term: ro.option_label || `Option ${i + 1}`,
      description: '',
      start: ro.start_date || null,
      end: ro.end_date || null,
      months: ro.term_months != null ? Number(ro.term_months) : termMonths(ro.start_date, ro.end_date),
      baseRentAnnual: ro.new_rent != null ? Number(ro.new_rent) : null,
      notes: [ro.notes, ro.status && ro.status !== 'pending' ? ro.status : null, ro.notice_by_date ? `notice by ${ro.notice_by_date}` : null].filter(Boolean).join(' · '),
    });
  });

  return {
    lease_id: share.lease_id,
    tenant_name: share.tenant_name,
    property_name: property.name || '',
    property_address: property.address || '',
    year: Number(year),
    sqft,
    buildingSf,
    sharePct,
    base: { annual: baseAnnual, psf: sqft > 0 ? baseAnnual / sqft : null, monthly: monthlyBase },
    estCamTax, actualCamTax, estRoof, actualRoof,
    // ⚠ CARRIED, NOT ABSORBED (2026-08-16). This figure has always been folded INTO
    // `estCamTax` above — correctly, because a correction the tenant was already billed has
    // to sit on the estimate side or the true-up charges the same dollars twice. But it was
    // folded SILENTLY: it moved TOTAL VARIANCE with no line, no memo and no count, so a
    // tenant querying their bill met a number nobody could account for. The arithmetic is
    // untouched; it now also gets a row of its own.
    camTaxAdjust: round2(Number(fig.camTaxAdjust) || 0),
    camTaxAdjustCount: (adjustments || []).filter((a) => adjustmentKindInfo(a?.kind).offsetsCamTax).length,
    anyEstimate: est.anyEstimate,
    itemsActual,
    totalOwedEst, totalOwedActual, variance,
    direction: fig.direction,
    insights,
    terms,
  };
}

// Fetch everything the report needs for a property + year and shape one entry per
// tenant. Returns { property, year, tenants:[…] }.
export async function buildReconciliationReport({ propertyId, year }) {
  const [property, shares, camItemsAll, taxItems, expense, roll] = await Promise.all([
    getProperty(propertyId),
    getTenantShares(propertyId, year),
    listCamLineItems(propertyId, year),
    listTaxLineItems(propertyId, year),
    getExpenseRecord(propertyId, year),
    getPropertyMonthlyRoll(propertyId, year),
  ]);
  const buildingSf = Number(property?.building_sf) || 0;
  const roofTotal = Number(expense?.roof_total) || 0;
  // Only BILLABLE CAM items reach a tenant's bill (the "not billed to tenants" family
  // is tracked for the owner's records but never charged).
  const camItems = (camItemsAll || []).filter((it) => it.billable !== false);
  const rollByLease = Object.fromEntries((roll || []).map((r) => [r.lease_id, r]));

  const renewalsByLease = Object.fromEntries(
    await Promise.all((shares || []).map(async (s) => [s.lease_id, await listRenewals(s.lease_id).catch(() => [])]))
  );

  const tenants = (shares || []).map((share) =>
    shapeTenantReport({
      share, camItems, taxItems, roofTotal, buildingSf,
      roll: rollByLease[share.lease_id] || null,
      renewals: renewalsByLease[share.lease_id] || [],
      // The roll already carries this year's rows — no extra query.
      adjustments: rollByLease[share.lease_id]?.adjustmentRows || [],
      property: property || {}, year,
    })
  );
  return { property: property || {}, year: Number(year), tenants };
}
