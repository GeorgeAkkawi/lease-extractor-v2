// "Is this tenant behind on rent?" — the ONE reframe of overdue that replaces the old
// "the annual invoice's due date has passed" model (which turned every tenant red from
// ~Aug 1, because a whole-year invoice comes due once but rent is really paid monthly).
//
// A tenant is behind by the months that have COME DUE (their first day is on/before
// today) and remain unpaid. It reads the tenant's own annual invoice: the total (already
// prorated to the months the lease covers), the amount paid, and the tenancy's
// occupancy start (min lease_start / earliest applied step — so a mid-year tenant is
// only expected to have paid the months they actually owe).
//
// Reconciliation invoices (year-end CAM/tax true-ups) are a single one-off bill, not a
// monthly stream — they keep the plain "past the due date and still owed" test.
//
// Pure + dependency-free so the dashboard alert, the AR summary cards, and the tests all
// share one definition.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const noon = (iso) => (iso ? new Date(`${iso}T12:00:00`) : null);
const monthStart = (y, m) => new Date(y, m - 1, 1, 12);
const monthEnd = (y, m) => new Date(y, m, 0, 12); // day 0 of next month = last day of this one

// How many of a year's 12 months the lease covers (its last day is on/after the
// occupancy start). Null occupancy → all 12 (an old lease with no start bills the
// full year, unchanged behavior).
export function inTermMonths(year, occupancyStartIso) {
  const occ = occupancyStartIso ? noon(occupancyStartIso) : null;
  if (!occ) return 12;
  let n = 0;
  for (let m = 1; m <= 12; m++) if (monthEnd(year, m) >= occ) n++;
  return n;
}

// Months of `year` that have COME DUE as of `today`: in-term AND their first day is
// on/before today. A past fiscal year → all in-term months are due; a future year → 0.
export function monthsDueByNow(year, occupancyStartIso, today = new Date()) {
  const occ = occupancyStartIso ? noon(occupancyStartIso) : null;
  let n = 0;
  for (let m = 1; m <= 12; m++) {
    if (occ && monthEnd(year, m) < occ) continue; // before the tenancy began
    if (monthStart(year, m) <= today) n++;         // has this month started?
  }
  return n;
}

// The behind status of ONE invoice-balance row.
//   invRow: { year, kind, total_amount, amount_paid, balance, due_date }
//   ctx:    { occupancyStartIso, owedByMonth? }  (null occupancy → full-year)
//     • owedByMonth (optional): a length-12 array [Jan..Dec] of the rent OWED each month,
//       the way the tenant is actually billed — free months $0, months before the tenancy
//       $0, mid-year rate steps blended, scaled to the invoice total (leaseSchedule.js's
//       owedByMonthForInvoice). When present, "behind" is judged against this real schedule
//       instead of a flat total ÷ in-term-months, so a tenant who's paid every DUE month is
//       never wrongly flagged just because free/not-yet-due months exist. When absent, the
//       even-split fallback below runs — byte-identical to the prior behavior.
// Returns { isReconciliation, monthsDue, monthsBehind, amountBehind, behind }.
export function monthsBehindForInvoice(invRow, ctx = {}, today = new Date()) {
  const balance = Number(invRow?.balance) || 0;
  const kind = invRow?.kind ?? 'annual';

  // Reconciliation invoices: a lump one-off, judged purely by its due date.
  if (kind === 'reconciliation') {
    const due = invRow?.due_date ? noon(invRow.due_date) : null;
    const overdue = balance > 0.05 && !!due && due < today;
    return { isReconciliation: true, monthsDue: 0, monthsBehind: overdue ? 1 : 0, amountBehind: overdue ? round2(balance) : 0, behind: overdue };
  }

  const year = Number(invRow?.year);
  const total = Number(invRow?.total_amount) || 0;
  const paid = invRow?.amount_paid != null ? Number(invRow.amount_paid) : round2(total - balance);

  // Schedule-aware path: walk the tenant's own owed-per-month, counting only months that
  // have COME DUE (their 1st is on/before today). A payment covers the earliest due months
  // first; the months whose cumulative owed runs past what's been paid are the arrears.
  const owed = Array.isArray(ctx.owedByMonth) && ctx.owedByMonth.length === 12 ? ctx.owedByMonth : null;
  if (owed) {
    let expectedByNow = 0;
    let cumulative = 0;
    let monthsBehind = 0;
    let monthsDue = 0;
    const paidR = round2(paid);
    for (let m = 1; m <= 12; m++) {
      if (monthStart(year, m) > today) continue;    // month hasn't started → not yet due
      const owe = Number(owed[m - 1]) || 0;
      if (owe <= 0) continue;                        // free / out-of-term → not a rent month
      monthsDue += 1;
      expectedByNow = round2(expectedByNow + owe);
      cumulative = round2(cumulative + owe);
      if (cumulative > paidR + 0.05) monthsBehind += 1; // this due month isn't covered by the payment
    }
    const amountBehind = round2(Math.max(0, expectedByNow - paid));
    if (amountBehind <= 0.05) {
      return { isReconciliation: false, monthsDue, monthsBehind: 0, amountBehind: 0, behind: false };
    }
    return { isReconciliation: false, monthsDue, monthsBehind: Math.max(1, monthsBehind), amountBehind, behind: true };
  }

  // Even-split fallback (no schedule supplied): total ÷ in-term months, applied to the
  // months that have come due. Unchanged behavior for callers that don't pass owedByMonth.
  const nInTerm = inTermMonths(year, ctx.occupancyStartIso);
  const perMonth = nInTerm > 0 ? total / nInTerm : 0;
  const due = monthsDueByNow(year, ctx.occupancyStartIso, today);

  const expectedByNow = round2(perMonth * due);
  const amountBehind = round2(Math.max(0, expectedByNow - paid));
  // Within a month's rounding dust → not really behind.
  if (amountBehind <= 0.05 || perMonth <= 0) {
    return { isReconciliation: false, monthsDue: due, monthsBehind: 0, amountBehind: 0, behind: false };
  }
  const monthsBehind = Math.min(due, Math.max(1, Math.round(amountBehind / perMonth)));
  return { isReconciliation: false, monthsDue: due, monthsBehind, amountBehind, behind: true };
}
