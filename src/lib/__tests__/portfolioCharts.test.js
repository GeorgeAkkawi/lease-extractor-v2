// The Overview chart band draws from the SAME rows as the metric cards above it
// (v_property_totals for the selected year), so these shapers are the one place a
// disagreement could creep in. Each is pure, so each is pinned here.
import { describe, it, expect } from 'vitest';
import {
  revenueByProperty, occupancyByProperty, portfolioOccupancy, rentRollover,
  tenantMix, basisRows, portfolioBasis, kfmt, shortName, DONUT_PALETTE,
} from '../portfolioCharts';

const PROPS = [
  { id: 'p1', name: 'Maple Plaza', building_sf: 5000 },
  { id: 'p2', name: 'Oak Center', building_sf: 8000 },
  { id: 'p3', name: 'Elm Court', building_sf: 0 },   // no building size on file
];
const TOTALS = {
  p1: { total_revenue: 120000, total_sf: 4200, taxes_total: 25000, cam_total: 18000, roof_total: 2000, noi: 75000 },
  p2: { total_revenue: 300000, total_sf: 8000, taxes_total: 40000, cam_total: 30000, roof_total: 0, noi: 230000 },
  p3: { total_revenue: 0, total_sf: 0, taxes_total: 0, cam_total: 0, roof_total: 0, noi: 0 },
};
// ⚠ `rentProjected` DELIBERATELY DISAGREES WITH `total_revenue` IN BOTH DIRECTIONS, because
// after 2026-08-18 (3) that is the whole point: p1 is $2,000 BELOW the view (a raise that landed
// mid-year, which the view prices for all twelve months) and p2 is $3,000 ABOVE it (a raise the
// leases schedule for later this year, which the view cannot see at all). Fixtures where the two
// agreed would let a regression back to `total_revenue` pass every assertion below.
const BASIS = {
  p1: { rentProjected: 118000, projectedAhead: 0, rentNotDue: 39000, camTaxNotDue: 13000, rentLive: 60000, camTaxLive: 12000, chargesLive: 0, chargesProjected: 0, otherLive: 1800, camTaxProjected: 40000, unapplied: 1750 },
  p2: { rentProjected: 303000, projectedAhead: 3000, rentNotDue: 101000, camTaxNotDue: 0, rentLive: 90000, camTaxLive: 0, chargesLive: 0, chargesProjected: 0, otherLive: 0, camTaxProjected: 0, unapplied: 0 },
};

describe('revenueByProperty', () => {
  it('ranks properties by rent roll, biggest first', () => {
    const out = revenueByProperty(PROPS, TOTALS, BASIS);
    expect(out.map((d) => d.name)).toEqual(['Oak Center', 'Maple Plaza']);
    expect(out[0].value).toBe(303000);
  });

  it('drops a zero-revenue property — an invisible slice still costs a legend entry', () => {
    expect(revenueByProperty(PROPS, TOTALS, BASIS).some((d) => d.name === 'Elm Court')).toBe(false);
  });

  // ⚠ THE DONUT IS THE LEASES' OWN MONTHS NOW, NOT THE ANNUAL RATE (2026-08-18 (3)). George:
  // *"we should make rent projections part of the projected rent because we know what those
  // numbers are so that shouldn't be a discrepancy."* Both figures moved together — see the
  // identity test under `basisRows` — so what this pins is that the donut left the view behind
  // rather than that it sums to it.
  it('sums the leases’ scheduled rent, not the view’s annual rate', () => {
    const total = revenueByProperty(PROPS, TOTALS, BASIS).reduce((s, d) => s + d.value, 0);
    expect(total).toBe(421000);
    const cardTotal = Object.values(TOTALS).reduce((s, t) => s + Number(t.total_revenue), 0);
    expect(cardTotal).toBe(420000);
    expect(total).not.toBe(cardTotal);
  });

  // ⚠ NOTHING, NOT THE VIEW'S FIGURE. A fallback to `total_revenue` while the roll is in flight
  // would paint one answer and revise it to another a beat later — the same two-figures fault
  // the band was rebuilt to close, spread over time instead of across the screen.
  it('draws nothing at all until the leases’ own rent has landed', () => {
    expect(revenueByProperty(PROPS, TOTALS)).toEqual([]);
    expect(revenueByProperty(PROPS, TOTALS, null)).toEqual([]);
  });

  it('degrades to an empty list, never a throw', () => {
    expect(revenueByProperty(null, null, null)).toEqual([]);
    expect(revenueByProperty(PROPS, {}, BASIS)).toEqual([]);
    expect(revenueByProperty([{ id: 'x' }], { x: { total_revenue: 5 } }, { x: { rentProjected: 5 } })[0].name)
      .toBe('Untitled property');
  });

  it('has enough distinct colours that two properties never share one at normal portfolio sizes', () => {
    expect(new Set(DONUT_PALETTE).size).toBe(DONUT_PALETTE.length);
    expect(DONUT_PALETTE.length).toBeGreaterThanOrEqual(10);
  });
});

