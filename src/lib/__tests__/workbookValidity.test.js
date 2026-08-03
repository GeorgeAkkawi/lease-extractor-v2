// Do the workbooks this app hands people actually OPEN?
//
// ⚠ EVERY EXISTING WORKBOOK TEST ASSERTS `blob.size > 4000`, AND THAT IS WHY THIS DEFECT
// SHIPPED. A corrupt .xlsx is still a well-formed zip of exactly the right size — Excel
// only rejects it when it validates the package on open. So all five exports were
// "verified" by a check that could not fail for the thing that was wrong with them.
// Size is not validity, the same way round 15's five buttons proved existence is not
// reachability.
//
// The bug: `sheet()` in cpaExcel.js always emitted `{ state: 'frozen', ySplit: 0 }` for
// every sheet that opted out of freezing — a frozen pane splitting nothing. Excel calls
// the package damaged and "repairs" it by discarding the view. 8 sheets across three
// workbooks. rentRollExcel.js:120 has carried a comment warning about exactly this since
// the last time someone hit it.
//
// So this reads the bytes Excel reads: unzip the real buffer, parse each sheet's XML, and
// assert the frozen-pane rule structurally. All five workbooks are covered, which also
// pins the two writers that were already correct — a later refactor onto the shared
// writer cannot silently break them.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import JSZip from 'jszip';

// Capture the exact ArrayBuffer each exporter hands to the browser. Mocking the save tail
// rather than shimming URL.createObjectURL keeps jsdom's Blob (which lacks arrayBuffer())
// out of it entirely — these are the same bytes either way.
const saved = [];
vi.mock('../download', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    saveWorkbook: (buf, filename) => { saved.push({ buf, filename }); return 'blob:test'; },
    saveBlob: () => 'blob:test',
  };
});

const { downloadCpaPackageXlsx } = await import('../cpaExcel');
const { downloadLenderPackageXlsx } = await import('../lenderExcel');
const { download1099WorksheetXlsx } = await import('../form1099Excel');
const { downloadReconciliationXlsx } = await import('../reconciliationExcel');
const { downloadRentRollXlsx } = await import('../rentRollExcel');
const { fetchSearchIndex } = await import('../api');
const { currentYear } = await import('../format');

const Y = currentYear();

/** Unzip the last saved workbook and return every worksheet's XML, keyed by part name. */
async function sheetsOf(entry) {
  const zip = await JSZip.loadAsync(entry.buf);
  const names = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  expect(names.length).toBeGreaterThan(0);
  const out = {};
  for (const n of names) out[n] = await zip.file(n).async('string');
  return out;
}

/**
 * The two things that decide whether Excel opens a sheet without the repair dialog.
 * Kept deliberately narrow: this is a regression guard, not a schema validator.
 */
function expectSheetOpens(name, xml) {
  // 1. It parses at all.
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.querySelector('parsererror'), `${name} is not well-formed XML`).toBeNull();

  // 2. ⚠ THE REGRESSION. A frozen pane must declare a real split row. Stated structurally
  //    so it holds however the view is written — a missing ySplit is as invalid as "0".
  for (const pane of doc.getElementsByTagName('pane')) {
    if (pane.getAttribute('state') !== 'frozen') continue;
    const y = Number(pane.getAttribute('ySplit') || 0);
    const x = Number(pane.getAttribute('xSplit') || 0);
    expect(y > 0 || x > 0, `${name} declares a frozen pane that splits nothing — Excel will call this file damaged`).toBe(true);
  }
}

beforeEach(() => { saved.length = 0; });

describe('every downloadable workbook opens without a repair dialog', () => {
  it('the tax package — 5 sheets, Summary was the broken one', async () => {
    await downloadCpaPackageXlsx({ corporationId: 'corp-1', year: Y });
    expect(saved).toHaveLength(1);
    const sheets = await sheetsOf(saved[0]);
    expect(Object.keys(sheets)).toHaveLength(5);
    for (const [n, xml] of Object.entries(sheets)) expectSheetOpens(n, xml);
  }, 30000);

  it('the lender package — all 5 sheets were broken', async () => {
    await downloadLenderPackageXlsx({ corporationId: 'corp-1', year: Y, assumptions: { debtService: 80000 } });
    expect(saved).toHaveLength(1);
    const sheets = await sheetsOf(saved[0]);
    expect(Object.keys(sheets)).toHaveLength(5);
    for (const [n, xml] of Object.entries(sheets)) expectSheetOpens(n, xml);
  }, 30000);

  it('the 1099 worksheet — both sheets were broken', async () => {
    await download1099WorksheetXlsx({ corporationId: 'corp-1', year: Y });
    expect(saved).toHaveLength(1);
    const sheets = await sheetsOf(saved[0]);
    expect(Object.keys(sheets)).toHaveLength(2);
    for (const [n, xml] of Object.entries(sheets)) expectSheetOpens(n, xml);
  }, 30000);

  // These two use their own writers and were already correct. Covering them is what stops
  // a later refactor onto the shared writer from breaking them quietly.
  it('the reconciliation export — its own writer, already correct', async () => {
    await downloadReconciliationXlsx({ propertyId: 'prop-1', year: Y });
    expect(saved).toHaveLength(1);
    for (const [n, xml] of Object.entries(await sheetsOf(saved[0]))) expectSheetOpens(n, xml);
  }, 30000);

  it('the rent roll — freezes rows 1-9, and that is the shape that works', async () => {
    const idx = await fetchSearchIndex();
    await downloadRentRollXlsx({ leases: idx.leases, properties: idx.properties });
    expect(saved).toHaveLength(1);
    const sheets = await sheetsOf(saved[0]);
    for (const [n, xml] of Object.entries(sheets)) expectSheetOpens(n, xml);
    // It genuinely freezes — proving the assertion above can tell a real split from none.
    expect(Object.values(sheets).some((x) => /state="frozen"/.test(x))).toBe(true);
  }, 30000);
});
