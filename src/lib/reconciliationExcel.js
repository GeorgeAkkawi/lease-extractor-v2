// Year-end reconciliation workbook — one worksheet per tenant, itemized actual vs
// estimated CAM & tax, a summary, auto-insights, and a lease-terms reference. Pure
// formatting over the live figures from reconciliationData.js (no AI, no network of
// its own). ExcelJS is imported lazily so it stays out of the initial page load.
import { saveWorkbook, fileSlug } from './download';
import { buildReconciliationReport } from './reconciliationData';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Brand palette (ARGB). Olive header on cream text; green/red variance fills.
const OLIVE = 'FF5C6B3C';
const CREAM = 'FFF1ECE1';
const INK = 'FF333333';
const MUTED = 'FF6B6B60';
const GREEN_BG = 'FFEAF3DE', GREEN_INK = 'FF3B6D11';
const RED_BG = 'FFFCEBEB', RED_INK = 'FFA32D2D';
const NEUTRAL_BG = 'FFF1EFE8';
const ACTUAL_BG = 'FFF5F5F5';
const SUMMARY_BG = 'FFF5F4F0';

const CUR = '$#,##0.00';
const PSF = '0.0000'; // $/SF to 4 decimals — George validates the rate to the 4th place

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FFCCCCCC' } };
const borders = { top: thin, left: thin, bottom: thin, right: thin };

const COLS = 15; // A label · B $/SF · C Annual · D–O twelve months
const LAST = 'O';

function safeSheetName(name, used) {
  let base = (name || 'Tenant').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Tenant';
  let n = base, i = 2;
  while (used.has(n)) { const suffix = ` (${i++})`; n = base.slice(0, 31 - suffix.length) + suffix; }
  used.add(n);
  return n;
}

// The fill for a variance figure: green when favorable (under estimate → ≤ 0),
// red when unfavorable (over → > 0), neutral when nil.
function varianceFill(v) {
  if (Math.abs(Number(v) || 0) <= 0.005) return { bg: NEUTRAL_BG, ink: INK };
  return Number(v) < 0 ? { bg: GREEN_BG, ink: GREEN_INK } : { bg: RED_BG, ink: RED_INK };
}

