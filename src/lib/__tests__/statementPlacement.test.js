// Answering the "money not yet placed" nag — and the one guard that outlived the panel.
//
// These three blocks were the part of `bankTieOut.test.js` that was never about the tie-out.
// When the bank tie-out was retired (2026-08-18) the file went with it and they moved here,
// because each pins behaviour that is still live: `placeUnplacedLine` writing a real payment,
// the same function refusing to bill an owner's draw, and the workbook staying free of a bank
// tab it used to carry.
//
// ⚠ THE WORKBOOK GUARD MATTERS MORE NOW, NOT LESS. It is the only thing left in the suite
// that remembers a "Where bank money went" sheet ever existed — and a regression guard whose
// subject has been deleted everywhere else is exactly the one nobody thinks to keep.
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import {
  applyStatementImport, getPropertyMonthlyRoll, placeUnplacedLine,
  listUnplacedLines, listCamLineItems,
} from '../api';
import { currentYear } from '../format';

// Capture the bytes the exporter hands the browser, the same way workbookValidity does.
const saved = [];
vi.mock('../download', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, saveWorkbook: (buf, filename) => { saved.push({ buf, filename }); return 'blob:test'; } };
});
const { buildIncomeExpense } = await import('../incomeExpense');
const { downloadIncomeExpenseXlsx } = await import('../incomeExpenseExcel');

const Y = currentYear();

// ── Money that arrived and belonged to a month nobody would have guessed ──────────────────
//
// George: "an option for money not placed yet should be to record it as a payment for the next
// or previous month. sometimes tenants pay twice in the same month."
describe('placing an unplaced deposit as rent', () => {
  it('settles the month it is tagged to, not the month it cleared', async () => {
    const dep = { hash: 'rent-late', year: Y, date: `${Y}-05-28`, description: 'MOBILE DEPOSIT', amount: 6500, direction: 'in' };
    await applyStatementImport({
      propertyId: 'prop-1', year: Y, fileName: 'rent.pdf',
      entries: [], lines: [{ ...dep, disposition: 'unclassified' }],
    });

    const mine = (await listUnplacedLines('prop-1', Y)).find((l) => l.line_hash === 'rent-late');
    expect(mine).toBeTruthy();
    // ⚠ TAGGED TO JUNE THOUGH IT CLEARED IN MAY — the whole request. A cheque that cleared on
    // the 28th can be next month's rent, and the month is the landlord's choice, not the date's.
    const { entry } = await placeUnplacedLine(mine, { kind: 'payment', leaseId: 'lease-1', month: 6, year: Y });
    expect(Number(entry.period_month)).toBe(6);
    expect(Number(entry.amount)).toBe(6500);
    // ⚠ THE THREE STAMPS, each load-bearing: `import_id` keeps the payment pointing at the
    // statement it came from, so the register still names the money that import made; without
    // `import_hash` the duplicate guard would let a re-import book it twice; `source` is
    // stored, never inferred (0088), and left to the default it would read 'system' and become
    // re-pricable by `resyncYearBillingToEstimate`.
    expect(entry.import_id).toBeTruthy();
    expect(entry.import_hash).toBe('rent-late');
    expect(entry.source).toBe('import');

    // It has left the work-list — a line sits in exactly one of unplaced / decided.
    expect((await listUnplacedLines('prop-1', Y)).some((l) => l.line_hash === 'rent-late')).toBe(false);
    // And the grid agrees: June is settled at what arrived.
    const roll = await getPropertyMonthlyRoll('prop-1', Y);
    const row = roll.find((r) => r.lease_id === 'lease-1');
    expect(row.payments.some((p) => Number(p.period_month) === 6 && Number(p.amount) === 6500)).toBe(true);
  });

  it('refuses without a tenant rather than writing a payment against nobody', async () => {
    const res = await placeUnplacedLine({ id: 'x', property_id: 'prop-1', amount: 100 }, { kind: 'payment', leaseId: null, year: Y });
    expect(res.refused).toBe(true);
    expect(res.entry).toBe(null);
  });
});