describe('occupancyByProperty', () => {
  it('leased + vacant always equals the building size — the track IS the building', () => {
    for (const d of occupancyByProperty(PROPS, TOTALS)) {
      expect(d.leased + d.vacant).toBe(d.building);
    }
  });

  it('reads vacancy and the share from leased SF against the entered building size', () => {
    const maple = occupancyByProperty(PROPS, TOTALS).find((d) => d.name === 'Maple Plaza');
    expect(maple).toMatchObject({ leased: 4200, vacant: 800, building: 5000, pct: 84 });
  });

  it('puts the emptiest property first — the vacancy is the thing worth looking at', () => {
    expect(occupancyByProperty(PROPS, TOTALS).map((d) => d.name)).toEqual(['Maple Plaza', 'Oak Center']);
  });

  it('omits a property with no building size rather than calling it fully leased', () => {
    // v_property_totals coalesces building_sf to the leased total when none is entered,
    // so including it would draw a full track that means nothing.
    expect(occupancyByProperty(PROPS, TOTALS).some((d) => d.name === 'Elm Court')).toBe(false);
  });

  it('never shows negative vacancy when leased SF exceeds a stale building size', () => {
    const out = occupancyByProperty([{ id: 'p1', name: 'Maple Plaza', building_sf: 3000 }], TOTALS);
    expect(out[0]).toMatchObject({ leased: 3000, vacant: 0, pct: 100 });
  });
});

describe('portfolioOccupancy', () => {
  it('sums the same rows the tracks draw, so the headline can never disagree with them', () => {
    const rows = occupancyByProperty(PROPS, TOTALS);
    expect(portfolioOccupancy(rows)).toEqual({ building: 13000, leased: 12200, vacant: 800, pct: 94 });
  });

  it('returns null when nothing can be measured — no building sizes on file', () => {
    expect(portfolioOccupancy([])).toBeNull();
    expect(portfolioOccupancy(null)).toBeNull();
  });
});

describe('rentRollover', () => {
  const LEASES = [
    { id: 'a', tenant_name: 'Anchor Foods', is_active: true, base_rent: 60000, lease_termination_date: '2026-11-30' }, // this year
    { id: 'b', tenant_name: 'Barber Co', is_active: true, base_rent: 40000, lease_termination_date: '2026-03-31' },    // this year, already past
    { id: 'c', tenant_name: 'City Dental', is_active: true, base_rent: 90000, lease_termination_date: '2028-06-30' },
    { id: 'd', tenant_name: 'Dry Cleaners', is_active: true, base_rent: 20000, lease_termination_date: '2028-12-31' },
    { id: 'e', tenant_name: 'Eastside Gym', is_active: true, base_rent: 10000, lease_termination_date: '2040-01-01' }, // beyond the window
    { id: 'f', tenant_name: 'Florist', is_active: true, base_rent: 15000, lease_termination_date: null },              // no term end
    { id: 'g', tenant_name: 'Gone Ltd', is_active: false, base_rent: 99000, lease_termination_date: '2028-01-01' },    // parked
  ];
  const TODAY = '2026-07-29';

  it('buckets the rent by the year it comes up, in time order', () => {
    const out = rentRollover(LEASES, TODAY);
    expect(out.map((d) => d.label)).toEqual(['Now', '2026', '2028']);
    expect(out.find((d) => d.label === '2026')).toMatchObject({ value: 60000, count: 1 });
    expect(out.find((d) => d.label === '2028')).toMatchObject({ value: 110000, count: 2 });
  });

  it('leads with a "Now" bucket for rent already sitting on holdover', () => {
    // Lease b's term ended in March and the tenant is still active — that rent is at risk
    // today, which nothing else on the Overview says.
    const now = rentRollover(LEASES, TODAY)[0];
    expect(now).toMatchObject({ key: 'now', label: 'Now', kind: 'now', value: 40000, count: 1 });
  });

  it('ignores parked leases, leases with no term end, and anything past the window', () => {
    const values = rentRollover(LEASES, TODAY).reduce((s, d) => s + d.value, 0);
    expect(values).toBe(40000 + 60000 + 110000);   // not g (parked), f (no end) or e (2040)
  });

  it('carries the leases inside each bar, biggest rent first — the hover names them', () => {
    const y2028 = rentRollover(LEASES, TODAY).find((d) => d.label === '2028');
    expect(y2028.leases.map((l) => l.name)).toEqual(['City Dental', 'Dry Cleaners']);
    expect(y2028.leases[0]).toMatchObject({ id: 'c', rent: 90000, end: '2028-06-30' });
    // The named rents must always add back up to the bar they sit under, or the tooltip
    // would be describing a different figure than the one being hovered.
    expect(y2028.leases.reduce((s, l) => s + l.rent, 0)).toBe(y2028.value);
    expect(y2028.leases.length).toBe(y2028.count);
  });

  it('names an untitled tenant rather than rendering a blank row', () => {
    const [b] = rentRollover([{ id: 'x', is_active: true, base_rent: 1000, lease_termination_date: '2027-02-01' }], TODAY);
    expect(b.leases[0].name).toBe('Untitled tenant');
  });

  it('degrades to an empty list, never a throw', () => {
    expect(rentRollover(null, TODAY)).toEqual([]);
    expect(rentRollover([], TODAY)).toEqual([]);
    expect(rentRollover(LEASES, null)).toEqual([]);
    expect(rentRollover([{ is_active: true, base_rent: 0, lease_termination_date: '2027-01-01' }], TODAY)).toEqual([]);
  });
});

