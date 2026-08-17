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
// ⚠ A TINT MEANS A DECISION WAS POSTED ON THAT MONTH — never that the cash came in short.
// George set that condition himself (2026-08-17): *"only … when a charge is actually confirmed
// as carried trhough or written off or a credit was paid. if nothing has changed we dont want
// the revenue to not match the true money being exchanged."* Marking the months where the
// money merely fell short would colour a sheet for months still waiting on a bank statement,
// and it would mix bases: this grid is what tenants were BILLED. `row.marks` (adjustments.js)
// is null unless a real `lease_adjustments` row lands on the month.
//
// The VALUE never moves, so every row still adds across to its own figure and Total billed
// still ties to the Ledger to the cent — the colour is the only thing added.
const markStyle = (marks) => {
  if (!marks) return {};
  const cellBg = {}; const cellInk = {}; const cellNote = {};
  marks.forEach((mk, i) => {
    if (!mk) return;
    const col = i + 2;                       // A: label · B: total · C…N: Jan…Dec
    const credit = mk.total < 0;
    cellBg[col] = credit ? P.FOREST_BG : P.GOLD_BG;
    cellInk[col] = credit ? P.FOREST_INK : P.GOLD_INK;
    cellNote[col] = mk.items
      .map((it) => `${it.label}: ${it.amount < 0 ? '−' : '+'}${usd(Math.abs(it.amount))}${it.memo ? ` — ${it.memo}` : ''}`)
      .join('\n');
  });
  return { cellBg, cellInk, cellNote };
};

const grid = (pen, label, row, opts = {}) =>
  pen.line(
    [label, row.total ?? row.spent ?? 0, ...(row.byMonth || []).map(dash), dash(row.undated)],
    { aligns: RIGHT, ...markStyle(row.marks), ...opts }
  );

const indent = (label) => `    ${label}`;

const usd = (n) => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/**
 * The accrual-to-cash bridge, printed under "What the year left" on BOTH sheets.
 *
 * ⚠ "LEAVE IT OPEN" HAD NO ACCOUNTING CONSEQUENCE AND NO VISIBILITY, which is the gap the
 * five-questions audit turned up: the three settlements are deliberately different — a
 * write-off reduces the year's income, a carry-forward moves only the receivable, and leaving
 * it open moves NOTHING. The last is right, and it meant the sheet printed "Total earned
 * $191,290" with no hint that $58,844 of it never arrived. This is the first question an
 * accountant asks of an accrual statement, and the figure was already on the shape.
 *
 * ⚠ IT IS AN ANNOTATION, NEVER A TERM. It is printed BELOW the net line and subtracted from
 * nothing — the money was earned and the sheet is right to count it. Netting it here would
 * turn an accrual statement into neither one thing nor the other.
 */
