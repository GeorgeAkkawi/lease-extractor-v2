// Slice 5b, against the demo mock — the round's headline, and the one write in this
// whole accounting arc that deliberately MOVES A TENANT'S BILL.
//
// Round 9 could record an $18,000 roof in the asset register but could not take it out of
// the year's roof_total, so a landlord who did both told the app about the same roof
// twice. This is the other half. Because roof_total feeds v_property_totals, which feeds
// every roof-responsible lease's roof_amt, removing it lowers what THOSE tenants are
// billed — and leaves everyone else exactly where they were. That asymmetry is the whole
// reason an amortized roof must not be pushed into CAM, and it is what these tests pin.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addRoofLineItem, listRoofLineItems, listCamLineItems, getExpenseRecord, upsertExpenseRecord,
  capitalizeExpenseLine, setAssetAmortization, syncAmortizationItems,
  listFixedAssets, deleteFixedAsset, getTenantShares, updateLease, getLease,
} from '../api';
import { currentYear } from '../format';

const Y = currentYear();
const PROP = 'prop-2';        // Oak Center — no financial_snapshots row, so its years are OPEN
const CLOSED_PROP = 'prop-1'; // Maple Plaza — the current year IS closed on the demo seed
const ROOF_TENANT = 'lease-4'; // Sunrise Yoga, 1,000 SF of a 6,000 SF building
const OTHER_TENANT = 'lease-3'; // Northwind Books — deliberately NOT roof-responsible

// The demo mock's store is module-level and persists across a file, so each case works in
// its OWN fiscal year — the same isolation expenseDatesAndRoof.test.js uses. The seeded
// years then stay exactly as other suites pin them.
//
// ⚠ BUT A SCRATCH YEAR DOES NOT ISOLATE AN ASSET, and finding that out was worth the
// detour: an asset is deliberately NOT year-scoped (round 9's whole point — it belongs to
// every year of its life, not the one it was bought in), so an asset left behind by one
// case goes on amortizing into every later case's year. That is the feature behaving
// correctly, and it is exactly what a landlord should see. So each case starts from no
// amortizing assets rather than from a fresh year.
// Handed out two at a time: the self-heal case legitimately works in `y` AND `y + 1`,
// and a later case reusing that second year would inherit its amortization line — which
// suppresses carryFlatIntoItems (the year is already itemized) and reads as a mystery.
let nextYear = Y + 10;
const scratch = async (roof = 12000) => {
  const y = nextYear;
  nextYear += 2;
  await upsertExpenseRecord({ property_id: PROP, year: y, taxes_total: 5000, cam_total: 3000, roof_total: roof });
  return y;
};

beforeEach(async () => {
  for (const a of await listFixedAssets(PROP)) {
    if (a.amortize_into || a.kind !== 'building') await deleteFixedAsset(a.id);
  }
});

const roofOf = async (p, y) => Number((await getExpenseRecord(p, y))?.roof_total) || 0;
const camOf = async (p, y) => Number((await getExpenseRecord(p, y))?.cam_total) || 0;
const shareOf = async (p, y, leaseId) => {
  const shares = await getTenantShares(p, y);
  return shares.find((s) => s.lease_id === leaseId);
};

