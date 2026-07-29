// An alert's urgency bar is only honest if it's measured against the window that alert
// actually appeared in. "30 days out" is nearly here on a 31-day annual-report lead and
// months of runway on a 183-day lease-end one — so buildAlerts stamps horizonDays and the
// Overview fills the bar against it.
//
// The other half of the contract matters just as much: three alert types carry a SORT
// WEIGHT in `days`, not a countdown, and must never grow a bar or a "N days over" figure.
import { describe, it, expect } from 'vitest';
import { buildAlerts } from '../alerts';
import { urgencyFill } from '../../pages/DashboardPage';

const NOW = new Date('2026-07-29T12:00:00');
const iso = (daysFromNow) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
};

const PROPS = [{ id: 'p1', name: 'Maple Plaza', corporation_id: 'c1' }];
const LEASE = { id: 'l1', property_id: 'p1', tenant_name: 'City Dental', is_active: true };

const only = (focus, alerts) => alerts.filter((a) => a.focus === focus);

describe('horizonDays is stamped on every date-driven alert', () => {
  it('a lease ending carries the general lease_end lead', () => {
    const [a] = only('termination', buildAlerts(
      { leases: [{ ...LEASE, lease_termination_date: iso(40) }], properties: PROPS },
      undefined, NOW,
    ));
    expect(a.horizonDays).toBe(183);
    expect(a.days).toBe(40);
  });

  it('a lease with its OWN notify_lease_end_days uses that, not the general lead', () => {
    // This is precisely why the horizon can't be looked up in the UI: only buildAlerts
    // knows a per-lease override was in play for this one row.
    const [a] = only('termination', buildAlerts(
      { leases: [{ ...LEASE, lease_termination_date: iso(20), notify_lease_end_days: 30 }], properties: PROPS },
      undefined, NOW,
    ));
    expect(a.horizonDays).toBe(30);
  });

  it('the owner’s configured lead flows through to the alert', () => {
    const [a] = only('escalation', buildAlerts(
      {
        leases: [{ ...LEASE, lease_termination_date: iso(900) }],
        escalations: [{ lease_id: 'l1', status: 'scheduled', effective_date: iso(50) }],
        properties: PROPS,
      },
      undefined, NOW, { leadDays: { escalation: 60 } },
    ));
    expect(a.horizonDays).toBe(60);
  });

  it('a renewal notice, a contract, an insurance policy and an annual report all carry one', () => {
    const alerts = buildAlerts({
      leases: [LEASE],
      properties: PROPS,
      renewals: [{ lease_id: 'l1', id: 'r1', status: 'pending', notice_by_date: iso(30) }],
      contracts: [{ id: 'k1', property_id: 'p1', name: 'Elevator', end_date: iso(30) }],
      insurance: [{ id: 'i1', party: 'landlord', property_id: 'p1', expiry_date: iso(30) }],
      annualReports: [{ corporation_id: 'c1', due_date: iso(20) }],
      corporations: [{ id: 'c1', name: 'Acme Holdings' }],
    }, undefined, NOW);
    for (const focus of ['renewal', 'contract', 'insurance', 'annual_report']) {
      const [a] = only(focus, alerts);
      expect(a, focus).toBeTruthy();
      expect(a.horizonDays, focus).toBeGreaterThan(0);
    }
  });
});

describe('the three sort-weight alerts carry NO horizon', () => {
  it('a statement reminder sorts by month count, so it gets no countdown', () => {
    const [a] = only('statement_reminder', buildAlerts({
      leases: [LEASE], properties: PROPS,
      unloggedMonths: [{ property_id: 'p1', year: 2026, months: [5, 6] }],
    }, undefined, NOW));
    expect(a).toBeTruthy();
    expect(a.horizonDays).toBeUndefined();
    // days is a weight — rendering "-2 days over" would be nonsense.
    expect(a.days).toBe(-2);
    expect(urgencyFill(a.days, a.horizonDays)).toBeNull();
  });

  it('a missing payment likewise', () => {
    const [a] = only('missing_payment', buildAlerts({
      leases: [LEASE], properties: PROPS,
      missingPayments: [{ lease_id: 'l1', property_id: 'p1', year: 2026, months: [4], tenant_name: 'City Dental', amount: 5000 }],
    }, undefined, NOW));
    expect(a.horizonDays).toBeUndefined();
    expect(urgencyFill(a.days, a.horizonDays)).toBeNull();
  });

  it('an insurance chase-up counts days SINCE the request, so it gets none either', () => {
    const [a] = only('insurance_chase', buildAlerts({
      leases: [LEASE], properties: PROPS,
      insurance: [],
      insuranceRequests: [{ lease_id: 'l1', event_date: iso(-40) }],
    }, undefined, NOW));
    expect(a).toBeTruthy();
    expect(a.days).toBeLessThan(0);          // always negative — it's an elapsed count
    expect(a.horizonDays).toBeUndefined();
    expect(urgencyFill(a.days, a.horizonDays)).toBeNull();
  });
});

describe('urgencyFill', () => {
  it('runs empty at the far edge of the horizon and full on the day', () => {
    expect(urgencyFill(183, 183)).toBeCloseTo(0.04);  // floored so a bar always reads as one
    expect(urgencyFill(0, 183)).toBe(1);
  });

  it('never reads empty for a date that is genuinely close', () => {
    // The failure mode this rule exists for: a filing due in 30 days sits on a 31-day
    // notice lead, so measured against its OWN window alone it would fill 3% — an empty
    // bar beside the words "30 days left". Absolute closeness carries it instead.
    expect(urgencyFill(30, 31)).toBeCloseTo(0.667, 2);
    expect(urgencyFill(7, 31)).toBeCloseTo(0.922, 2);
    expect(urgencyFill(1, 31)).toBeCloseTo(0.989, 2);
  });

  it('still rises through a long notice window before the date is close', () => {
    // A lease ending in 120 days isn't "soon", but two-thirds of the 183-day window the
    // landlord asked for is already gone — so the bar has moved. Without this term it
    // would sit flat at the floor for three months and then jump.
    expect(urgencyFill(120, 183)).toBeCloseTo(0.344, 2);
    expect(urgencyFill(180, 183)).toBeCloseTo(0.04, 2);
  });

  it('is monotonic — a bar can only ever get fuller as the date approaches', () => {
    const fills = [183, 150, 120, 90, 60, 30, 14, 3, 0].map((d) => urgencyFill(d, 183));
    for (let i = 1; i < fills.length; i++) expect(fills[i]).toBeGreaterThanOrEqual(fills[i - 1]);
  });

  it('pins full once the date has passed', () => {
    expect(urgencyFill(-1, 183)).toBe(1);
    expect(urgencyFill(-400, 183)).toBe(1);
  });

  it('two alerts the same number of days out never contradict their own figures', () => {
    // Both read "30 days left", so neither may look calm while the other looks urgent.
    const short = urgencyFill(30, 31);
    const long = urgencyFill(30, 183);
    expect(short).toBeGreaterThan(0.5);
    expect(long).toBeGreaterThan(0.5);
  });

  it('returns null rather than a fabricated bar when there is no horizon', () => {
    expect(urgencyFill(10, null)).toBeNull();
    expect(urgencyFill(10, 0)).toBeNull();
    expect(urgencyFill(null, 183)).toBeNull();
  });
});
