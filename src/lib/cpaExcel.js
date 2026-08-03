// The CPA package workbook — five sheets, built entirely from figures the app already
// shows. Pure formatting over cpaPackage.js (no AI, no network of its own). ExcelJS is
// imported lazily so it stays out of the initial page load, exactly as the reconciliation
// workbook does.
//
// The sheets, and why each earns its place:
//   Summary            — the form's own layout: categories down, properties across.
//   Detail             — every line behind every figure above it.
//   Depreciation       — the register, and what it refuses to compute.
//   Not on this return — the money deliberately left off, with the reason.
//   Tie-out            — where this package and the app's own NOI differ, and why.
//
// ⚠ The fourth sheet is the one that makes the other four trustworthy. Round 6 established
// the rule (a dollar is recorded somewhere or explicitly excluded WITH A REASON) and round
// 11 applied it to a document; this applies it to a tax package. A CPA cannot otherwise
// tell a careful export from one that quietly dropped every distribution.
import { saveWorkbook, fileSlug } from './download';
import { buildCpaPackage, FORM_REVISION_NOTE } from './cpaPackage';
import { assetKindLabel } from './depreciation';

const OLIVE = 'FF5C6B3C';
const CREAM = 'FFF1ECE1';
const INK = 'FF333333';
const MUTED = 'FF6B6B60';
const GOLD_BG = 'FFFBF3DF', GOLD_INK = 'FF7A5A12';
const NEUTRAL_BG = 'FFF1EFE8';
const SUMMARY_BG = 'FFF5F4F0';

