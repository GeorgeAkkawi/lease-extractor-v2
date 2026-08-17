// Do the workbooks this app hands people actually OPEN?
//
// ⚠ EVERY EXISTING WORKBOOK TEST ASSERTED `blob.size > 4000`, AND THAT IS WHY THIS DEFECT
// SHIPPED. A corrupt .xlsx is still a well-formed zip of exactly the right size — Excel
// only rejects it when it validates the package on open. So the exports were "verified"
// by a check that could not fail for the thing that was wrong with them. Size is not
// validity, the same way five buttons proved existence is not reachability.
//
// The bug: the shared `sheet()` always emitted `{ state: 'frozen', ySplit: 0 }` for every
// sheet that opted out of freezing — a frozen pane splitting nothing. Excel calls the
// package damaged and "repairs" it by discarding the view. 8 sheets across three
// workbooks. rentRollExcel.js:120 has carried a comment warning about exactly this since
// the last time someone hit it.
//
// ⚠ AND THE RISK OUTLIVED THE WORKBOOKS. Those three were removed 2026-08-12, but the
// writer they shared did not go with them — it moved to `xlsx.js` and the Income-and-
// expenses workbook is built on it, with `freeze: 0` on EVERY sheet. That is precisely
// the configuration that was broken, so this test matters more now, not less.
//
// So this reads the bytes Excel reads: unzip the real buffer, parse each sheet's XML, and
// assert the frozen-pane rule structurally. All three surviving workbooks are covered,
// including the two with their own writers — a later refactor onto the shared writer
// cannot silently break them.
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

const { downloadIncomeExpenseXlsx } = await import('../incomeExpenseExcel');
const { downloadReconciliationXlsx } = await import('../reconciliationExcel');
const { downloadRentRollXlsx } = await import('../rentRollExcel');
const { fetchSearchIndex, addAdjustment, markMonthPaid } = await import('../api');
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

/**
 * Every grid row reads the same across as down: B…N (Jan…Dec + No date) === O (the Total).
 *
 * ⚠ A MISSING Total IS THE FAILURE, not a row to skip. The expense CATEGORY rows shipped with
 * a blank Total in the first draft — `recoverabilityRows` calls the year's figure `spent`
 * where every other row calls it `total` — and a version of this check that skipped a null
 * Total column would have passed straight over it.
 */
function expectGridAddsUp(name, xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  let checked = 0;
  for (const row of doc.getElementsByTagName('row')) {
    const cells = {};
    for (const c of row.getElementsByTagName('c')) {
      const ref = (c.getAttribute('r') || '').replace(/\d+/g, '');
      const v = c.getElementsByTagName('v')[0];
      if (v && c.getAttribute('t') !== 's') cells[ref] = Number(v.textContent);
    }
    const across = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N']
      .reduce((s, k) => s + (cells[k] || 0), 0);
    // Rows that are not part of the grid (the two-column "what the year left" block, the
    // six-column tenant standings) carry no month cells at all, and are not what this asserts.
    if (across === 0) continue;
    expect(cells.O, `${name} row ${row.getAttribute('r')} carries months but no Total`).not.toBeUndefined();
    expect(Math.abs(across - cells.O), `${name} row ${row.getAttribute('r')} totals ${cells.O} but its months add to ${across}`).toBeLessThan(0.02);
    checked += 1;
  }
  return checked;
}

beforeEach(() => { saved.length = 0; });

