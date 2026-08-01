// The 1099 worksheet workbook — two sheets, and the second is the point.
//
//   Worksheet            — every vendor that may need a 1099, with a BLANK W-9 column.
//   Not on this worksheet — every dollar deliberately left off, with the reason.
//
// Round 6's rule (a dollar is recorded somewhere or explicitly excluded WITH A REASON)
// applied to vendors instead of bank lines. Without the second sheet an accountant
// cannot tell a careful list from one that quietly dropped every utility bill.
//
// Pure formatting over form1099.js — no AI, no network of its own, no writes. ExcelJS is
// imported lazily so it stays out of the initial page load. The writer and palette come
// from cpaExcel.js so both workbooks lay out identically.
import { xlsxSheet, xlsxPen, XLSX_PALETTE } from './cpaExcel';
import {
  build1099Worksheet, FILING_DEADLINE, EFILE_AT, PENALTY_NOTE, THRESHOLD_NOTE,
  PAYEE_SOURCES, treatmentInfo, vendorPhrase,
} from './form1099';

const { GOLD_BG, GOLD_INK, INK, MUTED, SUMMARY_BG } = XLSX_PALETTE;

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

// ── Sheet 1 — the worksheet ──────────────────────────────────────────────────
function addWorksheet(wb, pkg, now) {
  const ws = xlsxSheet(wb, 'Worksheet', [34, 15, 13, 15, 20, 22, 26, 30], { freeze: 0 });
  const p = xlsxPen(ws, 'H');

  p.title(`1099 worksheet · ${pkg.corporation.name || 'Entity'} · ${pkg.year}`);
  p.pair('Prepared', fmtDate(now));
  p.pair('Threshold used', money(pkg.threshold));
  p.pair('Due to vendor and IRS', `${FILING_DEADLINE}, ${pkg.year + 1}`);
  p.skip();

  p.note(
    'Amlak cannot tell whether a vendor is incorporated — only a W-9 answers that, and a ' +
    'corporation is generally exempt. So this names the candidates and leaves the W-9 ' +
    'column blank for you to fill in. It is a worksheet, not a filing.',
    { italic: false, ink: INK, height: 30 }
  );
  p.note(THRESHOLD_NOTE, { height: 30 });
  p.note(PENALTY_NOTE, { height: 30 });
  p.skip();

  if (pkg.counts.efile) {
    p.note(
      `⚠ ${pkg.counts.candidates} candidates is ${EFILE_AT} or more, and at ${EFILE_AT} ` +
      'information returns the IRS requires electronic filing. Your accountant or a filing ' +
      'service handles that — Amlak does not file.',
      { italic: false, ink: GOLD_INK, bg: GOLD_BG, height: 28 }
    );
    p.skip();
  }

  const HEAD = ['Vendor', 'Paid', 'By card', 'Counts toward', 'Standing', 'W-9 on file?', 'Name came from', 'What it was for'];
  const ALIGN = ['left', 'right', 'right', 'right', 'left', 'center', 'left', 'left'];

  p.section(`Above the threshold — ${pkg.counts.candidates} vendor${pkg.counts.candidates === 1 ? '' : 's'}`);
  if (!pkg.candidates.length) {
    p.note('No vendor crossed the threshold on the figures recorded for this year.', { italic: false, ink: INK });
  } else {
    p.head(HEAD, ALIGN);
    for (const v of pkg.candidates) row(p, v, ALIGN);
    p.line(
      ['Total', pkg.candidates.reduce((s, v) => s + v.total, 0), pkg.candidates.reduce((s, v) => s + v.cardTotal, 0), pkg.candidates.reduce((s, v) => s + v.reportable, 0), '', '', '', ''],
      { bold: true, bg: SUMMARY_BG, aligns: ALIGN }
    );
  }
  p.skip();

  // ⚠ Listed, not hidden. The threshold moved between 2025 and 2026 and the figure above
  // may not be the one that applies — so everything under it is still on the page.
  p.section(`Below the threshold — ${pkg.counts.below} vendor${pkg.counts.below === 1 ? '' : 's'}`);
  p.note(
    'Listed rather than dropped, because the threshold that applies to your filing year ' +
    'may differ from the one used above. Nothing here is hidden by that number.',
    { height: 24 }
  );
  if (!pkg.below.length) p.note('Nothing.', { italic: false, ink: INK });
  else {
    p.head(HEAD, ALIGN);
    for (const v of pkg.below) row(p, v, ALIGN);
  }

  p.skip();
  if (pkg.counts.imprecise || pkg.counts.needsCategory || pkg.counts.noMethod) {
    p.section('What to check before you rely on this');
    if (pkg.counts.imprecise) {
      p.note(
        `• ${vendorPhrase(pkg.counts.imprecise, 'is', 'are')} named after an EXPENSE BUCKET rather ` +
        'than a payee. A bucket can cover more than one vendor, so confirm who each one ' +
        'actually went to — importing a bank statement teaches Amlak the payee.',
        { italic: false, ink: GOLD_INK, bg: GOLD_BG, height: 30 }
      );
    }
    if (pkg.counts.needsCategory) {
      p.note(
        `• ${vendorPhrase(pkg.counts.needsCategory, 'carries', 'carry')} no tax category, so Amlak ` +
        `could not rule ${pkg.counts.needsCategory === 1 ? 'it' : 'them'} out and listed ` +
        `${pkg.counts.needsCategory === 1 ? 'it' : 'them'}. Setting the category on the Expense ` +
        'entry removes the ones that are utilities, materials or taxes.',
        { italic: false, ink: GOLD_INK, bg: GOLD_BG, height: 30 }
      );
    }
    if (pkg.counts.noMethod) {
      p.note(
        `• ${vendorPhrase(pkg.counts.noMethod, 'has', 'have')} no record of HOW ` +
        `${pkg.counts.noMethod === 1 ? 'it was' : 'they were'} paid. A card or PayPal ` +
        'payment is reported by the processor on a 1099-K and must not go on your 1099-NEC ' +
        'as well — check any of these that were paid by card.',
        { italic: false, ink: GOLD_INK, bg: GOLD_BG, height: 30 }
      );
    }
  }
}