// ⚠ THE WORKBOOK MUST NOT REGROW A BANK TAB (2026-08-17, George: *"take out the bank tie up"*;
// the Ledger panel and `bankTieOut.js` followed it on 2026-08-18). Nothing in the app computes
// this any more, so nothing but this test would notice it coming back.
//
// ⚠ RUNS AFTER the import above, deliberately: the demo store is shared across a file, so this
// is the workbook a landlord would download HAVING imported a statement — the exact case that
// used to grow the tab. Asserting its absence on a corporation with nothing imported would
// prove nothing at all.
describe('the workbook carries no bank tie-out tab', () => {
  it('writes Summary plus one sheet per property, and nothing about the bank', async () => {
    const pkg = await buildIncomeExpense('corp-1', Y);
    expect(pkg.properties.find((p) => p.name === 'Maple Plaza')).toBeTruthy();
    // The field is gone from the shape too, not merely unread by the writer.
    expect(pkg.properties.every((p) => p.tieOut === undefined)).toBe(true);
    expect(pkg.flags.some((f) => /Where bank money went/.test(f))).toBe(false);

    saved.length = 0;
    await downloadIncomeExpenseXlsx({ corporationId: 'corp-1', corporationName: 'Acme', year: Y });
    const zip = await JSZip.loadAsync(saved[0].buf);
    const wbXml = await zip.file('xl/workbook.xml').async('string');
    expect(wbXml).not.toMatch(/name="Where bank money went"/);
    // …and none of its prose survives in a note on another sheet.
    const strings = await zip.file('xl/sharedStrings.xml').async('string');
    for (const phrase of ['Where your bank money went', 'The bank showed', 'What this cannot catch']) {
      expect(strings, `the workbook must no longer say "${phrase}"`).not.toContain(phrase);
    }
    // Every sheet still opens: no frozen pane that splits nothing (see workbookValidity).
    for (const n of Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))) {
      const xml = await zip.file(n).async('string');
      expect(new DOMParser().parseFromString(xml, 'application/xml').querySelector('parsererror')).toBeNull();
      expect(/state="frozen"/.test(xml)).toBe(false);
    }
  }, 30000);
});

// ── A placed expense nobody could ever bill ───────────────────────────────────────────────
//
// George, 2026-08-16: *"lastly does all this stuff tie into income and expenses where it needs
// to be?"* `placeUnplacedLine` FORCED `billable: false`, a deliberate safety property
// ("answering the nag can never move a tenant's bill") whose cost was that a genuinely
// recoverable cost placed after the fact reached "what the year cost you" and no tenant's CAM.
// The landlord absorbed it, silently, with nothing on any screen saying so.
//
// ⚠ THE DEFAULT DOES NOT MOVE. What changed is that the choice exists, is stated in the confirm,
// and carries the money all the way through when it is taken.
describe('a placed expense can now reach the tenants — but only when asked', () => {
  const feed = async (hash, amount, description) => {
    await applyStatementImport({
      propertyId: 'prop-2', year: Y, fileName: `${hash}.pdf`,
      entries: [],
      lines: [{ hash, year: Y, date: `${Y}-03-11`, description, amount, direction: 'out', disposition: 'unclassified' }],
    });
    return (await listUnplacedLines('prop-2', Y)).find((l) => l.line_hash === hash);
  };

  it('absorbs it by default, exactly as before', async () => {
    const l = await feed('bill-off', 1200, 'ARCTIC SNOW PLOWING');
    const res = await placeUnplacedLine(l, { kind: 'expense', category: 'repairs', year: Y });
    expect(res.billable).toBe(false);
    const item = (await listCamLineItems('prop-2', Y)).find((c) => c.id === res.entry.id);
    expect(item.billable).toBe(false);
    // The whole safety property in one assertion: syncCamTotal sums `billable is not false`,
    // so a not-billed line reaches no total, no share and no invoice.
    expect(res.rebilled).toBeNull();
  });

  it('bills it to the tenants when asked, and carries the change through to their invoices', async () => {
    const roll0 = await getPropertyMonthlyRoll('prop-2', Y);
    const before = roll0.find((r) => r.lease_id === 'lease-3');

    const l = await feed('bill-on', 6000, 'CITYWIDE LANDSCAPING SEASON');
    const res = await placeUnplacedLine(l, { kind: 'expense', category: 'cleaning', year: Y, billable: true });
    expect(res.billable).toBe(true);
    const item = (await listCamLineItems('prop-2', Y)).find((c) => c.id === res.entry.id);
    expect(item.billable).toBe(true);

    // ⚠ THE CARRY-THROUGH IS THE POINT. `addCamLineItem` moved `cam_total`, which moves
    // `v_tenant_shares` — and every screen that builds UP from live data follows on its own.
    // The STORED invoice does not (CLAUDE.md §1), which is why `resyncPropertyBilling` runs.
    const after = (await getPropertyMonthlyRoll('prop-2', Y)).find((r) => r.lease_id === 'lease-3');
    expect(after.camTaxAnnual).toBeGreaterThan(before.camTaxAnnual);
    expect(after.annual).toBeGreaterThan(before.annual);
    // The bill was rebuilt rather than left behind — no drift between schedule and invoice.
    expect(Math.abs(Number(after.drift) || 0)).toBeLessThanOrEqual(1);
  });

  // ⚠ AND A DRAW CAN NEVER BE BILLABLE, whatever is passed. `cam_line_items` is the table the
  // building bills from and a distribution is money that is not the building's; the predicate
  // keeping it inert is exactly this column. Asking for it must be refused, not obeyed.
  it('refuses to bill an owner distribution to the tenants even when told to', async () => {
    const l = await feed('bill-draw', 4000, 'TRANSFER TO OWNER');
    const res = await placeUnplacedLine(l, { kind: 'expense', category: 'distribution', party: 'G. Akkawi', year: Y, billable: true });
    expect(res.billable).toBe(false);
    expect(res.line.disposition).toBe('owner');
    const item = (await listCamLineItems('prop-2', Y)).find((c) => c.id === res.entry.id);
    expect(item.billable).toBe(false);
  });
});
