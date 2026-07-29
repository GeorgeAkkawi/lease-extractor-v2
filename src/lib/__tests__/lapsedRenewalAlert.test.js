// A renewal option that lapsed long ago is not a live deadline, and the bell must stop
// counting down to it.
//
// The case that prompted this: beauty and barber shop carries a pending option whose
// notice date is 2008-09-01 on a lease running to 2030-05-31 (the notice belongs to an
// earlier term the lease was later extended past). The 2026-07-28 round taught the lease
// page, the decision prompt and the SQL cron to read that as lapsed — buildAlerts was the
// one consumer left out, so the Overview kept raising "Renewal notice — 6,540 days over".
//
// The rule has to cut exactly one way: kill the eighteen-year-old notice, keep the one
// that's genuinely two months late.
import { describe, it, expect } from 'vitest';
import { buildAlerts, isLongPast, LONG_PAST_DAYS } from '../alerts';
import { optionLapseReason } from '../renewals';

const NOW = new Date('2026-07-29T12:00:00');
const PROPS = [{ id: 'p1', name: 'Pershing Plaza', corporation_id: 'c1' }];
const renewalAlerts = (data) => buildAlerts(data, undefined, NOW).filter((a) => a.focus === 'renewal');

describe('a lapsed renewal option raises no notice alert', () => {
  it('drops the option whose notice belongs to an earlier term', () => {
    const lease = { id: 'l1', property_id: 'p1', tenant_name: 'beauty and barber shop', is_active: true, lease_termination_date: '2030-05-31' };
    const ren = { id: 'r1', lease_id: 'l1', notice_by_date: '2008-09-01', status: 'pending' };
    // The shared rule agrees this option is dead…
    expect(optionLapseReason(ren, lease.lease_termination_date, '2026-07-29')).toBe('notice_passed');
    // …so the bell says nothing about it.
    expect(renewalAlerts({ leases: [lease], properties: PROPS, renewals: [ren] })).toEqual([]);
  });

  it('drops an option on a lease whose term has already ended', () => {
    const lease = { id: 'l1', property_id: 'p1', tenant_name: 'Holdover Co', is_active: true, lease_termination_date: '2025-01-31' };
    const ren = { id: 'r1', lease_id: 'l1', notice_by_date: '2024-08-01', status: 'pending' };
    expect(optionLapseReason(ren, lease.lease_termination_date, '2026-07-29')).toBe('term_ended');
    expect(renewalAlerts({ leases: [lease], properties: PROPS, renewals: [ren] })).toEqual([]);
    // The lease itself is still flagged — it's in holdover, which is the real problem.
    expect(buildAlerts({ leases: [lease], properties: PROPS, renewals: [ren] }, undefined, NOW)
      .some((a) => a.focus === 'termination' && a.holdover)).toBe(true);
  });

  it('STILL raises a notice that was genuinely missed on a live term', () => {
    // Two months past a deadline on a term ending next year is a real, actionable miss —
    // the 18-month test is what keeps it apart from a stale one.
    const lease = { id: 'l1', property_id: 'p1', tenant_name: "Ricki's-Lyons", is_active: true, lease_termination_date: '2027-05-01' };
    const ren = { id: 'r1', lease_id: 'l1', notice_by_date: '2026-05-20', status: 'pending' };
    expect(optionLapseReason(ren, lease.lease_termination_date, '2026-07-29')).toBeNull();
    const [a] = renewalAlerts({ leases: [lease], properties: PROPS, renewals: [ren] });
    expect(a).toBeTruthy();
    expect(a.days).toBeLessThan(0);
    expect(a.horizonDays).toBe(183);   // still a countdown — it's a live deadline
  });

  it('still raises an upcoming notice untouched', () => {
    const lease = { id: 'l1', property_id: 'p1', tenant_name: 'Five Points', is_active: true, lease_termination_date: '2027-12-31' };
    const ren = { id: 'r1', lease_id: 'l1', notice_by_date: '2026-09-15', status: 'pending' };
    const [a] = renewalAlerts({ leases: [lease], properties: PROPS, renewals: [ren] });
    expect(a.title).toMatch(/Renewal notice/);
    expect(a.days).toBeGreaterThan(0);
  });
});

describe('isLongPast — which rows get a labelled Ignore instead of a bare ✕', () => {
  it('is true only for a dated alert more than a year past its date', () => {
    expect(isLongPast({ days: -400, horizonDays: 183 })).toBe(true);
    expect(isLongPast({ days: -LONG_PAST_DAYS, horizonDays: 183 })).toBe(false); // exactly a year is not "long"
    expect(isLongPast({ days: -30, horizonDays: 183 })).toBe(false);
    expect(isLongPast({ days: 5, horizonDays: 183 })).toBe(false);
  });

  it('is false for a weight-based alert, whose `days` is not a date at all', () => {
    // statement_reminder / missing_payment / insurance_chase carry a sort weight in `days`.
    // A big negative weight must never be mistaken for a decade-old deadline.
    expect(isLongPast({ days: -4000, horizonDays: undefined })).toBe(false);
    expect(isLongPast({})).toBe(false);
    expect(isLongPast(null)).toBe(false);
  });
});
