// The bank tie-out (Slice 3).
//
// ⚠ THE ONE THING THAT WOULD MAKE THIS FILE USELESS is a tie-out derived from the lines it
// is checking. That version balances on every input, passes every test anyone thinks to
// write, and tells the landlord nothing. So the first test here does not check that a clean
// case balances — it checks that a BROKEN one does not, by deleting the money behind a line
// that says it was recorded.
//
// The rest pins the judgements: in and out never netted, the four deliberate-nowhere rows,
// an unknown disposition surfacing rather than vanishing, rent as a reconciling item, and
// the null-year expense that ties here and appears in no year's figures.
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { bankTieOut, rentPosition, tieOutSentence, rowFiscalYear, WHERE_IT_LANDS } from '../bankTieOut';
import {
  applyStatementImport, getBankTieOut, getPropertyMonthlyRoll, placeUnplacedLine,
  listUnplacedLines, listCamLineItems, listStatementLinesForYear,
} from '../api';
import { ledgerRowSummary, allocatePayments } from '../ledger';
import { currentYear } from '../format';

// Capture the bytes the exporter hands the browser, the same way workbookValidity does.
const saved = [];
vi.mock('../download', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, saveWorkbook: (buf, filename) => { saved.push({ buf, filename }); return 'blob:test'; } };
});
const { buildIncomeExpense, flags } = await import('../incomeExpense');
const { downloadIncomeExpenseXlsx } = await import('../incomeExpenseExcel');

const Y = currentYear();
const line = (over = {}) => ({
  hash: `h-${Math.random()}`, year: Y, direction: 'out', amount: 100,
  disposition: 'unclassified', txn_date: `${Y}-03-04`, ...over,
});

