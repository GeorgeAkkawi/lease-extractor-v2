// The expiring-soonest tenant sort. Pure JS — no network, no AI. Orders a
// property's tenants soonest term-end first (no-end-date leases last, ties by
// tenant name) — used everywhere the tenant list is shown.
import { byTermEnd } from '../leaseSearch';

const L = (over = {}) => ({
  id: 'x',
  tenant_name: 'Tenant',
  lease_termination_date: null,
  ...over,
});

describe('byTermEnd — soonest term end first', () => {
  test('dated ascending, no-date leases last, no-date ties alphabetical', () => {
    const leases = [
      L({ id: 'z', tenant_name: 'Zeta', lease_termination_date: null }),
      L({ id: 'far', tenant_name: 'Ricki', lease_termination_date: '2031-05-01' }),
      L({ id: 'soon', tenant_name: 'Vibhakar', lease_termination_date: '2026-09-30' }),
      L({ id: 'a', tenant_name: 'Ace', lease_termination_date: null }),
    ];
    expect([...leases].sort(byTermEnd).map((l) => l.id)).toEqual(['soon', 'far', 'a', 'z']);
  });

  test('same end date falls back to tenant name', () => {
    const leases = [
      L({ id: 'b', tenant_name: 'Bravo', lease_termination_date: '2027-01-31' }),
      L({ id: 'a', tenant_name: 'Alpha', lease_termination_date: '2027-01-31' }),
    ];
    expect([...leases].sort(byTermEnd).map((l) => l.id)).toEqual(['a', 'b']);
  });
});
