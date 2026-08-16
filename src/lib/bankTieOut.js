// The bank tie-out — does what the bank showed agree with what the books hold?
//
// George, 2026-08-16: *"give everything that appears on the bank statement a home to stay
// and be represented unless it is ignored."* `lineCompleteness` (dispositions.js) already
// answers half of that: every transcribed line has a DECISION. It cannot answer the other
// half, because a decision is not a record — "38 of 38 lines placed ✓" counts choices, and
// says nothing about whether the money those choices promised ever reached a table.
//
// ⚠ TWO COLUMNS FROM TWO DIFFERENT PLACES, AND THE GAP IS THE ENTIRE PRODUCT.
//   left  — every imported line for the year, grouped by what was decided about it. Pure
//           `statement_lines`, the audit record (0076).
//   right — the real rows in the books: `payments`, `cam_line_items`, `other_income`.
// The right-hand side is READ FROM THE MONEY TABLES, never from the lines. Derived from the
// left it would balance by construction and prove nothing at all — which is the failure mode
// of every reconciliation report that reconciles a thing against itself.
//
// ⚠ FOUR ROWS ARE MEANT TO READ ZERO ON THE BOOKS SIDE, AND SAY SO OUT LOUD — a transfer, a
// line left out, a deposit held, a refund. Counted nowhere, on purpose. That is George's
// "unless it is ignored", and stating it is what stops a reader treating a legitimate zero
// as a missing figure.
//
// ⚠ RENT NEVER TIES, AND IS LABELLED AS A RECONCILING ITEM. Cash off the bank against what
// was billed differs by arrears or prepayment, always. The difference is a real figure the
// Ledger already names tenant by tenant; presenting it as a tie-out failure would train the
// landlord to ignore the one panel that is supposed to be believed.
//
// ⚠ MONEY IN AND MONEY OUT ARE NEVER NETTED — the same rule, and the same reason, as
// `lineCompleteness`: a $5,000 deposit and a $5,000 withdrawal that cancel would report
// "$0 difference" on a statement where $10,000 went astray.
//
// WHAT IT CANNOT CATCH, stated on the sheet rather than left to be assumed:
//   • a line transcribed with the wrong amount — both sides carry the same wrong number
//   • money that never touched the account that was imported
//   • a line filed under the wrong heading — it ties, in the wrong bucket
//
// Nothing here reads or writes. Every function is pure over rows it was handed.
import { dispositionInfo } from './dispositions';
import { categoryFor, isOwnerCategory } from './expenseCategories';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const abs2 = (n) => round2(Math.abs(num(n)));
const money = (n) => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/**
 * The fiscal year a BOOKS row belongs to, by the same rule `statementMatch` applies to a
 * bank line: `const year = Number(txn.date.slice(0, 4))`.
 *
 * ⚠ The stored column wins, then the row's own date, then null — and null means "says
 * nothing about a year", which is included in every year rather than excluded from all of
 * them. That is deliberately the same tolerant predicate `listStatementImports`,
 * `listUnplacedLines`, `listDecidedLines` and `listOtherIncome` already use, so a line and
 * the row it produced land in the same year on both sides of this comparison. The one
 * reader that does NOT follow it is `listExpenseLineItems` (`.eq('year', year)`), which is
 * exactly why `stranded` below exists.
 */
export function rowFiscalYear(row) {
  const stored = Number(row?.year);
  if (stored) return stored;
  const d = row?.paid_date || row?.txn_date || row?.date || null;
  const fromDate = d ? Number(String(d).slice(0, 4)) : 0;
  return fromDate || null;
}

const inYear = (row, year) => {
  const y = rowFiscalYear(row);
  return y == null || Number(y) === Number(year);
};

/** Is this expense line the landlord's own money rather than the building's? ONE predicate
 *  (`isOwnerCategory`), resolved through the same bucket lookup `recoverabilityRows` uses —
 *  a second copy here would let the tie-out and the "What it cost you" table disagree about
 *  whether a draw is an expense (CLAUDE.md §3). */
