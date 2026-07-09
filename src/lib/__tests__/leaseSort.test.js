// Leases-page sorting: every mode ascending/descending, numeric-aware address
// sort, nulls/blanks always last (both directions), and custom drag order with
// unknown ids appended in the default term-end order.
import { describe, it, expect } from 'vitest';
import { sortLeases } from '../leaseSort';

// Four leases with deliberately varied fields. ids kept short for order assertions.
const A = { id: 'a', tenant_name: 'Alpha', base_rent: 60000, square_footage: 2000, lease_termination_date: '2027-05-31', premises_address: '112 Main St' };
const B = { id: 'b', tenant_name: 'Bravo', base_rent: 84000, square_footage: 3000, lease_termination_date: '2026-05-31', premises_address: '9 Main St' };
const C = { id: 'c', tenant_name: 'Charlie', base_rent: 30000, square_footage: 1000, lease_termination_date: null, premises_address: '' };
const D = { id: 'd', tenant_name: 'Delta', base_rent: null, square_footage: 0, lease_termination_date: '2025-01-01', premises_address: '50 Oak Ave' };
const ALL = [A, B, C, D];
const ids = (list) => list.map((l) => l.id);

// per-lease Total = base + CAM/tax + roof (what the page passes in)
const totals = {
  a: { total: 72000 },
  b: { total: 96000 },
  c: { total: 33000 },
  d: { total: null }, // no expense data → total blank
};

describe('term_end sort', () => {
  it('ascending: soonest first, no-end-date last', () => {
    expect(ids(sortLeases(ALL, { mode: 'term_end', dir: 'asc' }))).toEqual(['d', 'b', 'a', 'c']);
  });
  it('descending: latest first, no-end-date still last', () => {
    expect(ids(sortLeases(ALL, { mode: 'term_end', dir: 'desc' }))).toEqual(['a', 'b', 'd', 'c']);
  });
});

describe('base_rent sort', () => {
  it('ascending, null base rent last', () => {
    expect(ids(sortLeases(ALL, { mode: 'base_rent', dir: 'asc' }))).toEqual(['c', 'a', 'b', 'd']);
  });
  it('descending, null base rent STILL last', () => {
    expect(ids(sortLeases(ALL, { mode: 'base_rent', dir: 'desc' }))).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('psf sort (base_rent / square_footage)', () => {
  // a: 30, b: 28, c: 30, d: null (sqft 0). a & c tie at 30 → tie-break by name.
  it('ascending, zero-sqft last', () => {
    expect(ids(sortLeases(ALL, { mode: 'psf', dir: 'asc' }))).toEqual(['b', 'a', 'c', 'd']);
  });
  it('descending keeps the zero-sqft row last', () => {
    expect(ids(sortLeases(ALL, { mode: 'psf', dir: 'desc' }))).toEqual(['a', 'c', 'b', 'd']);
  });
});

describe('total_rent sort (from the totals map)', () => {
  it('ascending, missing total last', () => {
    expect(ids(sortLeases(ALL, { mode: 'total_rent', dir: 'asc', totals }))).toEqual(['c', 'a', 'b', 'd']);
  });
  it('descending, missing total still last', () => {
    expect(ids(sortLeases(ALL, { mode: 'total_rent', dir: 'desc', totals }))).toEqual(['b', 'a', 'c', 'd']);
  });
});

describe('address sort', () => {
  it('numeric-aware: "9 Main" sorts before "112 Main"; empty address last', () => {
    // B "9 Main", A "112 Main", D "50 Oak", C "" → 9 < 50 < 112, blank last
    expect(ids(sortLeases(ALL, { mode: 'address', dir: 'asc' }))).toEqual(['b', 'd', 'a', 'c']);
  });
  it('descending keeps blank address last', () => {
    expect(ids(sortLeases(ALL, { mode: 'address', dir: 'desc' }))).toEqual(['a', 'd', 'b', 'c']);
  });
  it('is case-insensitive', () => {
    const lower = { id: 'x', tenant_name: 'x', premises_address: 'apple st' };
    const upper = { id: 'y', tenant_name: 'y', premises_address: 'Banana Rd' };
    expect(ids(sortLeases([upper, lower], { mode: 'address', dir: 'asc' }))).toEqual(['x', 'y']);
  });
});

describe('custom order', () => {
  it('orders by the saved id array', () => {
    expect(ids(sortLeases(ALL, { mode: 'custom', manualOrder: ['c', 'a', 'd', 'b'] }))).toEqual(['c', 'a', 'd', 'b']);
  });
  it('appends ids not in the saved order, in term-end order', () => {
    // only b,c saved → a,d appended by term-end (d 2025 before a 2027)
    expect(ids(sortLeases(ALL, { mode: 'custom', manualOrder: ['b', 'c'] }))).toEqual(['b', 'c', 'd', 'a']);
  });
  it('custom order ignores direction', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(ids(sortLeases(ALL, { mode: 'custom', dir: 'desc', manualOrder: order }))).toEqual(order);
  });
});

describe('purity + edge cases', () => {
  it('does not mutate the input array', () => {
    const input = [...ALL];
    const snapshot = ids(input);
    sortLeases(input, { mode: 'base_rent', dir: 'desc' });
    expect(ids(input)).toEqual(snapshot);
  });
  it('empty / missing options are safe', () => {
    expect(sortLeases([])).toEqual([]);
    expect(ids(sortLeases(ALL))).toEqual(['d', 'b', 'a', 'c']); // defaults to term_end asc
  });
});
