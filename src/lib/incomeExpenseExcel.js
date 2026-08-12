// The Income-and-expenses workbook. Pure formatting over incomeExpense.js — no AI, no
// network of its own. ExcelJS is imported lazily so it stays out of the initial page
// load, exactly as the reconciliation workbook does.
//
// LAID OUT MONTH BY MONTH (George, 2026-08-12: "it should be itemized like a
// reconciliation … all income and expenses monthly with the main buckets and items").
// Fifteen columns: the line item, its year, Jan…Dec, and — the one column a reader must
// not miss — "No date".
//
// ⚠ "NO DATE" IS REAL MONEY, NOT A REMAINDER. `cam_line_items.paid_date` is nullable and
// never backfilled (0074), a service contract's derived CAM line never carries one, and a
// kind entered as a single flat figure has no day at all. Spreading those dollars over
// twelve months would invent a year that didn't happen; dropping them would lose money off
// a sheet headed "income and expenses". So they get a column of their own, and every row
// reads the same across as down: Jan…Dec + No date === Total.
//
// Summary (the whole company, month by month) + one sheet per property. That is the whole
// structure: the three packages this replaced ran to five sheets each because each was
// arguing with a form. This one is a list of what came in and what went out.
import { saveWorkbook, fileSlug } from './download';
import { xlsxSheet, xlsxPen, XLSX_PALETTE } from './xlsx';
import { buildIncomeExpense, MONTHS } from './incomeExpense';

const P = XLSX_PALETTE;

// A: the line item · B: its year · C–N: Jan…Dec · O: what has no date.
const WIDTHS = [34, 14, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 12];
const LAST = 'O';
const RIGHT = ['left', ...Array(14).fill('right')];

const head = (first) => [first, 'Total', ...MONTHS, 'No date'];

// A zero prints as an em dash: on a 12-month grid most cells are empty, and a wall of
// $0.00 buries the months that actually carry money. (A string skips the currency format,
// which is the intent.)
const dash = (n) => (Math.abs(Number(n) || 0) < 0.005 ? '—' : Number(n));

// One row of the grid. `byMonth` is length-12; `undated` is the column that keeps the
// arithmetic honest.
//
// ⚠ `total ?? spent` is not defensive noise. An expense CATEGORY row comes straight off
// `recoverabilityRows`, where the year's figure is called `spent` because the same row
// also carries `recovered` and `net`; a rent row, an income group and a bucket item all
// call it `total`. Reading only one of the two prints a grid of months under an empty
// Total column — which is exactly what shipped in the first draft of this file.
const grid = (pen, label, row, opts = {}) =>
  pen.line(
    [label, row.total ?? row.spent ?? 0, ...(row.byMonth || []).map(dash), dash(row.undated)],
    { aligns: RIGHT, ...opts }
  );

const indent = (label) => `    ${label}`;

const usd = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

