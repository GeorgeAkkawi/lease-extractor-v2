// The two hover panels on the Overview's bar charts.
//
// They are tested directly because they CANNOT be tested through the page: recharts'
// ResponsiveContainer measures its parent, every element is 0×0 in jsdom, so no chart is
// ever drawn and no tooltip ever mounts. A render test of DashboardPage would go green
// with either of these throwing.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RolloverTip, PerformanceTip } from '../PortfolioCharts';

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
});