describe('every downloadable workbook opens without a repair dialog', () => {
  // Every sheet here passes { freeze: 0 } — the exact case that was broken — so this is
  // the live guard on the shared writer rather than a formality.
  it('income and expenses — Summary plus one sheet per property, none of them frozen', async () => {
    await downloadIncomeExpenseXlsx({ corporationId: 'corp-1', corporationName: 'Acme', year: Y });
    expect(saved).toHaveLength(1);
    const sheets = await sheetsOf(saved[0]);
    expect(Object.keys(sheets).length).toBeGreaterThan(1); // Summary + at least one property
    for (const [n, xml] of Object.entries(sheets)) expectSheetOpens(n, xml);
    // No sheet declares a pane at all, which is the shape that opens cleanly.
    expect(Object.values(sheets).every((x) => !/state="frozen"/.test(x))).toBe(true);

    // ⚠ AND THE GRID ADDS UP IN THE BYTES THAT SHIP, not just in the builder. The sheet is
    // fifteen columns — the line item, Jan…Dec, "No date" and the year's Total — and O must
    // equal B…N on every row that carries numbers. A monthly sheet whose Total disagrees
    // with its own months is the one error a reader would catch and never trust again.
    //
    // ⚠ THE COLUMNS MOVED ON 2026-08-17 (Total from B to the far right, George's ask) and this
    // is what proves the move actually landed in the file rather than only in the builder.
    // Pointed at the old letters it would have gone on passing while every row printed its
    // Total under "January".
    //
    // ⚠ THE SUMMARY SHEET ONLY, and that is not laziness. A property sheet carries two tables
    // that are NOT the monthly grid — the six-column tenant standings and the four-column
    // "what tenants paid back" — whose figures would be read here as January, February and
    // March. The grid lives on Summary; anything monthly belongs there, where this can see it.
    const checked = expectGridAddsUp('Summary', Object.values(sheets)[0]);
    expect(checked, 'no grid rows were found to check').toBeGreaterThan(3);
  }, 30000);

  // ⚠ THE LIVE COPY IS A SECOND FILE, and nothing else in the suite opens its bytes. It is
  // built from the same writer but a different set of rows — the cash apportionment, no NOI
  // bridge, a credit in the "No date" cell — and a workbook that only ever gets checked on one
  // of its two bases is checked on the one nobody was worried about.
  it('income and expenses — the live basis opens too, and its grid adds up', async () => {
    await downloadIncomeExpenseXlsx({ corporationId: 'corp-1', corporationName: 'Acme', year: Y, basis: 'live' });
    expect(saved).toHaveLength(1);
    // The basis is in the filename, so two downloads do not collide as "(1)".
    expect(saved[0].filename).toMatch(/-live\.xlsx$/);
    const sheets = await sheetsOf(saved[0]);
    for (const [n, xml] of Object.entries(sheets)) expectSheetOpens(n, xml);
    expect(expectGridAddsUp('Summary', Object.values(sheets)[0])).toBeGreaterThan(3);
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

// ── The tint, read out of the bytes that ship ─────────────────────────────────────────
//
// George, 2026-08-17, asked for the month a charge or credit landed on to be flagged on the
// sheet — and set the condition that decides the whole design: *"only … when a charge is
// actually confirmed as carried trhough or written off or a credit was paid. if nothing has
// changed we dont want the revenue to not match the true money being exchanged."*
//
// ⚠ SO THE TEST THAT MATTERS IS THE NEGATIVE ONE. Any implementation tints the month with a
// charge on it; the one that is WRONG also tints the month that merely came in short of
// cash, which would colour a sheet for months still waiting on a bank statement and read as
// a revenue difference that does not exist. Both are asserted here, out of the real package,
// because a fill lives in the styles part and nothing about the builder proves it shipped.
describe('the workbook flags the month a charge landed on — and only that month', () => {
  it('tints the charge’s month, leaves a merely-underpaid month plain, and moves no figure', async () => {
    // Northwind Books, prop-2: February settled UNDER its bill (money, nothing decided) and
    // March carries a real late fee (a decision).
    await markMonthPaid('lease-3', 'prop-2', Y, 2, { amount: 1000, source: 'manual' });
    const posted = await addAdjustment({
      leaseId: 'lease-3', propertyId: 'prop-2', year: Y, month: 3,
      kind: 'fee', amount: 150, memo: 'late fee — paid on the 12th',
    });
    expect(posted?.refused).toBeFalsy();

    saved.length = 0;
    // ⚠ corp-2, because that is the corporation Oak Center sits under — a workbook for the
    // wrong corporation prints no sheet for this property at all, and the assertion below
    // would then be passing over an empty file.
    await downloadIncomeExpenseXlsx({ corporationId: 'corp-2', corporationName: 'Beta', year: Y });
    const zip = await JSZip.loadAsync(saved[0].buf);

    // A cell's fill is `s="<n>"` into the styles part; resolve it rather than trusting an
    // index, so a reordering of the palette cannot make this pass by accident.
    const styles = await zip.file('xl/styles.xml').async('string');
    const sdoc = new DOMParser().parseFromString(styles, 'application/xml');
    const xfs = [...sdoc.getElementsByTagName('cellXfs')[0].getElementsByTagName('xf')];
    const fills = [...sdoc.getElementsByTagName('fills')[0].getElementsByTagName('fill')];
    const fillOf = (sIdx) => {
      const xf = xfs[Number(sIdx || 0)];
      const f = fills[Number(xf?.getAttribute('fillId') || 0)];
      return f?.getElementsByTagName('fgColor')[0]?.getAttribute('rgb') || null;
    };

    const names = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    const march = []; const febRent = [];
    for (const n of names) {
      const doc = new DOMParser().parseFromString(await zip.file(n).async('string'), 'application/xml');
      for (const row of doc.getElementsByTagName('row')) {
        const cells = [...row.getElementsByTagName('c')];
        const at = (col) => cells.find((c) => (c.getAttribute('r') || '').replace(/\d+/g, '') === col);
        const val = (c) => Number(c?.getElementsByTagName('v')[0]?.textContent);
        // ⚠ THE LETTERS MOVED ON 2026-08-17 when Total went to the far right: it is now
        // A: label · B: Jan · C: Feb · D: Mar … N: No date · O: Total. This test failing on the
        // old letters is what proved the move reached the bytes rather than only the builder —
        // and `markStyle`'s own month offset had to move with it, or the tint would land one
        // month late on every sheet.
        if (at('D') && val(at('D')) === 150) march.push(at('D'));
        // February on a rent row — money came in short, nothing was decided.
        if (at('C') && val(at('C')) === 12750) febRent.push(at('C'));
      }
    }

    expect(march.length, 'the $150 fee never reached a month cell').toBeGreaterThan(0);
    // ⚠ GOLD on the tenant's own row, and the FIGURE IS UNTOUCHED — the value is still 150,
    // so every row still adds across to its own total and Total billed still ties to the
    // Ledger. (The bold parent row above it prints the same figure and is deliberately not
    // tinted: the mark belongs to the lease that carries the charge.)
    expect(march.map((c) => fillOf(c.getAttribute('s')))).toContain('FFFBF3DF');
    // ⚠ THE ASSERTION THAT DECIDES THE DESIGN. February settled $11,750 under its bill and
    // NOTHING was decided about it, so it must stay plain — tinting it would colour a month
    // that is simply waiting on a bank statement and read as a revenue difference.
    expect(febRent.length).toBeGreaterThan(0);
    expect(febRent.every((c) => fillOf(c.getAttribute('s')) !== 'FFFBF3DF')).toBe(true);
  });
});
