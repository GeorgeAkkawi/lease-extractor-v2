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

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

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
export function buildLeaseSchedule({ year, grossBase, otherAnnual, abatements, escalations, leaseStart, invoiceTotal }) {
  const occ = occupancyStart({ lease_start: leaseStart }, escalations);
  const bases = monthlyBases(escalations, grossBase, year);
  const schedule = monthlyScheduleForYear({ year, annualBaseRent: grossBase, otherAnnual, abatements, occupancyStartIso: occ, monthlyBases: bases });
  const shareAnnual = round2(Object.values(schedule).reduce((s, c) => s + c.owed, 0));
  let factor = 1;
  if (invoiceTotal != null && shareAnnual > 0 && Math.abs(round2(invoiceTotal) - shareAnnual) > 0.05) {
    factor = Number(invoiceTotal) / shareAnnual;
    for (let m = 1; m <= 12; m++) {
      const c = schedule[m];
      if (c.outsideTerm) continue;
      c.owed = round2(c.owed * factor);
      if (!c.abated) c.full = c.owed;
    }
    // Penny-fold so the scaled months sum EXACTLY to the invoice total.
    const diff = round2(Number(invoiceTotal) - round2(Object.values(schedule).reduce((s, c) => s + c.owed, 0)));
    if (diff !== 0) {
      for (let m = 12; m >= 1; m--) {
        if (!schedule[m].outsideTerm && schedule[m].owed > 0) { schedule[m].owed = round2(schedule[m].owed + diff); if (!schedule[m].abated) schedule[m].full = schedule[m].owed; break; }
      }
    }
  }
  const annual = Object.values(schedule).reduce((s, c) => s + c.owed, 0);
  const owedMonths = Object.values(schedule).filter((c) => !c.outsideTerm && c.owed > 0).length;
  return { schedule, annual, owedMonths, occupancyStartIso: occ, factor };
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
export function owedByMonthForInvoice(invoice, { leaseStart = null, escalations = [], abatements = [] } = {}) {
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
  });
  const arr = [];
  for (let m = 1; m <= 12; m++) arr.push(Number(schedule[m]?.owed) || 0);
  return arr;
}
