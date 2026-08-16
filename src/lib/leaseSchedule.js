// The term-aware monthly rent schedule for one lease-year — the ONE shared builder
// behind the monthly rent tracker, the property rent roll, the Rent Ledger, and the
// "behind on rent" math. Pure: it composes occupancyStart + monthlyBases (escalations.js)
// with monthlyScheduleForYear (abatement.js).
//
// TWO modes, keyed by whether `invoiceTotal` is passed:
//   • PROJECTION (the ledger / tracker / roll) — NO invoiceTotal. The schedule builds UP
//     from the data: the lease's own base rent + estimated-else-actual CAM/tax/roof. The
//     invoice is a downstream OUTPUT of this same data, so the ledger never reads it back
//     to reshape the base (George, 2026-07-21: "build from the data, not backwards from
//     the invoice"). factor stays 1; base shows the lease's real per-month rent.
//   • RECONCILE-TO-A-BILL (owedByMonthForInvoice → summarizeAR / the dashboard alerts) —
//     passes a specific issued invoice's total so the 12 due-month figures settle THAT bill
//     to the cent (the 0055 penny invariant), for judging how many months are behind on
//     what was actually billed. This is the only path that scales.
//
// Moved out of api.js so those AR/alert paths can build the SAME per-month owed shape a
// tenant is actually billed — instead of an even total/12 split that over-charges free
// months and mis-charges a mid-year start.
import { occupancyStart, monthlyBases } from './escalations';
import { monthlyScheduleForYear } from './abatement';
import { monthlyAdjustments } from './adjustments';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Accept either a length-12 signed array or the raw lease_adjustments rows.
function adjArray(adjustments) {
  if (!adjustments) return null;
  if (Array.isArray(adjustments) && adjustments.length === 12 && adjustments.every((v) => typeof v === 'number')) {
    return adjustments.map((v) => round2(v));
  }
  const a = monthlyAdjustments(adjustments);
  return a.some((v) => v !== 0) ? a : null;
}

// Build the term-aware monthly schedule for one lease-year. The SHAPE — which months are
// owed vs "—" (before occupancy start), which are "Free" (abated), and a mid-year rate
// change — comes from the gross base + escalation ledger + abatement windows. The TOTAL
// comes from the year's invoice when one exists (so the 12 marked months settle it to the
// cent), else the schedule's own net annual. When a frozen invoice's total differs from
// the schedule's own sum (an estimate edited after billing, or a legacy full-year invoice
// on a mid-year lease), the per-month owed is scaled so it sums exactly to the invoice —
// free / out-of-term months stay $0. Returns { schedule, annual, owedMonths,
// occupancyStartIso, factor } — factor is the invoice-scaling ratio applied to the owed
// months (1 when no scaling ran), so the ledger's component split can scale CAM&tax the
// same way the whole month was scaled.
//
// `otherByMonth` (0089) is the CAM & tax + roof twin of the escalation ledger's monthlyBases:
// a length-12 array of the annual estimate in effect each month, from monthlyEstimates
// (reconciliation.js). Omit it and every month uses otherAnnual/12, exactly as before — which
// is what silently re-priced January when the estimate moved in August.
export function buildLeaseSchedule({ year, grossBase, otherAnnual, otherByMonth = null, abatements, escalations, leaseStart, invoiceTotal, adjustments }) {
  const occ = occupancyStart({ lease_start: leaseStart }, escalations);
  const bases = monthlyBases(escalations, grossBase, year);
  const schedule = monthlyScheduleForYear({
    year, annualBaseRent: grossBase, otherAnnual, abatements,
    occupancyStartIso: occ, monthlyBases: bases, monthlyOther: otherByMonth,
  });
  const shareAnnual = round2(Object.values(schedule).reduce((s, c) => s + c.owed, 0));
  // ⚠ Per-month charges and credits (0082). They are added LAST, after any scaling and
  // after both penny-folds, so an adjustment is the exact dollar figure the landlord
  // typed — never smeared across twelve months by the invoice `factor`, and never inside
  // abatement.js's own fold (which is gated at ≤12¢ and would be wrong by Σadj).
  const adj = adjArray(adjustments);
  const adjTotal = adj ? round2(adj.reduce((s, v) => s + v, 0)) : 0;
  // An invoice's total already CONTAINS Σadj (resyncYearBillingToEstimate writes it that
  // way), so the scheduled part must scale to the total LESS the adjustments — otherwise
  // the charge would be counted twice and every month re-priced by it.
  const scaleTarget = invoiceTotal != null ? round2(Number(invoiceTotal) - adjTotal) : null;
  let factor = 1;
  if (scaleTarget != null && shareAnnual > 0 && Math.abs(scaleTarget - shareAnnual) > 0.05) {
    factor = scaleTarget / shareAnnual;
    for (let m = 1; m <= 12; m++) {
      const c = schedule[m];
      if (c.outsideTerm) continue;
      c.owed = round2(c.owed * factor);
      if (!c.abated) c.full = c.owed;
    }
    // Penny-fold so the scaled months sum EXACTLY to the scheduled target. It lands only
    // on a SCHEDULED month (adjustments haven't been applied yet), so a month that owes
    // solely because of a charge can never absorb the year's rounding cents — which would
    // break `base + camTax + roof + adj === owed` by those cents.
    const diff = round2(scaleTarget - round2(Object.values(schedule).reduce((s, c) => s + c.owed, 0)));
    if (diff !== 0) {
      for (let m = 12; m >= 1; m--) {
        if (!schedule[m].outsideTerm && schedule[m].owed > 0) { schedule[m].owed = round2(schedule[m].owed + diff); if (!schedule[m].abated) schedule[m].full = schedule[m].owed; break; }
      }
    }
  }
  if (adj) {
    for (let m = 1; m <= 12; m++) {
      const a = adj[m - 1];
      if (!a) continue;
      const c = schedule[m];
      c.owed = round2(c.owed + a);
      c.adjustment = a;
    }
  }
  const annual = Object.values(schedule).reduce((s, c) => s + c.owed, 0);
  const owedMonths = Object.values(schedule).filter((c) => !c.outsideTerm && c.owed > 0).length;
  return { schedule, annual, owedMonths, occupancyStartIso: occ, factor, adjustments: adj };
}