// (The two `revenueExpensesNoi` describes lived here until 2026-08-18 (12), when the shaper
// itself was deleted — the grouped bars it fed were retired at George's word and no reader
// remained.)


// The Overview band — the BILL, read twice (2026-08-18).
//
// ⚠ WHAT THE FIRST ATTEMPT GOT WRONG, and the reason these columns are what they are. It made
// projected revenue ALL-IN and prorated, which read $1,155,141 on George's portfolio while the
// donut on the same screen said $1,032,564 for the same year. His question was the right one:
// *"where is this coming from."* Revenue is the figure `revenueByProperty` sums for the donut —
// so the two agree to the cent, and the test below asserts that identity rather than leaving it
// to hold by luck.
//
// ⚠ THE IDENTITY SURVIVED A CHANGE OF DEFINITION, WHICH IS WHY IT IS WRITTEN THIS WAY. Until
// 2026-08-18 (3) both sides simply quoted `v_property_totals.total_revenue`, and an older comment
// here named "projecting a rent step" as the thing this test existed to block. George asked for
// exactly that — *"we should make rent projections part of the projected rent because we know
// what those numbers are so that shouldn't be a discrepancy"* — because the annual rate neither
// dates an applied raise nor sees a scheduled one, and printed the difference as a gap he was
// asked to account for. So the definition moved; what may never move is the two sides moving
// apart. This test now pins the identity itself rather than the figure it happened to be.
describe('basisRows', () => {
  // ⚠ THE PIN THAT CLOSES GEORGE'S COMPLAINT. If anyone ever gives Revenue and the donut two
  // different sources again, this goes red before the two figures can disagree on screen.
  it('takes Revenue from the very figure the donut sums, so the two cannot disagree', () => {
    const rows = basisRows(PROPS, TOTALS, BASIS);
    const donut = revenueByProperty(PROPS, TOTALS, BASIS);
    expect(donut.length, 'a vacuous pass here would assert nothing at all').toBe(2);
    for (const d of donut) {
      expect(rows.find((r) => r.id === d.id).rentProjected).toBe(d.value);
    }
    const bandTotal = portfolioBasis(rows).rent.projected;
    expect(bandTotal).toBe(donut.reduce((s, d) => s + d.value, 0));
    // …and neither of them is the view any more.
    expect(bandTotal).not.toBe(Object.values(TOTALS).reduce((s, t) => s + Number(t.total_revenue), 0));
  });

  it('bills CAM & tax at the estimate, and adds the two columns into Total', () => {
    const maple = basisRows(PROPS, TOTALS, BASIS).find((d) => d.name === 'Maple Plaza');
    expect(maple).toMatchObject({
      rentProjected: 118000,
      camTaxProjected: 40000,
      rentLive: 60000,
      camTaxLive: 12000,
    });
    // Total projected is the two columns beside it — that is why it replaced "what's left".
    expect(maple.totalProjected).toBe(158000);
    // The timing split rides through for the bridge — the loader measured it, this only carries.
    expect(maple.rentNotDue).toBe(39000);
    expect(maple.camTaxNotDue).toBe(13000);
    // ⚠ And the view's figure is on NO field of the row (2026-08-18 (10)) — it was carried for
    // one afternoon as `rentAnnualRate` to feed a caveat comparing this band to the Financials
    // page, a third number George had to ask about three times. The view is read for presence
    // only; a field here is how it would find its way back onto a screen.
    expect(maple.rentAnnualRate).toBeUndefined();
  });

  // ⚠ GEORGE'S OWN QUESTION: *"what happens when a landlord has other sources of income."*
  // It rides no invoice and nothing forecasts it, so it can only be live — but Total live has
  // to equal the bank, so it goes IN there and is named separately rather than dropped.
  it('puts other income in Total live and in no projection', () => {
    const maple = basisRows(PROPS, TOTALS, BASIS).find((d) => d.name === 'Maple Plaza');
    expect(maple.otherLive).toBe(1800);
    expect(maple.totalLive).toBe(73800);          // 60,000 + 12,000 + 1,800
    expect(maple.totalProjected).toBe(158000);    // untouched by it
    // And the band carries it up as its own figure, so the foot can say where Total grew.
    expect(portfolioBasis(basisRows(PROPS, TOTALS, BASIS)).otherIncome).toBe(1800);
  });

  it('carries the unanswered surplus, which is in none of the three columns', () => {
    const maple = basisRows(PROPS, TOTALS, BASIS).find((d) => d.name === 'Maple Plaza');
    expect(maple.unapplied).toBe(1750);
    expect(maple.totalLive).toBe(73800);
  });

  // The band renders before the roll read lands, so a row has to be able to say "not yet"
  // rather than assert that nothing has come in all year.
  //
  // ⚠ INVERTED ON 2026-08-18 (3), DELIBERATELY. This used to assert that the projected side was
  // "already right, because it never needed the roll" — true when Revenue was the view. Now that
  // Revenue is the leases' own months, BOTH sides wait, and the row must still survive the wait:
  // a row dropped for having no figures yet would take the whole band off the page and put it
  // back a beat later.
  it('marks a row as still loading, and keeps it rather than dropping it', () => {
    const rows = basisRows(PROPS, TOTALS, null);
    expect(rows.every((r) => r.loading)).toBe(true);
    expect(rows.map((r) => r.name).sort()).toEqual(['Maple Plaza', 'Oak Center']);
    // Not the view's figure standing in — that would be one answer revised into another.
    expect(rows.find((r) => r.name === 'Maple Plaza').rentProjected).toBe(0);
    expect(basisRows(PROPS, TOTALS, BASIS).every((r) => r.loading)).toBe(false);
  });

  it('drops a property with nothing on any measure, and sorts by projected rent', () => {
    expect(basisRows(PROPS, TOTALS, BASIS).map((d) => d.name)).toEqual(['Oak Center', 'Maple Plaza']);
  });

  it('degrades to an empty list, never a throw', () => {
    expect(basisRows(null, null, null)).toEqual([]);
    expect(basisRows(PROPS, {}, BASIS)).toEqual([]);
  });
});

