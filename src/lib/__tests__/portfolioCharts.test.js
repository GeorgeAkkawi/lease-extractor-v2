// The Overview chart band draws from the SAME rows as the metric cards above it
// (v_property_totals for the selected year), so these shapers are the one place a
// disagreement could creep in. Each is pure, so each is pinned here.
import { describe, it, expect } from 'vitest';
import {
  revenueByProperty, occupancyByProperty, portfolioOccupancy, revenueExpensesNoi, rentRollover,
  tenantMix, hasCollectedBars, projectedVsLive, portfolioBasis, kfmt, shortName, DONUT_PALETTE,
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

describe('revenueByProperty', () => {
  it('ranks properties by rent roll, biggest first', () => {
    const out = revenueByProperty(PROPS, TOTALS);
    expect(out.map((d) => d.name)).toEqual(['Oak Center', 'Maple Plaza']);
    expect(out[0].value).toBe(300000);
  });

  it('drops a zero-revenue property — an invisible slice still costs a legend entry', () => {
    expect(revenueByProperty(PROPS, TOTALS).some((d) => d.name === 'Elm Court')).toBe(false);
  });

  it('sums to the rent roll the Overview card shows', () => {
    const total = revenueByProperty(PROPS, TOTALS).reduce((s, d) => s + d.value, 0);
    const cardTotal = Object.values(TOTALS).reduce((s, t) => s + Number(t.total_revenue), 0);
    expect(total).toBe(cardTotal);
  });

  it('degrades to an empty list, never a throw', () => {
    expect(revenueByProperty(null, null)).toEqual([]);
    expect(revenueByProperty(PROPS, {})).toEqual([]);
    expect(revenueByProperty([{ id: 'x' }], { x: { total_revenue: 5 } })[0].name).toBe('Untitled property');
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

describe('revenueExpensesNoi', () => {
  it('sums expenses from the three stored components, matching the History page', () => {
    const maple = revenueExpensesNoi(PROPS, TOTALS).find((d) => d.name === 'Maple Plaza');
    expect(maple).toMatchObject({ Revenue: 120000, Expenses: 45000, NOI: 75000 });
  });

  it('drops a property with nothing to show and sorts by revenue', () => {
    const out = revenueExpensesNoi(PROPS, TOTALS);
    expect(out.map((d) => d.name)).toEqual(['Oak Center', 'Maple Plaza']);
  });

  it('carries the ACTUAL taxes/CAM/roof it summed, so the hover can show its working', () => {
    // The bar is the landlord's entered expenses (expense_records), never the per-lease
    // CAM & tax ESTIMATES billed to tenants — a distinct, usually larger figure. Carrying
    // the three parts is what lets the tooltip prove which one is on screen.
    const maple = revenueExpensesNoi(PROPS, TOTALS).find((d) => d.name === 'Maple Plaza');
    expect(maple).toMatchObject({ taxes: 25000, cam: 18000, roof: 2000 });
    expect(maple.taxes + maple.cam + maple.roof).toBe(maple.Expenses);
  });

  it('adds NO collected field when there is nothing to add — byte-identical', () => {
    // The third argument is optional and must stay so: every existing caller (and the
    // panel's own three-bar mode) reads exactly the shape it always did.
    const before = revenueExpensesNoi(PROPS, TOTALS);
    expect(before[0].Collected).toBeUndefined();
    expect(before[0].hasCollected).toBeUndefined();
    expect(hasCollectedBars(before)).toBe(false);
  });
});

// The fourth bar: the rent that has actually arrived, beside the Revenue it belongs to.
describe('revenueExpensesNoi — rent collected so far', () => {
  const COLLECTED = {
    p1: { collected: 60000, billed: 120000 },
    p2: { collected: 0, billed: 0 },
  };

  it('adds the collected figure and leaves the three on-paper ones untouched', () => {
    const maple = revenueExpensesNoi(PROPS, TOTALS, COLLECTED).find((d) => d.name === 'Maple Plaza');
    expect(maple).toMatchObject({ Revenue: 120000, Expenses: 45000, NOI: 75000 });
    expect(maple).toMatchObject({ Collected: 60000, billedYtd: 120000, hasCollected: true });
  });

  it('draws the bar only when something has actually come in', () => {
    expect(hasCollectedBars(revenueExpensesNoi(PROPS, TOTALS, COLLECTED))).toBe(true);
    const nothing = { p1: { collected: 0, billed: 0 } };
    expect(hasCollectedBars(revenueExpensesNoi(PROPS, TOTALS, nothing))).toBe(false);
    // Billed but not paid is still nothing collected — an invoice raised is not money in.
    const billedOnly = { p1: { collected: 0, billed: 90000 } };
    expect(hasCollectedBars(revenueExpensesNoi(PROPS, TOTALS, billedOnly))).toBe(false);
  });

  // ⚠ THE ONE THAT MATTERS. Collected is ALL-IN — it carries the CAM & tax the tenants
  // reimburse — while Revenue is contract base rent only. So a well-collected property
  // legitimately reads ABOVE its Revenue bar. Silently capping it would make the chart lie
  // to protect a figure (v_property_totals, round 14) that is itself incomplete.
  it('lets Collected exceed Revenue without clamping — the two count different money', () => {
    const rich = { p1: { collected: 145000, billed: 145000 } };
    const maple = revenueExpensesNoi(PROPS, TOTALS, rich).find((d) => d.name === 'Maple Plaza');
    expect(maple.Collected).toBe(145000);
    expect(maple.Collected).toBeGreaterThan(maple.Revenue);
  });

  it('a property the read knows nothing about still renders, with zeros', () => {
    const maple = revenueExpensesNoi(PROPS, TOTALS, {}).find((d) => d.name === 'Maple Plaza');
    expect(maple).toMatchObject({ Collected: 0, billedYtd: 0, hasCollected: false });
    // …and its on-paper figures are untouched by the empty read.
    expect(maple).toMatchObject({ Revenue: 120000, Expenses: 45000, NOI: 75000 });
  });
});

// Projected vs live — the pair that replaced Revenue-beside-Collected (2026-08-18).
//
// ⚠ WHAT THE OLD SHAPER GOT WRONG AND THIS ONE MUST NOT. `revenueExpensesNoi` put
// base-rent-only Revenue next to all-in Collected, so the second could legitimately read
// above the first and the panel had to apologise for it in prose. Here BOTH halves of each
// pair count the same dollars — the projected side from the lease schedule, the live side
// from cash — so the gap between them is a fact about the year rather than about the
// measures.
describe('projectedVsLive', () => {
  const BASIS = {
    p1: { projectedRevenue: 201000, liveRevenue: 100300, unapplied: 1750, spentToDate: 19000, spentDated: 30000 },
    p2: { projectedRevenue: 360000, liveRevenue: 0, unapplied: 0, spentToDate: 70000, spentDated: 70000 },
  };

  it('pairs each measure with its own live reading, and derives both bottom lines', () => {
    const maple = projectedVsLive(PROPS, TOTALS, BASIS).find((d) => d.name === 'Maple Plaza');
    expect(maple).toMatchObject({
      'Projected revenue': 201000,
      'Live revenue': 100300,
      'Projected expenses': 45000,
      'Live expenses': 19000,
      projectedNet: 156000,
      liveNet: 81300,
    });
  });

  // ⚠ THE FIGURE THAT WOULD OTHERWISE TURN A MISSING DATE INTO A CHEAP YEAR. `paid_date` is
  // nullable and never backfilled (0074) — a kind entered as one flat total has no lines at
  // all — so the difference between the stored total and what carries a date is real money
  // sitting in Projected and in no Live figure. It has to be carried, or the panel reports
  // an underspend that never happened.
  it('names the costs carrying no payment date rather than dropping them', () => {
    const maple = projectedVsLive(PROPS, TOTALS, BASIS).find((d) => d.name === 'Maple Plaza');
    expect(maple.undatedExpenses).toBe(15000);  // 45,000 entered − 30,000 with a date
    // A property whose every cost is dated has nothing to say about it.
    const oak = projectedVsLive(PROPS, TOTALS, BASIS).find((d) => d.name === 'Oak Center');
    expect(oak.undatedExpenses).toBe(0);
  });

  it('never reports a negative undated figure when the lines outrun a stale total', () => {
    const over = { p1: { ...BASIS.p1, spentDated: 90000 } };
    const maple = projectedVsLive(PROPS, TOTALS, over).find((d) => d.name === 'Maple Plaza');
    expect(maple.undatedExpenses).toBe(0);
  });

  it('carries the unanswered surplus, which is in neither revenue figure', () => {
    const maple = projectedVsLive(PROPS, TOTALS, BASIS).find((d) => d.name === 'Maple Plaza');
    expect(maple.unapplied).toBe(1750);
    // …and it is genuinely OUT of live revenue, not folded in behind the scenes.
    expect(maple['Live revenue']).toBe(100300);
  });

  it('quotes NOI beside its own bottom lines, because they are different measures', () => {
    const maple = projectedVsLive(PROPS, TOTALS, BASIS).find((d) => d.name === 'Maple Plaza');
    expect(maple.noi).toBe(75000);
    // NOI counts base rent only; projectedNet counts the CAM & tax tenants reimburse too.
    expect(maple.projectedNet).toBeGreaterThan(maple.noi);
  });

  // The band renders before the roll read lands, so a row has to be able to say "not yet"
  // rather than assert that nothing has been collected all year.
  it('marks a row as still loading when no basis has arrived for it', () => {
    const rows = projectedVsLive(PROPS, TOTALS, null);
    expect(rows.every((r) => r.loading)).toBe(true);
    expect(rows.every((r) => r['Live revenue'] === 0)).toBe(true);
    expect(projectedVsLive(PROPS, TOTALS, BASIS).every((r) => r.loading)).toBe(false);
  });

  it('drops a property with nothing on any of the four measures, and sorts by projection', () => {
    const out = projectedVsLive(PROPS, TOTALS, BASIS);
    expect(out.map((d) => d.name)).toEqual(['Oak Center', 'Maple Plaza']);
  });

  it('degrades to an empty list, never a throw', () => {
    expect(projectedVsLive(null, null, null)).toEqual([]);
    expect(projectedVsLive(PROPS, {}, BASIS)).toEqual([]);
  });
});

describe('portfolioBasis — the headline band', () => {
  const ROWS = projectedVsLive(PROPS, TOTALS, {
    p1: { projectedRevenue: 201000, liveRevenue: 100300, unapplied: 1750, spentToDate: 19000, spentDated: 30000 },
    p2: { projectedRevenue: 360000, liveRevenue: 90000, unapplied: 0, spentToDate: 70000, spentDated: 70000 },
  });

  // ⚠ SUMMED FROM THE ROWS THE BARS ARE DRAWN FROM, never re-derived — otherwise the band
  // and the panel beneath it could sit a cent (or a property) apart on the same screen.
  it('ties to the sum of the bars beneath it', () => {
    const t = portfolioBasis(ROWS);
    expect(t.revenue.projected).toBe(561000);
    expect(t.revenue.live).toBe(190300);
    expect(t.expenses.projected).toBe(115000);
    expect(t.expenses.live).toBe(89000);
    expect(t.net.projected).toBe(446000);
    expect(t.net.live).toBe(101300);
  });

  it('states the gap as a signed figure, so nobody has to subtract to find it', () => {
    const t = portfolioBasis(ROWS);
    expect(t.revenue.delta).toBe(-370700);
    expect(t.expenses.delta).toBe(-26000);
    expect(t.net.delta).toBe(-344700);
  });

  it('carries both caveats up to the headline, summed across the portfolio', () => {
    const t = portfolioBasis(ROWS);
    expect(t.undatedExpenses).toBe(15000);
    expect(t.unapplied).toBe(1750);
  });

  // ⚠ NULL, NOT ZERO. "0% in" against a year that bills nothing is a fabricated accusation,
  // and the track drawn from it would be an empty bar shaped like a finding.
  it('has no share at all when nothing is projected', () => {
    const nothing = portfolioBasis([{ 'Projected revenue': 0, 'Live revenue': 0, 'Projected expenses': 0, 'Live expenses': 0 }]);
    expect(nothing.revenue.share).toBeNull();
    expect(nothing.expenses.share).toBeNull();
    expect(portfolioBasis(ROWS).revenue.share).toBeCloseTo(190300 / 561000, 6);
  });

  it('degrades to zeros, never a throw', () => {
    const t = portfolioBasis([]);
    expect(t.revenue).toMatchObject({ projected: 0, live: 0, delta: 0, share: null });
    expect(portfolioBasis(null).net.projected).toBe(0);
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
