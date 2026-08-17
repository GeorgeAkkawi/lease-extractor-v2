// Applying a change to the CACHED property roll, so the screen answers the click before the
// server has finished with it.
//
// Nothing here makes the database quicker. Posting a charge is a lock check, a schedule read,
// an insert, a full invoice rebuild and a history write — seconds of real work, correctly
// done. The fault was that the panel sat there for all of it with the button greyed and
// nothing else moving, so the click read as ignored (George, 2026-08-17: *"post charge button
// is super slow and when i press it it once goes dark"*). The work still happens; it happens
// behind a grid that already shows the answer.
//
// ⚠ ONE MODULE, because there are two painters over ONE cache. They were about to live in two
// components — the payment one in LedgerPage, the adjustment one in MonthDetailPanel — and two
// implementations of "what does the roll look like after this" is the drift CLAUDE.md §3 is
// about: the grid and the pop-up paint the same row.
//
// ⚠ EVERY PAINT MUST MATCH WHAT THE READ PATH WOULD RETURN, not merely look right. The roll
// row is consumed by `allocatePayments` (payments + the 12-array `adjustments`) and by
// `componentizeSchedule` (`schedule` + `adjustments`), and `buildLeaseSchedule` has ALREADY
// folded each adjustment into `schedule[m].owed`. Move one of those three and not the others
// and the box, the Collected column and the pop-up start disagreeing until the refetch lands.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Record or take back a month's payment. `action` is 'mark' | 'unmark'.
export function paintPayment(rows, leaseId, month, action, amount, { today = null } = {}) {
  return (rows || []).map((r) => {
    if (r.lease_id !== leaseId) return r;
    const payments = [...(r.payments || [])];
    const byMonth = { ...r.byMonth };
    if (action === 'unmark') {
      delete byMonth[month];
      return { ...r, byMonth, payments: payments.filter((p) => Number(p.period_month) !== month) };
    }
    payments.push({ amount, period_month: month, paid_date: today });
    byMonth[month] = { amount: (byMonth[month]?.amount || 0) + amount };
    return { ...r, byMonth, payments };
  });
}

// Post a charge or a credit on a month, or take one back (`row` = the stored row, negated).
// Mirrors `buildLeaseSchedule`'s own fold, which is the whole reason it is written out rather
// than re-derived: `schedule[m].owed` already CONTAINS the adjustment, and `annual` sums it.
export function paintAdjustment(rows, leaseId, month, adjRow) {
  const m = Number(month);
  const delta = round2(Number(adjRow?.amount) || 0);
  if (!(m >= 1 && m <= 12)) return rows;
  return (rows || []).map((r) => {
    if (r.lease_id !== leaseId) return r;
    const adjustments = [...(r.adjustments || Array(12).fill(0))];
    adjustments[m - 1] = round2((adjustments[m - 1] || 0) + delta);
    const cell = r.schedule?.[m];
    const schedule = cell
      ? { ...r.schedule, [m]: { ...cell, owed: round2((Number(cell.owed) || 0) + delta), adjustment: round2((Number(cell.adjustment) || 0) + delta) } }
      : r.schedule;
    const adjustmentRows = adjRow?.remove
      ? (r.adjustmentRows || []).filter((a) => a.id !== adjRow.remove)
      : [{ ...adjRow }, ...(r.adjustmentRows || [])];
    return { ...r, adjustments, schedule, adjustmentRows, annual: round2((Number(r.annual) || 0) + delta) };
  });
}