describe('bankTieOut — the two sides', () => {
  it('CATCHES a decided line whose money never reached a table', () => {
    // Two expense lines filed on the statement; only one row in the books behind them.
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [
        line({ disposition: 'expense', amount: 1200 }),
        line({ disposition: 'expense', amount: 800 }),
      ],
      expenseItems: [{ label: 'Snow removal', amount: 1200, year: Y }],
    });
    expect(t.balanced).toBe(false);
    const row = t.out.rows.find((r) => r.key === 'expense');
    expect(row.statement).toBe(2000);
    expect(row.books).toBe(1200);
    expect(row.diff).toBe(800);
    // It has to say WHICH side is short, in words. A signed number is a puzzle.
    expect(t.differences[0]).toMatch(/statements show \$800\.00 more than the books hold/);
  });

  // ⚠ NAMING THE BUCKET IS NOT NAMING THE FAULT. George: "if the moneys dont add up on the
  // bank tie out it should show where the discrepancy is happening." A line stamps `ref_id`
  // when it writes (0076), so a ref pointing at a row that is gone IS the evidence.
  it('names the line whose row was deleted, not just the bucket', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [
        line({ id: 'L1', disposition: 'expense', amount: 1200, ref_kind: 'cam', ref_id: 'cam-alive', description: 'GREENLEAF LANDSCAPING' }),
        line({ id: 'L2', disposition: 'expense', amount: 212.48, ref_kind: 'cam', ref_id: 'cam-gone', description: 'HOME DEPOT PURCHASE 8841', txn_date: `${Y}-03-22` }),
      ],
      expenseItems: [{ id: 'cam-alive', label: 'Landscaping', amount: 1200, year: Y }],
    });
    const row = t.out.rows.find((r) => r.key === 'expense');
    expect(row.diff).toBe(212.48);
    expect(row.suspects).toHaveLength(1);
    expect(row.suspects[0].description).toBe('HOME DEPOT PURCHASE 8841');
    const said = t.differences[0];
    expect(said).toMatch(/It is this line: Mar 22 · HOME DEPOT PURCHASE 8841 · \$212\.48 — the expense line it produced has since been deleted/);
    // The line that landed is never named.
    expect(said).not.toMatch(/GREENLEAF/);
  });

  // A row that still exists but under another year is a DIFFERENT fault with a different fix,
  // and reporting it as "deleted" sends the landlord hunting for something sitting right there.
  it('distinguishes a row filed under another year from a row that is gone', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [line({ id: 'L1', disposition: 'expense', amount: 500, ref_kind: 'cam', ref_id: 'cam-1', description: 'ACME' })],
      expenseItems: [{ id: 'cam-1', label: 'Acme', amount: 500, year: Y - 1 }],
    });
    expect(t.differences[0]).toMatch(new RegExp(`filed under FY ${Y - 1}`));
    expect(t.differences[0]).not.toMatch(/deleted/);
  });

  // ⚠ THE FIRST DRAFT OF THIS ACCUSED EVERY LINE THAT HAD NO REF, INCLUDING ONES THAT LANDED.
  // A line with no link cannot be followed in either direction; saying so is useful, calling
  // it the missing money is not.
  it('keeps an untraceable line apart from the cause, and never lets it exceed the difference', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [
        line({ id: 'L1', disposition: 'expense', amount: 1200, description: 'LANDED' }),
        line({ id: 'L2', disposition: 'expense', amount: 800, description: 'ALSO NO REF' }),
      ],
      expenseItems: [{ id: 'cam-1', label: 'Snow removal', amount: 1200, year: Y }],
    });
    const row = t.out.rows.find((r) => r.key === 'expense');
    expect(row.diff).toBe(800);
    expect(row.suspects).toEqual([]);            // nothing is PROVEN
    expect(row.untraceable).toHaveLength(2);
    const said = t.differences[0];
    expect(said).toMatch(/No line names itself as the cause/);
    expect(said).toMatch(/2 other lines on these statements \(\$2,000\.00\) carry no link/);
    // …and it never claims to have accounted for more than the difference.
    expect(said).not.toMatch(/\$2,000\.00 of it is/);
  });

  it('reports the books holding money no line accounts for, the other way round', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [line({ disposition: 'expense', amount: 500 })],
      expenseItems: [{ label: 'Snow removal', amount: 500, year: Y }, { label: 'Extra', amount: 250, year: Y }],
    });
    expect(t.balanced).toBe(false);
    expect(t.differences[0]).toMatch(/books hold \$250\.00 more/);
  });

  // ⚠ THE ONE THIS FILE MISSED FOR FIVE MONTHS, and it is the shape George's own data was in
  // (Pershing Plaza FY 2026, read out of the database 2026-08-17). Two faults in opposite
  // directions inside ONE bucket, netting to a figure that describes neither — and the old
  // code then subtracted the named suspects from the NET and reported the leftover as "not
  // explained by any line", which was a number corresponding to nothing at all.
  //
  //   bank showed $62,686.59 · books hold $86,286.18 · net −$23,599.59
  //   of which:   $12,630.00 missing (payments deleted)
  //               $36,229.59 unrecorded (imported before line records existed)
  //   $36,229.59 − $12,630.00 = $23,599.59 exactly, so nothing is left unexplained.
  it('splits a bucket whose two faults partly cancel, and leaves no phantom remainder', () => {
    const t = bankTieOut({
      year: Y,
      imports: 2,
      importRows: [
        { id: 'imp-new', file_name: 'july.pdf', created_at: `${Y}-08-13` },
        { id: 'imp-old', file_name: 'june.pdf', created_at: `${Y}-07-24` },
      ],
      lines: [
        // The good ones on the newer import.
        line({ id: 'L1', direction: 'in', disposition: 'rent', amount: 50056.59, import_id: 'imp-new', ref_kind: 'payment', ref_id: 'pay-live', description: 'ACH RENT BATCH' }),
        // Two whose payments have been deleted.
        line({ id: 'L2', direction: 'in', disposition: 'rent', amount: 6315, import_id: 'imp-new', ref_kind: 'payment', ref_id: 'pay-gone-1', description: 'ACH DENTALOFFICE', txn_date: `${Y}-07-02` }),
        line({ id: 'L3', direction: 'in', disposition: 'rent', amount: 6315, import_id: 'imp-new', ref_kind: 'payment', ref_id: 'pay-gone-2', description: 'ACH DENTALOFFICE', txn_date: `${Y}-07-31` }),
      ],
      payments: [
        { id: 'pay-live', amount: 50056.59, paid_date: `${Y}-07-01`, import_id: 'imp-new' },
        // June money from a statement that kept no lines at all.
        { id: 'pay-june-a', amount: 20000, paid_date: `${Y}-06-01`, import_id: 'imp-old' },
        { id: 'pay-june-b', amount: 16229.59, paid_date: `${Y}-06-02`, import_id: 'imp-old' },
      ],
    });
    const r = t.in.rows.find((x) => x.key === 'rent');
    expect(r.statement).toBe(62686.59);
    expect(r.books).toBe(86286.18);
    expect(r.diff).toBe(-23599.59);
    // The three tiers, each with its own evidence and never added together.
    expect(r.suspects.map((x) => x.amount)).toEqual([6315, 6315]);
    expect(r.orphans).toEqual([]);
    expect(r.unrecorded.map((x) => x.amount)).toEqual([20000, 16229.59]);
    expect(t.unaccounted).toEqual({ missing: 12630, orphan: 0, unchecked: 36229.59 });

    // The FAULT is the $12,630 and nothing else. "Cannot be checked" is filed apart.
    const said = t.differences.join(' § ');
    expect(said).toMatch(/\$12,630\.00 on these statements has no payment behind it/);
    expect(said).toMatch(/ACH DENTALOFFICE/);
    expect(t.notChecked).toHaveLength(1);
    expect(t.notChecked[0]).toMatch(/\$36,229\.59 in payments recorded cannot be checked/);
    expect(t.notChecked[0]).toMatch(/imported Jul 24/);
    expect(t.notChecked[0]).toMatch(/“june\.pdf”/);

    // ⚠ THE WHOLE POINT: no leftover is invented, and the net is explicitly disowned.
    expect(said).not.toMatch(/not explained by any line/);
    expect(said).not.toMatch(/\$10,969\.59/);
    expect(said).toMatch(/don’t read the \$23,599\.59 between the two columns as a finding/);
  });

  // The benign tier alone must not read as a fault — but it must not read as a clean bill
  // of health either. "Checked and clean" and "never looked at" printing the same is the
  // failure this whole panel exists to avoid, applied to itself.
  it('an import that kept no lines is “cannot be checked”, not a difference', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      importRows: [{ id: 'imp-old', file_name: 'may.pdf', created_at: `${Y}-06-01` }],
      lines: [],
      payments: [{ id: 'p1', amount: 4200, paid_date: `${Y}-05-02`, import_id: 'imp-old' }],
    });
    expect(t.differences).toEqual([]);
    expect(t.balanced).toBe(true);
    expect(t.notChecked).toHaveLength(1);
    expect(tieOutSentence(t)).toMatch(/cannot be checked/);
    expect(tieOutSentence(t)).not.toMatch(/all of it accounted for ✓/);
  });

  // A books row that no line claims IS a finding — but only when the import demonstrably
  // stamps refs. An import whose lines carry none can claim nothing, so its silence proves
  // nothing, and accusing it would repeat the untraceable-line mistake from the other side.
  it('calls out an unclaimed books row, and stays silent when the import stamps no refs at all', () => {
    const stamped = bankTieOut({
      year: Y, imports: 1,
      lines: [line({ id: 'L1', disposition: 'expense', amount: 500, import_id: 'i1', ref_kind: 'cam', ref_id: 'cam-1', description: 'ACME' })],
      expenseItems: [
        { id: 'cam-1', label: 'Acme', amount: 500, year: Y, import_id: 'i1' },
        { id: 'cam-2', label: 'Nobody asked for this', amount: 250, year: Y, import_id: 'i1' },
      ],
    });
    const r = stamped.out.rows.find((x) => x.key === 'expense');
    expect(r.orphans.map((x) => x.description)).toEqual(['Nobody asked for this']);
    expect(stamped.differences.join(' ')).toMatch(/\$250\.00 in “Money out” rows is on these imports with no line accounting for it/);

    const unstamped = bankTieOut({
      year: Y, imports: 1,
      lines: [line({ id: 'L1', disposition: 'expense', amount: 500, import_id: 'i1', description: 'ACME' })],
      expenseItems: [
        { id: 'cam-1', label: 'Acme', amount: 500, year: Y, import_id: 'i1' },
        { id: 'cam-2', label: 'Nobody asked for this', amount: 250, year: Y, import_id: 'i1' },
      ],
    });
    expect(unstamped.out.rows.find((x) => x.key === 'expense').orphans).toEqual([]);
    expect(unstamped.notChecked).toEqual([]);
  });

  it('ties clean when every line reaches its row', () => {
    const t = bankTieOut({
      year: Y, imports: 2,
      lines: [
        line({ disposition: 'rent', direction: 'in', amount: 6500 }),
        line({ disposition: 'other_income', direction: 'in', amount: 300 }),
        line({ disposition: 'expense', amount: 1200 }),
      ],
      payments: [{ amount: 6500, paid_date: `${Y}-03-04` }],
      incomeRows: [{ amount: 300, year: Y }],
      expenseItems: [{ label: 'Snow removal', amount: 1200, year: Y }],
    });
    expect(t.balanced).toBe(true);
    expect(t.differences).toEqual([]);
    expect(t.in.statementTotal).toBe(6800);
    expect(t.out.statementTotal).toBe(1200);
    expect(tieOutSentence(t)).toMatch(/all of it accounted for ✓/);
  });

  // ⚠ THE SAME RULE `lineCompleteness` KEEPS, and for the same reason: netting lets a
  // $5,000 deposit and a $5,000 withdrawal report "$0 unplaced" on a statement where
  // $10,000 is in limbo.
  it('never nets money in against money out', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [
        line({ direction: 'in', amount: 5000 }),
        line({ direction: 'out', amount: 5000 }),
      ],
    });
    expect(t.in.unplaced).toBe(5000);
    expect(t.out.unplaced).toBe(5000);
    expect(t.balanced).toBe(false);
    expect(t.differences.join(' ')).toMatch(/\$5,000\.00 in · \$5,000\.00 out/);
  });

  it('states the four rows that are MEANT to be empty on the books side', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [
        line({ direction: 'in', disposition: 'deposit_held', amount: 10000 }),
        line({ direction: 'in', disposition: 'transfer', amount: 2000 }),
        line({ direction: 'out', disposition: 'ignored', amount: 900 }),
      ],
    });
    const dep = t.in.rows.find((r) => r.key === 'deposit_held');
    expect(dep.statement).toBe(10000);
    expect(dep.books).toBe(null);
    expect(dep.nowhere).toMatch(/in no income figure anywhere/);
    expect(t.in.rows.find((r) => r.key === 'nowhere').statement).toBe(2000);
    expect(t.out.rows.find((r) => r.key === 'nowhere').statement).toBe(900);
    // None of them is a difference — they are decisions, not faults.
    expect(t.balanced).toBe(true);
  });

  // The `refund` disposition arrives with Slice 4. Its row is defined now so it appears the
  // day it does, rather than the money joining the catch-all with no label.
  it('has a home for a refund the moment one exists', () => {
    const t = bankTieOut({ year: Y, imports: 1, lines: [line({ disposition: 'refund', amount: 750 })] });
    const r = t.out.rows.find((x) => x.key === 'refund');
    expect(r.statement).toBe(750);
    expect(r.nowhere).toMatch(/never income/);
  });

  // ⚠ The same discipline as `dispositionInfo` refusing to read an unknown key as placed,
  // and as noiBridge's catch-all residual: money this file has not heard of must SHOW UP,
  // not disappear from a total.
  it('surfaces a disposition it has never heard of instead of dropping it', () => {
    const t = bankTieOut({ year: Y, imports: 1, lines: [line({ disposition: 'from_the_future', amount: 4321 })] });
    const other = t.out.rows.find((r) => r.key === 'other');
    expect(other.statement).toBe(4321);
    expect(other.unknown).toBe(true);
    expect(t.out.statementTotal).toBe(4321);
  });

  it('splits the owner\'s own money from the building\'s by the ONE predicate', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [
        line({ disposition: 'expense', amount: 1200 }),
        line({ disposition: 'owner', amount: 5000 }),
      ],
      expenseItems: [
        { label: 'Snow removal', amount: 1200, year: Y },
        { label: 'Dana Whitfield', amount: 5000, year: Y },
      ],
      buckets: [{ label: 'Dana Whitfield', category: 'distribution' }],
    });
    expect(t.out.rows.find((r) => r.key === 'expense').books).toBe(1200);
    expect(t.out.rows.find((r) => r.key === 'owner').books).toBe(5000);
    expect(t.balanced).toBe(true);
  });

  // ⚠ THE NULL-YEAR EXPENSE. It ties here and is in NO year's Money out, because
  // listExpenseLineItems reads the year exactly while every other fiscal-year reader
  // tolerates a null. A row that is on the books and in no report is the worst shape money
  // can take: nothing ever asks about it.
  it('names an expense recorded with no year at all', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [line({ disposition: 'expense', amount: 640 })],
      expenseItems: [{ label: 'Plumbing', amount: 640, year: null, paid_date: `${Y}-03-04` }],
    });
    // The comparison itself still balances — the row exists, it is just unreachable.
    expect(t.out.rows.find((r) => r.key === 'expense').diff).toBe(0);
    expect(t.stranded).toEqual({ count: 1, amount: 640 });
    expect(t.differences[0]).toMatch(/no year on it/);
    expect(t.differences[0]).toMatch(/in NO year's Money out/);
  });

  it('scopes both sides by ONE fiscal-year rule', () => {
    expect(rowFiscalYear({ year: 2024, paid_date: '2026-01-01' })).toBe(2024); // stored wins
    expect(rowFiscalYear({ paid_date: '2026-01-01' })).toBe(2026);             // then the date
    expect(rowFiscalYear({ txn_date: '2025-12-30' })).toBe(2025);
    expect(rowFiscalYear({})).toBe(null);                                      // then nothing
    // A row from another year is excluded from BOTH sides, so it can't fake a difference.
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [line({ disposition: 'expense', amount: 400 })],
      expenseItems: [
        { label: 'This year', amount: 400, year: Y },
        { label: 'Last year', amount: 9999, year: Y - 1 },
      ],
    });
    expect(t.out.rows.find((r) => r.key === 'expense').books).toBe(400);
    expect(t.balanced).toBe(true);
  });

  it('counts hand entry as context, never as a difference', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [line({ disposition: 'expense', amount: 400 })],
      expenseItems: [{ label: 'Imported', amount: 400, year: Y, import_id: 'imp-1' }],
      allExpenseItems: [
        { label: 'Imported', amount: 400, year: Y, import_id: 'imp-1' },
        { label: 'Typed in', amount: 18000, year: Y },
      ],
      allIncomeRows: [{ amount: 2690, year: Y }],
    });
    expect(t.handEntered).toEqual({ expenses: 18000, income: 2690 });
    expect(t.balanced).toBe(true); // hand entry is normal, not a fault
  });
});