describe('capitalizing an expense line', () => {
  it('takes the cost out of the year and lowers the bill for the tenants who pay that charge — and only them', async () => {
    // Make one tenant responsible for the roof, which is what the flag is for. Sunrise
    // Yoga is 1,000 of 6,000 SF, so its roof share is exactly one sixth.
    await updateLease(ROOF_TENANT, { roof_responsible: true });
    const y = await scratch();

    // An $18,000 roof replacement — the direction doc's own example, and the reason this
    // slice exists. The first itemized line carries the year's flat $12,000 in with it
    // (the 0074 guard), so the year now reads $30,000.
    await addRoofLineItem({
      property_id: PROP, year: y, label: 'Roof replacement', amount: 18000, paid_date: `${y}-01-01`,
    });
    expect(await roofOf(PROP, y)).toBe(30000);
    expect((await shareOf(PROP, y, ROOF_TENANT)).roof_amt).toBe(5000);   // 30,000 ÷ 6
    expect((await shareOf(PROP, y, OTHER_TENANT)).roof_amt).toBe(0);     // not responsible

    const line = (await listRoofLineItems(PROP, y)).find((i) => i.label === 'Roof replacement');
    const res = await capitalizeExpenseLine(line.id, { kind: 'improvement' });
    expect(res.skipped).toBeNull();
    expect(res.asset.cost).toBe(18000);
    // The date it entered service comes from the line's own paid_date — never invented.
    expect(res.asset.placed_in_service).toBe(`${y}-01-01`);

    // The cost has left the year, so the charge falls — for the roof-responsible tenant.
    expect(await roofOf(PROP, y)).toBe(12000);
    expect((await shareOf(PROP, y, ROOF_TENANT)).roof_amt).toBe(2000);   // 12,000 ÷ 6
    // ⚠ AND THE OTHER TENANT IS UNTOUCHED, which is the point. Had the cost been pushed
    // into CAM — what the direction doc originally said — this figure would have moved.
    expect((await shareOf(PROP, y, OTHER_TENANT)).roof_amt).toBe(0);

    await updateLease(ROOF_TENANT, { roof_responsible: false });
  });

  // ⚠ THE REFUSAL. A closed year's bills have been sent; moving a cost out of it would
  // leave the expense total and the frozen snapshot disagreeing with nothing able to
  // reconcile them. Record the asset by hand instead and leave the expense as history.
  it('refuses a closed year outright, and changes nothing', async () => {
    const before = await camOf(CLOSED_PROP, Y);
    const line = (await listCamLineItems(CLOSED_PROP, Y)).find((i) => Number(i.amount) >= 2500);
    expect(line).toBeTruthy();

    const res = await capitalizeExpenseLine(line.id, { kind: 'improvement' });
    expect(res.skipped).toBe('closed');
    expect(res.asset).toBeNull();
    // Nothing moved: the line is still there and the total is unchanged to the cent.
    expect(await camOf(CLOSED_PROP, Y)).toBe(before);
    expect((await listCamLineItems(CLOSED_PROP, Y)).some((i) => i.id === line.id)).toBe(true);
  });

  // An asset's schedule is dated from the day it entered service, and 0074 deliberately
  // backfilled no dates. Rather than invent one, this refuses and says so.
  it('refuses a line with no date paid rather than inventing one', async () => {
    const y = await scratch();
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Undated repair', amount: 9000 });
    const line = (await listRoofLineItems(PROP, y)).find((i) => i.label === 'Undated repair');
    expect(line.paid_date == null).toBe(true);

    const res = await capitalizeExpenseLine(line.id, { kind: 'improvement' });
    expect(res.skipped).toBe('no_date');
    expect(await listFixedAssets(PROP)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ description: 'Undated repair' })])
    );
  });

  it('carries the statement it came from onto the asset, so provenance survives', async () => {
    const y = await scratch();
    await addRoofLineItem({
      property_id: PROP, year: y, label: 'Imported roof', amount: 12000,
      paid_date: `${y}-03-01`, import_id: 'imp-demo-1',
    });
    const line = (await listRoofLineItems(PROP, y)).find((i) => i.label === 'Imported roof');
    const res = await capitalizeExpenseLine(line.id, { kind: 'improvement' });
    expect(res.asset.import_id).toBe('imp-demo-1');
  });
});