const isOwnerRow = (it, buckets) => isOwnerCategory(categoryFor(it?.label, buckets).category);

/**
 * Billed and received for the year, off the roll both surfaces already hold.
 *
 * ⚠ ONE IMPLEMENTATION, because the Ledger prints these two figures at the foot of its own
 * grid ("$X of $Y billed") and the tie-out prints them beside the bank. `r.annual` is
 * `buildLeaseSchedule`'s sum of `owed` — the same array `ledgerRowSummary` totals into
 * `billed` — and `r.payments` is the same list `allocatePayments` is handed. Deriving either
 * of them a second way is how two screens start quoting different dollars for one year.
 */
export function rentPosition(roll = []) {
  let billed = 0;
  let received = 0;
  for (const r of roll || []) {
    billed = round2(billed + num(r?.annual));
    for (const p of r?.payments || []) received = round2(received + num(p?.amount));
  }
  return { billed, received, behind: round2(billed - received) };
}

// The buckets, in the order they read. `booksLabel` present ⇒ this row is a real two-sided
// comparison and a difference is a finding. `nowhere` present ⇒ the books side is meant to
// be empty, and the row says why.
const IN_BUCKETS = [
  { key: 'rent', label: 'Tenant rent', booksLabel: 'payments recorded' },
  { key: 'other_income', label: 'Other income', booksLabel: '“Other income” rows' },
  { key: 'deposit_held', label: 'Security deposits', nowhere: 'held for the tenant. A liability — in no income figure anywhere.' },
];

const OUT_BUCKETS = [
  { key: 'expense', label: 'Property expenses', booksLabel: '“Money out” rows' },
  { key: 'owner', label: 'Owner distributions', booksLabel: '“Your own money”' },
  // Slice 4 writes this one. Present now so the row appears the day it does, rather than
  // the refund quietly joining the catch-all below.
  { key: 'refund', label: 'Returned to a tenant', nowhere: 'an overpayment going back. It was never income, so returning it is not a cost.' },
];

// Decisions that deliberately write nothing, merged into one line per direction. Splitting
// them would print two zeros where one sentence does the job.
const NOWHERE_KEYS = ['transfer', 'ignored'];

/**
 * One property's tie-out.
 *
 * @param lines         statement_lines for this property, scoped to this fiscal year
 * @param payments      payments rows written BY this property's imports (any property, any
 *                      invoice — a statement legitimately settles a lease on another
 *                      building, and the line for it still files under the account it was
 *                      imported from)
 * @param expenseItems  cam_line_items written by those imports
 * @param incomeRows    other_income rows written by those imports
 * @param allExpenseItems / allIncomeRows  the property's whole year, for the hand-entered
 *                      context line — a difference figure means nothing without knowing how
 *                      much of the books never came off a statement at all
 * @param buckets       expense buckets, for the owner-capital rule
 * @param rent          { billed, received } from `rentPosition`, the reconciling item
 */