function addTenantSheet(wb, used, t, now) {
  const ws = wb.addWorksheet(safeSheetName(t.tenant_name, used), {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 11;
  ws.getColumn(3).width = 15;
  for (let c = 4; c <= COLS; c++) ws.getColumn(c).width = 10;

  let r = 1;
  // --- Title band ---
  ws.mergeCells(`A${r}:${LAST}${r}`);
  const title = ws.getCell(`A${r}`);
  title.value = `CAM & Tax Reconciliation — ${t.year}`;
  title.font = { bold: true, size: 14, color: { argb: CREAM } };
  title.fill = fill(OLIVE);
  title.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  ws.getRow(r).height = 24;
  r += 2;

  // --- Header info block ---
  const info = [
    ['Property', [t.property_name, t.property_address].filter(Boolean).join(' — ')],
    ['Tenant', t.tenant_name],
    ['Tenant space', t.sqft ? `${t.sqft.toLocaleString()} SF` : '—'],
    ['Building size', t.buildingSf ? `${t.buildingSf.toLocaleString()} SF` : '—'],
    ['Tenant % of building', t.sharePct ? `${(t.sharePct * 100).toFixed(2)}%` : '—'],
    ['Year', String(t.year)],
    ['Report generated', new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).toLocaleDateString('en-US')],
  ];
  for (const [label, val] of info) {
    ws.getCell(`A${r}`).value = label;
    ws.getCell(`A${r}`).font = { bold: true, size: 10, color: { argb: MUTED } };
    ws.mergeCells(`B${r}:E${r}`);
    ws.getCell(`B${r}`).value = val;
    ws.getCell(`B${r}`).font = { size: 10, color: { argb: INK } };
    r++;
  }
  r++;

  // --- Section header helper ---
  const sectionHead = (text) => {
    ws.mergeCells(`A${r}:${LAST}${r}`);
    const c = ws.getCell(`A${r}`);
    c.value = text;
    c.font = { bold: true, size: 11, color: { argb: CREAM } };
    c.fill = fill(OLIVE);
    c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    ws.getRow(r).height = 18;
    r++;
  };

  // --- Income table ---
  sectionHead('Income — estimated vs actual');
  // column headers
  const heads = ['Line item', '$/SF', 'Annual', ...MONTHS];
  heads.forEach((h, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = h;
    c.font = { bold: true, size: 9, color: { argb: INK } };
    c.fill = fill(NEUTRAL_BG);
    c.border = borders;
    c.alignment = { horizontal: i === 0 ? 'left' : 'right' };
  });
  r++;

  // one data row: label + $/SF + annual + 12 monthly figures
  const dataRow = (label, psf, annual, monthly, opts = {}) => {
    const { bg, ink = INK, bold = false } = opts;
    const cells = [label, psf, annual, ...(monthly || Array(12).fill(null))];
    cells.forEach((v, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = v == null ? '' : v;
      if (i === 1 && v != null && v !== '') c.numFmt = PSF;
      if (i >= 2 && v != null && v !== '') c.numFmt = CUR;
      c.border = borders;
      c.font = { size: 9, bold, color: { argb: ink } };
      if (bg) c.fill = fill(bg);
      c.alignment = { horizontal: i === 0 ? 'left' : 'right' };
    });
    r++;
  };

  const sqft = t.sqft || 0;
  const psfOf = (annual) => (sqft > 0 ? annual / sqft : null);
  const monthlyFlat = (annual) => Array(12).fill(Math.round((annual / 12) * 100) / 100);

  dataRow('Base rent', psfOf(t.base.annual), t.base.annual, t.base.monthly);
  r++; // spacer
  dataRow('CAM & tax (estimated)', psfOf(t.estCamTax), t.estCamTax, monthlyFlat(t.estCamTax));
  // ⚠ THE LINE THAT WAS MISSING. A CAM & tax correction posted during the year is part of
  // what the tenant was billed, so it belongs inside the estimate above — and it always has
  // been. What it did not have was a name: it moved TOTAL VARIANCE with nothing on the page
  // to explain it. Stated here as a memo row (it is already counted in the row above, so it
  // must NOT be added again), because a figure a tenant cannot account for is one they call
  // about.
  if (Math.abs(t.camTaxAdjust || 0) > 0.005) {
    dataRow(
      `    of which corrections billed during the year (${t.camTaxAdjustCount} posted)`,
      null, t.camTaxAdjust, null,
    );
  }
  dataRow('CAM & tax (actual)', psfOf(t.actualCamTax), t.actualCamTax, monthlyFlat(t.actualCamTax), { bg: ACTUAL_BG });
  const camTaxVar = Math.round((t.actualCamTax - t.estCamTax) * 100) / 100;
  const cv = varianceFill(camTaxVar);
  dataRow('CAM & tax variance', psfOf(camTaxVar), camTaxVar, monthlyFlat(camTaxVar), { bg: cv.bg, ink: cv.ink, bold: true });
  if (t.estRoof > 0 || t.actualRoof > 0) {
    r++;
    dataRow('Roof (estimated)', psfOf(t.estRoof), t.estRoof, monthlyFlat(t.estRoof));
    dataRow('Roof (actual)', psfOf(t.actualRoof), t.actualRoof, monthlyFlat(t.actualRoof), { bg: ACTUAL_BG });
    const rv = varianceFill(t.actualRoof - t.estRoof);
    dataRow('Roof variance', psfOf(t.actualRoof - t.estRoof), Math.round((t.actualRoof - t.estRoof) * 100) / 100, monthlyFlat(t.actualRoof - t.estRoof), { bg: rv.bg, ink: rv.ink, bold: true });
  }
  r++; // spacer
  dataRow('TOTAL OWED (estimated)', psfOf(t.totalOwedEst), t.totalOwedEst, null, { bg: SUMMARY_BG, bold: true });
  dataRow('TOTAL OWED (actual)', psfOf(t.totalOwedActual), t.totalOwedActual, null, { bg: SUMMARY_BG, bold: true });
  const tv = varianceFill(t.variance);
  dataRow('TOTAL VARIANCE', psfOf(t.variance), t.variance, null, { bg: tv.bg, ink: tv.ink, bold: true });
  r += 2;

  // --- Itemized actual expenses ---
  sectionHead('Actual expenses — itemized (tenant share)');
  ['Expense line', '$/SF', 'Annual'].forEach((h, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = h;
    c.font = { bold: true, size: 9, color: { argb: INK } };
    c.fill = fill(NEUTRAL_BG);
    c.border = borders;
    c.alignment = { horizontal: i === 0 ? 'left' : 'right' };
  });
  r++;
  const kindLabel = { tax: 'Tax', cam: 'CAM', roof: 'Roof' };
  for (const it of t.itemsActual) {
    ['', '', ''].forEach((_, i) => {
      const c = ws.getCell(r, i + 1);
      const v = i === 0 ? `${it.label}${it.kind ? ` (${kindLabel[it.kind] || it.kind})` : ''}` : i === 1 ? it.psf : it.annual;
      c.value = v == null ? '' : v;
      if (i === 1 && v != null) c.numFmt = PSF;
      if (i === 2 && v != null) c.numFmt = CUR;
      c.border = borders;
      c.font = { size: 9, color: { argb: INK } };
      c.alignment = { horizontal: i === 0 ? 'left' : 'right' };
    });
    r++;
  }
  // total of itemized actuals (= actual CAM & tax + roof)
  const actualTotal = Math.round((t.actualCamTax + t.actualRoof) * 100) / 100;
  ['TOTAL ACTUAL EXPENSES', psfOf(actualTotal), actualTotal].forEach((v, i) => {
    const c = ws.getCell(r, i + 1);
    c.value = v == null ? '' : v;
    if (i === 1 && v != null) c.numFmt = PSF;
    if (i === 2 && v != null) c.numFmt = CUR;
    c.border = borders;
    c.font = { size: 9, bold: true, color: { argb: INK } };
    c.fill = fill(SUMMARY_BG);
    c.alignment = { horizontal: i === 0 ? 'left' : 'right' };
  });
  r += 3;

  // --- Summary card ---
  sectionHead('Annual reconciliation summary');
  const summary = [
    ['Base rent', t.base.annual],
    ['CAM & tax (estimated)', t.estCamTax],
    ['CAM & tax (actual)', t.actualCamTax],
  ];
  if (t.estRoof > 0 || t.actualRoof > 0) {
    summary.push(['Roof (estimated)', t.estRoof], ['Roof (actual)', t.actualRoof]);
  }
  summary.push(['Total owed (estimated)', t.totalOwedEst], ['Total owed (actual)', t.totalOwedActual]);
  for (const [label, val] of summary) {
    ws.getCell(`A${r}`).value = label;
    ws.getCell(`A${r}`).font = { size: 10, color: { argb: INK } };
    ws.getCell(`C${r}`).value = val;
    ws.getCell(`C${r}`).numFmt = CUR;
    ws.getCell(`C${r}`).font = { size: 10, color: { argb: INK } };
    ws.getCell(`C${r}`).alignment = { horizontal: 'right' };
    r++;
  }
  // settlement line
  const owesTenant = t.variance < -0.005; // actual under estimate → refund the tenant
  ws.getCell(`A${r}`).value = owesTenant ? 'REFUND OWED TO TENANT' : t.variance > 0.005 ? 'BALANCE DUE FROM TENANT' : 'SETTLED — EVEN';
  ws.getCell(`A${r}`).font = { bold: true, size: 11, color: { argb: INK } };
  ws.getCell(`A${r}`).fill = fill(SUMMARY_BG);
  const sv = varianceFill(t.variance);
  ws.getCell(`C${r}`).value = Math.abs(t.variance) <= 0.005 ? 0 : Math.abs(t.variance);
  ws.getCell(`C${r}`).numFmt = CUR;
  ws.getCell(`C${r}`).font = { bold: true, size: 11, color: { argb: sv.ink } };
  ws.getCell(`C${r}`).fill = fill(sv.bg);
  ws.getCell(`C${r}`).alignment = { horizontal: 'right' };
  ws.getCell(`B${r}`).fill = fill(SUMMARY_BG);
  r += 3;

  // --- Insights ---
  sectionHead('Notes');
  for (const line of t.insights) {
    ws.mergeCells(`A${r}:${LAST}${r}`);
    const c = ws.getCell(`A${r}`);
    c.value = `• ${line}`;
    c.font = { size: 10, color: { argb: INK } };
    c.alignment = { horizontal: 'left', wrapText: true };
    r++;
  }
  r += 2;

  // --- Lease-terms reference ---
  sectionHead('Lease terms reference');
  const termHeads = ['Term', 'Start', 'End', 'Months', 'Base rent (annual)', 'Notes'];
  const termCols = ['A', 'B', 'C', 'D', 'E', 'F'];
  // widen the notes column span via merge (F:O)
  termHeads.forEach((h, i) => {
    const c = ws.getCell(`${termCols[i]}${r}`);
    c.value = h;
    c.font = { bold: true, size: 9, color: { argb: INK } };
    c.fill = fill(NEUTRAL_BG);
    c.border = borders;
    c.alignment = { horizontal: i >= 3 && i <= 4 ? 'right' : 'left' };
  });
  ws.mergeCells(`F${r}:${LAST}${r}`);
  r++;
  for (const term of t.terms) {
    const vals = [term.term, term.start || '', term.end || '', term.months ?? '', term.baseRentAnnual ?? '', term.notes || ''];
    vals.forEach((v, i) => {
      const c = ws.getCell(`${termCols[i]}${r}`);
      c.value = v == null ? '' : v;
      if (i === 4 && v !== '' && v != null) c.numFmt = CUR;
      c.border = borders;
      c.font = { size: 9, color: { argb: INK } };
      c.alignment = { horizontal: i >= 3 && i <= 4 ? 'right' : 'left', wrapText: i === 5 };
    });
    ws.mergeCells(`F${r}:${LAST}${r}`);
    r++;
  }
}

/**
 * Build + download the reconciliation workbook for a property + year. Pass `leaseIds`
 * to limit to a subset of tenants (else every tenant on the property gets a tab).
 */
export async function downloadReconciliationXlsx({ propertyId, year, leaseIds = null } = {}) {
  const report = await buildReconciliationReport({ propertyId, year });
  const mod = await import('exceljs/dist/exceljs.min.js');
  const ExcelJS = mod.default || mod;
  const now = new Date();

  let tenants = report.tenants;
  if (Array.isArray(leaseIds) && leaseIds.length) {
    const wanted = new Set(leaseIds);
    tenants = tenants.filter((t) => wanted.has(t.lease_id));
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Amlak';
  const used = new Set();
  if (!tenants.length) {
    const ws = wb.addWorksheet('Reconciliation');
    ws.getCell('A1').value = 'No tenants to reconcile for this property and year.';
  } else {
    for (const t of tenants) addTenantSheet(wb, used, t, now);
  }

  const buf = await wb.xlsx.writeBuffer();
  saveWorkbook(buf, `${fileSlug(report.property?.name, 'property')}-Reconciliation-${year}.xlsx`);
}
