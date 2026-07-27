// Custom notification lead times + the bank-statement reminder. Pure buildAlerts — no
// backend. Confirms defaults are byte-identical to the old hard-coded horizons, a
// custom lead widens/narrows a type's window, the per-lease lease-end override wins,
// and the ledger-gated statement reminder renders ONE calm alert per property.
import { describe, test, expect } from 'vitest';
import { buildAlerts, alertKey } from '../alerts';

const NOW = new Date('2026-01-15T12:00:00');
const EMPTY = {
  leases: [], escalations: [], renewals: [], properties: [], insurance: [],
  contracts: [], abatements: [], insuranceRequests: [], annualReports: [], corporations: [], unloggedMonths: [],
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

describe('bank-statement reminder (replaces the per-tenant "behind on rent" alert)', () => {
  const unlogged = (months, property_id = 'p1') => ({ property_id, year: 2026, months });
  const prop2 = { id: 'p2', name: 'Oak Center', corporation_id: 'c1' };

  test('one unlogged month → ONE calm info alert naming the month and the property', () => {
    const out = buildAlerts({ ...EMPTY, properties: [prop], unloggedMonths: [unlogged([6])] }, undefined, NOW);
    const a = out.find((x) => x.focus === 'statement_reminder');
    expect(a).toBeTruthy();
    expect(a.tone).toBe('info');
    expect(a.title).toBe('Import your June statement — Plaza');
    expect(a.detail).toBe('Nothing recorded for June — import the bank statement to log payments and expenses.');
    expect(a.corporation_id).toBe('c1');
    expect(a.property_id).toBe('p1');
  });

  test('nothing anywhere says a tenant is "behind" or "late"', () => {
    const out = buildAlerts({ ...EMPTY, properties: [prop], unloggedMonths: [unlogged([1, 2, 6])] }, undefined, NOW);
    const a = out.find((x) => x.focus === 'statement_reminder');
    expect(`${a.title} ${a.detail} ${a.bucketLabel}`).not.toMatch(/behind|late|overdue|unpaid/i);
  });

  test('several unlogged months stay ONE alert per property, not one per month', () => {
    const out = buildAlerts({ ...EMPTY, properties: [prop], unloggedMonths: [unlogged([1, 2, 6])] }, undefined, NOW);
    const all = out.filter((x) => x.focus === 'statement_reminder');
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('Import your bank statements — Plaza');
    expect(all[0].detail).toContain('January, February and June');
    expect(all[0].tone).toBe('warn'); // 3+ months piled up
  });

  test('a long backlog is summarised, never listed out in full', () => {
    const out = buildAlerts({ ...EMPTY, properties: [prop], unloggedMonths: [unlogged([1, 2, 3, 4, 5, 6])] }, undefined, NOW);
    expect(out.find((x) => x.focus === 'statement_reminder').detail)
      .toContain('January, February, March and 3 more');
  });

  test('two properties → one alert each, with distinct dismiss keys', () => {
    const out = buildAlerts(
      { ...EMPTY, properties: [prop, prop2], unloggedMonths: [unlogged([6]), unlogged([6], 'p2')] },
      undefined, NOW,
    );
    const all = out.filter((x) => x.focus === 'statement_reminder');
    expect(all).toHaveLength(2);
    expect(new Set(all.map(alertKey)).size).toBe(2);
  });

  test('the dismiss key rolls forward when a NEW month goes unlogged', () => {
    const june = buildAlerts({ ...EMPTY, properties: [prop], unloggedMonths: [unlogged([6])] }, undefined, NOW)
      .find((x) => x.focus === 'statement_reminder');
    const juneAndJuly = buildAlerts({ ...EMPTY, properties: [prop], unloggedMonths: [unlogged([6, 7])] }, undefined, NOW)
      .find((x) => x.focus === 'statement_reminder');
    // Dismissing June must not silence the reminder once July also needs logging.
    expect(alertKey(june)).not.toBe(alertKey(juneAndJuly));
    expect(june.date).toBe('2026-06-30');
    expect(juneAndJuly.date).toBe('2026-07-31');
  });

  test('no unlogged months → no alert', () => {
    const out = buildAlerts({ ...EMPTY, properties: [prop], unloggedMonths: [unlogged([])] }, undefined, NOW);
    expect(out.find((x) => x.focus === 'statement_reminder')).toBeUndefined();
  });

  test('Rent Ledger module off → the reminder is gone', () => {
    const out = buildAlerts(
      { ...EMPTY, properties: [prop], unloggedMonths: [unlogged([1, 2])] },
      undefined, NOW, { features: ['insurance'] }, // ledger not in the enabled set
    );
    expect(out.find((x) => x.focus === 'statement_reminder')).toBeUndefined();
  });

  test('it sorts above what is not yet due, below what is genuinely overdue', () => {
    const out = buildAlerts(
      {
        ...EMPTY,
        properties: [prop],
        unloggedMonths: [unlogged([6])],
        leases: [leaseEndingIn('2026-03-01')], // ~45 days out → days ≈ 45
        annualReports: [{ corporation_id: 'c1', due_date: '2026-01-05' }], // overdue → days < 0
        corporations: [{ id: 'c1', name: 'Acme LLC' }],
      },
      undefined, NOW,
    );
    const order = out.map((a) => a.focus);
    expect(order.indexOf('annual_report')).toBeLessThan(order.indexOf('statement_reminder'));
    expect(order.indexOf('statement_reminder')).toBeLessThan(order.indexOf('termination'));
  });
});