const CUR = '$#,##0.00';

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FFCCCCCC' } };
const borders = { top: thin, left: thin, bottom: thin, right: thin };

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const colLetter = (n) => {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

// Exported for the 1099 worksheet (form1099Excel.js) so the two workbooks share ONE
// writer and one palette. §3's rule read forward: two implementations of one layout
// drift, and the second one would drift silently because nothing compares them.
export const XLSX_PALETTE = { OLIVE, CREAM, INK, MUTED, GOLD_BG, GOLD_INK, NEUTRAL_BG, SUMMARY_BG, CUR };
export { sheet as xlsxSheet, pen as xlsxPen };

// ⚠ A frozen pane MUST have a real split row. `{ state: 'frozen', ySplit: 0 }` declares a
// pane that splits nothing — Excel rejects it, calls the whole package damaged, and
// "repairs" it by discarding the view ("we found a problem… couldn't recover everything").
// The figures survive; the dialog does not inspire confidence. rentRollExcel.js:120 has
// carried this warning since the last time someone hit it. So: no split → NO view at all,
// and a real split carries the matching topLeftCell.
//
// Most sheets here pass { freeze: 0 } on purpose — they stack a title band, notes and
// several head() bands per property, so there is no single header row worth pinning.
function sheet(wb, name, widths, opts = {}) {
  const freeze = Number(opts.freeze ?? 1) || 0;
  const ws = wb.addWorksheet(name, {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
    ...(freeze > 0 ? { views: [{ state: 'frozen', ySplit: freeze, topLeftCell: `A${freeze + 1}` }] } : {}),
  });
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  return ws;
}

// A writer bound to one sheet, so every sheet lays out the same way.
function pen(ws, lastCol) {
  let r = 1;
  const api = {
    get row() { return r; },
    skip(n = 1) { r += n; return api; },
    title(text) {
      ws.mergeCells(`A${r}:${lastCol}${r}`);
      const c = ws.getCell(`A${r}`);
      c.value = text;
      c.font = { bold: true, size: 14, color: { argb: CREAM } };
      c.fill = fill(OLIVE);
      c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      ws.getRow(r).height = 24;
      r += 1;
      return api;
    },
    section(text) {
      ws.mergeCells(`A${r}:${lastCol}${r}`);
      const c = ws.getCell(`A${r}`);
      c.value = text;
      c.font = { bold: true, size: 11, color: { argb: CREAM } };
      c.fill = fill(OLIVE);
      c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      ws.getRow(r).height = 18;
      r += 1;
      return api;
    },
    note(text, opts = {}) {
      ws.mergeCells(`A${r}:${lastCol}${r}`);
      const c = ws.getCell(`A${r}`);
      c.value = text;
      c.font = { size: 10, italic: opts.italic !== false, color: { argb: opts.ink || MUTED } };
      c.alignment = { horizontal: 'left', wrapText: true, vertical: 'top' };
      if (opts.bg) c.fill = fill(opts.bg);
      if (opts.height) ws.getRow(r).height = opts.height;
      r += 1;
      return api;
    },
    pair(label, value) {
      ws.getCell(`A${r}`).value = label;
      ws.getCell(`A${r}`).font = { bold: true, size: 10, color: { argb: MUTED } };
      ws.getCell(`B${r}`).value = value;
      ws.getCell(`B${r}`).font = { size: 10, color: { argb: INK } };
      r += 1;
      return api;
    },
    head(cells, aligns = []) {
      cells.forEach((h, i) => {
        const c = ws.getCell(r, i + 1);
        c.value = h;
        c.font = { bold: true, size: 9, color: { argb: INK } };
        c.fill = fill(NEUTRAL_BG);
        c.border = borders;
        c.alignment = { horizontal: aligns[i] || (i === 0 ? 'left' : 'right'), wrapText: true, vertical: 'bottom' };
      });
      r += 1;
      return api;
    },
    line(cells, opts = {}) {
      const { bg, ink = INK, bold = false, money: moneyFrom = 1, aligns = [] } = opts;
      cells.forEach((v, i) => {
        const c = ws.getCell(r, i + 1);
        c.value = v == null ? '' : v;
        if (i >= moneyFrom && typeof v === 'number') c.numFmt = CUR;
        c.border = borders;
        c.font = { size: 9, bold, color: { argb: ink } };
        if (bg) c.fill = fill(bg);
        c.alignment = { horizontal: aligns[i] || (i === 0 ? 'left' : 'right'), wrapText: i === 0 };
      });
      r += 1;
      return api;
    },
  };
  return api;
}

// ── Sheet 1 — Summary ────────────────────────────────────────────────────────
function addSummary(wb, pkg, now) {
  const props = pkg.properties;
  const nCols = 4 + props.length + 1; // label · 8825 · SchedE · [per property] · total
  const widths = [30, 30, 32, ...props.map(() => 16), 16];
  const ws = sheet(wb, 'Summary', widths, { freeze: 0 });
  const last = colLetter(Math.max(nCols, 5));
  const p = pen(ws, last);

  p.title(`${pkg.corporation.name || 'Portfolio'} — rental income and expenses · ${pkg.year}`);
  p.skip();
  p.pair('Entity', pkg.corporation.name || '—');
  p.pair('Tax year', String(pkg.year));
  p.pair('Basis', pkg.basis === 'cash' ? 'Cash — money that moved this year' : 'Accrual — the year each figure belongs to');
  p.pair('Properties', String(props.length));
  p.pair('Prepared', new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).toLocaleDateString('en-US'));
  p.skip();
  p.note(FORM_REVISION_NOTE);
  p.note('Figures are GROSS on both sides: a tenant’s CAM and tax reimbursement is rental income, and the expense it reimburses is deducted in full. What tenants paid back is shown on the tie-out sheet as context — it is never netted off an expense here.');
  p.skip();

  const propHeads = props.map((x) => x.name);
  const alignHead = ['left', 'left', 'left', ...props.map(() => 'right'), 'right'];

  // ── Income ──
  p.section('Rental income');
  p.head(['', 'Form 8825', 'Schedule E', ...propHeads, 'Total'], alignHead);
  const incomeRow = (label, f, e, pick) => {
    const vals = props.map((x) => Number(pick(x)) || 0);
    p.line([label, f, e, ...vals, vals.reduce((s, v) => s + v, 0)], { moneyFrom: 3 });
  };
  incomeRow(
    pkg.basis === 'cash' ? 'Rents received' : 'Rents billed',
    'Line 2 — Gross rents', 'Line 3 — Rents received',
    (x) => x.income.rent
  );
  if (pkg.summary.income.otherIncome > 0.005) {
    incomeRow('Other income — not tenant rent', 'Line 2 — Gross rents', 'Line 3 — Rents received', (x) => x.income.otherIncome);
  }
  const incTotals = props.map((x) => x.income.total);
  p.line(['TOTAL INCOME', '', '', ...incTotals, pkg.summary.income.total], { bg: SUMMARY_BG, bold: true, moneyFrom: 3 });
  p.skip();

  // ── Expenses ──
  p.section('Expenses');
  p.head(['Category', 'Form 8825', 'Schedule E', ...propHeads, 'Total'], alignHead);
  const formCell = (fl) => (fl ? `Line ${fl.line} — ${fl.label}${fl.viaOther ? ' (no line of its own)' : ''}` : 'No line on this form');
  for (const row of pkg.summary.rows) {
    p.line([row.label, formCell(row.f8825), formCell(row.schedE), ...row.byProperty, row.total], { moneyFrom: 3 });
  }

  // ⚠ Its own row, below the categories, and NEVER folded into "Other". Nobody deciding
  // is a different thing from someone choosing to file it as Other.
  if (pkg.summary.uncategorized) {
    const u = pkg.summary.uncategorized;
    p.line(['Not categorized', 'Needs a category before filing', u.buckets.length ? u.buckets.join(' · ') : '', ...u.byProperty, u.total],
      { bg: GOLD_BG, ink: GOLD_INK, bold: true, moneyFrom: 3 });
  }

  p.line(['TOTAL EXPENSES', '', '', ...pkg.summary.byPropertyExpense, pkg.summary.expenseTotal], { bg: SUMMARY_BG, bold: true, moneyFrom: 3 });
  p.skip();

  const nets = props.map((x) => x.netIncome);
  p.line(['NET RENTAL INCOME (LOSS)', 'Line 17', 'Line 21', ...nets, pkg.summary.netIncome], { bg: SUMMARY_BG, bold: true, moneyFrom: 3 });
  p.skip(2);

  if (pkg.summary.uncategorized) {
    p.note(`⚠ ${money(pkg.summary.uncategorized.total)} has no tax category yet, so it is shown on its own row rather than filed as “Other”. Set a category on each bucket in Amlak (Financials → Expense entry) and re-export.`, { ink: GOLD_INK, bg: GOLD_BG, height: 28 });
  }
  if (pkg.summary.undated > 0.005) {
    p.note(`⚠ On a cash basis, ${money(pkg.summary.undated)} of expenses carry no payment date and could not be placed in ${pkg.year}. They are listed on the Detail sheet and are NOT in the totals above. Nothing was given an invented date.`, { ink: GOLD_INK, bg: GOLD_BG, height: 28 });
  }
  p.note('Interest and mortgage costs are not tracked in Amlak yet, so those lines are blank here even if you paid them.');
}