// ── Summary ──────────────────────────────────────────────────────────────────
function addSummary(wb, pkg, corporationName, now) {
  const ws = xlsxSheet(wb, 'Summary', WIDTHS, { freeze: 0 });
  const pen = xlsxPen(ws, LAST);
  const t = pkg.totals;

  pen.title(`${corporationName} — income and expenses, FY ${pkg.year}`);
  pen.pair('Prepared', now);
  pen.pair('Properties', String(pkg.properties.length));
  pen.skip();

  pen.note(
    'Rent is what the leases oblige, month by month. Expenses sit in the month they were paid. Anything with no '
    + 'date on it is in the last column rather than spread across the year — every row adds across to its Total. '
    + 'What tenants reimbursed is shown below the grid, for the year: it is settled at reconciliation and has no month.',
    { bg: P.NEUTRAL_BG, height: 32 }
  );
  pen.skip();

  pen.section('Money in — all properties');
  pen.head(head(''), RIGHT);
  grid(pen, 'Rent — what the leases oblige', { total: t.rent, byMonth: t.rentByMonth, undated: 0 });
  grid(pen, 'Other income', { total: t.otherIncome, byMonth: t.incomeByMonth, undated: t.inUndated });
  grid(pen, 'Total in', { total: t.revenue, byMonth: t.inByMonth, undated: t.inUndated }, { bold: true, bg: P.SUMMARY_BG });
  pen.skip();

  pen.section('Money out — all properties, by category');
  pen.head(head('Category'), RIGHT);
  if (!pkg.categories.length) {
    pen.note('Nothing recorded for this year.', {});
  } else {
    for (const c of pkg.categories) {
      grid(pen, c.label, c, c.key == null ? { bg: P.GOLD_BG, ink: P.GOLD_INK } : {});
    }
    grid(pen, 'Total out', { total: t.spent, byMonth: t.outByMonth, undated: t.outUndated }, { bold: true, bg: P.SUMMARY_BG });
  }
  pen.skip();

  grid(pen, 'Money in less money out', { total: t.grossNet, byMonth: t.netByMonth, undated: t.netUndated }, { bold: true, bg: P.SUMMARY_BG });
  pen.skip();

  pen.section('What the year left');
  pen.head(['', 'Amount'], RIGHT);
  pen.line(['Money in less money out', t.grossNet], { aligns: RIGHT });
  pen.line(['Plus what tenants reimbursed (for the year)', t.recovered], { aligns: RIGHT });
  pen.line(['What the year left', t.net], { bold: true, bg: P.SUMMARY_BG, aligns: RIGHT });
  pen.skip();

  pen.section('What the year left — by property');
  pen.head(head('Property'), RIGHT);
  for (const p of pkg.properties) {
    grid(pen, p.name, { total: p.grossNet, byMonth: p.netByMonth, undated: p.netUndated });
  }
  pen.note(
    'These are money in less money out, before the reimbursement — the same figures as the grid above, split by '
    + 'building. Each property\'s own sheet carries its reimbursement and its final figure.',
    { height: 26 }
  );

  // Owner money, below the net line and never inside it — the same rule the screen
  // follows. Only shown when there is any: an always-present "$0 distributed" is noise.
  if (t.distributions > 0) {
    pen.skip();
    pen.section('Your own money — not part of the figures above');
    pen.note(
      'Money you took out reduces your equity; it is not a cost of any building, so it is in no expense total. '
      + 'It is listed because it crossed the bank, and every bank line has to be accounted for somewhere.',
      { height: 26 }
    );
    pen.head(['', 'Amount'], RIGHT);
    pen.line(['Distributions — money you took out', t.distributions], { aligns: RIGHT });
  }

  if (pkg.flags.length) {
    pen.skip();
    pen.section('Worth knowing before you send this');
    for (const f of pkg.flags) pen.note(`• ${f}`, { bg: P.GOLD_BG, ink: P.GOLD_INK, height: 28 });
  }
  return ws;
}

