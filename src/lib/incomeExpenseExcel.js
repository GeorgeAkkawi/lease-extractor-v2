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
    'Each month of Money in is what tenants were billed that month — the same figure the Ledger and the invoice '
    + 'show. Expenses sit in the month they were paid. Anything with no date on it is in the last column rather '
    + 'than spread across the year — every row adds across to its Total. The year-end reconciliation is settled '
    + 'once and has no month, so it sits on its own line; it is the tenants\' share of the expenses entered so '
    + 'far, and stays provisional until the year\'s costs are all recorded.',
    { bg: P.NEUTRAL_BG, height: 32 }
  );
  pen.skip();

  pen.section('Money in — all properties');
  pen.head(head(''), RIGHT);
  grid(pen, 'Rent', { total: t.rent, byMonth: t.rentByMonth, undated: 0 });
  if (Math.abs(t.camTaxBilled) > 0.005) grid(pen, 'CAM & tax billed to tenants', { total: t.camTaxBilled, byMonth: t.camTaxByMonth, undated: 0 });
  if (Math.abs(t.roofBilled) > 0.005) grid(pen, 'Roof billed to tenants', { total: t.roofBilled, byMonth: t.roofByMonth, undated: 0 });
  if (Math.abs(t.charges) > 0.005) grid(pen, 'Charges & credits', { total: t.charges, byMonth: t.chargesByMonth, undated: 0 });
  grid(pen, 'Other income', { total: t.otherIncome, byMonth: t.incomeByMonth, undated: t.inUndated });
  grid(pen, 'Total billed', { total: t.billedTotal, byMonth: t.inByMonth, undated: t.inUndated }, { bold: true, bg: P.SUMMARY_BG });
  if (Math.abs(t.trueUp) > 0.005) {
    grid(pen, 'Year-end reconciliation — actual share less what was billed', { total: t.trueUp, byMonth: Array(12).fill(0), undated: 0 });
    // No months — see the note on the property sheet's copy of this row.
    grid(pen, 'Total earned', { total: t.earned, byMonth: Array(12).fill(0), undated: 0 }, { bold: true, bg: P.SUMMARY_BG });
  }
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
  pen.line([Math.abs(t.trueUp) > 0.005 ? 'Total earned' : 'Total billed', t.earned], { aligns: RIGHT });
  pen.line(['Less what you spent', -t.spent], { aligns: RIGHT });
  pen.line(['What the year left', t.net], { bold: true, bg: P.SUMMARY_BG, aligns: RIGHT });
  pen.skip();

  // ⚠ THESE ROWS ARE `grossNet`, NOT `net`, and the heading has to say which. They are the
  // monthly grid split by building, so they cannot carry the year-end reconciliation — it
  // has no month, and a row whose cells don't add across to its own total is what
  // `workbookValidity.test.js` rejects out of the real file bytes. Calling them "what the
  // year left" (as this did until the 2026-08-16 audit) named them after a figure they are
  // not: on the demo they miss it by the true-up.
  pen.section('Money in less money out — by property');
  pen.head(head('Property'), RIGHT);
  for (const p of pkg.properties) {
    grid(pen, p.name, { total: p.grossNet, byMonth: p.netByMonth, undated: p.netUndated });
  }
  pen.note(
    'The grid above, split by building. These are the months only, so they stop short of the year-end '
    + 'reconciliation, which belongs to no month — each property\'s own sheet carries that line and its final '
    + 'figure.',
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
  //
  // ⚠ EVERY COMPONENT OF THE BILL, SEPARATELY (2026-08-16). This block used to print one
  // "Rent" row carrying base rent alone, so no monthly cell matched the Ledger, the invoice
  // or the bank — 18-23% low per tenant on the demo. The components are now stated, and
  // `Total billed` for a month is exactly what the Ledger shows that month as owed.
  pen.section('Money in');
  pen.head(head(''), RIGHT);
  grid(pen, 'Rent', { total: p.rent, byMonth: p.rentByMonth, undated: 0 }, { bold: true });
  if (!p.rentRows.length) pen.line(['    No leases on this property for the year'], { aligns: RIGHT });
  for (const r of p.rentRows) grid(pen, indent(r.label), r);

  if (Math.abs(p.camTaxBilled) > 0.005) {
    grid(pen, 'CAM & tax billed to tenants', { total: p.camTaxBilled, byMonth: p.camTaxByMonth, undated: 0 }, { bold: true });
    for (const r of p.camTaxRows) if (Math.abs(r.total) > 0.005) grid(pen, indent(r.label), r);
  }
  if (Math.abs(p.roofBilled) > 0.005) {
    grid(pen, 'Roof billed to tenants', { total: p.roofBilled, byMonth: p.roofByMonth, undated: 0 }, { bold: true });
    for (const r of p.roofRows) if (Math.abs(r.total) > 0.005) grid(pen, indent(r.label), r);
  }
  if (p.chargeRows.length) {
    grid(pen, 'Charges & credits', { total: p.charges, byMonth: p.chargesByMonth, undated: 0 }, { bold: true });
    for (const r of p.chargeRows) grid(pen, indent(r.label), r);
  }

  if (p.otherIncome > 0) {
    grid(pen, 'Other income', { total: p.otherIncome, byMonth: p.incomeByMonth, undated: p.incomeUndated }, { bold: true });
    for (const g of p.incomeGroups) grid(pen, indent(`${g.label} — ${g.count} line${g.count === 1 ? '' : 's'}`), g);
  }
  grid(pen, 'Total billed', { total: p.billedTotal, byMonth: p.inByMonth, undated: p.inUndated }, { bold: true, bg: P.SUMMARY_BG });

  // The year-end true-up. One line and not twelve, deliberately: it is settled once, and
  // spreading it back across the months would invent figures and break the promise that
  // every cell above equals the Ledger.
  if (Math.abs(p.trueUp) > 0.005) {
    grid(pen, 'Year-end reconciliation — actual share less what was billed',
      { total: p.trueUp, byMonth: Array(12).fill(0), undated: 0 });
    // ⚠ NO MONTHS ON THIS ROW, deliberately. It contains a year-end figure that belongs to
    // no month, so printing the billed months beside it would give a row whose cells do not
    // add across to its own total — which `workbookValidity.test.js` reads out of the real
    // file bytes and rejects, and which an accountant would reject for the same reason.
    grid(pen, 'Total earned', { total: p.earned, byMonth: Array(12).fill(0), undated: 0 }, { bold: true, bg: P.SUMMARY_BG });
  }
  // ⚠ THE YEAR-END LINE IS PROVISIONAL UNTIL THE COSTS ARE ALL IN, and it has to say so.
  // It is the tenants' share of the expenses RECORDED SO FAR less what they were billed —
  // so a landlord downloading this in July, with half the year's costs entered, gets a
  // large negative figure that is arithmetically right and reads like an alarm. The old
  // sheet had the same dependency, buried below the grid as "what tenants paid back";
  // giving it a line of its own is what made saying this necessary.
  pen.note(
    'Each month above is what the tenant was billed that month — the same figure the Ledger and the invoice show. '
    + 'Tenants pay an estimate for CAM & tax through the year; the difference between that and their actual share is '
    + 'settled once at reconciliation, which is the line with no months against it. That line is their share of the '
    + 'expenses entered so far, so until the year\'s costs are all recorded it is provisional.',
    { height: 32 }
  );
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
  // ⚠ THE SAME MONEY AS THE MONEY-IN ROWS, NOT A SECOND HELPING OF IT, and it has to say
  // so. Until 2026-08-16 the reimbursement appeared only here, netted off the cost side;
  // it is now stated on the income side too, so a reader who adds this to "CAM & tax
  // billed" above would count it twice — the exact error the old arrangement avoided,
  // arriving from the other direction. This block is what those dollars OFFSET, by
  // category; "What the year left" below adds nothing back.
  pen.note(
    'This is each tenant\'s actual pro-rata share of the year\'s costs, set against the categories it offsets. It is '
    + 'the SAME money already shown in Money in — the CAM & tax and roof rows there, plus the year-end reconciliation '
    + '— shown here a second way, not a second time. Nothing below adds it back.',
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

  // ⚠ THE REIMBURSEMENT IS NO LONGER ADDED BACK HERE, and it must not be: since 2026-08-16
  // it is stated on the income side as "CAM & tax billed" + the year-end reconciliation, so
  // adding it a second time below the expenses would count it twice — the exact error the
  // old netting arrangement existed to avoid, arriving from the other direction. What the
  // year left is now plain subtraction, which is also what an accountant will try first.
  pen.head(['What the year left', 'Amount'], RIGHT);
  pen.line([Math.abs(p.trueUp) > 0.005 ? 'Total earned' : 'Total billed', p.earned], { aligns: RIGHT });
  pen.line(['Less what you spent', -p.expenseTotals.spent], { aligns: RIGHT });
  pen.line(['What the year left', p.net], { bold: true, bg: P.SUMMARY_BG, aligns: RIGHT });
  // ⚠ THE RECONCILIATION AN ACCOUNTANT WILL CHECK. It has to be arithmetic they can
  // follow on the page, not a claim — so the terms are BUILT (`noiBridge`, incomeExpense.js)
  // and this only renders them. Written as a sentence it was wrong twice: missing
  // `absorbed` when it shipped, and missing the rent basis until the 2026-08-16 audit,
  // where Oak Center printed an equation out by $17,999.94 under the word "exactly".
  // `noiBridge` carries a catch-all residual, so a term nobody thought of prints as a
  // visible difference instead of turning the sum into a lie.
  pen.note(
    `The app's own NOI for this property reads ${usd(p.noiBridge.noi)}. It answers a different question, and these `
    + `figures bridge to it: NOI ${usd(p.noiBridge.noi)}`
    + p.noiBridge.terms.map((t) => ` ${t.amount < 0 ? '−' : '+'} ${usd(Math.abs(t.amount))} ${t.label}`).join('')
    + ` = ${usd(p.noiBridge.total)}. NOI counts only what you billed tenants for, at each lease's annual rate, and `
    + 'knows nothing about a late fee or a write-off — which is what the terms after it are for.',
    { height: 44 }
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