// ── Sheet 2 — Detail ─────────────────────────────────────────────────────────
function addDetail(wb, pkg) {
  const ws = sheet(wb, 'Detail', [22, 12, 26, 24, 14, 12, 14, 14, 16]);
  const p = pen(ws, 'I');
  p.title(`Every expense line · ${pkg.year}`);
  p.skip();
  p.note('One row per line behind the Summary. “Billed to tenants” and “Reimbursed” are context only — the deductible figure is the full amount, never the net.');
  p.skip();

  p.head(['Property', 'Date paid', 'Bucket', 'Tax category', 'Amount', 'Billed back?', 'Reimbursed', 'Your net cost', 'Category source'],
    ['left', 'left', 'left', 'left', 'right', 'left', 'right', 'right', 'left']);

  let any = false;
  for (const prop of pkg.properties) {
    // Recompute each line's category from the same rows the Summary grouped, so a line
    // can never show one category here and roll up under another there.
    for (const cat of [...prop.categories, ...(prop.uncategorized ? [prop.uncategorized] : [])]) {
      for (const bucket of cat.buckets) {
        const lines = prop.lines.filter((it) => (String(it.label || '').trim() || '—') === bucket);
        const rowsFor = lines.length ? lines : [{ label: bucket, amount: null, paid_date: null, billable: true, flat: true }];
        for (const it of rowsFor) {
          any = true;
          const amount = it.amount == null ? cat.spent : Number(it.amount) || 0;
          const billable = it.billable !== false;
          const frac = cat.spent > 0 ? cat.recovered / cat.spent : 0;
          const reimbursed = billable ? Math.round(amount * frac * 100) / 100 : 0;
          p.line([
            prop.name,
            it.paid_date || '—',
            bucket,
            cat.key ? cat.label : 'Not categorized',
            amount,
            billable ? 'Yes' : 'No — absorbed',
            reimbursed,
            Math.round((amount - reimbursed) * 100) / 100,
            cat.key ? (cat.anyDefault ? 'Amlak default' : 'You chose it') : 'Nobody has set one',
          ], {
            moneyFrom: 4,
            aligns: ['left', 'left', 'left', 'left', 'right', 'left', 'right', 'right', 'left'],
            bg: cat.key ? undefined : GOLD_BG,
            ink: cat.key ? INK : GOLD_INK,
          });
        }
      }
    }
    // ⚠ Undated lines are LISTED, never dropped and never dated. They are excluded from
    // a cash-basis total above and this is where a CPA sees exactly what was left out.
    for (const it of prop.undated.lines) {
      any = true;
      p.line([prop.name, 'no date', String(it.label || '—'), 'Not placed in this year', Number(it.amount) || 0, it.billable === false ? 'No — absorbed' : 'Yes', '', '', 'Undated on a cash basis'],
        { moneyFrom: 4, aligns: ['left', 'left', 'left', 'left', 'right', 'left', 'right', 'right', 'left'], bg: GOLD_BG, ink: GOLD_INK });
    }
    for (const f of prop.undated.flat) {
      any = true;
      p.line([prop.name, 'no date', `${f.label} — entered as one figure`, 'Not placed in this year', f.amount, 'Yes', '', '', 'Never itemized, so never dated'],
        { moneyFrom: 4, aligns: ['left', 'left', 'left', 'left', 'right', 'left', 'right', 'right', 'left'], bg: GOLD_BG, ink: GOLD_INK });
    }
  }
  if (!any) p.note(`No expense lines recorded for ${pkg.year}.`);
}

