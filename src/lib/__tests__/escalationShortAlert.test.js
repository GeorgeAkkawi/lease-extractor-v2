// `escalation_short` — the follow-through to the `escalation` alert. That one says a rent
// step is COMING; this one says a step landed and the tenant is still remitting the old
// amount (George, 2026-08-13).
//
// The three things worth pinning, because each of them silently ruins the alert:
//   • it must NOT collide with the `escalation` alert on the same lease (alertKey is
//     focus:id:date and both anchor on lease_id),
//   • it must be gated by the Rent Ledger module, like the other two ledger reminders,
//   • it must be mapped in NOTIFY_COLUMNS, or it is invisible in the notification
//     preferences (notifyTypes.test.js also catches this, from the other direction).
import { describe, it, expect } from 'vitest';
import { buildAlerts, alertKey } from '../alerts';
import { NOTIFY_COLUMNS } from '../notifyTypes';

const NOW = new Date('2026-09-15T12:00:00');
const PROPS = [{ id: 'p1', corporation_id: 'corp1', name: 'Oak Center' }];
const LEASES = [{ id: 'l1', tenant_name: 'Sam Nails', property_id: 'p1', is_active: true }];

// One tenant, one applied June step, short $54.12/mo across three settled months.
const SHORT = {
  lease_id: 'l1', property_id: 'p1', tenant_name: 'Sam Nails', year: 2026,
  month: 6, billJump: 54.12, shortPerMonth: 54.12, shortSince: 162.36,
  settledSince: 3, owedMonthly: 5078.20,
};

const build = (escalationShort, opts = {}) => buildAlerts(
  { leases: LEASES, escalations: [], renewals: [], insurance: [], properties: PROPS, escalationShort },
  undefined, NOW, opts,
);
// A lease with no certificate on file also raises insurance_missing, so never index by
// position — pick the one under test.
const only = (out) => out.find((x) => x.focus === 'escalation_short');

describe('escalation_short', () => {
  it('names the tenant, the month, the increase and the running shortfall', () => {
    const a = build([SHORT]).find((x) => x.focus === 'escalation_short');
    expect(a).toBeTruthy();
    expect(a.lease_id).toBe('l1');
    expect(a.property_id).toBe('p1');
    expect(a.corporation_id).toBe('corp1');
    expect(a.title).toContain('Sam Nails');
    expect(a.title).toContain('not picked up');
    // The detail has to be actionable on its own — which month, how much a month, how
    // much in total. "3 months behind" tells the landlord nothing he can act on.
    expect(a.detail).toContain('June');
    expect(a.detail).toContain('$54');
    expect(a.detail).toContain('$162');
    // The three figures the hover panel prints.
    expect(a.owedMonthly).toBe(5078.20);
    expect(a.stepAmount).toBe(54.12);
    expect(a.shortPerMonth).toBe(54.12);
  });

  it('anchors to the last day of the step month, and does not collide with `escalation`', () => {
    const out = buildAlerts(
      {
        leases: LEASES, renewals: [], insurance: [], properties: PROPS,
        // A scheduled step on the SAME lease → the other escalation alert.
        escalations: [{ lease_id: 'l1', effective_date: '2026-10-01', status: 'scheduled', new_base_rent: 52000 }],
        escalationShort: [SHORT],
      },
      undefined, NOW, {},
    );
    const short = out.find((x) => x.focus === 'escalation_short');
    const coming = out.find((x) => x.focus === 'escalation');
    expect(short.date).toBe('2026-06-30');
    expect(coming).toBeTruthy();
    expect(alertKey(short)).not.toBe(alertKey(coming));
    // Neither key collapses to `undefined` — lease_id is already in the anchor chain.
    expect(alertKey(short)).toBe('escalation_short:l1:2026-06-30');
  });

  it('two steps on one lease get two distinct dismissal keys', () => {
    const out = build([SHORT, { ...SHORT, month: 9, shortSince: 54.12, settledSince: 1 }]);
    const keys = out.filter((x) => x.focus === 'escalation_short').map(alertKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('firms up to danger once three months have gone by at the old rate', () => {
    expect(only(build([{ ...SHORT, settledSince: 1 }])).tone).toBe('warn');
    expect(only(build([SHORT])).tone).toBe('danger');
  });

  it('is gated by the Rent Ledger module', () => {
    const off = build([SHORT], { features: ['insurance'] });
    expect(off.find((x) => x.focus === 'escalation_short')).toBeUndefined();
    const on = build([SHORT], { features: ['ledger'] });
    expect(on.find((x) => x.focus === 'escalation_short')).toBeTruthy();
  });

  it('a dismissed key silences it', () => {
    const a = build([SHORT])[0];
    const out = buildAlerts(
      { leases: LEASES, escalations: [], renewals: [], insurance: [], properties: PROPS, escalationShort: [SHORT] },
      { dismissed: new Set([alertKey(a)]), snoozedUntil: {} }, NOW, {},
    );
    expect(out.find((x) => x.focus === 'escalation_short')).toBeUndefined();
  });

  it('an out-of-range month raises nothing rather than a garbled date', () => {
    expect(only(build([{ ...SHORT, month: 0 }]))).toBeUndefined();
    expect(only(build([{ ...SHORT, month: 13 }]))).toBeUndefined();
  });

  it('sits in the Rent-escalations notification column, beside the step itself', () => {
    const col = NOTIFY_COLUMNS.find((c) => c.key === 'escalation');
    expect(col.focuses).toContain('escalation');
    expect(col.focuses).toContain('escalation_short');
  });
});