// ── One property ─────────────────────────────────────────────────────────────
function addProperty(wb, p, year, used) {
  // Excel caps a sheet name at 31 chars and forbids : \ / ? * [ ]. Duplicates are
  // impossible in principle (a corporation's properties are uniquely named) but a
  // truncation can create one, so the suffix is applied rather than assumed away —
  // ExcelJS throws on a duplicate name and would fail the whole download.
  let name = String(p.name || 'Property').replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim() || 'Property';
  let n = 2;
  while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${n++}`;
  used.add(name.toLowerCase());

  const ws = xlsxSheet(wb, name, WIDTHS, { freeze: 0 });
  const pen = xlsxPen(ws, LAST);

  pen.title(`${p.name} — FY ${year}`);
  if (p.address) pen.pair('Address', p.address);
  pen.skip();

  // ── Money in ───────────────────────────────────────────────────────────────
  pen.section('Money in');
  pen.head(head(''), RIGHT);
  grid(pen, 'Rent — what the leases oblige', { total: p.rent, byMonth: p.rentByMonth, undated: 0 }, { bold: true });
  if (!p.rentRows.length) pen.line(['    No leases on this property for the year'], { aligns: RIGHT });
  for (const r of p.rentRows) grid(pen, indent(r.label), r);

  if (p.otherIncome > 0) {
    grid(pen, 'Other income', { total: p.otherIncome, byMonth: p.incomeByMonth, undated: p.incomeUndated }, { bold: true });
    for (const g of p.incomeGroups) grid(pen, indent(`${g.label} — ${g.count} line${g.count === 1 ? '' : 's'}`), g);
  }
  grid(pen, 'Total in', { total: p.revenue, byMonth: p.inByMonth, undated: p.inUndated }, { bold: true, bg: P.SUMMARY_BG });
  pen.skip();

  // ── Money out ──────────────────────────────────────────────────────────────
  pen.section('Money out');
  pen.head(head('Category / bucket'), RIGHT);
  if (!p.expenseRows.length) {
    pen.note('Nothing recorded for this year.', {});
  } else {
    for (const r of p.expenseRows) {
      // "Not categorized" is never folded into Other — it is surfaced so it can be
      // answered, which is the whole point of the category on the bucket.
      const gold = r.key == null ? { bg: P.GOLD_BG, ink: P.GOLD_INK } : {};
      grid(pen, r.label, r, { bold: true, ...gold });
      for (const it of r.items) {
        grid(pen, indent(it.flat ? `${it.label} — entered as one figure, not itemized` : it.label), it, gold);
      }
    }
    grid(pen, 'Total out', { total: p.expenseTotals.spent, byMonth: p.outByMonth, undated: p.outUndated }, { bold: true, bg: P.SUMMARY_BG });
  }
  pen.skip();

  grid(pen, 'Money in less money out', { total: p.grossNet, byMonth: p.netByMonth, undated: p.netUndated }, { bold: true, bg: P.SUMMARY_BG });
  pen.skip();

  // ── What came back ─────────────────────────────────────────────────────────
  pen.section('What tenants paid back — for the year');
  pen.note(
    'A tenant pays an estimate through the year and the difference is settled at reconciliation, so this is each '
    + 'tenant\'s actual share for the year as a whole. There is no month for it, which is why it sits below the grid '
    + 'rather than in it.',
    { height: 28 }
  );
  pen.head(['Category', 'Spent', 'Recovered', 'Your net cost'], ['left', 'right', 'right', 'right']);
  for (const r of p.expenseRows) {
    pen.line([r.label, r.spent, dash(r.recovered), r.net],
      { aligns: ['left', 'right', 'right', 'right'], ...(r.key == null ? { bg: P.GOLD_BG, ink: P.GOLD_INK } : {}) });
  }
  pen.line(['Total', p.expenseTotals.spent, dash(p.expenseTotals.recovered), p.expenseTotals.net],
    { bold: true, bg: P.SUMMARY_BG, aligns: ['left', 'right', 'right', 'right'] });
  pen.skip();

  pen.head(['What the year left', 'Amount'], RIGHT);
  pen.line(['Money in less money out', p.grossNet], { aligns: RIGHT });
  pen.line(['Plus what tenants reimbursed', p.expenseTotals.recovered], { aligns: RIGHT });
  pen.line(['What the year left', p.net], { bold: true, bg: P.SUMMARY_BG, aligns: RIGHT });
  // ⚠ THE RECONCILIATION AN ACCOUNTANT WILL CHECK. It has to be arithmetic they can
  // follow on the page, not a claim. NOI is built from BILLED expenses only — `cam_total`
  // counts `billable is not false` lines — so a cost the landlord entered and chose to
  // eat is in this sheet and in none of NOI. Naming all three terms is what makes the two
  // figures meet; naming two of them (as this note did when it shipped) does not.
  pen.note(
    `The app's own NOI for this property reads ${usd(p.noi)}. It answers a different question, and these figures `
    + `reconcile to it exactly: NOI ${usd(p.noi)} + ${usd(p.recovered)} tenants reimbursed + ${usd(p.otherIncome)} `
    + `other income − ${usd(p.absorbed)} of costs you entered and chose not to bill = ${usd(p.net)}. NOI counts only `
    + 'what you billed tenants for, which is why the last term is there.',
    { height: 32 }
  );

  if (p.distributionsTotal > 0) {
    pen.skip();
    pen.section('Your own money — not part of the figures above');
    pen.head(head(''), RIGHT);
    for (const d of p.distributions) {
      for (const it of d.items) grid(pen, it.label, it);
    }
  }
  return ws;
}

export async function downloadIncomeExpenseXlsx({ corporationId, corporationName, year, prebuilt = null } = {}) {
  const pkg = prebuilt || (await buildIncomeExpense(corporationId, year));
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Amlak';

  // A real date, formatted once and passed down — the sheets must all agree, and a
  // second `new Date()` two functions later is how they stop.
  const now = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  addSummary(wb, pkg, corporationName || 'Portfolio', now);
  const used = new Set(['summary']);
  for (const p of pkg.properties) addProperty(wb, p, year, used);

  const buf = await wb.xlsx.writeBuffer();
  saveWorkbook(buf, `${fileSlug(corporationName, 'portfolio')}-income-expenses-${year}.xlsx`);
  return pkg;
}