// How many of the year's twelve months this lease was actually in term for — the SAME
// count the invoice prorates by (resyncYearBillingToEstimate / draft-invoice both walk the
// schedule and skip `outsideTerm`). Returns 12 for a lease that covers the whole year, and
// 12 when nothing is known about the start (the safe, unchanged default).
//
// ⚠ It builds a bare schedule rather than re-testing the dates itself, so `outsideTerm` keeps
// exactly ONE definition (monthlyScheduleForYear). A second copy of "is this month in term?"
// is precisely how the year-end reconciliation drifted away from the invoice that billed it.
//
// ⚠ AND IT NEEDS THE ESCALATIONS, not just lease_start. occupancyStart pulls the start back to
// the earliest APPLIED step, because a catch-up renewal moves lease_start forward — read
// lease_start alone and a tenant of ten years renewed mid-year looks like it just moved in,
// and gets its reconciliation prorated to a few months.
export function inTermMonths({ year, leaseStart = null, escalations = [] }) {
  const occ = occupancyStart({ lease_start: leaseStart }, escalations);
  if (!occ) return 12;
  const schedule = monthlyScheduleForYear({
    year: Number(year), annualBaseRent: 0, occupancyStartIso: occ,
  });
  return Object.values(schedule).filter((c) => !c.outsideTerm).length;
}

// The same count for every tenant share on a property, as { [lease_id]: months } — what
// `recoveryFractions` needs to weigh each tenant's share by the part of the year they were
// actually here.
//
// ⚠ It exists so the FOURTH caller of this rule isn't a fourth copy of it. ⚖ Reconcile, the
// per-tenant breakdown and the invoice all prorate by inTerm/12 already; the recovery figure
// on the "What it cost you" table and in the workbook did not, which is the only reason those
// two disagreed with what a mid-year tenant actually settles at. Same escalations argument,
// same reason (a catch-up renewal moves lease_start forward — read it alone and a ten-year
// tenant looks brand new and gets prorated to a few months).
export function inTermByLease({ year, shares = [], escByLease = {} } = {}) {
  const out = {};
  for (const s of shares || []) {
    if (!s?.lease_id) continue;
    out[s.lease_id] = inTermMonths({ year, leaseStart: s.lease_start, escalations: escByLease[s.lease_id] || [] });
  }
  return out;
}

// The per-month rent OWED for an invoice's own year, as a length-12 array [Jan..Dec],
// scaled to settle exactly at the invoice total. Free months are $0, months before the
// tenancy began are $0, and a mid-year rate change bills the old rate before it. The
// invoice carries its own gross figures (base_rent_annual + cam/tax/roof_annual), so this
// works from the v_invoice_balances row alone plus the lease's escalation ledger + any
// abatement windows. Returns null when there is no invoice. This is the schedule-aware
// input arStatus.monthsBehindForInvoice / summarizeAR / the bell alerts use to decide how
// many DUE months are actually unpaid (vs a flat total/12 that mis-reads free + mid-year
// leases).
export function owedByMonthForInvoice(invoice, { leaseStart = null, escalations = [], abatements = [], adjustments = null } = {}) {
  if (!invoice) return null;
  const grossBase = Number(invoice.base_rent_annual || 0);
  const otherAnnual =
    Number(invoice.cam_annual || 0) + Number(invoice.tax_annual || 0) + Number(invoice.roof_annual || 0);
  // No gross breakdown on this invoice (a legacy row, or all components zero) → there's no
  // month-shape to build. Return null so the caller falls back to the even-split off the
  // invoice total, rather than reading an all-$0 schedule as "nothing owed / never behind".
  if (!(grossBase > 0) && !(otherAnnual > 0)) return null;
  const invoiceTotal = Number(invoice.total_amount || 0);
  const { schedule } = buildLeaseSchedule({
    year: Number(invoice.year),
    grossBase,
    otherAnnual,
    abatements,
    escalations,
    leaseStart,
    invoiceTotal,
    // ⚠ Without this the alert path scales the SCHEDULED months to a total that already
    // contains Σadj, smearing a one-month charge across the whole year.
    adjustments,
  });
  const arr = [];
  for (let m = 1; m <= 12; m++) arr.push(Number(schedule[m]?.owed) || 0);
  return arr;
}