describe('rentPosition', () => {
  it('is the SAME billed and collected figures the Ledger grid prints', async () => {
    const roll = await getPropertyMonthlyRoll('prop-1', Y);
    expect(roll.length).toBeGreaterThan(0);
    const pos = rentPosition(roll);
    // The grid's own footer, derived the way LedgerPage derives it.
    let billed = 0;
    let collected = 0;
    for (const r of roll) {
      const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments });
      const s = ledgerRowSummary({ year: Y, owedByMonth: r.schedule, allocation: alloc });
      billed += s.billed;
      collected += s.collected;
    }
    expect(pos.billed).toBeCloseTo(billed, 2);
    expect(pos.received).toBeCloseTo(collected, 2);
    expect(pos.behind).toBeCloseTo(billed - collected, 2);
  });
});

describe('getBankTieOut — against the real import path', () => {
  it('returns null when nothing has been imported — "no statements" is not "clean"', async () => {
    expect(await getBankTieOut('prop-2', Y)).toBe(null);
  });

  it('ties a real import out, and follows a line placed afterwards', async () => {
    const paid = { hash: 'tie-pay', year: Y, date: `${Y}-02-05`, description: 'DEPOSIT BRIGHT COFFEE', amount: 6500, direction: 'in' };
    const spend = { hash: 'tie-cam', year: Y, date: `${Y}-02-11`, description: 'ACME LANDSCAPING', amount: 900, direction: 'out' };
    const mystery = { hash: 'tie-huh', year: Y, date: `${Y}-02-19`, description: 'WHO KNOWS', amount: 425, direction: 'out' };
    await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'tieout.pdf',
      entries: [
        { type: 'payment', lease_id: 'lease-1', property_id: 'prop-1', year: Y, amount: 6500, date: paid.date, period_month: 2, hash: paid.hash },
        { type: 'cam', property_id: 'prop-1', year: Y, label: 'Landscaping', amount: 900, date: spend.date, billable: true, hash: spend.hash },
      ],
      lines: [
        { ...paid, disposition: 'rent' },
        { ...spend, disposition: 'expense' },
        { ...mystery, disposition: 'unclassified' },
      ],
    });

    const t = await getBankTieOut('prop-1', Y);
    expect(t).not.toBe(null);
    expect(t.out.rows.find((r) => r.key === 'expense').diff).toBe(0);
    expect(t.in.rows.find((r) => r.key === 'rent').diff).toBe(0);
    // The unplaced line is money in no figure anywhere, and the tie-out says so.
    expect(t.out.unplaced).toBe(425);
    expect(t.differences.some((d) => /crossed the bank and has not been placed/.test(d))).toBe(true);
    // Hand-entered expenses are the demo's own seed — real, and not from a statement.
    expect(t.handEntered.expenses).toBeGreaterThan(0);

    // ⚠ AND THE PLACED LINE MUST CARRY A YEAR. `placeUnplacedLine` wrote `line.year || null`
    // until 2026-08-16; a null there puts the expense in no year's Money out while the line
    // reads "recorded". The tie-out is what found it, so this is what stops it coming back.
    const unplaced = await listUnplacedLines('prop-1', Y);
    const mine = unplaced.find((l) => l.line_hash === 'tie-huh');
    expect(mine).toBeTruthy();
    await placeUnplacedLine(mine, { kind: 'expense', category: 'repairs', year: Y });
    const cams = await listCamLineItems('prop-1', Y);
    const placed = cams.find((c) => Math.abs(Number(c.amount) - 425) < 0.005);
    expect(placed, 'the placed expense must be readable in ITS OWN fiscal year').toBeTruthy();
    expect(Number(placed.year)).toBe(Y);

    const after = await getBankTieOut('prop-1', Y);
    expect(after.out.unplaced).toBe(0);
    expect(after.out.rows.find((r) => r.key === 'expense').diff).toBe(0);
    // Every line for the year is visible to the third reader, decided or not.
    const all = await listStatementLinesForYear('prop-1', Y);
    expect(all.length).toBeGreaterThanOrEqual(3);
  });
});

