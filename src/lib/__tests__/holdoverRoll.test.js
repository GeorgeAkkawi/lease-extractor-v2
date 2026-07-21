// Holdover sync: an outdated (is_active = false) tenant must stay on the property
// rent roll and keep billing until the landlord removes it. Runs against the demo
// mock (DEMO mode forced by the vite test env), which mirrors v_tenant_shares after
// migration 0058 — all leases, is_active/lease_termination_date/premises_address
// carried through. Own file so its updateLease() mutation doesn't leak into others.
import { describe, it, expect } from 'vitest';
import { updateLease, getTenantShares, getPropertyMonthlyRoll, markMonthPaidAllTenants } from '../api';
import { currentYear } from '../format';

const Y = currentYear();
// lease-2 (City Dental, prop-1) — flip it outdated, as backfill would for a lapsed lease.

describe('an outdated lease stays on the rent roll', () => {
  it('getTenantShares still returns the is_active=false lease with the new fields', async () => {
    await updateLease('lease-2', { is_active: false });
    const shares = await getTenantShares('prop-1', Y);
    const s = shares.find((r) => r.lease_id === 'lease-2');
    expect(s).toBeTruthy(); // would be DROPPED before 0058 (view filtered is_active)
    expect(s.is_active).toBe(false);
    expect(s.lease_termination_date).toBe('2026-05-31');
    expect(s.premises_address).toBe('100 Maple St — Suite 30');
  });

  it('getPropertyMonthlyRoll carries is_active + lease_termination_date onto the roll row', async () => {
    const roll = await getPropertyMonthlyRoll('prop-1', Y);
    const r = roll.find((x) => x.lease_id === 'lease-2');
    expect(r).toBeTruthy();
    expect(r.is_active).toBe(false);
    expect(r.lease_termination_date).toBe('2026-05-31');
    expect(r.monthly).toBeGreaterThan(0); // still owes rent — held over
  });

  it('bulk "mark all paid" includes the held-over tenant', async () => {
    const res = await markMonthPaidAllTenants('prop-1', Y, 6);
    // both active Bright Coffee and held-over City Dental are billable that month
    expect(res.total).toBeGreaterThanOrEqual(2);
    expect(res.paid).toBeGreaterThanOrEqual(1);
  });
});
