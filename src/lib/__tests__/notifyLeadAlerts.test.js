// Custom notification lead times + the new unpaid-rent alert. Pure buildAlerts — no
// backend. Confirms defaults are byte-identical to the old hard-coded horizons, a
// custom lead widens/narrows a type's window, the per-lease lease-end override wins,
// and the ledger-gated behind-on-rent alert renders from a precomputed list.
import { describe, test, expect } from 'vitest';
import { buildAlerts } from '../alerts';

const NOW = new Date('2026-01-15T12:00:00');
const EMPTY = {
  leases: [], escalations: [], renewals: [], properties: [], insurance: [],
  contracts: [], abatements: [], insuranceRequests: [], annualReports: [], corporations: [], unpaidRent: [],
};

const prop = { id: 'p1', name: 'Plaza', corporation_id: 'c1' };
const leaseEndingIn = (iso) => ({ id: 'l1', tenant_name: 'Acme', property_id: 'p1', lease_termination_date: iso, is_active: true });

describe('lease-ending horizon honors the custom lead', () => {
  test('default (183d): a term 200 days out is off the radar', () => {
    const out = buildAlerts({ ...EMPTY, leases: [leaseEndingIn('2026-08-03')], properties: [prop] }, undefined, NOW);
    expect(out.find((a) => a.focus === 'termination')).toBeUndefined();
  });
  test('custom lease_end = 1 year surfaces the same 200-days-out term (info tone)', () => {
    // A pending renewal on file → not the red "no renewal" case, so the far-out term
    // reads calm (info), proving the horizon widened (default 183 would hide it entirely).
    const out = buildAlerts(
      { ...EMPTY, leases: [leaseEndingIn('2026-08-03')], renewals: [{ id: 'r1', lease_id: 'l1', status: 'pending', notice_by_date: null }], properties: [prop] },
      undefined, NOW, { leadDays: { lease_end: 365 } },
    );
    const t = out.find((a) => a.focus === 'termination');
    expect(t).toBeTruthy();
    expect(t.tone).toBe('info');
  });
  test('a per-lease override beats the general setting', () => {
    const lease = { ...leaseEndingIn('2026-08-03'), notify_lease_end_days: 365 };
    // General lease_end left at default 183 → without the override this term wouldn't show.
    const out = buildAlerts({ ...EMPTY, leases: [lease], properties: [prop] }, undefined, NOW);
    expect(out.find((a) => a.focus === 'termination')).toBeTruthy();
  });
});

describe('defaults are unchanged (byte-identical horizons)', () => {
  test('a term 100 days out still shows at the default lead', () => {
    const out = buildAlerts({ ...EMPTY, leases: [leaseEndingIn('2026-04-25')], properties: [prop] }, undefined, NOW);
    expect(out.find((a) => a.focus === 'termination')).toBeTruthy();
  });
  test('an annual report 45 days out stays hidden at the default 31-day lead', () => {
    const out = buildAlerts(
      { ...EMPTY, annualReports: [{ corporation_id: 'c1', due_date: '2026-03-01' }], corporations: [{ id: 'c1', name: 'Acme LLC' }] },
      undefined, NOW,
    );
    expect(out.find((a) => a.focus === 'annual_report')).toBeUndefined();
  });
  test('…but a 60-day annual-report lead surfaces it', () => {
    const out = buildAlerts(
      { ...EMPTY, annualReports: [{ corporation_id: 'c1', due_date: '2026-03-01' }], corporations: [{ id: 'c1', name: 'Acme LLC' }] },
      undefined, NOW, { leadDays: { annual_report: 60 } },
    );
    expect(out.find((a) => a.focus === 'annual_report')).toBeTruthy();
  });
});

describe('unpaid-rent (tenant behind on rent) alert', () => {
  const behind = (monthsBehind, amountBehind = 0) => ({
    lease_id: 'l1', property_id: 'p1', tenant_name: 'Acme', monthsBehind, amountBehind, year: 2026,
  });
  test('1 month behind → a warn alert keyed by lease, clickable to the property', () => {
    const out = buildAlerts({ ...EMPTY, properties: [prop], unpaidRent: [behind(1, 3300)] }, undefined, NOW);
    const a = out.find((x) => x.focus === 'unpaid_rent');
    expect(a).toBeTruthy();
    expect(a.tone).toBe('warn');
    expect(a.corporation_id).toBe('c1');
    expect(a.property_id).toBe('p1');
  });
  test('2+ months behind → danger', () => {
    const out = buildAlerts({ ...EMPTY, properties: [prop], unpaidRent: [behind(3, 9900)] }, undefined, NOW);
    expect(out.find((x) => x.focus === 'unpaid_rent').tone).toBe('danger');
  });
  test('0 months behind → no alert', () => {
    const out = buildAlerts({ ...EMPTY, properties: [prop], unpaidRent: [behind(0)] }, undefined, NOW);
    expect(out.find((x) => x.focus === 'unpaid_rent')).toBeUndefined();
  });
  test('Rent Ledger module off → the alert is gone', () => {
    const out = buildAlerts(
      { ...EMPTY, properties: [prop], unpaidRent: [behind(2, 6600)] },
      undefined, NOW, { features: ['insurance'] }, // ledger not in the enabled set
    );
    expect(out.find((x) => x.focus === 'unpaid_rent')).toBeUndefined();
  });
});
