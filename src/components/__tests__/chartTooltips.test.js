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

describe('PerformanceTip — Revenue · Expenses · NOI, in that order', () => {
  const row = { name: 'Maple Plaza', Revenue: 120000, Expenses: 45000, NOI: 75000, taxes: 25000, cam: 18000, roof: 2000 };

  it('lists the three series in declared order, not alphabetically', () => {
    // The bug this replaces: recharts' Tooltip defaults to itemSorter:'name', which
    // rendered Expenses · NOI · Revenue — reading as though NOI came out of expenses.
    const { container } = render(<PerformanceTip active payload={[{ payload: row }]} label="Maple Plaza" />);
    const names = [...container.querySelectorAll('.chart-tip-name')].map((n) => n.textContent);
    expect(names.slice(0, 2)).toEqual(['Revenue', 'Expenses']);
    expect(names[names.length - 1]).toBe('NOI');
  });

  it('breaks the Expenses figure into the actual taxes, CAM and roof it summed', () => {
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
    render(<PerformanceTip active payload={[{ payload: { name: 'Elm Court', Revenue: 9000, Expenses: 0, NOI: 9000, taxes: 0, cam: 0, roof: 0 } }]} label="Elm Court" />);
    expect(screen.getByText(/No expenses entered for this year/)).toBeTruthy();
  });

  it('renders nothing when inactive', () => {
    const { container } = render(<PerformanceTip active={false} payload={[{ payload: row }]} label="Maple Plaza" />);
    expect(container.firstChild).toBeNull();
  });

  // The collected bar's figure is the one that needs context: it is not a share of the
  // Revenue bar it stands beside, so the hover has to say what it IS a share of and why
  // it can read higher.
  describe('with the rent collected so far', () => {
    const withCollected = { ...row, Collected: 60000, billedYtd: 120000 };

    it('puts Collected directly under Revenue, ahead of Expenses and NOI', () => {
      const { container } = render(<PerformanceTip active payload={[{ payload: withCollected }]} label="Maple Plaza" year={2026} />);
      const names = [...container.querySelectorAll('.chart-tip-name')].map((n) => n.textContent);
      expect(names.indexOf('Revenue')).toBeLessThan(names.indexOf('Collected so far'));
      expect(names.indexOf('Collected so far')).toBeLessThan(names.indexOf('Expenses'));
      expect(names.indexOf('Collected so far')).toBeLessThan(names.indexOf('NOI'));
      expect(screen.getByText('$60,000.00')).toBeTruthy();
    });

    // ⚠ The assertion this block exists for. "$60,000" against a "$120,000" Revenue bar
    // invites exactly the wrong reading — 50% collected — when the two count different
    // money. Both halves of the correction have to be on the panel.
    it('names what the figure is a share OF, and says it is all-in', () => {
      render(<PerformanceTip active payload={[{ payload: withCollected }]} label="Maple Plaza" year={2026} />);
      expect(screen.getByText('of $120,000.00 billed')).toBeTruthy();
      expect(screen.getByText(/incl\. reimbursed CAM & tax/)).toBeTruthy();
    });

    it('says so plainly when nothing has been billed yet', () => {
      render(<PerformanceTip active payload={[{ payload: { ...withCollected, Collected: 0, billedYtd: 0 } }]} label="Maple Plaza" year={2026} />);
      expect(screen.getByText('nothing billed yet this year')).toBeTruthy();
      // …and doesn't explain an all-in figure that is zero.
      expect(screen.queryByText(/incl\. reimbursed/)).toBeNull();
    });

    it('draws nothing extra when the row carries no collected read', () => {
      const { container } = render(<PerformanceTip active payload={[{ payload: row }]} label="Maple Plaza" year={2026} />);
      const names = [...container.querySelectorAll('.chart-tip-name')].map((n) => n.textContent);
      expect(names).not.toContain('Collected so far');
      expect(screen.queryByText(/billed/)).toBeNull();
    });
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