describe('billing a capitalized cost back over its life', () => {
  it('does nothing until it is switched on', async () => {
    const y = await scratch();
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Roof replacement', amount: 18000, paid_date: `${y}-01-01` });
    const line = (await listRoofLineItems(PROP, y)).find((i) => i.label === 'Roof replacement');
    await capitalizeExpenseLine(line.id, { kind: 'improvement' });

    // The cost left, and nothing came back — because nobody said it should.
    expect(await roofOf(PROP, y)).toBe(12000);
    const derived = (await listRoofLineItems(PROP, y)).filter((i) => i.asset_id);
    expect(derived).toHaveLength(0);
  });

  it('brings it back through the SAME charge, at cost ÷ life', async () => {
    const y = await scratch();
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Roof replacement', amount: 19500, paid_date: `${y}-01-01` });
    const line = (await listRoofLineItems(PROP, y)).find((i) => i.label === 'Roof replacement');
    // amortize: true → it returns to the kind it came from, which is roof.
    const res = await capitalizeExpenseLine(line.id, { kind: 'improvement', amortize: true });
    expect(res.asset.amortize_into).toBe('roof');

    // 19,500 over 39 years = exactly $500, and January 1 means no proration.
    const derived = (await listRoofLineItems(PROP, y)).filter((i) => i.asset_id === res.asset.id);
    expect(derived).toHaveLength(1);
    expect(Number(derived[0].amount)).toBe(500);
    expect(derived[0].label).toContain('amortized');
    // 12,000 carried + 500 amortized. The tenants who pay the roof pay the 500.
    expect(await roofOf(PROP, y)).toBe(12500);
    // ⚠ AND IT DID NOT LAND IN CAM, which is the correction this round makes.
    expect((await listCamLineItems(PROP, y)).some((i) => i.asset_id)).toBe(false);
  });

  it('can be switched on and off later, and the charge follows', async () => {
    const y = await scratch();
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Roof replacement', amount: 19500, paid_date: `${y}-01-01` });
    const line = (await listRoofLineItems(PROP, y)).find((i) => i.label === 'Roof replacement');
    const { asset } = await capitalizeExpenseLine(line.id, { kind: 'improvement' });
    expect(await roofOf(PROP, y)).toBe(12000);

    await setAssetAmortization(asset.id, 'roof', PROP, y);
    expect(await roofOf(PROP, y)).toBe(12500);

    await setAssetAmortization(asset.id, null, PROP, y);
    expect(await roofOf(PROP, y)).toBe(12000);
    expect((await listRoofLineItems(PROP, y)).filter((i) => i.asset_id)).toHaveLength(0);
  });

  // The self-heal: opening a later year re-derives the figure rather than repeating the
  // first year's. Same shape service contracts and rent-percentage fees already have.
  it('re-derives the figure when a later year is opened, and prorates the first', async () => {
    const y = await scratch();
    await upsertExpenseRecord({ property_id: PROP, year: y + 1, taxes_total: 0, cam_total: 0, roof_total: 0 });
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Roof replacement', amount: 19500, paid_date: `${y}-10-01` });
    const line = (await listRoofLineItems(PROP, y)).find((i) => i.label === 'Roof replacement');
    const res = await capitalizeExpenseLine(line.id, { kind: 'improvement', amortize: true });

    // Placed October 1 → three months of a $500 year.
    const first = (await listRoofLineItems(PROP, y)).find((i) => i.asset_id === res.asset.id);
    expect(Number(first.amount)).toBe(125);

    // The next year is a full one, and nothing had to be re-entered.
    const sync = await syncAmortizationItems(PROP, y + 1);
    expect(sync.changed).toBe(true);
    const second = (await listRoofLineItems(PROP, y + 1)).find((i) => i.asset_id === res.asset.id);
    expect(Number(second.amount)).toBe(500);
  });

  // ⚠ A closed year's bills are frozen, so no derived line is written into one. The
  // asset still amortizes — the charge simply starts from the next open year.
  it('writes no charge into a closed year', async () => {
    const before = await camOf(CLOSED_PROP, Y);
    const roofBefore = await roofOf(CLOSED_PROP, Y);
    const assets = await listFixedAssets(CLOSED_PROP);
    const roofAsset = assets.find((a) => a.kind === 'improvement');
    expect(roofAsset).toBeTruthy();

    const res = await setAssetAmortization(roofAsset.id, 'roof', CLOSED_PROP, Y);
    expect(res.skipped).toBe('closed');
    // The intent is recorded on the asset; the year's figures are untouched.
    expect(res.asset.amortize_into).toBe('roof');
    expect(await camOf(CLOSED_PROP, Y)).toBe(before);
    expect(await roofOf(CLOSED_PROP, Y)).toBe(roofBefore);
    expect((await listRoofLineItems(CLOSED_PROP, Y)).filter((i) => i.asset_id)).toHaveLength(0);

    await setAssetAmortization(roofAsset.id, null, CLOSED_PROP, Y);
  });

  // Removing the asset must take its charge with it, or the expense total keeps a figure
  // derived from something that no longer exists.
  it('takes the charge away with the asset', async () => {
    const y = await scratch();
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Roof replacement', amount: 19500, paid_date: `${y}-01-01` });
    const line = (await listRoofLineItems(PROP, y)).find((i) => i.label === 'Roof replacement');
    const { asset } = await capitalizeExpenseLine(line.id, { kind: 'improvement', amortize: true });
    expect(await roofOf(PROP, y)).toBe(12500);

    await deleteFixedAsset(asset.id);
    const sync = await syncAmortizationItems(PROP, y);
    expect(sync.changed).toBe(true);
    expect(await roofOf(PROP, y)).toBe(12000);
  });
});

describe('what capitalizing does NOT do', () => {
  it('leaves the lease and its rent exactly where they were', async () => {
    const y = await scratch();
    const before = await getLease(ROOF_TENANT);
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Roof replacement', amount: 19500, paid_date: `${y}-01-01` });
    const line = (await listRoofLineItems(PROP, y)).find((i) => i.label === 'Roof replacement');
    await capitalizeExpenseLine(line.id, { kind: 'improvement', amortize: true });

    const after = await getLease(ROOF_TENANT);
    expect(after.base_rent).toBe(before.base_rent);
    expect(after.square_footage).toBe(before.square_footage);
    expect(after.lease_termination_date).toBe(before.lease_termination_date);
  });

  it('leaves the other expense kinds alone', async () => {
    const y = await scratch();
    const taxBefore = Number((await getExpenseRecord(PROP, y))?.taxes_total) || 0;
    const camBefore = await camOf(PROP, y);
    await addRoofLineItem({ property_id: PROP, year: y, label: 'Roof replacement', amount: 19500, paid_date: `${y}-01-01` });
    const line = (await listRoofLineItems(PROP, y)).find((i) => i.label === 'Roof replacement');
    await capitalizeExpenseLine(line.id, { kind: 'improvement', amortize: true });

    expect(Number((await getExpenseRecord(PROP, y))?.taxes_total) || 0).toBe(taxBefore);
    expect(await camOf(PROP, y)).toBe(camBefore);
  });
});