// ⚠ THE NAG COULD NOT ANSWER "THIS IS RENT" UNTIL 2026-08-16. The picker offered expenses,
// income, a deposit, a transfer and leave-out; a deposit that was plainly a tenant's rent had
// no home, and the panel told the landlord to re-import the statement — which means still
// having the PDF. George: "an option for money not placed yet should be to record it as a
// payment for the next or previous month. sometimes tenants pay twice in the same month."
describe('placing an unplaced deposit as rent', () => {
  it('settles the month it is tagged to, and the tie-out follows', async () => {
    const dep = { hash: 'rent-late', year: Y, date: `${Y}-05-28`, description: 'MOBILE DEPOSIT', amount: 6500, direction: 'in' };
    await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'rent.pdf',
      entries: [], lines: [{ ...dep, disposition: 'unclassified' }],
    });
    const before = await getBankTieOut('prop-1', Y);
    expect(before.in.unplaced).toBeGreaterThanOrEqual(6500);

    const mine = (await listUnplacedLines('prop-1', Y)).find((l) => l.line_hash === 'rent-late');
    // ⚠ TAGGED TO JUNE THOUGH IT CLEARED IN MAY — the whole request. A cheque that cleared on
    // the 28th can be next month's rent, and the month is the landlord's choice, not the date's.
    const { entry } = await placeUnplacedLine(mine, { kind: 'payment', leaseId: 'lease-1', month: 6, year: Y });
    expect(Number(entry.period_month)).toBe(6);
    expect(Number(entry.amount)).toBe(6500);
    // ⚠ THE THREE STAMPS, each load-bearing: without import_id the tie-out cannot see the
    // payment and reports a difference it caused itself; without import_hash the duplicate
    // guard would let a re-import book it twice; `source` is stored, never inferred (0088),
    // and left to the default it would read 'system' and become re-pricable.
    expect(entry.import_id).toBeTruthy();
    expect(entry.import_hash).toBe('rent-late');
    expect(entry.source).toBe('import');

    const after = await getBankTieOut('prop-1', Y);
    expect(after.in.unplaced).toBeCloseTo(before.in.unplaced - 6500, 2);
    // The line now sits in the rent bucket and TIES — the books side sees it because the
    // payment carries the import.
    expect(after.in.rows.find((r) => r.key === 'rent').diff).toBe(0);
    // And the grid agrees: June is settled at what arrived.
    const roll = await getPropertyMonthlyRoll('prop-1', Y);
    const row = roll.find((r) => r.lease_id === 'lease-1');
    expect(row.payments.some((p) => Number(p.period_month) === 6 && Number(p.amount) === 6500)).toBe(true);
  });

  it('refuses without a tenant rather than writing a payment against nobody', async () => {
    const res = await placeUnplacedLine({ id: 'x', property_id: 'prop-1', amount: 100 }, { kind: 'payment', leaseId: null, year: Y });
    expect(res.refused).toBe(true);
    expect(res.entry).toBe(null);
  });
});

