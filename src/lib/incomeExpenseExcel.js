// The Income-and-expenses workbook. Pure formatting over incomeExpense.js — no AI, no
// network of its own. ExcelJS is imported lazily so it stays out of the initial page
// load, exactly as the reconciliation workbook does.
//
// Summary (every property, one row each) + one sheet per property. That is the whole
// structure: the three packages this replaced ran to five sheets each because each was
// arguing with a form. This one is a list of what came in and what went out.
import { saveWorkbook, fileSlug } from './download';
import { xlsxSheet, xlsxPen, XLSX_PALETTE } from './xlsx';
import { buildIncomeExpense } from './incomeExpense';

const P = XLSX_PALETTE;

const dash = (n) => (Math.abs(Number(n) || 0) < 0.005 ? '—' : Number(n));

// ── Summary ──────────────────────────────────────────────────────────────────
function addSummary(wb, pkg, corporationName, now) {
  const ws = xlsxSheet(wb, 'Summary', [34, 16, 16, 16, 16, 16, 16], { freeze: 0 });
  const pen = xlsxPen(ws, 'G');

  pen.title(`${corporationName} — income and expenses, FY ${pkg.year}`);
  pen.pair('Prepared', now);
  pen.pair('Properties', String(pkg.properties.length));
  pen.skip();

  pen.note(
    'Rent is what the leases oblige for the year. Expenses are shown three ways: what you spent, what tenants '
    + 'reimbursed through their share, and what it therefore cost you. The reimbursement is netted off the cost '
    + 'rather than added to rent — counting it in both places would report the same dollars twice.',
    { bg: P.NEUTRAL_BG, height: 30 }
  );
  pen.skip();

  pen.head(['Property', 'Rent', 'Other income', 'Total in', 'Spent', 'Recovered', 'Your net cost']);
  for (const p of pkg.properties) {
    pen.line([p.name, p.rent, dash(p.otherIncome), p.revenue, p.expenseTotals.spent, dash(p.expenseTotals.recovered), p.expenseTotals.net]);
  }
  const t = pkg.totals;
  pen.line(['All properties', t.rent, dash(t.otherIncome), t.revenue, t.spent, dash(t.recovered), t.netCost], { bold: true, bg: P.SUMMARY_BG });
  pen.skip();

  pen.section('What the year left');
  pen.head(['Property', 'Net']);
  for (const p of pkg.properties) pen.line([p.name, p.net]);
  pen.line(['All properties', t.net], { bold: true, bg: P.SUMMARY_BG });

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
    pen.head(['', 'Amount']);
    pen.line(['Distributions — money you took out', t.distributions]);
  }

  if (pkg.flags.length) {
    pen.skip();
    pen.section('Worth knowing before you send this');
    for (const f of pkg.flags) pen.note(`• ${f}`, { bg: P.GOLD_BG, ink: P.GOLD_INK, height: 26 });
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

  const ws = xlsxSheet(wb, name, [38, 16, 16, 16, 26], { freeze: 0 });
  const pen = xlsxPen(ws, 'E');

  pen.title(`${p.name} — FY ${year}`);
  if (p.address) pen.pair('Address', p.address);
  pen.skip();

  pen.section('Money in');
  pen.head(['', 'Amount', '', '', '']);
  pen.line(['Rent — what the leases oblige', p.rent]);
  for (const g of p.incomeGroups) pen.line([`${g.label} — ${g.count} line${g.count === 1 ? '' : 's'}`, g.total]);
  pen.line(['Total in', p.revenue], { bold: true, bg: P.SUMMARY_BG });
  pen.skip();

  pen.section('Money out');
  pen.head(['Category', 'Spent', 'Recovered', 'Your net cost', 'Buckets']);
  if (!p.expenseRows.length) {
    pen.note('Nothing recorded for this year.', {});
  } else {
    for (const r of p.expenseRows) {
      pen.line(
        [r.label, r.spent, dash(r.recovered), r.net, r.buckets.join(', ')],
        // "Not categorized" is never folded into Other — it is surfaced so it can be
        // answered, which is the whole point of the category on the bucket.
        r.key == null ? { bg: P.GOLD_BG, ink: P.GOLD_INK, aligns: ['left', 'right', 'right', 'right', 'left'] } : { aligns: ['left', 'right', 'right', 'right', 'left'] }
      );
    }
    pen.line(['Total out', p.expenseTotals.spent, dash(p.expenseTotals.recovered), p.expenseTotals.net, ''], { bold: true, bg: P.SUMMARY_BG, aligns: ['left', 'right', 'right', 'right', 'left'] });
  }
  pen.skip();

  pen.head(['What the year left', 'Net', '', '', '']);
  pen.line(['Total in less your net cost', p.net], { bold: true, bg: P.SUMMARY_BG });
  pen.note(
    `The app's own NOI for this property reads $${p.noi.toLocaleString('en-US', { minimumFractionDigits: 2 })}. `
    + 'It is a different question, not a different answer: NOI takes the gross expense off the rent and counts '
    + `neither the $${p.recovered.toLocaleString('en-US', { minimumFractionDigits: 2 })} tenants reimbursed nor `
    + `the $${p.otherIncome.toLocaleString('en-US', { minimumFractionDigits: 2 })} of other income. Add both back and the two figures meet.`,
    { height: 30 }
  );

  if (p.distributionsTotal > 0) {
    pen.skip();
    pen.section('Your own money — not part of the figures above');
    pen.head(['', 'Amount', '', '', '']);
    for (const d of p.distributions) pen.line([`${d.label} — ${d.buckets.join(', ')}`, d.spent]);
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
