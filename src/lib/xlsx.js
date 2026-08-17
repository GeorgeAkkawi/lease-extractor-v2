// The shared workbook writer — one palette and one layout for every Excel export.
//
// These primitives lived in cpaExcel.js and were imported from there by the 1099 and
// lender workbooks, which made the tax package load-bearing for two exports that had
// nothing to do with a tax return. When the three packages were removed (2026-08-12)
// that import would have taken the survivor down with them, so the writer moved here:
// a module that owns nothing but formatting and depends on nothing but ExcelJS's cell
// API. Its reason for existing is unchanged — CLAUDE.md §3's rule read forward, that
// two implementations of one layout drift, and the second drifts SILENTLY because
// nothing compares them.
//
// reconciliationExcel.js and rentRollExcel.js predate this and still roll their own.
// That is a known duplication, not an endorsement: a third workbook belongs here.

const OLIVE = 'FF5C6B3C';
const CREAM = 'FFF1ECE1';
const INK = 'FF333333';
const MUTED = 'FF6B6B60';
const GOLD_BG = 'FFFBF3DF', GOLD_INK = 'FF7A5A12';
// The credit side of the same pair — the forest the app uses on screen for "a credit", so a
// tinted cell in the workbook means what the tinted box on the Ledger means.
const FOREST_BG = 'FFE0E6DE', FOREST_INK = 'FF3E5A3E';
const NEUTRAL_BG = 'FFF1EFE8';
const SUMMARY_BG = 'FFF5F4F0';

const CUR = '$#,##0.00';

export const XLSX_PALETTE = { OLIVE, CREAM, INK, MUTED, GOLD_BG, GOLD_INK, FOREST_BG, FOREST_INK, NEUTRAL_BG, SUMMARY_BG, CUR };

export const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

const thin = { style: 'thin', color: { argb: 'FFCCCCCC' } };
const borders = { top: thin, left: thin, bottom: thin, right: thin };

export const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const colLetter = (n) => {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

// ⚠ A frozen pane MUST have a real split row. `{ state: 'frozen', ySplit: 0 }` declares a
// pane that splits nothing — Excel rejects it, calls the whole package damaged, and
// "repairs" it by discarding the view ("we found a problem… couldn't recover everything").
// The figures survive; the dialog does not inspire confidence. rentRollExcel.js:120 has
// carried this warning since the last time someone hit it. So: no split → NO view at all,
// and a real split carries the matching topLeftCell.
//
// A sheet that stacks a title band, notes and several head() bands has no single header
// row worth pinning and should pass { freeze: 0 } on purpose.
export function xlsxSheet(wb, name, widths, opts = {}) {
  const freeze = Number(opts.freeze ?? 1) || 0;
  const ws = wb.addWorksheet(name, {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
    ...(freeze > 0 ? { views: [{ state: 'frozen', ySplit: freeze, topLeftCell: `A${freeze + 1}` }] } : {}),
  });
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  return ws;
}

// A writer bound to one sheet, so every sheet lays out the same way.
export function xlsxPen(ws, lastCol) {
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
    // `cellBg` / `cellInk` / `cellNote` are keyed by COLUMN INDEX and win over the row-wide
    // `bg` / `ink`. They exist because a workbook sometimes has to mark one figure rather
    // than one row: the Income-and-expenses sheet tints the month a charge or a credit landed
    // on, and prints what it was in the cell's own note (2026-08-17). Absent, the row behaves
    // exactly as it always has.
    line(cells, opts = {}) {
      const { bg, ink = INK, bold = false, money: moneyFrom = 1, aligns = [], cellBg = null, cellInk = null, cellNote = null } = opts;
      cells.forEach((v, i) => {
        const c = ws.getCell(r, i + 1);
        c.value = v == null ? '' : v;
        if (i >= moneyFrom && typeof v === 'number') c.numFmt = CUR;
        c.border = borders;
        c.font = { size: 9, bold, color: { argb: (cellInk && cellInk[i]) || ink } };
        const bgHere = (cellBg && cellBg[i]) || bg;
        if (bgHere) c.fill = fill(bgHere);
        if (cellNote && cellNote[i]) c.note = String(cellNote[i]);
        c.alignment = { horizontal: aligns[i] || (i === 0 ? 'left' : 'right'), wrapText: i === 0 };
      });
      r += 1;
      return api;
    },
  };
  return api;
}