// ⚠ RUNS AFTER the import above, deliberately: the demo store is shared across a file, so
// this is the workbook a landlord would download HAVING imported a statement. Without that
// ordering the seed has no statement lines at all and the whole sheet is skipped — which is
// exactly how a tab can ship untested and never render for anyone.
describe('the workbook grows a “Where bank money went” tab once there is something to tie out', () => {
  it('carries the tie-out onto every property shape and writes the sheet', async () => {
    const pkg = await buildIncomeExpense('corp-1', Y);
    const maple = pkg.properties.find((p) => p.name === 'Maple Plaza');
    expect(maple.tieOut, 'the property that was imported into carries a tie-out').not.toBe(null);
    // The rent block is attached from the roll shapeProperty already holds, not read again.
    expect(maple.tieOut.rent.billed).toBeGreaterThan(0);
    expect(maple.tieOut.rent.behind).toBeCloseTo(
      maple.tieOut.rent.billed - maple.tieOut.rent.received, 2
    );

    saved.length = 0;
    await downloadIncomeExpenseXlsx({ corporationId: 'corp-1', corporationName: 'Acme', year: Y });
    const zip = await JSZip.loadAsync(saved[0].buf);
    const wbXml = await zip.file('xl/workbook.xml').async('string');
    expect(wbXml).toMatch(/name="Where bank money went"/);
    // …and the sheet actually SAYS the things it exists to say. A tab that renders as a
    // title and four empty rows still passes a "does the file open?" check.
    const strings = await zip.file('xl/sharedStrings.xml').async('string');
    for (const phrase of [
      'Where your bank money went — FY',
      'Money in on your statements',
      'Money out on your statements',
      // ⚠ THE TWO RENT HEADINGS MUST NOT READ ALIKE. The Money-in row is a TIE (a difference
      // is a fault); these three are arrears (a difference is normal). They sat a few rows
      // apart under headings that both said "rent" and George read them as one thing.
      'Your whole year’s rent — not a tie, and not meant to balance',
      'Rent off these statements',
      // The sheet's columns name the two ACTORS, the same words the Ledger panel uses.
      // Two documents describing one comparison must not label it differently.
      'The bank showed',
      'Amlak recorded',
      'What this cannot catch',
      'not from the lines, because a report derived from the same list it is checking',
    ]) expect(strings, `the sheet must say "${phrase}"`).toContain(phrase);
    // Every sheet still opens: no frozen pane that splits nothing (see workbookValidity).
    for (const n of Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))) {
      const xml = await zip.file(n).async('string');
      expect(new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror')).toBeNull();
      expect(/state="frozen"/.test(xml)).toBe(false);
    }
  }, 30000);

  it('writes NO tie-out tab for a corporation with no imported statement', async () => {
    saved.length = 0;
    await downloadIncomeExpenseXlsx({ corporationId: 'corp-2', corporationName: 'Northwind', year: Y });
    const zip = await JSZip.loadAsync(saved[0].buf);
    const wbXml = await zip.file('xl/workbook.xml').async('string');
    // "Nothing imported" and "imported and clean" are different answers. A tab that always
    // appears, always saying nothing, is the tab nobody opens the day it matters.
    expect(wbXml).not.toMatch(/name="Where bank money went"/);
  }, 30000);
});

