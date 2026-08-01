// Slice 5b — the rule that decides WHO pays for a capitalized cost.
//
// The round exists because the direction doc got this wrong. It said a capitalized cost
// comes back as "a CAM amortization line" — and on live data that would move roughly
// $17,000 of an $18,000 roof onto eight Pershing tenants whose leases exclude the roof,
// because roof_amt is gated on each lease's roof_responsible flag while cam_amount is
// not. So an asset amortizes back into THE KIND IT CAME FROM, and these tests pin it.
import { describe, it, expect } from 'vitest';
import {
  ASSET_KINDS, AMORTIZE_KINDS, canAmortize, amortizationFor, amortizationLabel,
  depreciationForYear, amortizeKindLabel,
} from '../depreciation';

// A $19,500 roof placed on January 1 — no proration, so every year is exactly $500 over
// a 39-year life. Chosen to divide evenly: the arithmetic should never be what a reader
// has to check.
const roof = {
  id: 'a-roof', kind: 'improvement', description: 'Roof replacement',
  cost: 19500, placed_in_service: '2020-01-01',
};

describe('what a capitalized cost bills back, and through which charge', () => {
  // ⚠ THE HEADLINE REFUSAL. Nothing bills back until the landlord says so — whether a
  // lease permits recovering a capital cost is a LEASE question Amlak cannot answer from
  // the schema, and auto-billing for something the lease may not allow is the cam_capped
  // problem with the sign flipped.
  it('bills back nothing by default', () => {
    expect(amortizationFor(roof, 2021)).toBeNull();
    expect(roof.amortize_into).toBeUndefined();
    // …and the depreciation is unaffected either way: it is non-cash and always runs.
    expect(depreciationForYear(roof, 2021).thisYear).toBe(500);
  });

  it('sends a roof back through the roof charge, so only roof-responsible leases pay it', () => {
    const am = amortizationFor({ ...roof, amortize_into: 'roof' }, 2021);
    expect(am.kind).toBe('roof');
    expect(am.amount).toBe(500);
  });

  it('sends a parking lot back through CAM, where every tenant pays pro-rata', () => {
    const lot = { kind: 'land_improvement', description: 'Parking lot', cost: 42000, placed_in_service: '2022-01-01', amortize_into: 'cam' };
    // 42,000 over the 15-year default = $2,800 a year.
    const am = amortizationFor(lot, 2023);
    expect(am.kind).toBe('cam');
    expect(am.amount).toBe(2800);
  });

  // The amount IS the year's depreciation — one pure function, one source of truth — so
  // the first year bills the months the asset was actually in service rather than a full
  // year of a thing that stood there for three months.
  it('prorates the first year to the months it was actually in service', () => {
    const late = { ...roof, placed_in_service: '2020-10-01', amortize_into: 'roof' };
    // 3 months of a $500 year.
    expect(amortizationFor(late, 2020).amount).toBe(125);
    expect(amortizationFor(late, 2021).amount).toBe(500);
  });

  it('stops billing once the asset is fully depreciated, rather than billing forever', () => {
    const short = { kind: 'appliances', description: 'Carpet', cost: 5000, placed_in_service: '2020-01-01', amortize_into: 'cam' };
    expect(amortizationFor(short, 2024).amount).toBe(1000); // year 5 of 5
    expect(amortizationFor(short, 2025)).toBeNull();
  });

  it('bills nothing while the asset is blocked, so an unanswered question never becomes a charge', () => {
    const building = { kind: 'building', description: 'Structure', cost: 800000, placed_in_service: '2015-01-01', land_cost: null, amortize_into: 'cam' };
    expect(depreciationForYear(building, 2020).blocked).toBe(true);
    expect(amortizationFor(building, 2020)).toBeNull();
  });

  it('bills nothing before it was placed in service', () => {
    expect(amortizationFor({ ...roof, amortize_into: 'roof' }, 2019)).toBeNull();
  });
});

describe('which kinds may be billed back at all', () => {
  // A tenant pays for improvements to the property. They do not pay for the landlord
  // owning the building, for what it cost to buy it, or for the cost of the debt — so
  // the option is never offered on those, which is a stronger guarantee than defaulting
  // them off.
  it('refuses the building, its acquisition costs and loan costs', () => {
    expect(canAmortize({ kind: 'building' })).toBe(false);
    expect(canAmortize({ kind: 'acquisition_costs' })).toBe(false);
    expect(canAmortize({ kind: 'loan_costs' })).toBe(false);
  });

  it('allows the four kinds a CAM clause actually covers', () => {
    for (const k of ['improvement', 'land_improvement', 'equipment', 'appliances']) {
      expect(canAmortize({ kind: k })).toBe(true);
    }
  });

  // Same refusal assetKindInfo makes: an unknown kind carries no defaults, so it must
  // not inherit another kind's permission either.
  it('refuses an unknown kind rather than letting it inherit one', () => {
    expect(canAmortize({ kind: 'solar_array_round_14' })).toBe(false);
    expect(canAmortize({})).toBe(false);
  });

  // ⚠ Even an amortizable kind bills nothing until amortize_into is set — the flag says
  // the option MAY be offered, never that it is on.
  it('does not bill back an amortizable kind that was never switched on', () => {
    expect(amortizationFor({ ...roof, amortize_into: null }, 2021)).toBeNull();
  });

  it('refuses to bill back a kind the option was never offered on, even if the column says otherwise', () => {
    // A hand-edited row, or one written by a future round: the kind wins over the column.
    const building = { kind: 'building', cost: 800000, land_cost: 200000, placed_in_service: '2015-01-01', amortize_into: 'cam' };
    expect(depreciationForYear(building, 2020).blocked).toBe(false);
    expect(amortizationFor(building, 2020)).toBeNull();
  });
});

describe('the line explains itself in the expense list', () => {
  it('names the asset and which year of the life this is', () => {
    expect(amortizationLabel(roof, 2022)).toBe('Roof replacement — amortized (yr 3 of 39)');
    expect(amortizationFor({ ...roof, amortize_into: 'roof' }, 2022).yearOf).toBe(3);
  });

  it('falls back to the kind when the asset has no description', () => {
    expect(amortizationLabel({ kind: 'equipment', cost: 7000, placed_in_service: '2021-01-01' }, 2021))
      .toBe('Equipment and fixtures — amortized (yr 1 of 7)');
  });

  it('names the two charges a cost can be recovered through', () => {
    expect(AMORTIZE_KINDS.map((k) => k.key)).toEqual(['cam', 'roof']);
    expect(amortizeKindLabel('roof')).toBe('Roof');
    expect(amortizeKindLabel(null)).toBe('Not billed back');
  });
});

describe('the registry stays coherent', () => {
  it('marks exactly the kinds a lease could recover, and no others', () => {
    const amortizable = ASSET_KINDS.filter((k) => k.amortizable).map((k) => k.key);
    expect(amortizable).toEqual(['improvement', 'land_improvement', 'equipment', 'appliances']);
  });
});
