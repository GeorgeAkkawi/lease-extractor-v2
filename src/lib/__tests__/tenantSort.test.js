// sortTenantRows — the shared sort for the Rent Ledger + the per-tenant breakdown.
// George's four fields (name / size / rent / suite), nulls/blanks always last both
// directions, numeric suite compare, and a `pick` accessor so both row shapes sort.
import { describe, it, expect } from 'vitest';
import { sortTenantRows, TENANT_SORTS } from '../leaseSort';

const rows = [
  { tenant_name: 'City Dental', square_footage: 1850, base_rent: 84000, premises_address: 'Suite 10' },
  { tenant_name: 'Bright Coffee', square_footage: 2000, base_rent: 60000, premises_address: 'Suite 2' },
  { tenant_name: 'Anchor Books', square_footage: null, base_rent: null, premises_address: '' },
];
const names = (list) => list.map((r) => r.tenant_name);

describe('sortTenantRows', () => {
  it('offers George’s four fields', () => {
    expect(TENANT_SORTS.map((s) => s.key)).toEqual(['tenant_name', 'square_footage', 'base_rent', 'premises_address']);
  });

  it('sorts by tenant name, both directions', () => {
    expect(names(sortTenantRows(rows, { mode: 'tenant_name', dir: 'asc' }))).toEqual(['Anchor Books', 'Bright Coffee', 'City Dental']);
    expect(names(sortTenantRows(rows, { mode: 'tenant_name', dir: 'desc' }))).toEqual(['City Dental', 'Bright Coffee', 'Anchor Books']);
  });

  it('sorts by size, nulls last in BOTH directions', () => {
    expect(names(sortTenantRows(rows, { mode: 'square_footage', dir: 'asc' }))).toEqual(['City Dental', 'Bright Coffee', 'Anchor Books']);
    // desc flips the sized rows but the null (Anchor) still sinks to the bottom.
    expect(names(sortTenantRows(rows, { mode: 'square_footage', dir: 'desc' }))).toEqual(['Bright Coffee', 'City Dental', 'Anchor Books']);
  });

  it('sorts by base rent', () => {
    expect(names(sortTenantRows(rows, { mode: 'base_rent', dir: 'asc' }))).toEqual(['Bright Coffee', 'City Dental', 'Anchor Books']);
    expect(names(sortTenantRows(rows, { mode: 'base_rent', dir: 'desc' }))).toEqual(['City Dental', 'Bright Coffee', 'Anchor Books']);
  });

  it('sorts suites NUMERICALLY, blanks last ("Suite 2" before "Suite 10")', () => {
    expect(names(sortTenantRows(rows, { mode: 'premises_address', dir: 'asc' }))).toEqual(['Bright Coffee', 'City Dental', 'Anchor Books']);
    expect(names(sortTenantRows(rows, { mode: 'premises_address', dir: 'desc' }))).toEqual(['City Dental', 'Bright Coffee', 'Anchor Books']);
  });

  it('defaults to name asc and never mutates the input', () => {
    const before = names(rows);
    const out = sortTenantRows(rows, {});
    expect(names(out)).toEqual(['Anchor Books', 'Bright Coffee', 'City Dental']);
    expect(names(rows)).toEqual(before); // untouched
  });

  it('uses the pick accessor for a wrapped row shape', () => {
    const wrapped = rows.map((r) => ({ share: r, extra: 1 }));
    const out = sortTenantRows(wrapped, { mode: 'tenant_name', dir: 'asc', pick: (w) => w.share });
    expect(out.map((w) => w.share.tenant_name)).toEqual(['Anchor Books', 'Bright Coffee', 'City Dental']);
  });

  it('breaks numeric ties by tenant name', () => {
    const tie = [
      { tenant_name: 'Zed', square_footage: 1000 },
      { tenant_name: 'Abe', square_footage: 1000 },
    ];
    expect(names(sortTenantRows(tie, { mode: 'square_footage', dir: 'asc' }))).toEqual(['Abe', 'Zed']);
  });
});