// ⚠ AND THE PRE-FLIGHT HAS TO CARRY IT. A reader who never opens the Bank tie-out tab still
// has to learn that money crossed the account and reached none of the figures they are
// about to hand someone — the flags are what the download dialog prints and what the
// Summary sheet ends with.
describe('the workbook pre-flight names an unbalanced tie-out', () => {
  it('puts the difference in flags(), and says nothing when it balances', () => {
    const broken = {
      name: 'Maple Plaza', expenseRows: [], expenseTotals: { spent: 1, recovered: 0, net: 1 },
      outUndated: 0, inUndated: 0, rentDrift: 0, rentScheduled: 0, rent: 0, rentQuoted: 0,
      tieOut: bankTieOut({
        year: Y, imports: 1,
        lines: [line({ disposition: 'expense', amount: 900 })],
        expenseItems: [],
      }),
    };
    const said = flags([broken]);
    expect(said.some((f) => /“Where bank money went” sheet has 1 thing to look at/.test(f))).toBe(true);
    expect(said.some((f) => /\$900\.00 more than the books hold/.test(f))).toBe(true);

    const clean = { ...broken, tieOut: bankTieOut({ year: Y, imports: 1, lines: [] }) };
    expect(flags([clean]).some((f) => /Where bank money went/.test(f))).toBe(false);
    // …and a property with no statements at all raises nothing either.
    expect(flags([{ ...broken, tieOut: null }]).some((f) => /Where bank money went/.test(f))).toBe(false);
  });
});

