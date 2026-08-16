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
// "Mar 22" from an ISO day, without pulling `format.js` into a file that is otherwise pure
// over its arguments. Slices the string rather than parsing it — a Date would apply the
// browser's timezone and can shift the day backwards for anyone west of UTC.
const DAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso) => {
  const s = String(iso || '');
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return m >= 1 && m <= 12 && d >= 1 ? `${DAY_MONTHS[m - 1]} ${d}` : s.slice(0, 10);
};

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

  // ── Which LINE is the difference? ───────────────────────────────────────────────────
  //
  // George: *"if the moneys dont add up on the bank tie out it should show where the
  // discrepancy is happening."* Naming the bucket and the amount tells him something is
  // wrong; naming the line tells him what to do.
  //
  // ⚠ THIS DOES NOT BREAK THE RULE AT THE TOP OF THIS FILE. The difference is still computed
  // from the two independent columns — this pass runs afterwards and only ATTRIBUTES it.
  // Deriving the total from the lines would balance every time and prove nothing; explaining
  // it from the lines is exactly what `ref_kind` / `ref_id` were stored for (0076).
  //
  // Existence is checked against the UNSCOPED rows on purpose, so "the row is gone" and "the
  // row is filed under another year" come back as different sentences. They are different
  // faults with different fixes, and reporting the second as the first sends the landlord
  // looking for something that is sitting right there.
  const byId = new Map();
  for (const [rowsOf, kind] of [[payments, 'payment'], [expenseItems, 'cam'], [incomeRows, 'income']]) {
    for (const r of rowsOf || []) if (r?.id) byId.set(String(r.id), { row: r, kind });
  }
  // Which dispositions PROMISED a money row. A deposit's ref points at a lease and a transfer
  // writes nothing, so neither can be missing from a money table.
  const PRODUCES = { rent: 'payment', expense: 'expense line', owner: 'expense line', other_income: 'income row' };
  // ⚠ TWO TIERS, AND CONFLATING THEM ACCUSES LINES THAT LANDED PERFECTLY WELL.
  //   PROVEN      — the line stamped a `ref_id` and that row is gone, or is filed under
  //                 another year. The line itself is the evidence; nothing is being guessed.
  //   UNTRACEABLE — the line carries no `ref_id` at all, so it cannot be followed either way.
  //                 That is worth saying (0076 stores the ref precisely so a line CAN be
  //                 traced) but it is NOT proof the money is missing — an older row, or one
  //                 written before the ref was stamped, looks identical to a failed write.
  // Only the proven tier is ever presented as the cause of a figure.
  const suspects = {};
  const untraceable = {};
  for (const l of lines || []) {
    const key = l?.disposition || 'unclassified';
    const promised = PRODUCES[key];
    if (!promised) continue;
    const entry = {
      id: l.id, date: l.txn_date || null, description: l.description || null, amount: abs2(l.amount),
    };
    if (!l?.ref_id) {
      (untraceable[key] ||= []).push({ ...entry, why: `carries no link to the ${promised} it produced, so it cannot be traced either way` });
      continue;
    }
    const hit = byId.get(String(l.ref_id));
    if (!hit) {
      (suspects[key] ||= []).push({ ...entry, why: `the ${promised} it produced has since been deleted` });
    } else if (!inYear(hit.row, year)) {
      (suspects[key] ||= []).push({ ...entry, why: `its ${promised} is filed under FY ${rowFiscalYear(hit.row)}, so it counts in that year and not this one` });
    }
  }
  const byAmount = (a, b) => b.amount - a.amount || String(a.date).localeCompare(String(b.date));
  for (const k of Object.keys(suspects)) suspects[k].sort(byAmount);
  for (const k of Object.keys(untraceable)) untraceable[k].sort(byAmount);

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
        // The lines this bucket's difference can be pinned on, biggest first — and the ones
        // that merely cannot be followed, kept apart from them.
        suspects: suspects[d.key] || [],
        untraceable: untraceable[d.key] || [],
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
      // ⚠ NAME THE LINE, not just the bucket. "Property expenses are $800 short" tells the
      // landlord something is wrong; "the Home Depot line of 22 March produced nothing" tells
      // them what to do about it. When the suspects account for the whole difference the
      // generic guess at a cause is dropped — it would be guessing at something now known.
      const name = (x) => `${x.date ? fmtDay(x.date) : 'undated'} · ${x.description || 'this line'} · ${money(x.amount)} — ${x.why}`;
      const named = (r.suspects || []).map(name);
      const accounted = round2((r.suspects || []).reduce((t, x) => t + x.amount, 0));
      const gap = round2(Math.abs(r.diff) - accounted);
      const head = r.diff > 0
        ? `${r.label}: the statements show ${money(r.diff)} more than the books hold — ${money(r.statement)} on ${r.count} line${r.count === 1 ? '' : 's'} against ${money(r.books)} in ${r.booksLabel}.`
        : `${r.label}: the books hold ${money(-r.diff)} more than these statements show — ${money(r.books)} in ${r.booksLabel} against ${money(r.statement)} on ${r.count} line${r.count === 1 ? '' : 's'}.`;
      let tail;
      if (named.length && Math.abs(gap) <= 0.05) {
        tail = ` It is ${named.length === 1 ? 'this line' : 'these lines'}: ${named.join(' · ')}`;
      } else if (named.length) {
        tail = ` ${money(accounted)} of it is ${named.length === 1 ? 'this line' : 'these lines'}: ${named.join(' · ')} The remaining ${money(Math.abs(gap))} is not explained by any line.`;
      } else if (r.diff > 0) {
        tail = ' No line names itself as the cause, so the record was removed after the import stamped it, or was never linked. Check the expense and payment lists for something deleted.';
      } else {
        tail = ' Something was recorded against one of these imports that no line on them accounts for.';
      }
      // ⚠ STATED SEPARATELY AND NEVER AS THE CAUSE. A line with no link cannot be followed in
      // either direction — reporting it as the missing money would accuse lines that landed
      // perfectly well, which is exactly what the first draft of this did.
      const blind = r.untraceable || [];
      if (blind.length) {
        tail += ` ${blind.length} other line${blind.length === 1 ? '' : 's'} on these statements (${money(round2(blind.reduce((t, x) => t + x.amount, 0)))}) carr${blind.length === 1 ? 'ies' : 'y'} no link to what ${blind.length === 1 ? 'it' : 'they'} produced, so ${blind.length === 1 ? 'it' : 'they'} cannot be traced either way.`;
      }
      differences.push(head + tail);
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