function row(p, v, aligns) {
  const t = v.treatment || treatmentInfo(v.report === 'always' ? 'attorney' : 'ask');
  const standing = v.report === 'always' ? 'Report even if incorporated' : 'Reportable unless incorporated';
  const src = PAYEE_SOURCES[v.source] || { label: 'Unknown' };
  p.line(
    [
      v.name,
      v.total,
      v.cardTotal || '',
      v.reportable,
      standing,
      '', // ⚠ Deliberately blank — this is the question, and its answer is not Amlak's.
      src.label + (src.precise ? '' : ' (not a payee)'),
      v.categories.join(' · ') || (v.needsCategory ? 'No tax category set' : ''),
    ],
    {
      aligns,
      moneyFrom: 1,
      bg: v.report === 'always' ? GOLD_BG : undefined,
      ink: v.report === 'always' ? GOLD_INK : INK,
    }
  );
  if (v.report === 'always' && t?.why) p.note(`   ${t.why}`, { ink: GOLD_INK });
}

// ── Sheet 2 — what is deliberately left off ──────────────────────────────────
function addLeftOff(wb, pkg) {
  const ws = xlsxSheet(wb, 'Not on this worksheet', [34, 16, 70], { freeze: 0 });
  const p = xlsxPen(ws, 'C');
  const L = pkg.leftOff;

  p.title(`Not on this worksheet · ${pkg.corporation.name || 'Entity'} · ${pkg.year}`);
  p.note(
    'Every dollar of expense that is NOT a 1099 candidate, and why. Without this you ' +
    'cannot tell a careful worksheet from one that quietly dropped a vendor.',
    { italic: false, ink: INK, height: 26 }
  );
  p.skip();

  p.head(['What', 'Amount', 'Why it is not on the worksheet'], ['left', 'right', 'left']);

  if (pkg.excluded.length) {
    for (const v of pkg.excluded) {
      const t = v.treatment;
      p.line([v.name, v.total, t ? `${t.label} — ${t.why}` : 'Not a reportable payment.'], { aligns: ['left', 'right', 'left'] });
    }
  }

  if (L.drawCount) {
    p.line(
      [`Owner draws and contributions (${L.drawCount})`, L.draws,
        'A distribution is not a payment for services — it reduces equity and files on no 1099.'],
      { aligns: ['left', 'right', 'left'] }
    );
  }

  if (L.capital > 0) {
    p.line(
      ['Capitalized costs being written off', L.capital,
        'A capital cost spread over its life. The money left in the year the asset was bought, and was reportable then — counting it again each year would invent a payment that never happened.'],
      { aligns: ['left', 'right', 'left'] }
    );
  }

  if (L.cardTotal > 0) {
    p.line(
      ['Paid by card or a payment app', L.cardTotal,
        'Reported by the card processor on a 1099-K. Putting it on your 1099-NEC as well reports the same money twice against that vendor.'],
      { aligns: ['left', 'right', 'left'], bg: GOLD_BG, ink: GOLD_INK }
    );
  }

  // ⚠ The honest one. A flat un-itemized total has no payee attached to any part of it,
  // so it cannot be tested against the threshold at all. Silence here would read as
  // "nothing to report" when the truth is "nobody knows".
  if (L.unattributed > 0) {
    p.line(
      ['Expenses entered as one figure', L.unattributed,
        'Entered as a single yearly total with no vendor attached, so Amlak cannot tell who it went to or whether any one of them crossed the threshold. Itemize it on the Expense entry — or check it by hand.'],
      { aligns: ['left', 'right', 'left'], bg: GOLD_BG, ink: GOLD_INK }
    );
  }

  p.line(
    ['Total left off', L.excludedTotal + L.draws + L.capital + L.unattributed, ''],
    { bold: true, bg: SUMMARY_BG, aligns: ['left', 'right', 'left'] }
  );

  p.skip();
  p.note(
    'Not covered anywhere on this worksheet: anyone you pay as an employee (that is a W-2), ' +
    'and rent you PAY to another landlord (that is 1099-MISC box 1, a different form). ' +
    'Rent you RECEIVE is never something you issue a 1099 for.',
    { ink: MUTED, height: 28 }
  );
}

/**
 * Build + download the 1099 worksheet for one corporation and year.
 */
export async function download1099WorksheetXlsx({ corporationId, year, prebuilt = null } = {}) {
  // The modal shows the same shape on screen, so it hands it straight back rather than
  // making every export read the portfolio twice.
  const pkg = prebuilt || await build1099Worksheet({ corporationId, year });
  const mod = await import('exceljs/dist/exceljs.min.js');
  const ExcelJS = mod.default || mod;
  const now = new Date();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Amlak';
  addWorksheet(wb, pkg, now);
  addLeftOff(wb, pkg);

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const slug = String(pkg.corporation?.name || 'entity').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slug || 'entity'}-1099-Worksheet-${year}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
  return pkg;
}
