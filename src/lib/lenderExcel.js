// The lender package workbook — five sheets, in the order a lender reads them.
//
//   Summary              — income, expenses, NOI, and the coverage ratio.
//   Operating statement  — the same figures per property, plus what can be placed by month.
//   Rent roll            — every tenant, with what leaving them would actually cost.
//   Rollover & coverage  — when the rent rolls off, and the DSCR if it does.
//   Not in this package  — what is deliberately absent, with the reason.
//
// ⚠ The fifth sheet matters more here than anywhere else in this arc. A lender who
// cannot tell a careful export from one that quietly omitted the debt has to assume the
// worst — so the absence of the loans is stated on its own sheet rather than left to be
// noticed.
//
// Pure formatting over lenderPackage.js — no AI, no network of its own, no writes.
// ExcelJS is imported lazily so it stays out of the initial page load. The writer and
// palette come from cpaExcel.js so all three workbooks lay out identically.
import { xlsxSheet, xlsxPen, XLSX_PALETTE } from './cpaExcel';
import {
  buildLenderPackage, coverage, notInPackage, MONTH_ABBR, ADJUSTMENT_NOTE, PERIOD_NOTE,
} from './lenderPackage';

const { GOLD_BG, GOLD_INK, MUTED, SUMMARY_BG } = XLSX_PALETTE;

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sf = (n) => (Number(n) || 0).toLocaleString('en-US') + ' SF';
const pct1 = (n) => (n == null ? '—' : (n * 100).toFixed(1) + '%');
const fmtDate = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const dateStr = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('en-US') : '—');
// ⚠ A ratio with an unknown denominator is not a small ratio. Never 0.00×, never ∞.
const ratio = (r) => (r == null ? '—' : `${r.toFixed(2)}×`);

