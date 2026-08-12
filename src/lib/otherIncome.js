// Slice 4c — income the property really received that is not tenant rent.
//
// THE FAILURE THIS PREVENTS, stated exactly. Before this, a deposit on a bank statement
// had two destinations: a tenant lease, or Ignore. So a $75 late fee had to be booked
// against the tenant who paid it — which credits it toward that tenant's ANNUAL
// INVOICE, so `allocatePayments` reads the month over-paid and the Ledger's Collected
// column overstates rent collection — or dropped entirely.
//
// That is the mirror of round 7's distributions gap with one crucial difference: an
// unrecorded distribution OMITS a figure, while a late fee booked as rent CORRUPTS one
// the landlord trusts. So this needs its own destination for the same reason a draw
// does, with the opposite sign.
//
// ⚠ THESE ARE NOT TAX LINES, and the distinction matters. EXPENSE_CATEGORIES maps a
// bucket onto a real line of Form 8825 / Schedule E. Ancillary income mostly does NOT
// have its own line — late fees, parking and laundry all roll into "Rents received"
// with the rent. So this list exists for VISIBILITY, which is the whole point of the
// accounting arc, and the export says so rather than implying a separate line.
// Insurance proceeds are the one genuine exception (a casualty recovery is not rent),
// which is exactly why it is broken out rather than buried in "Other".
import { monthOfYearIndex } from './isoDate';

// key is stable and stored; label is what the user reads. Order is the order shown.
export const INCOME_CATEGORIES = [
  { key: 'late_fee',   label: 'Late fees',              hint: 'Charged under the lease when rent arrives late.' },
  { key: 'parking',    label: 'Parking',                hint: 'Parking or storage let separately from the premises.' },
  { key: 'laundry',    label: 'Laundry and vending',    hint: 'Machine income from equipment on site.' },
  { key: 'utility',    label: 'Utility reimbursement',  hint: 'A tenant paying back a utility you were billed for.' },
  { key: 'insurance',  label: 'Insurance proceeds',     hint: 'A claim paid out — a recovery, not rent.' },
  { key: 'other',      label: 'Other income',           hint: 'Real income that is none of the above.' },
];

// ⚠ MONEY THE OWNER PUTS IN IS DELIBERATELY NOT ON THIS LIST. When the entity ledger was
// retired (2026-08-12) a draw became an expense category, and the symmetric move would
// have been a `contribution` category here. It was refused: every member of this list is
// money the PROPERTY EARNED, and the one export that reads it prints the lot as revenue.
// A contribution inside it would inflate that by exactly the amount the landlord funded
// himself. It uses the `transfer` disposition instead — recorded, placed, counted
// nowhere, which is what that disposition has always meant.

const BY_KEY = new Map(INCOME_CATEGORIES.map((c) => [c.key, c]));

export const incomeCategoryInfo = (key) =>
  BY_KEY.get(key) || { key: key || 'other', label: 'Other income', hint: '' };
export const incomeCategoryLabel = (key) => incomeCategoryInfo(key).label;
export const isIncomeCategory = (key) => BY_KEY.has(key);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const zero12 = () => Array(12).fill(0);

/**
 * Total and per-category breakdown, biggest first. Amounts are taken ABSOLUTE for the
 * same reason entity_ledger's were: a sign slip on one row must not silently cancel a
 * real receipt on another, which would under-report in the direction that hides money.
 *
 * Each group also carries the year month by month (2026-08-12), so the Income-and-expenses
 * workbook can lay income out beside expenses on one grid. It is grown HERE rather than in
 * the workbook for the reason `recoverabilityRows` grew its own: which bucket a receipt
 * belongs to is decided once, and a second copy of that decision beside this one would be
 * free to disagree (CLAUDE.md §3).
 *
 * ⚠ `txn_date` IS NULLABLE and the hand-entry form makes it optional, so `undated` is a
 * real figure and not a remainder — it must be shown, never spread across months. Passing
 * `year` also sends a receipt dated in a DIFFERENT year to `undated`: `other_income.year`
 * and `other_income.txn_date` are separate columns, and a row filed under this year
 * carrying last December's date must not print as this December.
 */
export function summarizeOtherIncome(rows = [], year = null) {
  const byCategory = new Map();
  let total = 0;
  const byMonth = zero12();
  let undated = 0;
  for (const r of rows || []) {
    if (!r) continue;
    const amt = Math.abs(Number(r.amount) || 0);
    total = round2(total + amt);
    const key = isIncomeCategory(r.category) ? r.category : 'other';
    const prev = byCategory.get(key) || { key, label: incomeCategoryLabel(key), total: 0, count: 0, rows: [], byMonth: zero12(), undated: 0 };
    prev.total = round2(prev.total + amt);
    prev.count += 1;
    prev.rows.push(r);
    const mi = monthOfYearIndex(r.txn_date, year);
    if (mi == null) { prev.undated = round2(prev.undated + amt); undated = round2(undated + amt); }
    else { prev.byMonth[mi] = round2(prev.byMonth[mi] + amt); byMonth[mi] = round2(byMonth[mi] + amt); }
    byCategory.set(key, prev);
  }
  const groups = [...byCategory.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  return { total, count: (rows || []).length, groups, byMonth, undated };
}

// Which tenants this income came FROM, for the rows that name one. Attribution without
// billing: the whole reason `other_income.lease_id` exists is that a late fee genuinely
// comes from a tenant and must still never touch their invoice.
export function incomeByLease(rows = []) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r?.lease_id) continue;
    const prev = out.get(r.lease_id) || { lease_id: r.lease_id, total: 0, count: 0 };
    prev.total = round2(prev.total + Math.abs(Number(r.amount) || 0));
    prev.count += 1;
    out.set(r.lease_id, prev);
  }
  return [...out.values()].sort((a, b) => b.total - a.total);
}