// ── The second leak: a placed expense nobody could ever bill ─────────────────────────────
//
// George, 2026-08-16: *"lastly does all this stuff tie into income and expenses where it needs
// to be?"* Tracing every disposition turned up two gaps. The first — an unplaced line reaching
// nothing — is what "Tenant rent" above closed. This is the second: `placeUnplacedLine` FORCED
// `billable: false`, a deliberate safety property ("answering the nag can never move a tenant's
// bill") whose cost was that a genuinely recoverable cost placed after the fact reached "what
// the year cost you" and no tenant's CAM. The landlord absorbed it, silently, with nothing on
// any screen saying so.
//
// ⚠ THE DEFAULT DOES NOT MOVE. What changed is that the choice exists, is stated in the confirm,
// and carries the money all the way through when it is taken.
describe('a placed expense can now reach the tenants — but only when asked', () => {
  const feed = async (hash, amount, description) => {
    await applyStatementImport({
      propertyId: 'prop-2', year: Y, fileName: `${hash}.pdf`,
      entries: [],
      lines: [{ hash, year: Y, date: `${Y}-03-11`, description, amount, direction: 'out', disposition: 'unclassified' }],
    });
    return (await listUnplacedLines('prop-2', Y)).find((l) => l.line_hash === hash);
  };

  it('absorbs it by default, exactly as before', async () => {
    const l = await feed('bill-off', 1200, 'ARCTIC SNOW PLOWING');
    const res = await placeUnplacedLine(l, { kind: 'expense', category: 'repairs', year: Y });
    expect(res.billable).toBe(false);
    const item = (await listCamLineItems('prop-2', Y)).find((c) => c.id === res.entry.id);
    expect(item.billable).toBe(false);
    // The whole safety property in one assertion: syncCamTotal sums `billable is not false`,
    // so a not-billed line reaches no total, no share and no invoice.
    expect(res.rebilled).toBeNull();
  });

  it('bills it to the tenants when asked, and carries the change through to their invoices', async () => {
    const roll0 = await getPropertyMonthlyRoll('prop-2', Y);
    const before = roll0.find((r) => r.lease_id === 'lease-3');

    const l = await feed('bill-on', 6000, 'CITYWIDE LANDSCAPING SEASON');
    const res = await placeUnplacedLine(l, { kind: 'expense', category: 'cleaning', year: Y, billable: true });
    expect(res.billable).toBe(true);
    const item = (await listCamLineItems('prop-2', Y)).find((c) => c.id === res.entry.id);
    expect(item.billable).toBe(true);

    // ⚠ THE CARRY-THROUGH IS THE POINT. `addCamLineItem` moved `cam_total`, which moves
    // `v_tenant_shares` — and every screen that builds UP from live data follows on its own.
    // The STORED invoice does not (CLAUDE.md §1), which is why `resyncPropertyBilling` runs.
    const after = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === 'lease-3');
    expect(after.camTaxAnnual).toBeGreaterThan(before.camTaxAnnual);
    expect(after.annual).toBeGreaterThan(before.annual);
    // The bill was rebuilt rather than left behind — no drift between schedule and invoice.
    expect(Math.abs(Number(after.drift) || 0)).toBeLessThanOrEqual(1);
  });

  // ⚠ AND A DRAW CAN NEVER BE BILLABLE, whatever is passed. `cam_line_items` is the table the
  // building bills from and a distribution is money that is not the building's; the predicate
  // keeping it inert is exactly this column. Asking for it must be refused, not obeyed.
  it('refuses to bill an owner distribution to the tenants even when told to', async () => {
    const l = await feed('bill-draw', 4000, 'TRANSFER TO OWNER');
    const res = await placeUnplacedLine(l, { kind: 'expense', category: 'distribution', party: 'G. Akkawi', year: Y, billable: true });
    expect(res.billable).toBe(false);
    expect(res.line.disposition).toBe('owner');
    const item = (await listCamLineItems('prop-2', Y)).find((c) => c.id === res.entry.id);
    expect(item.billable).toBe(false);
  });
});