describe('portfolioBasis — the headline band', () => {
  const ROWS = basisRows(PROPS, TOTALS, BASIS);

  // ⚠ SUMMED FROM THE ROWS, never re-derived — otherwise the band and anything built from the
  // same rows could sit a cent, or a property, apart on one screen.
  it('ties to the rows it was built from', () => {
    const t = portfolioBasis(ROWS);
    expect(t.rent).toMatchObject({ projected: 421000, live: 150000 });
    expect(t.camTax).toMatchObject({ projected: 40000, live: 12000 });
    expect(t.total).toMatchObject({ projected: 461000, live: 163800 });
    // Total is Revenue + Expenses on the projected side, exactly.
    expect(t.total.projected).toBe(t.rent.projected + t.camTax.projected);
  });

  it('states the gap as a signed figure, so nobody has to subtract to find it', () => {
    const t = portfolioBasis(ROWS);
    expect(t.rent.delta).toBe(-271000);
    expect(t.camTax.delta).toBe(-28000);
    expect(t.total.delta).toBe(-297200);
  });

  // ⚠ NULL, NOT ZERO. "0% in" against a year that bills nothing is a fabricated accusation,
  // and the track drawn from it would be an empty bar shaped like a finding.
  it('has no share at all when nothing is projected', () => {
    const nothing = portfolioBasis([{ rentProjected: 0, rentLive: 0, camTaxProjected: 0, camTaxLive: 0, totalProjected: 0, totalLive: 0 }]);
    expect(nothing.rent.share).toBeNull();
    expect(nothing.total.share).toBeNull();
    expect(portfolioBasis(ROWS).rent.share).toBeCloseTo(150000 / 421000, 6);
  });

  it('degrades to zeros, never a throw', () => {
    expect(portfolioBasis([]).rent).toMatchObject({ projected: 0, live: 0, delta: 0, share: null });
    expect(portfolioBasis(null).total.projected).toBe(0);
  });
});