// ── Sheet 1 — Summary ────────────────────────────────────────────────────────
function addSummary(wb, pkg, cov, now) {
  const ws = xlsxSheet(wb, 'Summary', [42, 20, 20, 22, 22], { freeze: 0 });
  const p = xlsxPen(ws, 'E');
  const f = pkg.portfolio;

  p.title(`${pkg.corporation.name || 'Portfolio'} — operating summary · FY ${pkg.year}`);
  p.skip();
  p.pair('Entity', pkg.corporation.name || '—');
  p.pair('Properties', `${pkg.properties.length} · ${sf(f.buildingSf)}`);
  p.pair('Occupancy', `${pct1(f.occupancy)} leased · ${sf(f.vacantSf)} vacant`);
  p.pair('Weighted average lease term', f.walt == null ? '—' : `${f.walt.toFixed(1)} years`);
  p.pair('Prepared', fmtDate(now));
  p.skip();

  p.section('Effective gross income');
  p.head(['', '', '', 'Annual', '']);
  p.line(['In-place contract rent', '', '', f.inPlaceRent, ''], { moneyFrom: 3 });
  p.line(['Expense reimbursements from tenants', '', '', f.reimbursements, ''], { moneyFrom: 3 });
  if (f.otherIncome > 0.005) p.line(['Other income — not tenant rent', '', '', f.otherIncome, ''], { moneyFrom: 3 });
  p.line(['EFFECTIVE GROSS INCOME', '', '', f.egi, ''], { bg: SUMMARY_BG, bold: true, moneyFrom: 3 });
  if (f.grossInsideRent > 0.005) {
    p.note(`A further ${money(f.grossInsideRent)} of CAM and tax is recovered from gross-lease tenants — it is already inside their flat rent above, so it is NOT added again here.`);
  }
  p.skip();

  p.section('Operating expenses');
  p.head(['Category', 'Spent', 'Reimbursed by tenants', 'Net to owner', '']);
  const cats = new Map();
  for (const prop of pkg.properties) {
    for (const c of [...prop.categories, ...(prop.uncategorized ? [prop.uncategorized] : [])]) {
      const e = cats.get(c.label) || { label: c.label, spent: 0, recovered: 0, uncategorized: c.key === null };
      e.spent += c.spent; e.recovered += c.recovered;
      cats.set(c.label, e);
    }
  }
  const catRows = [...cats.values()].sort((a, b) => (a.uncategorized ? 1 : 0) - (b.uncategorized ? 1 : 0) || b.spent - a.spent);
  for (const c of catRows) {
    p.line([c.label, c.spent, c.recovered, c.spent - c.recovered, ''], c.uncategorized ? { bg: GOLD_BG, ink: GOLD_INK } : {});
  }
  p.line(['TOTAL OPERATING EXPENSES', f.opex, f.reimbursements, f.opex - f.reimbursements, ''], { bg: SUMMARY_BG, bold: true });
  p.skip();

  p.section('Net operating income');
  p.line(['NET OPERATING INCOME', '', '', f.noi, ''], { bg: SUMMARY_BG, bold: true, moneyFrom: 3 });
  p.note('Income is GROSS on both sides: a tenant’s CAM and tax reimbursement is income, and the expense it reimburses is taken out in full. Depreciation is not deducted — NOI is before it, and it never crossed the account.');
  if (f.noiGap != null && Math.abs(f.noiGap) > 0.005) {
    p.note(
      `⚠ Amlak’s own Financials page reports NOI of ${money(f.appNoi)} for this year — ${money(Math.abs(f.noiGap))} ${f.noiGap > 0 ? 'lower' : 'higher'} than the figure above. That view subtracts the whole expense without counting the reimbursement it was paid back with. The tie-out is on the Operating statement sheet.`,
      { bg: GOLD_BG, ink: GOLD_INK, height: 30 }
    );
  }
  p.skip();

  p.section('Debt service coverage');
  p.head(['', '', 'Today', 'If the near-term rollover does not renew', '']);
  const rowPair = (label, a, b, opts = {}) => p.line([label, '', a, b, ''], { moneyFrom: 2, ...opts });
  rowPair('Effective gross income', cov.now.egi, cov.down.egi);
  rowPair('Less operating expenses', -cov.now.opex, -cov.down.opex);
  if (cov.adjusted) {
    if (cov.now.mgmtFee > 0.005) rowPair('Less management fee (lender assumption)', -cov.now.mgmtFee, -cov.down.mgmtFee);
    if (cov.now.reserve > 0.005) rowPair('Less replacement reserve (lender assumption)', -cov.now.reserve, -cov.down.reserve);
  }
  rowPair('NET OPERATING INCOME', cov.now.noi, cov.down.noi, { bg: SUMMARY_BG, bold: true });
  rowPair('Less annual debt service', cov.debtService == null ? '—' : -cov.debtService, cov.debtService == null ? '—' : -cov.debtService);
  p.line(['DEBT SERVICE COVERAGE', '', ratio(cov.now.dscr), ratio(cov.down.dscr), ''], { bg: SUMMARY_BG, bold: true, moneyFrom: 99 });
  if (cov.debtService == null) {
    p.note('No annual debt service was entered, so coverage is not computed. Amlak does not hold your loans — the figure is typed at export and never saved.', { bg: GOLD_BG, ink: GOLD_INK });
  }
  if (!cov.adjusted) p.note(ADJUSTMENT_NOTE, { bg: GOLD_BG, ink: GOLD_INK, height: 30 });
  if (pkg.atRisk.total > 0.005) {
    p.note(
      `The downside column removes ${money(pkg.atRisk.total)} of rent and reimbursement from ${pkg.atRisk.leases.length} lease${pkg.atRisk.leases.length === 1 ? '' : 's'} reaching the end of term within 12 months. The operating expense stays — on a net lease that share becomes vacancy the owner carries.`
    );
  }
  return ws;
}