/**
 * Every decision a bank line can carry, what it writes, and whether it reaches the
 * Income-and-expenses workbook — George's *"do all the numbers from the bank statement show up
 * on income and expenses unless its ignored?"*, answered on the screen rather than in a reply
 * he has to remember.
 *
 * ⚠ THE ONE ANSWER THAT SURPRISES EVERY LANDLORD IS RENT, and it is right: the workbook is
 * ACCRUAL — Money in is what tenants were BILLED, not what they paid — so a rent deposit moves
 * who has settled and not what was earned. That is precisely why this panel exists: it is the
 * cash view the accrual sheet cannot give. Stating it here is the difference between a reader
 * trusting both figures and a reader concluding one of them is broken.
 *
 * Data, not prose, so the screen and any later export cannot drift into two different maps.
 */
export const WHERE_IT_LANDS = [
  { key: 'rent', filed: 'Tenant rent', writes: 'a payment', sheet: 'no — and correctly', note: 'The sheet counts rent when it falls DUE. Paying it changes the Ledger, not what was earned.' },
  { key: 'expense', filed: 'Property expense', writes: 'an expense line', sheet: 'yes', note: 'Money out. Billed to tenants only if you said so when you placed it.' },
  { key: 'owner', filed: 'Owner distribution', writes: 'a not-billed expense line', sheet: 'yes, apart', note: 'Reported as “Your own money” — not a cost of the building, so it is in no expense total.' },
  { key: 'other_income', filed: 'Other income', writes: 'an income row', sheet: 'yes', note: 'Money in, on the category you chose.' },
  { key: 'deposit_held', filed: 'Security deposit', writes: 'nothing', sheet: 'no', note: 'The tenant’s money, held. A liability — never income, never credited against rent.' },
  { key: 'transfer', filed: 'Transfer', writes: 'nothing', sheet: 'no', note: 'It never left your hands. The record of the move is the point.' },
  { key: 'ignored', filed: 'Left out', writes: 'nothing', sheet: 'no', note: 'You decided, and the reason is recorded beside the line under “Decided”.' },
  { key: 'unclassified', filed: 'Not yet placed', writes: 'nothing', sheet: 'no — and that is a gap', note: 'Real money in no figure on any sheet until you give it a home.' },
];

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
