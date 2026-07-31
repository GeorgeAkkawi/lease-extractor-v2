// Slice 1 — every expense line carries the day it was paid, and the roof becomes a
// third itemized list (migration 0074).
//
// Two things are pinned here, and they are not the same kind of thing.
//
// The DATE is additive and harmless: a nullable column, a sort, and a display. Nothing
// downstream reads it yet — that is the point of shipping it first, because a monthly
// trend, a cash-basis view and a T-12 all need dates on file before they can exist, and
// no amount of later cleverness can invent a date nobody recorded.
//
// The ROOF is the dangerous half. Roof costs bill back at 100% to roof-responsible
// tenants rather than pro-rata, so a property whose roof was typed as one flat figure
// must not have that figure re-summed away by the first itemized instalment. That
// already happened once with property taxes, which is why carryFlatIntoItems exists; the
// roof gets the same guard and the same test.
//
// The demo store is a module-level singleton with no reset hook, so every test here
// either works on a scratch year of its own or puts back exactly what it changed.
import { describe, it, expect } from 'vitest';
import {
  listRoofLineItems, addRoofLineItem, deleteRoofLineItem,
  listTaxLineItems, listCamLineItems, addCamLineItem, deleteCamLineItem,
  getExpenseRecord, upsertExpenseRecord, getTenantShares,
  applyStatementImport, undoStatementImport,
} from '../api';
import { fmtShortDate } from '../format';

const PROP = 'prop-1';        // roof seeded as two itemized lines summing to 4,000
const PROP_FLAT = 'prop-2';   // roof seeded as one flat 12,000, nothing itemized
const Y = new Date().getFullYear();

const roofOf = async (propId, year = Y) => Number((await getExpenseRecord(propId, year))?.roof_total) || 0;

// A year of its own with a flat roof figure and nothing itemized — the exact state a
// property is in the moment before anyone itemizes it for the first time.
const flatYear = async (year, roof) => {
  await upsertExpenseRecord({ property_id: PROP_FLAT, year, taxes_total: 0, cam_total: 0, roof_total: roof });
};

describe('the flat figure is carried in, never re-summed away', () => {
  // The whole reason this guard exists. Without it the first $2,000 repair would re-sum
  // a $12,000 roof year DOWN to $2,000 and under-bill every roof-responsible tenant by
  // the difference — silently, because nothing errors and the page just shows a smaller
  // number than it did a moment ago.
  it('adding the first roof line to a flat year keeps the flat figure', async () => {
    await flatYear(Y - 7, 12000);
    expect(await listRoofLineItems(PROP_FLAT, Y - 7)).toHaveLength(0);

    await addRoofLineItem({ property_id: PROP_FLAT, year: Y - 7, label: 'Gutter repair', amount: 2000 });

    const items = await listRoofLineItems(PROP_FLAT, Y - 7);
    expect(items.map((i) => i.label)).toEqual(['Entered by hand', 'Gutter repair']);
    expect(await roofOf(PROP_FLAT, Y - 7)).toBe(14000); // 12,000 carried + 2,000 added — NOT 2,000
  });

  it('carries only once — a second line does not duplicate the carried figure', async () => {
    await flatYear(Y - 8, 12000);
    await addRoofLineItem({ property_id: PROP_FLAT, year: Y - 8, label: 'Gutter repair', amount: 2000 });
    await addRoofLineItem({ property_id: PROP_FLAT, year: Y - 8, label: 'Flashing', amount: 500 });

    const items = await listRoofLineItems(PROP_FLAT, Y - 8);
    expect(items.filter((i) => i.label === 'Entered by hand')).toHaveLength(1);
    expect(await roofOf(PROP_FLAT, Y - 8)).toBe(14500);
  });

  it('does not invent a carried line when the year has no roof figure at all', async () => {
    await flatYear(Y - 9, 0);
    await addRoofLineItem({ property_id: PROP_FLAT, year: Y - 9, label: 'First ever', amount: 900 });

    expect((await listRoofLineItems(PROP_FLAT, Y - 9)).map((i) => i.label)).toEqual(['First ever']);
    expect(await roofOf(PROP_FLAT, Y - 9)).toBe(900);
  });
});

describe('roof lines re-sum into roof_total, the way tax lines do', () => {
  it('the seeded itemization already equals the stored total', async () => {
    const items = await listRoofLineItems(PROP, Y);
    expect(items).toHaveLength(2);
    expect(items.reduce((s, i) => s + Number(i.amount), 0)).toBe(await roofOf(PROP));
  });

  it('add then delete returns the year to exactly where it started', async () => {
    const before = await roofOf(PROP);
    const item = await addRoofLineItem({ property_id: PROP, year: Y, label: 'Emergency patch', amount: 750 });
    expect(await roofOf(PROP)).toBe(before + 750);
    await deleteRoofLineItem(item.id, PROP, Y);
    expect(await roofOf(PROP)).toBe(before);
  });

  // Three lists, one table. A roof line must never appear in the CAM list (where it
  // would bill pro-rata to everyone) or the tax list.
  it('keeps the three kinds apart', async () => {
    const [cam, tax, roof] = await Promise.all([
      listCamLineItems(PROP, Y), listTaxLineItems(PROP, Y), listRoofLineItems(PROP, Y),
    ]);
    expect(cam.every((i) => (i.kind || 'cam') === 'cam')).toBe(true);
    expect(tax.every((i) => i.kind === 'tax')).toBe(true);
    expect(roof.every((i) => i.kind === 'roof')).toBe(true);
    expect(cam.map((i) => i.label)).not.toContain('Apex Roofing — leak repair');
  });
});