// ── Sheet 2 — Operating statement ────────────────────────────────────────────
function addOperating(wb, pkg) {
  const ws = xlsxSheet(wb, 'Operating statement', [34, ...Array(12).fill(11), 13, 14], { freeze: 0 });
  const p = xlsxPen(ws, 'O');

  p.title(`Operating statement · FY ${pkg.year}`);
  p.note(PERIOD_NOTE, { height: 28 });
  p.skip();

  for (const prop of pkg.properties) {
    p.section(`${prop.name}${prop.address ? ` — ${prop.address}` : ''}`);
    p.head(['', ...MONTH_ABBR, 'Undated', 'Year']);

    p.line(['Rent collected', ...prop.collectedByMonth, prop.collectedUndated, prop.collectedTotal]);
    p.line(['Operating expenses paid', ...prop.expenseByMonth, prop.expenseUndated, prop.opex]);
    if (prop.expenseUndated > 0.005) {
      p.note(`${money(prop.expenseUndated)} of expenses carry no payment date, so they sit in the Undated column rather than being spread across the year. ${prop.datedLines} of ${prop.lineCount} lines are dated.`);
    }
    p.skip();

    p.head(['Annual', 'Amount', 'Reimbursed', 'Net to owner', ...Array(11).fill('')]);
    p.line(['In-place contract rent', prop.income.inPlaceRent, '', '', ...Array(11).fill('')]);
    p.line(['Expense reimbursements', prop.income.reimbursements, '', '', ...Array(11).fill('')]);
    if (prop.income.otherIncome > 0.005) p.line(['Other income', prop.income.otherIncome, '', '', ...Array(11).fill('')]);
    p.line(['EFFECTIVE GROSS INCOME', prop.income.egi, '', '', ...Array(11).fill('')], { bg: SUMMARY_BG, bold: true });
    for (const c of [...prop.categories, ...(prop.uncategorized ? [prop.uncategorized] : [])]) {
      p.line([c.label, c.spent, c.recovered, c.net, ...Array(11).fill('')], c.key === null ? { bg: GOLD_BG, ink: GOLD_INK } : {});
    }
    p.line(['TOTAL OPERATING EXPENSES', prop.opex, prop.recovered, prop.opex - prop.recovered, ...Array(11).fill('')], { bg: SUMMARY_BG, bold: true });
    p.line(['NET OPERATING INCOME', prop.noi, '', '', ...Array(11).fill('')], { bg: SUMMARY_BG, bold: true });
    if (!prop.expensesEntered) {
      p.note('⚠ No expenses are entered for this property this year, so the NOI above is the income with nothing taken out. It is not a real NOI.', { bg: GOLD_BG, ink: GOLD_INK });
    }
    p.skip();

    // The tie-out. Round 12 reconciles the return's expenses to the app's; this
    // reconciles the underwritten income to it, which is the other half of the same gap.
    p.head(['Tie-out to Amlak’s own figures', 'Amount', ...Array(13).fill('')]);
    p.line(['Rent billed on this year’s invoices', prop.income.billed, ...Array(13).fill('')]);
    p.line(['In-place contract rent used above', prop.income.inPlaceRent, ...Array(13).fill('')]);
    p.note('Billed rent includes the CAM and tax ESTIMATE each tenant pays through the year; the contract rent above is what the leases oblige. They settle against each other at reconciliation, which is why the package underwrites the contract figure.');
    if (prop.appNoi != null) {
      p.line(['NOI shown on Amlak’s Financials page', prop.appNoi, ...Array(13).fill('')]);
      p.line(['Add back reimbursements it does not count', prop.income.reimbursements, ...Array(13).fill('')]);
      if (prop.income.otherIncome > 0.005) p.line(['Add other income', prop.income.otherIncome, ...Array(13).fill('')]);
      p.line(['= NET OPERATING INCOME ON THIS PACKAGE', prop.noi, ...Array(13).fill('')], { bg: SUMMARY_BG, bold: true });
    }
    p.skip();
  }
  return ws;
}

