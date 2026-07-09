// Rent-roll Excel rows: holdover/outdated tenants must stay on the roll (flagged),
// and a "Vacant space" row must appear when the building has unleased SF. Guards the
// exact bug George hit — the Excel export used to filter is_active !== false (dropping
// held-over tenants) and never rendered vacancy. rentRollRows is the pure row builder
// behind the styled worksheet, so this needs no ExcelJS / browser.
import { describe, it, expect } from 'vitest';
import { rentRollRows } from '../rentRollExcel';

// Fixed "now" so past-term detection is deterministic.
const NOW = new Date('2026-07-09T12:00:00');
const prop = { id: 'p1', name: 'Pershing Plaza', building_sf: 10000 };

// 2 healthy tenants + 2 held over: one flagged is_active=false (needs extension),
// one simply past its term end. Leased SF = 2000+3000+1000+500 = 6500 → vacant 3500.
const leases = [
  { id: 'a', tenant_name: 'Alpha Retail', property_id: 'p1', square_footage: 2000, base_rent: 60000, lease_start: '2022-01-01', lease_termination_date: '2027-12-31' },
  { id: 'b', tenant_name: 'Bravo Cafe', property_id: 'p1', square_footage: 3000, base_rent: 90000, lease_start: '2021-06-01', lease_termination_date: '2028-05-31' },
  { id: 'c', tenant_name: 'City Dental', property_id: 'p1', square_footage: 1000, base_rent: 30000, lease_start: '2020-01-01', lease_termination_date: '2026-05-31', is_active: false },
  { id: 'd', tenant_name: 'Delta Barber', property_id: 'p1', square_footage: 500, base_rent: 18000, lease_start: '2019-01-01', lease_termination_date: '2025-05-31' },
];

describe('rentRollRows — holdover + vacancy', () => {
  const rows = rentRollRows(prop, leases, NOW);

  it('keeps EVERY lease (holdover ones are not dropped)', () => {
    const tenants = rows.filter((r) => r.kind !== 'vacant').map((r) => r.tenant);
    expect(tenants).toEqual(['Alpha Retail', 'Bravo Cafe', 'City Dental', 'Delta Barber']);
  });

  it('flags the is_active=false lease as holdover · needs extension', () => {
    const c = rows.find((r) => r.tenant === 'City Dental');
    expect(c.kind).toBe('holdover');
    expect(c.inTerm).toBe('Holdover');
    expect(c.notes).toContain('Expired — held over');
    expect(c.notes).toContain('needs extension');
    expect(c.annual).toBe(30000); // still collecting rent
  });

  it('flags a past-term (but active) lease as holdover without "needs extension"', () => {
    const d = rows.find((r) => r.tenant === 'Delta Barber');
    expect(d.kind).toBe('holdover');
    expect(d.notes).toContain('Expired — held over');
    expect(d.notes).not.toContain('needs extension');
  });

  it('leaves an in-term lease as a normal tenant row', () => {
    const a = rows.find((r) => r.tenant === 'Alpha Retail');
    expect(a.kind).toBe('tenant');
    expect(a.inTerm).toBe('Yes');
    expect(a.category).toBe('');
  });

  it('appends a Vacant space row = building − ALL leases, last', () => {
    const last = rows[rows.length - 1];
    expect(last.kind).toBe('vacant');
    expect(last.tenant).toBe('Vacant space');
    expect(last.sf).toBe(3500); // 10000 − 6500
    expect(last.pctNrsf).toBeCloseTo(0.35, 5);
    expect(last.annual).toBeNull(); // nothing to collect
  });

  it('shows no vacancy row when the building is fully leased', () => {
    const full = rentRollRows({ ...prop, building_sf: 6500 }, leases, NOW);
    expect(full.some((r) => r.kind === 'vacant')).toBe(false);
  });

  it('shows no vacancy row when no building size is set', () => {
    const noSize = rentRollRows({ ...prop, building_sf: null }, leases, NOW);
    expect(noSize.some((r) => r.kind === 'vacant')).toBe(false);
    expect(noSize).toHaveLength(4); // just the tenants
  });

  it('does not mutate the input leases array', () => {
    const snapshot = leases.map((l) => l.id);
    rentRollRows(prop, leases, NOW);
    expect(leases.map((l) => l.id)).toEqual(snapshot);
  });
});
