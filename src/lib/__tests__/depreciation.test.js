// Slice 5a — an asset with a life.
//
// The invariants that matter here are arithmetic ones, because the whole feature is a
// derivation: Σ of every year's expense must equal the depreciable basis to the cent
// across thirty-nine rows, land must never depreciate, and an asset nobody has split
// must refuse to depreciate rather than guessing a ratio.
import { describe, it, expect } from 'vitest';
import {
  ASSET_KINDS, assetKindInfo, depreciationSchedule, depreciationForYear,
  depreciableBasis, summarizeAssets, priorCheck,
} from '../depreciation';
import { listFixedAssets, getExpenseRecord, getTenantShares, getYearInvoice } from '../api';
import { currentYear } from '../format';

const Y = currentYear();
const sum = (ns) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;

// The demo's building: $1,190,000 with $254,000 of land → a $936,000 basis over 39
// years = exactly $24,000 a year, $2,000 a month.
const building = (over = {}) => ({
  kind: 'building', cost: 1190000, land_cost: 254000, placed_in_service: '2019-04-01', ...over,
});

describe('the schedule', () => {
  it('prorates the first year by whole months and the last by the remainder', () => {
    const s = depreciationSchedule(building());
    expect(s.blocked).toBe(false);
    expect(s.basis).toBe(936000);
    // April → 9 months of the first year (April through December). NOT the mid-month
    // convention, which is MACRS and deliberately not computed here.
    expect(s.rows[0]).toMatchObject({ year: 2019, months: 9, expense: 18000 });
    expect(s.rows[1]).toMatchObject({ year: 2020, months: 12, expense: 24000 });
    const last = s.rows[s.rows.length - 1];
    expect(last).toMatchObject({ year: 2058, months: 3, expense: 6000 });
    // 39 years starting mid-year spans 40 calendar rows.
    expect(s.rows).toHaveLength(40);
  });

  // THE invariant. Thirty-nine rounded rows must not drift a cent away from the basis.
  it('every year sums to exactly the basis, even when nothing divides evenly', () => {
    for (const asset of [
      building(),
      building({ cost: 1000000, land_cost: 200000 }),          // 800,000 / 468 months
      { kind: 'improvement', cost: 18000, placed_in_service: '2026-06-15' },
      { kind: 'land_improvement', cost: 42000, placed_in_service: '2022-07-01' },
      { kind: 'equipment', cost: 3333.33, placed_in_service: '2024-11-01' },
      { kind: 'appliances', cost: 7.77, placed_in_service: '2025-02-01' },
    ]) {
      const s = depreciationSchedule(asset);
      expect(s.blocked).toBe(false);
      expect(sum(s.rows.map((r) => r.expense))).toBe(s.basis);
      // And the running accumulated figure lands exactly on it too.
      expect(s.rows[s.rows.length - 1].accumulated).toBe(s.basis);
    }
  });

  // Book value is COST less accumulated, not basis less it — so a fully-depreciated
  // building is worth its land, forever. The arithmetic does the teaching.
  it('leaves the land standing at full value when everything else is gone', () => {
    const s = depreciationSchedule(building());
    expect(s.rows[s.rows.length - 1].bookValue).toBe(254000);
    expect(s.land).toBe(254000);
  });

  it('takes the life from the kind, and lets a typed life override it', () => {
    expect(assetKindInfo('building').life).toBe(39);
    expect(depreciationSchedule(building()).life).toBe(39);
    // A residential landlord types 27.5 and the schedule follows.
    const s = depreciationSchedule(building({ useful_life_years: 27.5 }));
    expect(s.life).toBe(27.5);
    expect(sum(s.rows.map((r) => r.expense))).toBe(936000);
    // ⚠ A full year is NOT round2(basis / life) repeated, and that distinction is the
    // design. 936,000 / 27.5 = 34,036.3636…, and repeating the rounded 34,036.36 for
    // 27 rows would end a third of a dollar short of the basis. Each year is instead
    // the difference between two rounded CUMULATIVE totals — here 34,036.37 — so the
    // rounding cannot accumulate and the last row is the exact remainder.
    expect(s.rows[1].expense).toBe(34036.37);
    expect(Math.abs(s.rows[1].expense - 936000 / 27.5)).toBeLessThan(0.01);
  });
});

