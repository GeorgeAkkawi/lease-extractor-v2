// The two hover panels on the Overview's bar charts.
//
// They are tested directly because they CANNOT be tested through the page: recharts'
// ResponsiveContainer measures its parent, every element is 0×0 in jsdom, so no chart is
// ever drawn and no tooltip ever mounts. A render test of DashboardPage would go green
// with either of these throwing.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RolloverTip, PerformanceTip } from '../PortfolioCharts';
import { TenantMixTip } from '../PropertyMixDonut';

beforeEach(() => cleanup());

const rolloverPayload = (d) => [{ payload: d }];

describe('RolloverTip — which leases are in this bar', () => {
  const bucket = {
    key: '2028', label: '2028', kind: 'year', value: 110000, count: 2,
    leases: [
      { id: 'c', name: 'City Dental', rent: 90000, end: '2028-06-30' },
      { id: 'd', name: 'Dry Cleaners', rent: 20000, end: '2028-12-31' },
    ],
  };

  it('names every lease behind the bar, with its rent', () => {
    render(<RolloverTip active payload={rolloverPayload(bucket)} />);
    expect(screen.getByText('Ending in 2028')).toBeTruthy();
    expect(screen.getByText('City Dental')).toBeTruthy();
    expect(screen.getByText('Dry Cleaners')).toBeTruthy();
    expect(screen.getByText(/\$110,000/)).toBeTruthy();
    expect(screen.getByText(/2 leases/)).toBeTruthy();
  });

  it('says plainly what the "Now" bar is, rather than leaving a bare label', () => {
    render(<RolloverTip active payload={rolloverPayload({ ...bucket, key: 'now', label: 'Now', kind: 'now' })} />);
    expect(screen.getByText('Already past its end date')).toBeTruthy();
  });

  it('caps a long list rather than running off the screen', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `l${i}`, name: `Tenant ${i}`, rent: 1000, end: '2028-01-01' }));
    render(<RolloverTip active payload={rolloverPayload({ ...bucket, count: 9, leases: many })} />);
    expect(screen.getByText('+3 more')).toBeTruthy();
    expect(screen.queryByText('Tenant 8')).toBeNull();
  });

  it('renders nothing when inactive or empty — recharts calls it either way', () => {
    const { container } = render(<RolloverTip active={false} payload={rolloverPayload(bucket)} />);
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(<RolloverTip active payload={[]} />);
    expect(c2.firstChild).toBeNull();
  });
});

describe('PerformanceTip — two pairs, each in bar order', () => {
  const row = {
    name: 'Maple Plaza',
    'Projected revenue': 201000, 'Live revenue': 100300,
    'Projected expenses': 45000, 'Live expenses': 19000,
    projectedNet: 156000, liveNet: 81300,
    undatedExpenses: 0, unapplied: 0,
    taxes: 25000, cam: 18000, roof: 2000, noi: 99000,
  };

  // The bug this guards: recharts' Tooltip defaults to itemSorter:'name', which would sort
  // the four series ALPHABETICALLY and split BOTH pairs apart — the one thing a panel about
  // pairing must not do.
  it('keeps each live figure directly under the projected one it belongs to', () => {
    const { container } = render(<PerformanceTip active payload={[{ payload: row }]} label="Maple Plaza" />);
    const names = [...container.querySelectorAll('.chart-tip-name')].map((n) => n.textContent);
    expect(names.slice(0, 2)).toEqual(['Projected revenue', 'Live revenue']);
    expect(names.indexOf('Live revenue')).toBeLessThan(names.indexOf('Projected expenses'));
    expect(names.indexOf('Projected expenses')).toBeLessThan(names.indexOf('Live expenses'));
    expect(screen.getByText('$100,300.00')).toBeTruthy();
  });

  it('breaks the projected expenses into the actual taxes, CAM and roof they summed', () => {
    render(<PerformanceTip active payload={[{ payload: row }]} label="Maple Plaza" />);
    expect(screen.getByText('Property taxes')).toBeTruthy();
    expect(screen.getByText('CAM / maintenance')).toBeTruthy();
    expect(screen.getByText('Roof')).toBeTruthy();
    expect(screen.getByText('$25,000.00')).toBeTruthy();
    expect(screen.getByText('$18,000.00')).toBeTruthy();
  });

  it('omits a component that is zero, and says so when there are none at all', () => {
    render(<PerformanceTip active payload={[{ payload: { ...row, roof: 0 } }]} label="Maple Plaza" />);
    expect(screen.queryByText('Roof')).toBeNull();
    cleanup();
    render(<PerformanceTip active payload={[{ payload: { ...row, taxes: 0, cam: 0, roof: 0 } }]} label="Elm Court" />);
    expect(screen.getByText(/No expenses entered for this year/)).toBeTruthy();
  });

  // ⚠ BOTH BOTTOM LINES, AND THE ONE THEY ARE NOT. "What's left" counts the CAM & tax
  // tenants reimburse and NOI does not, so a panel printing only the first would leave a
  // landlord unable to reconcile it with the figure on his own property page.
  it('prints what is left on each basis, and quotes NOI as the different measure it is', () => {
    const { container } = render(<PerformanceTip active payload={[{ payload: row }]} label="Maple Plaza" year={2026} />);
    const names = [...container.querySelectorAll('.chart-tip-name')].map((n) => n.textContent);
    expect(names).toContain('What\u2019s left \u00b7 projected');
    expect(names).toContain('What\u2019s left \u00b7 live');
    expect(names[names.length - 1]).toBe('NOI (base rent only)');
    expect(screen.getByText('$99,000.00')).toBeTruthy();
  });

  // ⚠ THE TWO FIGURES THAT WOULD OTHERWISE MAKE THE BARS LIE. An undated cost has not been
  // shown to be unspent, and a surplus nobody has answered for is in NEITHER revenue figure
  // — a hover that showed the bars and not these would be most convincing when most wrong.
  it('names the undated costs and the unanswered surplus when there are any', () => {
    render(<PerformanceTip active payload={[{ payload: { ...row, undatedExpenses: 26000, unapplied: 1750 } }]} label="Maple Plaza" />);
    expect(screen.getByText(/\$26,000\.00 carries no payment date/)).toBeTruthy();
    expect(screen.getByText(/\+\$1,750\.00 awaiting your answer/)).toBeTruthy();
  });

  it('says neither when there is nothing to say — an aside about $0 is noise', () => {
    render(<PerformanceTip active payload={[{ payload: row }]} label="Maple Plaza" />);
    expect(screen.queryByText(/carries no payment date/)).toBeNull();
    expect(screen.queryByText(/awaiting your answer/)).toBeNull();
  });

  it('renders nothing when inactive', () => {
    const { container } = render(<PerformanceTip active={false} payload={[{ payload: row }]} label="Maple Plaza" />);
    expect(container.firstChild).toBeNull();
  });
});