const uncollected = (pen, s) => {
  const owed = round2(s?.owed || 0);
  const credit = round2(s?.inCredit || 0);
  if (owed > 0.005) pen.line([indent('of which still uncollected at year end'), owed], { aligns: RIGHT, bg: P.GOLD_BG, ink: P.GOLD_INK });
  if (credit > 0.005) pen.line([indent('and held for tenants who are ahead'), -credit], { aligns: RIGHT });
};

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
  if (Math.abs(t.carried) > 0.005) grid(pen, 'Brought forward and refunds — not this year’s income', { total: t.carried, byMonth: t.carriedByMonth, undated: 0 });
  grid(pen, 'Other income', { total: t.otherIncome, byMonth: t.incomeByMonth, undated: t.inUndated });
  grid(pen, 'Total billed', { total: t.billedTotal, byMonth: t.inByMonth, undated: t.inUndated }, { bold: true, bg: P.SUMMARY_BG });
  if (Math.abs(t.trueUp) > 0.005 || Math.abs(t.carried) > 0.005) {
    if (Math.abs(t.carried) > 0.005) grid(pen, 'Less brought forward and refunds', { total: -t.carried, byMonth: Array(12).fill(0), undated: 0 });
    if (Math.abs(t.trueUp) > 0.005) grid(pen, 'Year-end reconciliation — actual share less what was billed', { total: t.trueUp, byMonth: Array(12).fill(0), undated: 0 });
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
  uncollected(pen, t);
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

// ── Bank tie-out ─────────────────────────────────────────────────────────────
//
// The one sheet in this workbook whose right-hand column did not come from Amlak. Every
// other figure here is the app checking its own arithmetic; this asks whether the money
// the BANK showed reached the books at all.
//
// ⚠ IT IS ITS OWN SHEET RATHER THAN A BLOCK ON EACH PROPERTY, because the question it
// answers is asked once — "did anything go astray?" — and a reader who has to visit five
// tabs to find out has been given five chances to stop looking. Properties with no
// imported statement are named on it and skipped: "nothing imported" and "imported and
// clean" are different answers and must not print the same.
//
// A: what it was filed as · B: on the statement · C: in the books · D: the difference ·
// E: what that means in words. Five columns, no monthly grid — the tie-out is a
// comparison, not a year.
const TIE_WIDTHS = [36, 16, 16, 14, 62];
const TIE_LAST = 'E';
const TIE_ALIGN = ['left', 'right', 'right', 'right', 'left'];

function addTieOut(wb, pkg, year) {
  const ws = xlsxSheet(wb, 'Where bank money went', TIE_WIDTHS, { freeze: 0 });
  const pen = xlsxPen(ws, TIE_LAST);

  pen.title(`Where your bank money went — FY ${year}`);
  pen.note(
    'Two columns from two different places. The left is every line on the statements you imported, grouped by what '
    + 'you decided about it. The right is the real rows in your books — payments, expenses, other income — read from '
    + 'those tables and not from the lines, because a report derived from the same list it is checking would balance '
    + 'no matter what was wrong. Money in and money out are never netted against each other.',
    { bg: P.NEUTRAL_BG, height: 40 }
  );
  pen.skip();

  const side = (title, s) => {
    pen.head([title, 'The bank showed', 'Amlak recorded', 'Difference', ''], TIE_ALIGN);
    for (const r of s.rows) {
      const off = Math.abs(r.diff) > 0.005;
      const attention = off || (r.unplaced && r.statement > 0.005) || r.unknown;
      pen.line(
        [
          r.label,
          r.statement,
          r.books == null ? '—' : r.books,
          r.books == null ? '' : r.diff,
          r.booksLabel ? `${r.booksLabel}${off ? '' : ' ✓'}` : r.nowhere || '',
        ],
        { aligns: TIE_ALIGN, ...(attention ? { bg: P.GOLD_BG, ink: P.GOLD_INK } : {}) }
      );
    }
    pen.line([`Total ${title.toLowerCase()}`, s.statementTotal, '', '', ''], { bold: true, bg: P.SUMMARY_BG, aligns: TIE_ALIGN });
  };

  for (const p of pkg.properties) {
    pen.section(p.name);
    const t = p.tieOut;
    if (!t) {
      pen.note('No bank statement has been imported for this property this year, so there is nothing to tie out. '
        + 'That is not the same as "checked and clean".', { height: 26 });
      pen.skip();
      continue;
    }
    pen.pair('Statements read', String(t.imports));
    side('Money in on your statements', t.in);
    pen.skip();
    side('Money out on your statements', t.out);
    pen.skip();

    // ⚠ RENT NEVER TIES, AND SAYS SO IN ITS OWN HEADING. Cash off the bank against what
    // was billed differs by arrears or prepayment on every property in the world. Printed
    // as a difference among the others it would read as a fault and teach the reader that
    // this sheet cries wolf.
    // ⚠ AND THE HEADING SAYS IT IN PLAIN WORDS. "Rent is a reconciling item" is accountant's
    // English sitting a few rows under a Money-in row that is ALSO about tenant rent and
    // means the opposite. Two headings that read alike and mean opposite things is a
    // labelling fault (George, 2026-08-17: *"i dont get the tenant rent difference"*).
    if (t.rent) {
      pen.head(['Your whole year’s rent — not a tie, and not meant to balance', 'Amount', '', '', ''], TIE_ALIGN);
      pen.line(['Billed to tenants this year', t.rent.billed, '', '', 'every month of every lease\'s schedule'], { aligns: TIE_ALIGN });
      pen.line(['Received this year', t.rent.received, '', '', 'every payment recorded against those bills, however it arrived'], { aligns: TIE_ALIGN });
      pen.line([
        t.rent.behind >= 0 ? 'Still owed' : 'Paid ahead',
        Math.abs(t.rent.behind), '', '',
        t.rent.behind >= 0
          ? 'arrears. The Ledger names it tenant by tenant, month by month.'
          : 'tenants are ahead of their bills. The Ledger names who.',
      ], { bold: true, bg: P.SUMMARY_BG, aligns: TIE_ALIGN });
      pen.skip();
    }

    if (t.handEntered && (t.handEntered.expenses > 0.005 || t.handEntered.income > 0.005)) {
      pen.note(
        `Not part of the comparison above: ${usd(t.handEntered.expenses)} of expenses and ${usd(t.handEntered.income)} `
        + 'of other income are on the books with no imported statement behind them. Typed in by hand, or paid from an '
        + 'account you have not imported. Real money, simply not something a bank line can confirm.',
        { height: 28 }
      );
    }

    if (t.differences.length) {
      pen.head(['What to look at', '', '', '', ''], TIE_ALIGN);
      for (const d of t.differences) pen.note(`• ${d}`, { bg: P.GOLD_BG, ink: P.GOLD_INK, height: 34 });
    } else if (!(t.notChecked || []).length) {
      pen.note('Every line on these statements reaches the figure it was filed as. ✓', { height: 16 });
    }
    // ⚠ ITS OWN HEADING, AND NOT GOLD. Money that could not be checked is not money that is
    // wrong — filed under "what to look at" it would send an accountant hunting for a fault
    // that does not exist, and would mark every account that imported a statement before the
    // line record existed. See bankTieOut.js for why the two tiers are never summed.
    if ((t.notChecked || []).length) {
      pen.head(['Could not be checked — not a difference', '', '', '', ''], TIE_ALIGN);
      for (const d of t.notChecked) pen.note(`• ${d}`, { bg: P.NEUTRAL_BG, height: 34 });
    }
    pen.skip();
  }

  // ⚠ SAID ON THE SHEET, NOT ASSUMED. A tie-out that balances is easily read as "the books
  // are right", which it is not — it says the two records agree, and they can agree on the
  // same wrong number. Stating the three blind spots is what makes the ✓ above worth
  // anything.
  pen.section('What this cannot catch');
  pen.note('• A line transcribed with the wrong amount. Both sides carry the same wrong number and it ties perfectly.', { height: 16 });
  pen.note('• Money that never touched the account you imported — another bank account, or cash.', { height: 16 });
  pen.note('• A line filed under the wrong heading. It ties, in the wrong bucket.', { height: 16 });
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
  // The tint's legend, printed where the tinted cells are. Without it a coloured cell is a
  // reader guessing, and the likeliest guess — "this month wasn't paid" — is the one thing
  // it does NOT mean.
  if (p.rentRows.some((r) => r.marks) || p.camTaxRows.some((r) => r.marks) || p.chargeRows.length) {
    pen.note(
      'A shaded month carries a charge or a credit somebody posted on it, and that figure is already '
      + 'inside the amount shown — gold for a charge, green for a credit. Hover the cell for what it was. '
      + 'Shading never means a month went unpaid: these columns are what tenants were BILLED, and what '
      + 'actually reached the bank is the “Where bank money went” sheet.',
      { height: 28 },
    );
  }
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
  // ⚠ IN Total billed, OUT AGAIN BEFORE Total earned, and the row title has to carry that
  // by itself — this is the one line on the sheet that appears twice with opposite signs.
  // It is here because the Ledger bills it (a balance brought forward is genuinely owed) and
  // it leaves before "earned" because it was another year's income, or never income at all.
  if (p.carriedRows.length) {
    grid(pen, 'Brought forward and refunds — not this year’s income', { total: p.carried, byMonth: p.carriedByMonth, undated: 0 }, { bold: true });
    for (const r of p.carriedRows) grid(pen, indent(r.label), r);
  }

  if (p.otherIncome > 0) {
    grid(pen, 'Other income', { total: p.otherIncome, byMonth: p.incomeByMonth, undated: p.incomeUndated }, { bold: true });
    for (const g of p.incomeGroups) grid(pen, indent(`${g.label} — ${g.count} line${g.count === 1 ? '' : 's'}`), g);
  }
  grid(pen, 'Total billed', { total: p.billedTotal, byMonth: p.inByMonth, undated: p.inUndated }, { bold: true, bg: P.SUMMARY_BG });

  // The year-end true-up. One line and not twelve, deliberately: it is settled once, and
  // spreading it back across the months would invent figures and break the promise that
  // every cell above equals the Ledger.
  if (Math.abs(p.trueUp) > 0.005 || Math.abs(p.carried) > 0.005) {
    if (Math.abs(p.carried) > 0.005) {
      grid(pen, 'Less brought forward and refunds', { total: -p.carried, byMonth: Array(12).fill(0), undated: 0 });
    }
    if (Math.abs(p.trueUp) > 0.005) {
      grid(pen, 'Year-end reconciliation — actual share less what was billed',
        { total: p.trueUp, byMonth: Array(12).fill(0), undated: 0 });
    }
    // ⚠ NO MONTHS ON THESE ROWS, deliberately. They contain year-end figures that belong to
    // no month, so printing the billed months beside them would give a row whose cells do not
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

  // ── Where each tenant stands ───────────────────────────────────────────────
  //
  // George, 2026-08-16: *"How do we convey credits or debits at the end of the year?"* Here,
  // and on the Ledger row, from one function (`propertyStandings`, settle.js) reading the same
  // `allocatePayments` / `ledgerRowSummary` pair the Ledger grid is painted from.
  //
  // ⚠ THE CLOSING BALANCE IS NOT `billed − received`. It is `owesToDate − credit`, so a year
  // still in progress does not report December's rent as arrears — see `tenantStanding`.
  // ⚠ A TABLE, NOT THE MONTHLY GRID — like "What tenants paid back" below it. `workbookValidity`
  // asserts every row's months add across to its own Total, and it reads the SUMMARY sheet,
  // where the grid lives; a five-column block here would be checked as if C–E were months.
  // Anything monthly belongs above, in the grid, where that guard can see it.
  if (p.standings.rows.length) {
    // ⚠ SIX COLUMNS NOW, AND THE SIXTH IS THE ONE THAT SURVIVES REOPENING. A closing balance of
    // zero cannot tell a year that was COLLECTED from one that was FORGIVEN — opposite facts,
    // identical figure — so "Settled as" states what was decided. Same string the year-close
    // snapshot stores (`settled_as`), from one function (`settledAs`, settle.js).
    const ALIGN6 = ['left', 'right', 'right', 'right', 'right', 'left'];
    pen.section('Where each tenant stands');
    pen.head(['Tenant', 'Billed', 'Received', 'Charges & credits', 'Closing balance', 'Settled as'], ALIGN6);
    for (const s of p.standings.rows) {
      pen.line(
        [s.label, s.billed, s.received, dash(s.charges), s.settled ? '—' : s.closing, s.settledAs],
        { aligns: ALIGN6, ...(s.settled ? {} : { bg: P.GOLD_BG, ink: P.GOLD_INK }) }
      );
    }
    pen.line(['Total', p.standings.totals.billed, p.standings.totals.received, dash(p.standings.totals.charges),
      round2(p.standings.totals.owed - p.standings.totals.inCredit), ''],
    { bold: true, bg: P.SUMMARY_BG, aligns: ALIGN6 });
    pen.note(
      'A positive closing balance is money the tenant still owes; a negative one is money they are ahead by. It counts '
      + 'only the months that have come due, so a year still running does not report next month\'s rent as arrears. '
      + '"Settled as" is what was decided about it: written off (which came off this year\'s income), carried forward '
      + 'into next January (which moved the receivable and not the income), refunded, left open — or square, meaning '
      + 'there was nothing to decide. Settle up on the Ledger row is where those choices are made.',
      { height: 42 }
    );
    pen.skip();
  }

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
  uncollected(pen, p.standings.totals);
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
  // Only when there is something to tie out. An always-present tab reading "nothing
  // imported" on every property teaches the reader to skip the one sheet that would have
  // told them money went astray.
  if (pkg.properties.some((p) => p.tieOut)) {
    addTieOut(wb, pkg, year);
    used.add('where bank money went');
  }
  for (const p of pkg.properties) addProperty(wb, p, year, used);

  const buf = await wb.xlsx.writeBuffer();
  saveWorkbook(buf, `${fileSlug(corporationName, 'portfolio')}-income-expenses-${year}.xlsx`);
  return pkg;
}