describe('what it refuses to do', () => {
  // ⚠ THE FORCING FUNCTION. The land/building split is an allocation DECISION, not a
  // fact on the settlement statement, and an 80/20 default is one line of code and
  // silently wrong on most properties. So it blocks, and says which answer is missing.
  it('will not depreciate a building whose land has never been valued', () => {
    const s = depreciationSchedule(building({ land_cost: null }));
    expect(s.blocked).toBe(true);
    expect(s.reason).toMatch(/land value/i);
    expect(s.rows).toEqual([]);
    expect(depreciableBasis(building({ land_cost: null }))).toBeNull();
  });

  // null IS NOT zero. A ground lease or a condo unit legitimately has no land value,
  // and answering "none" is a different act from never being asked.
  it('treats a land value of 0 as an answer, and depreciates the whole cost', () => {
    const s = depreciationSchedule(building({ land_cost: 0 }));
    expect(s.blocked).toBe(false);
    expect(s.basis).toBe(1190000);
  });

  it('blocks on a missing cost, a missing date and a missing life, each by name', () => {
    expect(depreciationSchedule({ kind: 'improvement', cost: 0, placed_in_service: '2026-01-01' }).reason).toMatch(/cost/i);
    expect(depreciationSchedule({ kind: 'improvement', cost: 100, placed_in_service: '' }).reason).toMatch(/in-service date/i);
    // Loan costs carry no default life on purpose — points amortize over the term of a
    // loan Amlak does not know until Slice 6.
    expect(assetKindInfo('loan_costs').life).toBeNull();
    expect(depreciationSchedule({ kind: 'loan_costs', cost: 9000, placed_in_service: '2026-01-01' }).reason).toMatch(/useful life/i);
    expect(depreciationSchedule({ kind: 'loan_costs', cost: 9000, placed_in_service: '2026-01-01', useful_life_years: 10 }).blocked).toBe(false);
  });

  it('says so rather than reporting $0 when the land allocation is the whole cost', () => {
    const s = depreciationSchedule(building({ land_cost: 1190000 }));
    expect(s.blocked).toBe(true);
    expect(s.basis).toBe(0);
    expect(s.reason).toMatch(/nothing to depreciate/i);
  });

  // A kind written by a later round and read by an older cached bundle must not
  // silently borrow another kind's life — the same refusal dispositionInfo and
  // entityKindInfo make.
  it('does not guess a life for a kind it has never heard of', () => {
    expect(assetKindInfo('vehicles').life).toBeNull();
    expect(depreciationSchedule({ kind: 'vehicles', cost: 40000, placed_in_service: '2026-01-01' }).blocked).toBe(true);
  });
});

describe('one asset in one year', () => {
  it('reports nothing before it starts, and holds after it ends', () => {
    const a = building();
    expect(depreciationForYear(a, 2018).thisYear).toBe(0);
    expect(depreciationForYear(a, 2018).accumulated).toBe(0);
    expect(depreciationForYear(a, 2019).thisYear).toBe(18000);
    expect(depreciationForYear(a, 2020).accumulated).toBe(42000);
    // Fully depreciated: no more expense, and the accumulated figure stands.
    const after = depreciationForYear(a, 2075);
    expect(after.thisYear).toBe(0);
    expect(after.accumulated).toBe(936000);
    expect(after.bookValue).toBe(254000);
  });

  it('quotes a representative FULL year as the annual figure, not the prorated first one', () => {
    expect(depreciationForYear(building(), 2019).annual).toBe(24000);
  });
});

describe('the property total', () => {
  const assets = [
    { id: 'a', ...building() },
    { id: 'b', kind: 'improvement', cost: 19500, placed_in_service: '2024-01-01' },
    { id: 'c', kind: 'land_improvement', cost: 42000, placed_in_service: '2022-07-01' },
    { id: 'd', kind: 'building', cost: 800000, land_cost: null, placed_in_service: '2021-01-01' },
  ];

  it('leads with the biggest asset and counts the ones that cannot depreciate', () => {
    const s = summarizeAssets(assets, 2026);
    expect(s.rows.map((r) => r.asset.id)).toEqual(['a', 'd', 'c', 'b']);
    expect(s.blocked).toBe(1);
    // 24,000 + 500 + 2,800 — the blocked building contributes no depreciation…
    expect(s.thisYear).toBe(27300);
    // …but its cost and its book value are still real. A building you cannot yet
    // depreciate is still a building you own.
    expect(s.cost).toBe(2051500);
  });

  it('totals from the rows shown, so the table cannot disagree with its own arithmetic', () => {
    const s = summarizeAssets(assets, 2026);
    const shown = s.rows.filter((r) => !r.calc.blocked);
    expect(sum(shown.map((r) => r.calc.thisYear))).toBe(s.thisYear);
    expect(sum(shown.map((r) => r.calc.accumulated))).toBe(s.accumulated);
    expect(s.bookValue).toBe(Math.round((s.cost - s.accumulated) * 100) / 100);
  });

  it('is empty rather than wrong with nothing recorded', () => {
    const s = summarizeAssets([], 2026);
    expect(s).toMatchObject({ count: 0, cost: 0, thisYear: 0, accumulated: 0, bookValue: 0, blocked: 0 });
  });
});