// The round's non-negotiable: no tenant's bill moves except where a slice intends it to.
describe('itemizing does not move a tenant bill', () => {
  it('the roof share a tenant is charged returns exactly to where it was', async () => {
    const key = (rows) => rows.map((r) => `${r.lease_id}:${r.roof_amt}:${r.cam_amount}:${r.tax_amount}`).join('|');
    const before = key(await getTenantShares(PROP, Y));

    const item = await addRoofLineItem({ property_id: PROP, year: Y, label: 'Ridge vent', amount: 800 });
    // Real money was added, so the shares SHOULD move — the guard's job is that they
    // move by what was added and by nothing else.
    expect(key(await getTenantShares(PROP, Y))).not.toBe(before);

    await deleteRoofLineItem(item.id, PROP, Y);
    expect(key(await getTenantShares(PROP, Y))).toBe(before);
  });
});

describe('the day it was paid', () => {
  it('is stored on a line and read back', async () => {
    const item = await addRoofLineItem({ property_id: PROP, year: Y, label: 'Inspection', amount: 300, paid_date: `${Y}-06-15` });
    expect(item.paid_date).toBe(`${Y}-06-15`);
    const found = (await listRoofLineItems(PROP, Y)).find((i) => i.id === item.id);
    expect(found.paid_date).toBe(`${Y}-06-15`);
    await deleteRoofLineItem(item.id, PROP, Y);
  });

  // An undated line is a hand-typed figure with no known day. Sorting it FIRST would
  // read as "paid in January" — a date the app invented. It sorts last and says "—".
  it('sorts dated lines chronologically and undated ones last', async () => {
    const item = await addCamLineItem({ property_id: PROP, year: Y, label: 'Early bill', amount: 100, paid_date: `${Y}-01-05` });
    const dates = (await listCamLineItems(PROP, Y)).map((i) => i.paid_date || null);

    const dated = dates.filter(Boolean);
    expect(dated).toEqual([...dated].sort());
    expect(dated[0]).toBe(`${Y}-01-05`);
    expect(dates.at(-1)).toBe(null); // the seeded undated 'Security'
    await deleteCamLineItem(item.id, PROP, Y);
  });

  it('says "—" rather than guessing when there is no date', () => {
    expect(fmtShortDate(null)).toBe('—');
    expect(fmtShortDate('')).toBe('—');
    expect(fmtShortDate(`${Y}-03-14`)).toBe('Mar 14');
  });
});

describe('a statement import books the roof as a line, and undo removes it', () => {
  const entry = (over = {}) => ({
    type: 'roof', property_id: PROP, year: Y, amount: 1800,
    label: 'Apex Roofing', date: `${Y}-07-09`, hash: 'roof-hash-1', ...over,
  });

  it('creates its own dated row instead of incrementing a running total', async () => {
    const before = await roofOf(PROP);
    const res = await applyStatementImport({ propertyId: PROP, year: Y, fileName: 'july.pdf', entries: [entry()] });

    const added = (await listRoofLineItems(PROP, Y)).find((i) => i.import_id);
    expect(added).toBeTruthy();
    expect(added.label).toBe('Apex Roofing');
    expect(added.paid_date).toBe(`${Y}-07-09`); // the bank's own date, which used to be discarded
    expect(await roofOf(PROP)).toBe(before + 1800);

    await undoStatementImport(res.import);
  });

  it('undo deletes the row and restores the total exactly', async () => {
    const before = await roofOf(PROP);
    const beforeCount = (await listRoofLineItems(PROP, Y)).length;
    const res = await applyStatementImport({ propertyId: PROP, year: Y, fileName: 'july.pdf', entries: [entry({ hash: 'roof-hash-2' })] });

    await undoStatementImport(res.import);
    expect(await roofOf(PROP)).toBe(before);
    expect(await listRoofLineItems(PROP, Y)).toHaveLength(beforeCount);
  });

  // A statement imported before 0074 recorded the roof as a subtraction, not a row. Its
  // ↩ Undo has to keep working forever, so the old branch stays.
  it('still reverses a pre-0074 running-total record', async () => {
    const before = await roofOf(PROP);
    const rec = await getExpenseRecord(PROP, Y);
    // Exactly what such an import did: move the stored total, create no row.
    await upsertExpenseRecord({
      property_id: PROP, year: Y,
      taxes_total: Number(rec?.taxes_total) || 0,
      cam_total: Number(rec?.cam_total) || 0,
      roof_total: before + 500,
    });

    await undoStatementImport({
      id: 'legacy-import', property_id: PROP, year: Y,
      applied: [{ kind: 'roof', property_id: PROP, year: Y, amount: 500, hash: 'old' }],
    });
    expect(await roofOf(PROP)).toBe(before);
  });
});
