// Group a statement's resolved rows by calendar month for the review screen, and
// decide which rows still "need review". A statement often spans a Dec→Jan boundary
// or two pay periods; showing one collapsible section per month — all-matched months
// collapsed, months that still want a look open — turns a 40–100-line wall into a
// scannable list. Pure functions over the `resolved` shape StatementReview builds
// (StatementReview.js:92-114): { row:{txn,duplicate,confidence,kind}, i, kind, checked,
// picked, mismatch, ... }. No React, no fetch — unit-tested directly.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2026-07" → "July 2026". Leaves an unrecognized key untouched.
function monthLabel(key) {
  const [y, m] = String(key || '').split('-');
  const name = MONTH_NAMES[Number(m) - 1];
  return name && y ? `${name} ${y}` : String(key || '');
}

// Does one resolved row still want the landlord's attention? Consistent with the
// footer's mismatch count (StatementReview.js:276) — an escalation-explained deposit is
// NOT a shortfall, so it doesn't count. The four cases, in order:
//   1. a duplicate lives in its own global group — never a review flag here;
//   2. a balance-check flag (the parser couldn't reconcile the amount) always wants a
//      look, even if the row happens to be checked;
//   3. a CHECKED row is settled unless its amount diverges from the ledger's projection
//      (the amber "≠ projected" chip) with no escalation to explain it;
//   4. an UNCHECKED row is fine only when it's a RESOLVED ignore — a keyword/rule ignore
//      (MORTGAGE/TRANSFER…) or one the user explicitly picked. Everything else unchecked
//      (an unmatched deposit, a weak "?" guess, an unticked AI suggestion) needs a look.
export function rowNeedsReview(r) {
  if (!r || !r.row) return false;
  if (r.row.duplicate) return false;
  if (r.row.txn && r.row.txn.needsReview) return true;
  if (r.checked) return !!(r.mismatch && !r.mismatch.escalation);
  const conf = r.row.confidence;
  const resolvedIgnore = r.kind === 'ignore' && (r.picked || conf === 'high' || conf === 'rule');
  return !resolvedIgnore;
}

// Bucket the resolved rows by their own transaction month (each line's OWN date decides
// its month, so a Dec/Jan statement splits correctly), sorted chronologically. Duplicates
// are excluded from the groups and every count. Each group carries the live counts the
// header shows: total lines, money-in / money-out totals, and matched vs need-review.
export function buildMonthGroups(resolved) {
  const groups = new Map();
  for (const r of resolved || []) {
    if (!r || !r.row || r.row.duplicate) continue;
    const date = r.row.txn && r.row.txn.date;
    if (!date) continue;
    const key = String(date).slice(0, 7); // "2026-07" — string sort == chronological
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [key, rowsIn] of groups) {
    const moneyIn = rowsIn.filter((r) => r.row.txn.direction === 'in');
    const moneyOut = rowsIn.filter((r) => r.row.txn.direction === 'out');
    const inTotal = moneyIn.reduce((s, r) => s + (Number(r.row.txn.amount) || 0), 0);
    const outTotal = moneyOut.reduce((s, r) => s + (Number(r.row.txn.amount) || 0), 0);
    const needsReview = rowsIn.filter(rowNeedsReview).length;
    out.push({
      key,
      label: monthLabel(key),
      moneyIn,
      moneyOut,
      inTotal,
      outTotal,
      count: rowsIn.length,
      needsReview,
      matched: rowsIn.length - needsReview,
    });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}