describe('the accountant cross-check', () => {
  // Two independent sources for one number: this schedule, and the figure on the CPA's
  // last Form 4562. Neither is derived from the other, which is what lets Amlak say
  // they disagree.
  it('says nothing at all when no figure has been supplied', () => {
    expect(priorCheck(building()).state).toBe('none');
    expect(priorCheck(building({ prior_accumulated: 114000 })).state).toBe('none'); // no year
  });

  it('confirms a match', () => {
    const c = priorCheck(building({ prior_accumulated: 114000, prior_accumulated_year: 2023 }));
    expect(c.state).toBe('matched');
    expect(c.computed).toBe(114000);
    expect(c.tone).toBe('good');
  });

  // ⚠ THEY WILL ALMOST NEVER MATCH EXACTLY, AND THAT IS NOT A FINDING. A CPA applies
  // the mid-month convention in the first year; this file prorates by whole months and
  // says so. Reporting that as a warning would train George to ignore the warning.
  it('explains a small gap instead of flagging it', () => {
    const c = priorCheck(building({ prior_accumulated: 113000, prior_accumulated_year: 2023 }));
    expect(c.state).toBe('close');
    expect(c.tone).toBeNull();
    expect(c.sentence).toMatch(/normal/i);
    expect(c.difference).toBe(-1000);
  });

  // Beyond a full year's depreciation the two are working from a different cost or a
  // different life, which IS worth flagging.
  it('flags a gap larger than a year’s depreciation', () => {
    const c = priorCheck(building({ prior_accumulated: 60000, prior_accumulated_year: 2023 }));
    expect(c.state).toBe('differs');
    expect(c.tone).toBe('warn');
    expect(c.sentence).toMatch(/different cost or a different life/i);
  });

  it('stays quiet on an asset that cannot depreciate at all', () => {
    expect(priorCheck(building({ land_cost: null, prior_accumulated: 1, prior_accumulated_year: 2023 })).state).toBe('none');
  });
});

describe('the registry', () => {
  it('has unique keys and a hint on every kind', () => {
    const keys = ASSET_KINDS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ASSET_KINDS.every((k) => k.hint && k.label)).toBe(true);
    // Exactly one kind demands a land split — the building. A roof has no land in it.
    expect(ASSET_KINDS.filter((k) => k.landSplit).map((k) => k.key)).toEqual(['building']);
  });
});

// ⚠ THE REGRESSION THIS ROUND TURNS ON. Depreciation is a NON-CASH figure: recording an
// asset must move no expense total, no tenant's share and no invoice. The safety is
// structural — fixed_assets is read by no view, no invoice and no share calculation —
// so this proves the structure rather than the care.
describe('recording an asset moves nothing', () => {
  it('leaves every expense total, every tenant’s share and every invoice untouched', async () => {
    const { addFixedAsset, deleteFixedAsset } = await import('../api');
    const before = {
      cam: await getExpenseRecord('prop-1', Y),
      shares: await getTenantShares('prop-1', Y),
      invoice: await getYearInvoice('lease-2', Y),
    };

    const created = await addFixedAsset({
      property_id: 'prop-1', kind: 'improvement', description: 'HVAC replacement',
      cost: 46800, placed_in_service: `${Y}-01-01`,
    });
    expect(depreciationForYear(created, Y).thisYear).toBe(1200); // 46,800 / 39

    const after = await getExpenseRecord('prop-1', Y);
    expect(after.cam_total).toBe(before.cam.cam_total);
    expect(after.roof_total).toBe(before.cam.roof_total);
    expect(after.taxes_total).toBe(before.cam.taxes_total);
    expect((await getTenantShares('prop-1', Y)).map((s) => s.total_due))
      .toEqual(before.shares.map((s) => s.total_due));
    expect((await getYearInvoice('lease-2', Y)).total_amount).toBe(before.invoice.total_amount);

    await deleteFixedAsset(created.id);
  });

  // An asset is the only money row in this app that is NOT keyed to a fiscal year —
  // it has a date and a life spanning decades, and the year's figure is derived. So the
  // list must not be year-scoped, or the building would vanish from every year but the
  // one it was bought in.
  it('lists an asset in every year of its life, not just the one it was bought in', async () => {
    const assets = await listFixedAssets('prop-1');
    const b = assets.find((a) => a.kind === 'building');
    expect(b).toBeTruthy();
    expect(depreciationForYear(b, Y).thisYear).toBe(24000);
    expect(depreciationForYear(b, Y - 5).thisYear).toBe(24000);
    expect(depreciationForYear(b, Y - 7).thisYear).toBe(18000); // placed in April
  });
});
