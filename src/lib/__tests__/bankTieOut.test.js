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
import { bankTieOut, rentPosition, tieOutSentence, rowFiscalYear } from '../bankTieOut';
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

  it('reports the books holding money no line accounts for, the other way round', () => {
    const t = bankTieOut({
      year: Y, imports: 1,
      lines: [line({ disposition: 'expense', amount: 500 })],
      expenseItems: [{ label: 'Snow removal', amount: 500, year: Y }, { label: 'Extra', amount: 250, year: Y }],
    });
    expect(t.balanced).toBe(false);
    expect(t.differences[0]).toMatch(/books hold \$250\.00 more/);
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

// ⚠ RUNS AFTER the import above, deliberately: the demo store is shared across a file, so
// this is the workbook a landlord would download HAVING imported a statement. Without that
// ordering the seed has no statement lines at all and the whole sheet is skipped — which is
// exactly how a tab can ship untested and never render for anyone.
describe('the workbook grows a Bank tie-out tab once there is something to tie out', () => {
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
    expect(wbXml).toMatch(/name="Bank tie-out"/);
    // …and the sheet actually SAYS the things it exists to say. A tab that renders as a
    // title and four empty rows still passes a "does the file open?" check.
    const strings = await zip.file('xl/sharedStrings.xml').async('string');
    for (const phrase of [
      'Bank tie-out — FY',
      'Money in on your statements',
      'Money out on your statements',
      'Rent is a reconciling item, not a tie',
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
    expect(wbXml).not.toMatch(/name="Bank tie-out"/);
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
    expect(said.some((f) => /Bank tie-out sheet has 1 thing to look at/.test(f))).toBe(true);
    expect(said.some((f) => /\$900\.00 more than the books hold/.test(f))).toBe(true);

    const clean = { ...broken, tieOut: bankTieOut({ year: Y, imports: 1, lines: [] }) };
    expect(flags([clean]).some((f) => /Bank tie-out/.test(f))).toBe(false);
    // …and a property with no statements at all raises nothing either.
    expect(flags([{ ...broken, tieOut: null }]).some((f) => /Bank tie-out/.test(f))).toBe(false);
  });
});