// ── Sheet 3 — Depreciation ───────────────────────────────────────────────────
function addDepreciation(wb, pkg) {
  const ws = sheet(wb, 'Depreciation', [22, 26, 20, 14, 14, 14, 14, 10, 14, 16, 16]);
  const p = pen(ws, 'K');
  p.title(`Depreciation schedule · ${pkg.year}`);
  p.skip();
  p.note('Straight-line, book basis, whole-month proration. Amlak deliberately does not compute MACRS, bonus or §179 — those elections are your accountant’s, and being subtly wrong about them is worse than being absent. Expect a small first-year difference from a schedule that applies the mid-month convention.');
  p.skip();

  p.head(['Property', 'Asset', 'Kind', 'In service', 'Cost', 'Land', 'Basis', 'Life', `FY ${pkg.year}`, 'Taken to date', 'Book value'],
    ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right']);

  let total = 0;
  let count = 0;
  let blocked = 0;
  for (const prop of pkg.properties) {
    for (const { asset, calc } of prop.depreciation.rows) {
      count += 1;
      const isBlocked = !!calc.blocked;
      if (isBlocked) blocked += 1; else total = Math.round((total + (calc.thisYear || 0)) * 100) / 100;
      // ⚠ "—", never $0. A fully depreciated asset legitimately reads $0 and the two must
      // not look alike; the reason is carried in the same row so it is actionable.
      p.line([
        prop.name,
        asset.description || assetKindLabel(asset.kind),
        assetKindLabel(asset.kind),
        asset.placed_in_service || '—',
        Number(asset.cost) || 0,
        asset.land_cost == null ? '—' : Number(asset.land_cost),
        isBlocked ? '—' : (calc.basis ?? '—'),
        asset.useful_life_years ? `${asset.useful_life_years} yr` : '—',
        isBlocked ? '—' : (calc.thisYear ?? 0),
        isBlocked ? '—' : (calc.accumulated ?? 0),
        isBlocked ? '—' : (calc.bookValue ?? 0),
      ], { moneyFrom: 4, aligns: ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'], bg: isBlocked ? GOLD_BG : undefined, ink: isBlocked ? GOLD_INK : INK });
      if (isBlocked) p.note(`   ↳ ${asset.description || assetKindLabel(asset.kind)}: ${calc.reason}`, { ink: GOLD_INK });
    }
  }

  if (!count) {
    p.note(`No assets recorded. The building itself is the place to start — its cost, the date you bought it, and how much of that was the land. Until then this line of the return is $0.`, { ink: GOLD_INK, bg: GOLD_BG, height: 28 });
    return;
  }
  p.line(['TOTAL', '', '', '', '', '', '', '', total, '', ''], { bg: SUMMARY_BG, bold: true, moneyFrom: 4 });
  if (blocked) {
    p.skip();
    p.note(`⚠ ${blocked} asset${blocked === 1 ? '' : 's'} could not be depreciated and contributed $0 to the figure above — most often because the land value has not been set. Answer it in Amlak and re-export.`, { ink: GOLD_INK, bg: GOLD_BG, height: 28 });
  }
  p.skip();
  p.note('A building you owned before Amlak also needs the depreciation already taken — that figure comes off your accountant’s last Form 4562 and goes in the “Already depreciated” box on each asset.');
}

// ── Sheet 4 — Not on this return ─────────────────────────────────────────────
function addExcluded(wb, pkg) {
  const ws = sheet(wb, 'Not on this return', [34, 18, 80]);
  const p = pen(ws, 'C');
  p.title('Money deliberately left off this return');
  p.skip();
  p.note('Every figure below really moved and really does not belong on Form 8825 or Schedule E. It is listed so you can see that it was considered and excluded on purpose — not missed. Filing any of it as an expense would understate income by exactly that amount.');
  p.skip();

  p.head(['What', 'Amount', 'Why it is not on the return'], ['left', 'right', 'left']);
  if (!pkg.excluded.groups.length) {
    p.line(['Nothing', 0, 'No draws, contributions, deposits held or unplaced bank lines were recorded for this year.'], { moneyFrom: 1, aligns: ['left', 'right', 'left'] });
  } else {
    for (const g of pkg.excluded.groups) {
      p.line([g.label + (g.count ? ` (${g.count} line${g.count === 1 ? '' : 's'})` : ''), g.amount, g.why], { moneyFrom: 1, aligns: ['left', 'right', 'left'] });
    }
    p.line(['TOTAL LEFT OFF', pkg.excluded.total, ''], { bg: SUMMARY_BG, bold: true, moneyFrom: 1, aligns: ['left', 'right', 'left'] });
  }
  p.skip();

  if (pkg.entity.costs > 0.005) {
    p.section('Entity-level costs — deductible, but not any one building’s');
    p.note(`${money(pkg.entity.costs)} of costs belong to the entity rather than to a property — a registered agent, a franchise tax, corporate legal. They are deductible, but Amlak will not guess an allocation across your properties, so they are stated here for your accountant to place.`);
  }
  p.skip();
  p.note('A security deposit becomes income only in the year it is applied to unpaid rent or damages. Amlak does not automate that — it is a decision, not arithmetic.');
}

// ── Sheet 5 — Tie-out ────────────────────────────────────────────────────────
function addTieOut(wb, pkg) {
  const ws = sheet(wb, 'Tie-out', [38, 18, 76]);
  const p = pen(ws, 'C');
  p.title(`Tie-out — how this package relates to what Amlak shows on screen · ${pkg.year}`);
  p.skip();
  p.note('If a figure here disagrees with the app, this sheet says why. Every difference below is deliberate.');
  p.skip();

  p.section('Income');
  p.head(['Figure', 'Amount', 'What it is'], ['left', 'right', 'left']);
  const inc = pkg.summary.income;
  p.line(['Rents billed for the year', inc.billed, 'Every live invoice raised for this year — the accrual figure.'], { moneyFrom: 1, aligns: ['left', 'right', 'left'] });
  p.line(['Rents received during the year', inc.received, 'Every payment banked this year, whatever year’s invoice it settles — the cash figure.'], { moneyFrom: 1, aligns: ['left', 'right', 'left'] });
  if (inc.receivedPriorYear > 0.005) {
    // ⚠ The CAM straddle, reported rather than picked. A prior-year true-up collected now
    // is this year's cash income and last year's accrual expense; there is no correct
    // silent answer, so the figure is stated.
    p.line(['…of which settled a PRIOR year’s invoice', inc.receivedPriorYear, 'A CAM true-up billed last year and collected this one. On a cash basis it is this year’s income; on an accrual basis it belonged to last year.'],
      { moneyFrom: 1, aligns: ['left', 'right', 'left'], bg: GOLD_BG, ink: GOLD_INK });
  }
  p.line(['Difference (billed less received)', Math.round((inc.billed - inc.received) * 100) / 100, 'What is still outstanding, or prepaid if negative.'], { moneyFrom: 1, aligns: ['left', 'right', 'left'] });
  p.skip();

  p.section('Expenses');
  p.head(['Figure', 'Amount', 'What it is'], ['left', 'right', 'left']);
  const appExp = Math.round(pkg.properties.reduce((s, x) => s + x.appExpenses, 0) * 100) / 100;
  const dep = Math.round(pkg.properties.reduce((s, x) => s + x.depreciation.amount, 0) * 100) / 100;
  p.line(['Expenses as Amlak’s NOI counts them', appExp, 'Property taxes + CAM + roof, as shown on each property’s Financials page.'], { moneyFrom: 1, aligns: ['left', 'right', 'left'] });
  // ⚠ THE DIFFERENCE THAT MATTERS. syncCamTotal sums only billable !== false, so an
  // absorbed cost never reaches cam_total and therefore never reaches NOI. It is still an
  // ordinary expense of the property, so it IS on the return.
  p.line(['+ Costs you absorbed (not billed to tenants)', pkg.summary.absorbed, 'Excluded from the CAM total that drives NOI, because billing tenants for them is exactly what marking them “not billed” prevents. Still deductible.'],
    { moneyFrom: 1, aligns: ['left', 'right', 'left'] });
  p.line(['+ Depreciation', dep, 'Non-cash, so it is deliberately absent from “what actually stayed” and from NOI — and belongs on a return.'], { moneyFrom: 1, aligns: ['left', 'right', 'left'] });
  if (pkg.summary.undated > 0.005) {
    p.line(['− Expenses with no payment date', pkg.summary.undated, 'A cash basis cannot place them in a year and nothing was given an invented date. Listed in full on the Detail sheet.'],
      { moneyFrom: 1, aligns: ['left', 'right', 'left'], bg: GOLD_BG, ink: GOLD_INK });
  }
  p.line(['= EXPENSES ON THIS RETURN', pkg.summary.expenseTotal, ''], { bg: SUMMARY_BG, bold: true, moneyFrom: 1, aligns: ['left', 'right', 'left'] });
  p.skip();

  p.section('What tenants paid back');
  p.head(['Figure', 'Amount', 'What it is'], ['left', 'right', 'left']);
  p.line(['Reimbursed by tenants', pkg.summary.recovered, 'Already inside the rental income above — shown here only so you can see how much of the expense column came back. It is NOT subtracted from any expense.'],
    { moneyFrom: 1, aligns: ['left', 'right', 'left'] });
  p.skip();

  p.section('What this package does not know');
  const gaps = [
    'Mortgage principal, interest and escrow — Amlak does not track debt yet, so the Interest line is blank even if you paid it.',
    'Anything before you started using Amlak — figures here cover only what has been entered or imported.',
    'Whether a vendor is incorporated — that determines who needs a 1099 and only a W-9 answers it.',
  ];
  if (pkg.summary.uncategorized) {
    gaps.unshift(`${money(pkg.summary.uncategorized.total)} of expenses have no tax category yet and are on their own Summary row rather than filed as “Other”.`);
  }
  for (const g of gaps) p.note(`• ${g}`, { italic: false, ink: INK });
}

/**
 * Build + download the CPA package for one corporation and year.
 */
export async function downloadCpaPackageXlsx({ corporationId, year, basis = 'accrual', prebuilt = null } = {}) {
  // The modal shows a pre-flight built from this same shape, so it hands the package
  // straight back rather than making every export fetch the portfolio twice.
  const pkg = prebuilt || await buildCpaPackage({ corporationId, year, basis });
  const mod = await import('exceljs/dist/exceljs.min.js');
  const ExcelJS = mod.default || mod;
  const now = new Date();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Amlak';
  if (!pkg.properties.length) {
    const ws = wb.addWorksheet('Summary');
    ws.getCell('A1').value = `No properties under ${pkg.corporation.name || 'this corporation'} for ${year}.`;
  } else {
    addSummary(wb, pkg, now);
    addDetail(wb, pkg);
    addDepreciation(wb, pkg);
    addExcluded(wb, pkg);
    addTieOut(wb, pkg);
  }

  const buf = await wb.xlsx.writeBuffer();
  saveWorkbook(buf, `${fileSlug(pkg.corporation?.name, 'entity')}-Tax-Package-${year}.xlsx`);
  return pkg;
}
