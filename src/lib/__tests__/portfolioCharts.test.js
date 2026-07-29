// The Overview chart band draws from the SAME rows as the metric cards above it
// (v_property_totals for the selected year), so these shapers are the one place a
// disagreement could creep in. Each is pure, so each is pinned here.
import { describe, it, expect } from 'vitest';
import {
  revenueByProperty, occupancyByProperty, portfolioOccupancy, revenueExpensesNoi, rentRollover,
  kfmt, shortName, DONUT_PALETTE,
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
    { id: 'a', is_active: true, base_rent: 60000, lease_termination_date: '2026-11-30' }, // this year
    { id: 'b', is_active: true, base_rent: 40000, lease_termination_date: '2026-03-31' }, // this year, already past
    { id: 'c', is_active: true, base_rent: 90000, lease_termination_date: '2028-06-30' },
    { id: 'd', is_active: true, base_rent: 20000, lease_termination_date: '2028-12-31' },
    { id: 'e', is_active: true, base_rent: 10000, lease_termination_date: '2040-01-01' }, // beyond the window
    { id: 'f', is_active: true, base_rent: 15000, lease_termination_date: null },          // no term end
    { id: 'g', is_active: false, base_rent: 99000, lease_termination_date: '2028-01-01' }, // parked
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