// ⚠ THE MAP IS PRINTED ON THE SCREEN, so it has to stay true. Every disposition the tie-out can
// group a line under needs a row here saying what it writes and whether the workbook counts it —
// a decision missing from the map is one a landlord will look up and not find, on the one panel
// that exists to answer exactly that question.
describe('where each kind of line ends up', () => {
  it('covers every disposition the tie-out groups a line under', () => {
    const named = new Set(WHERE_IT_LANDS.map((w) => w.key));
    for (const key of ['rent', 'other_income', 'deposit_held', 'expense', 'owner', 'transfer', 'ignored', 'unclassified']) {
      expect(named.has(key), `the map must say where "${key}" ends up`).toBe(true);
    }
    // The one answer that surprises every landlord, and the one that must never quietly flip:
    // the workbook is ACCRUAL, so a rent payment moves the Ledger and not what was earned.
    expect(WHERE_IT_LANDS.find((w) => w.key === 'rent').sheet).toMatch(/^no/);
    expect(WHERE_IT_LANDS.find((w) => w.key === 'rent').note).toMatch(/falls DUE/);
    // …and an unplaced line is a gap, said out loud rather than filed as a legitimate zero.
    expect(WHERE_IT_LANDS.find((w) => w.key === 'unclassified').sheet).toMatch(/gap/);
    for (const w of WHERE_IT_LANDS) expect(w.filed && w.writes && w.sheet && w.note).toBeTruthy();
  });
});