export function bankTieOut({
  lines = [], payments = [], expenseItems = [], incomeRows = [],
  allExpenseItems = null, allIncomeRows = null,
  buckets = [], year = null, imports = 0, rent = null,
} = {}) {
  const scopedPayments = (payments || []).filter((p) => inYear(p, year));
  const scopedExpenses = (expenseItems || []).filter((it) => inYear(it, year));
  const scopedIncome = (incomeRows || []).filter((r) => inYear(r, year));

  // The statement side, grouped by the decision that was made.
  const byKey = new Map();
  for (const l of lines || []) {
    const key = l?.disposition || 'unclassified';
    const dir = l?.direction === 'in' ? 'in' : 'out';
    const slot = byKey.get(`${dir}:${key}`) || { amount: 0, count: 0 };
    slot.amount = round2(slot.amount + abs2(l?.amount));
    slot.count += 1;
    byKey.set(`${dir}:${key}`, slot);
  }
  const bank = (dir, key) => byKey.get(`${dir}:${key}`) || { amount: 0, count: 0 };

  // The books side. Owner money is split from the building's by the one predicate.
  const books = {
    rent: scopedPayments.reduce((s, p) => round2(s + abs2(p?.amount)), 0),
    other_income: scopedIncome.reduce((s, r) => round2(s + abs2(r?.amount)), 0),
    expense: scopedExpenses.filter((it) => !isOwnerRow(it, buckets)).reduce((s, it) => round2(s + abs2(it?.amount)), 0),
    owner: scopedExpenses.filter((it) => isOwnerRow(it, buckets)).reduce((s, it) => round2(s + abs2(it?.amount)), 0),
    refund: 0,
  };

  const buildSide = (dir, defs) => {
    const rows = [];
    const claimed = new Set([...defs.map((d) => d.key), ...NOWHERE_KEYS, 'unclassified']);
    for (const d of defs) {
      const b = bank(dir, d.key);
      const bookAmt = round2(books[d.key] || 0);
      // A row that is zero on BOTH sides and was never meant to carry anything is noise.
      // A row that is zero on both sides but IS a real comparison stays, because "$0.00 ✓"
      // is the answer to "did anything go astray here?".
      if (d.nowhere && b.amount === 0 && b.count === 0) continue;
      rows.push({
        key: d.key,
        label: d.label,
        statement: b.amount,
        count: b.count,
        books: d.nowhere ? null : bookAmt,
        booksLabel: d.booksLabel || null,
        nowhere: d.nowhere || null,
        diff: d.nowhere ? 0 : round2(b.amount - bookAmt),
      });
    }
    // Transfers and deliberate exclusions, as one line.
    const nowhereAmt = NOWHERE_KEYS.reduce((s, k) => round2(s + bank(dir, k).amount), 0);
    const nowhereCount = NOWHERE_KEYS.reduce((s, k) => s + bank(dir, k).count, 0);
    if (nowhereCount) {
      rows.push({
        key: 'nowhere', label: 'Transfers and lines you left out',
        statement: nowhereAmt, count: nowhereCount, books: null, booksLabel: null,
        nowhere: 'counted nowhere, on purpose — the record that you decided it is the point.',
        diff: 0,
      });
    }
    // ⚠ ANY DISPOSITION THIS FILE HAS NOT HEARD OF LANDS HERE RATHER THAN VANISHING. A key
    // added by a later round (or read out of a row an older bundle wrote) must show up as
    // money on the statement with nothing said about it — the same discipline as
    // `dispositionInfo` refusing to read an unknown key as placed.
    let otherAmt = 0;
    let otherCount = 0;
    const otherLabels = [];
    for (const [k, v] of byKey) {
      const [d0, key] = k.split(':');
      if (d0 !== dir || claimed.has(key)) continue;
      otherAmt = round2(otherAmt + v.amount);
      otherCount += v.count;
      const l = dispositionInfo(key).label;
      if (!otherLabels.includes(l)) otherLabels.push(l);
    }
    if (otherCount) {
      rows.push({
        key: 'other', label: `Filed some other way — ${otherLabels.join(', ')}`,
        statement: otherAmt, count: otherCount, books: null, booksLabel: null,
        nowhere: 'this report does not know where these landed. Check them by hand.',
        diff: 0, unknown: true,
      });
    }
    const unplaced = bank(dir, 'unclassified');
    rows.push({
      key: 'unclassified', label: 'Not yet placed',
      statement: unplaced.amount, count: unplaced.count, books: null, booksLabel: null,
      nowhere: unplaced.amount
        ? 'nothing is recorded for this, and nothing will be until you place it.'
        : 'nothing left undecided.',
      diff: 0, unplaced: true,
    });
    const statementTotal = rows.reduce((s, r) => round2(s + r.statement), 0);
    return { rows, statementTotal, unplaced: unplaced.amount, unplacedCount: unplaced.count };
  };

  const moneyIn = buildSide('in', IN_BUCKETS);
  const moneyOut = buildSide('out', OUT_BUCKETS);

  // ⚠ RECORDED, AND IN NO YEAR'S FIGURES. `listExpenseLineItems` filters `.eq('year', year)`
  // while every other fiscal-year reader in the app tolerates a null (see `rowFiscalYear`),
  // so an expense written without one is on the books, ties here, and appears in no year's
  // Money out. `placeUnplacedLine` wrote exactly that shape until 2026-08-16 (`year:
  // line.year || null`); rows from before the fix are still out there, and this is what
  // finds them.
  const strandedRows = scopedExpenses.filter((it) => !Number(it?.year));
  const stranded = {
    count: strandedRows.length,
    amount: strandedRows.reduce((s, it) => round2(s + abs2(it?.amount)), 0),
  };

  // How much of the books never came off a statement at all. Context, never a difference:
  // hand entry is normal, and a tie-out that called it an error would be crying wolf on
  // every property that has ever had a bill typed in.
  const handEntered = allExpenseItems || allIncomeRows
    ? {
      expenses: (allExpenseItems || []).filter((it) => !it?.import_id).reduce((s, it) => round2(s + abs2(it?.amount)), 0),
      income: (allIncomeRows || []).filter((r) => !r?.import_id).reduce((s, r) => round2(s + abs2(r?.amount)), 0),
    }
    : null;

  // The findings, as sentences that name the side that is short. A slug or a bare signed
  // figure is not a finding — it is a puzzle.
  const differences = [];
  for (const [side, s] of [['in', moneyIn], ['out', moneyOut]]) {
    for (const r of s.rows) {
      if (!r.booksLabel || Math.abs(r.diff) <= 0.005) continue;
      differences.push(
        r.diff > 0
          ? `${r.label}: the statements show ${money(r.diff)} more than the books hold — ${money(r.statement)} on ${r.count} line${r.count === 1 ? '' : 's'} against ${money(r.books)} in ${r.booksLabel}. A line was filed but the record it promised is not there: it was deleted by hand afterwards, or the write failed at import.`
          : `${r.label}: the books hold ${money(-r.diff)} more than these statements show — ${money(r.books)} in ${r.booksLabel} against ${money(r.statement)} on ${r.count} line${r.count === 1 ? '' : 's'}. Something was recorded against one of these imports that no line on them accounts for.`
      );
      void side;
    }
  }
  if (stranded.count) {
    differences.push(
      `${money(stranded.amount)} of expenses across ${stranded.count} line${stranded.count === 1 ? '' : 's'} is recorded with no year on it. It ties here, and it is in NO year's Money out — the expense list reads a year exactly, so a row without one is invisible on every sheet. Open the line on the Financials page and give it a date.`
    );
  }
  if (moneyIn.unplaced > 0.005 || moneyOut.unplaced > 0.005) {
    const bits = [];
    if (moneyIn.unplaced > 0.005) bits.push(`${money(moneyIn.unplaced)} in`);
    if (moneyOut.unplaced > 0.005) bits.push(`${money(moneyOut.unplaced)} out`);
    differences.push(
      `${bits.join(' · ')} crossed the bank and has not been placed. It is in no figure on any sheet. The Ledger's "Money not yet placed" panel is where each line gets a home.`
    );
  }

  return {
    year: Number(year) || null,
    imports,
    in: moneyIn,
    out: moneyOut,
    stranded,
    handEntered,
    rent: rent ? { ...rent } : null,
    differences,
    balanced: differences.length === 0,
    lineCount: (lines || []).length,
  };
}

/** The one-line bottom line, for a folded panel and for the workbook's headline. A folded
 *  section still states what it holds (Panel's own rule), and "the tie-out" with no figure
 *  is exactly the fold that gets reopened every time. */
export function tieOutSentence(t) {
  if (!t) return '';
  const read = `${t.imports} statement${t.imports === 1 ? '' : 's'} · ${money(t.in.statementTotal)} in · ${money(t.out.statementTotal)} out`;
  if (t.balanced) return `${read} — all of it accounted for ✓`;
  const n = t.differences.length;
  return `${read} — ${n} thing${n === 1 ? '' : 's'} to look at`;
}