// ── Sheet 3 — Rent roll ──────────────────────────────────────────────────────
function addRentRoll(wb, pkg) {
  const ws = xlsxSheet(wb, 'Rent roll', [26, 24, 11, 10, 12, 12, 9, 15, 11, 16, 15, 18], { freeze: 0 });
  const p = xlsxPen(ws, 'L');

  p.title(`Rent roll · as of ${dateStr(pkg.todayIso)}`);
  p.note('Reimbursement is this tenant’s actual pro-rata share of the year’s taxes, CAM and roof — what they pay back on top of rent. For a gross lease it is already inside the rent and shows as $0 here, with the note on the row.');
  p.skip();

  for (const prop of pkg.properties) {
    p.section(prop.name);
    p.head(['Tenant', 'Suite', 'Sq ft', '% of bldg', 'Start', 'End', 'Mo left', 'Base rent', '$/SF', 'Reimbursement', 'Total', 'Renewal'],
      ['left', 'left', 'right', 'right', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left']);
    for (const r of prop.rentRoll) {
      const renewal = r.holdover
        ? (r.optionsPending > 0 ? 'Holding over — option unexercised' : 'Holding over')
        : r.optionsPending > 0
          ? `${r.optionsPending} option${r.optionsPending === 1 ? '' : 's'}${r.noticeBy ? ` · notice by ${dateStr(r.noticeBy)}` : ''}`
          : r.optionsLapsed > 0 ? 'Option lapsed' : 'None on file';
      p.line([
        r.tenant + (r.gross ? ' (gross lease)' : ''), r.suite || '—', r.sf, pct1(r.shareOfBuilding),
        dateStr(r.start), dateStr(r.end), r.monthsLeft == null ? '—' : r.monthsLeft,
        r.rent, r.psf == null ? '—' : r.psf, r.reimbursement, r.total, renewal,
      ], {
        bg: r.holdover ? GOLD_BG : undefined,
        ink: r.holdover ? GOLD_INK : undefined,
        moneyFrom: 7,
        aligns: ['left', 'left', 'right', 'right', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'],
      });
    }
    if (prop.vacantSf > 0) {
      p.line(['Vacant space', '—', prop.vacantSf, pct1(prop.buildingSf > 0 ? prop.vacantSf / prop.buildingSf : null), '—', '—', '—', 0, '—', 0, 0, 'Unleased'], {
        ink: MUTED, moneyFrom: 7,
        aligns: ['left', 'left', 'right', 'right', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'],
      });
    }
    p.line(['TOTAL', '', prop.leasedSf, pct1(prop.occupancy), '', '', '', prop.income.inPlaceRent, '', prop.income.reimbursements, prop.income.inPlaceRent + prop.income.reimbursements, ''],
      { bg: SUMMARY_BG, bold: true, moneyFrom: 7, aligns: ['left', 'left', 'right', 'right', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'] });
    p.skip();
  }
  return ws;
}

// ── Sheet 4 — Rollover & coverage ────────────────────────────────────────────
function addRollover(wb, pkg, cov) {
  const ws = xlsxSheet(wb, 'Rollover', [26, 10, 16, 18, 16, 14, 20], { freeze: 0 });
  const p = xlsxPen(ws, 'G');

  p.title(`Lease rollover · as of ${dateStr(pkg.todayIso)}`);
  p.note('What leaving costs is rent PLUS the tenant’s expense reimbursement — the expense itself stays, so their share becomes vacancy the owner carries. Rent alone understates the exposure by the whole recovered amount.');
  p.skip();

  p.section('When the rent rolls off');
  p.head(['Period', 'Leases', 'Base rent', 'Reimbursement', 'NOI at risk', '% of rent roll', '']);
  for (const b of pkg.rollover.buckets) {
    p.line([b.label, b.count, b.rent, b.reimbursement, b.atRisk, pct1(pkg.rollover.shareOf(b)), b.note || ''],
      b.key === 'holdover' ? { bg: GOLD_BG, ink: GOLD_INK, moneyFrom: 2 } : { moneyFrom: 2 });
  }
  if (pkg.rollover.undated.length) {
    p.note(`${pkg.rollover.undated.length} lease${pkg.rollover.undated.length === 1 ? ' has' : 's have'} no term end on file, so ${pkg.rollover.undated.length === 1 ? 'it is' : 'they are'} in no bucket above — a gap in the record, not a lease that never ends. ${pkg.rollover.undated.map((r) => r.tenant).join(' · ')}`, { bg: GOLD_BG, ink: GOLD_INK });
  }
  p.skip();

  p.section('Within twelve months');
  if (!pkg.atRisk.leases.length) {
    p.note('No lease reaches the end of its term within twelve months.');
  } else {
    p.head(['Tenant', 'Ends', 'Base rent', 'Reimbursement', 'NOI at risk', 'Notice by', 'Renewal option']);
    for (const r of pkg.atRisk.leases) {
      p.line([r.tenant, r.holdover ? 'Holding over' : dateStr(r.end), r.rent, r.reimbursement, r.total,
        r.noticeBy ? dateStr(r.noticeBy) : '—',
        r.optionsPending > 0 ? `${r.optionsPending} unexercised` : r.optionsLapsed > 0 ? 'Lapsed' : 'None on file'],
      { bg: r.holdover ? GOLD_BG : undefined, ink: r.holdover ? GOLD_INK : undefined, moneyFrom: 2, aligns: ['left', 'left', 'right', 'right', 'right', 'left', 'left'] });
    }
    p.line(['TOTAL AT RISK', '', pkg.atRisk.rent, pkg.atRisk.total - pkg.atRisk.rent, pkg.atRisk.total, '', ''], { bg: SUMMARY_BG, bold: true, moneyFrom: 2 });
    if (pkg.atRisk.withOption > 0) {
      p.note(`${pkg.atRisk.withOption} of these carries an unexercised renewal option. That is a mitigant, not a certainty — it is named beside the figure rather than discounted out of it.`);
    }
  }
  p.skip();

  p.section('Coverage if that rollover does not renew');
  p.head(['', '', 'Today', 'Downside', '', '', '']);
  p.line(['Net operating income', '', cov.now.noi, cov.down.noi, '', '', ''], { moneyFrom: 2 });
  p.line(['Annual debt service', '', cov.debtService == null ? '—' : cov.debtService, cov.debtService == null ? '—' : cov.debtService, '', '', ''], { moneyFrom: 2 });
  p.line(['DEBT SERVICE COVERAGE', '', ratio(cov.now.dscr), ratio(cov.down.dscr), '', '', ''], { bg: SUMMARY_BG, bold: true, moneyFrom: 99 });
  if (cov.headroom != null) {
    p.note(`NOI can fall ${money(cov.headroom)} before coverage reaches 1.00×.`);
  }
  return ws;
}

// ── Sheet 5 — Not in this package ────────────────────────────────────────────
function addNotIncluded(wb, pkg) {
  const ws = xlsxSheet(wb, 'Not in this package', [34, 16, 96], { freeze: 0 });
  const p = xlsxPen(ws, 'C');

  p.title('What this package does not contain');
  p.note('Round for round, the sheet that makes the rest trustworthy: everything deliberately absent, with the reason. A lender who cannot tell a careful export from one that quietly omitted the debt has to assume the worst.');
  p.skip();
  p.head(['', 'Amount', 'Why it is not here'], ['left', 'right', 'left']);
  for (const g of pkg.notIncluded) {
    const amount = g.amount != null ? g.amount : (g.count ? `${g.count}${g.names ? ` — ${g.names.join(' · ')}` : ''}` : '—');
    p.line([g.label, amount, g.why], { aligns: ['left', 'right', 'left'], moneyFrom: g.amount != null ? 1 : 99 });
  }
  return ws;
}

/**
 * Build + download the lender package for one corporation and year.
 *
 * `assumptions` are the lender's, not Amlak's — typed on the way out and never stored.
 */
export async function downloadLenderPackageXlsx({ corporationId, year, assumptions = {}, prebuilt = null } = {}) {
  // The modal shows the same figures on screen, so it hands the shape straight back
  // rather than making every export read the portfolio twice.
  const pkg = prebuilt || await buildLenderPackage({ corporationId, year });
  const cov = coverage({
    egi: pkg.portfolio.egi,
    opex: pkg.portfolio.opex,
    atRisk: pkg.atRisk.total,
    buildingSf: pkg.portfolio.buildingSf,
    ...assumptions,
  });
  // Recomputed here rather than carried, so a property whose expenses were entered
  // between the pre-flight and the click cannot leave a stale sheet behind.
  pkg.notIncluded = notInPackage({ properties: pkg.properties, unplaced: pkg.unplaced });

  const mod = await import('exceljs/dist/exceljs.min.js');
  const ExcelJS = mod.default || mod;
  const now = new Date();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Amlak';
  addSummary(wb, pkg, cov, now);
  addOperating(wb, pkg);
  addRentRoll(wb, pkg);
  addRollover(wb, pkg, cov);
  addNotIncluded(wb, pkg);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const slug = String(pkg.corporation?.name || 'entity').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug || 'entity'}-Lender-Package-${year}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  return pkg;
}