// The property card's tenant-mix donut. Same jsdom caveat as the two above, and the same
// reason for testing it directly — this hover IS the feature George asked for ("mainly
// showing percentage of building and psf base rent when hovering"), so a page render test
// that never draws the chart would prove nothing about it.
describe('TenantMixTip — % of building and $/SF on hover', () => {
  const tenant = {
    id: 'a', name: 'D & D Dental', kind: 'tenant',
    sf: 1077, rent: 31800.96, pct: 1077 / 13750, psf: 31800.96 / 1077,
  };

  it('names the tenant with its size, its share of the building and its rent', () => {
    render(<TenantMixTip active payload={[{ payload: tenant }]} building={13750} />);
    expect(screen.getByText('D & D Dental')).toBeTruthy();
    expect(screen.getByText('1,077 SF · 7.8% of building')).toBeTruthy();
    expect(screen.getByText('Base rent')).toBeTruthy();
    expect(screen.getByText('$31,800.96/yr')).toBeTruthy();
    expect(screen.getByText(/29\.53 \/SF\/yr/)).toBeTruthy();
    expect(screen.getByText('Of 13,750 SF total.')).toBeTruthy();
  });

  it('marks the $/SF approximate when it cannot be multiplied back to the rent', () => {
    // $31,800.96 ÷ 1,077 = $29.5273…, and $29.53 × 1,077 is $31,803.81 — three dollars
    // above the figure printed directly above it (the format.js approx rule, 2026-07-24).
    render(<TenantMixTip active payload={[{ payload: tenant }]} building={13750} />);
    expect(screen.getByText(/≈ \$29\.53/)).toBeTruthy();
  });

  it('leaves an even rate exact, with no ≈', () => {
    const even = { ...tenant, name: 'Round Co', sf: 1000, rent: 30000, psf: 30 };
    render(<TenantMixTip active payload={[{ payload: even }]} building={13750} />);
    expect(screen.getByText('$30.00 /SF/yr')).toBeTruthy();
  });

  it('reads the vacant slice as unleased, with no rent line to invent', () => {
    const vacant = { id: '__vacant__', name: 'Vacant space', kind: 'vacant', sf: 882, rent: 0, pct: 882 / 13750, psf: null };
    render(<TenantMixTip active payload={[{ payload: vacant }]} building={13750} />);
    expect(screen.getByText('Vacant space')).toBeTruthy();
    expect(screen.getByText('882 SF · 6.4% of building')).toBeTruthy();
    expect(screen.getByText(/Unleased — nothing to collect/)).toBeTruthy();
    expect(screen.queryByText('Base rent')).toBeNull();
  });

  it('renders nothing when inactive', () => {
    const { container } = render(<TenantMixTip active={false} payload={[{ payload: tenant }]} building={13750} />);
    expect(container.firstChild).toBeNull();
  });
});