// The donut on each property card — who occupies the building, and what's empty.
describe('tenantMix', () => {
  const PERSHING = { id: 'p1', name: 'Pershing Plaza', building_sf: 13750 };
  const LEASES = [
    { id: 'a', tenant_name: 'D & D Dental', square_footage: 1077, base_rent: 31800.96 },
    { id: 'b', tenant_name: 'Five Points Wings', square_footage: 2100, base_rent: 41403 },
  ];

  it('sizes every tenant by SF, biggest first, with the vacant slice LAST', () => {
    const mix = tenantMix(PERSHING, LEASES);
    expect(mix.map((r) => r.name)).toEqual(['Five Points Wings', 'D & D Dental', 'Vacant space']);
    expect(mix.at(-1).kind).toBe('vacant');
  });

  it('leaves the vacant slice equal to building − leased, and the shares summing to 1', () => {
    const mix = tenantMix(PERSHING, LEASES);
    expect(mix.at(-1).sf).toBe(13750 - 1077 - 2100);
    expect(mix.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(1, 10);
  });

  it('divides by the BUILDING size, matching the rule the CAM/tax bills are split by', () => {
    // v_tenant_shares: coalesce(nullif(p.building_sf,0), pt.total_sf). A slice's
    // percentage has to be the same share the tenant is charged on, or the card and the
    // Financials breakdown would disagree.
    const dental = tenantMix(PERSHING, LEASES).find((r) => r.name === 'D & D Dental');
    expect(dental.pct).toBeCloseTo(1077 / 13750, 10);
  });

  it('falls back to leased SF with no building size — and draws no vacant slice', () => {
    // Nothing is KNOWN to be empty, so inventing a vacancy would be a lie. Same choice
    // occupancyByProperty makes.
    const mix = tenantMix({ id: 'p9', name: 'Elm Court', building_sf: 0 }, LEASES);
    expect(mix.some((r) => r.kind === 'vacant')).toBe(false);
    expect(mix.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(1, 10);
    expect(mix.find((r) => r.name === 'D & D Dental').pct).toBeCloseTo(1077 / 3177, 10);
  });

  it('carries $/SF base rent — the figure George asked to see on hover', () => {
    const wings = tenantMix(PERSHING, LEASES).find((r) => r.name === 'Five Points Wings');
    expect(wings.psf).toBeCloseTo(41403 / 2100, 10);
    expect(tenantMix(PERSHING, LEASES).at(-1).psf).toBeNull(); // vacant space has no rate
  });

  it('never returns Infinity for a lease with rent but no size — it takes no slice', () => {
    const mix = tenantMix(PERSHING, [...LEASES, { id: 'c', tenant_name: 'Ghost', square_footage: 0, base_rent: 9000 }]);
    expect(mix.some((r) => r.name === 'Ghost')).toBe(false);
    expect(mix.every((r) => r.psf == null || Number.isFinite(r.psf))).toBe(true);
  });

  it('counts an outdated (is_active false) tenant — they still occupy the space', () => {
    const mix = tenantMix(PERSHING, [...LEASES, { id: 'd', tenant_name: 'Held over', square_footage: 500, base_rent: 12000, is_active: false }]);
    expect(mix.some((r) => r.name === 'Held over')).toBe(true);
  });

  it('has nothing to divide when there is neither a building size nor a sized lease', () => {
    expect(tenantMix({ id: 'p0', building_sf: 0 }, [])).toEqual([]);
    expect(tenantMix(null, null)).toEqual([]);
  });

  it('is fully leased without a vacant slice when the tenants fill the building', () => {
    const mix = tenantMix({ id: 'p2', name: 'Full', building_sf: 3177 }, LEASES);
    expect(mix).toHaveLength(2);
    expect(mix.some((r) => r.kind === 'vacant')).toBe(false);
  });
});

describe('formatters', () => {
  it('kfmt abbreviates thousands and leaves small figures alone', () => {
    expect(kfmt(300000)).toBe('$300k');
    expect(kfmt(450)).toBe('$450');
    expect(kfmt(null)).toBe('');
    expect(kfmt(NaN)).toBe('');
  });

  it('shortName truncates only when it must', () => {
    expect(shortName('Oak Center')).toBe('Oak Center');
    expect(shortName('A very long property name indeed', 12)).toBe('A very long…');
  });
});
