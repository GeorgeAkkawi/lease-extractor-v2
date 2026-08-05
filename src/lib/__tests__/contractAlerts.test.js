// The two contract alerts 0091 adds: the CANCELLATION-NOTICE deadline (the one that costs
// money) and a fee step coming due.
//
// A missed notice date commits the landlord to another full term at the vendor's figure —
// which then flows into CAM and therefore into what the tenants are billed, for another
// year. Nothing watched it before, because there was nowhere to store it.
import { describe, it, expect } from 'vitest';
import { buildAlerts, alertKey } from '../alerts';
import { NOTIFY_TYPES, DEFAULT_LEAD_DAYS } from '../notifyPrefs';

const NOW = new Date('2026-06-15T12:00:00');
const PROPS = [{ id: 'p1', corporation_id: 'corp1', name: 'Oak Center' }];

const build = (contracts, contractSteps = [], opts = {}) => buildAlerts(
  { leases: [], escalations: [], renewals: [], insurance: [], properties: PROPS, contracts, contractSteps },
  undefined, NOW, opts,
);

const CONTRACT = {
  id: 'c1', name: 'Snow removal — Arctic', vendor: 'Arctic Snow Services',
  vendor_email: 'billing@arctic.example', property_id: 'p1',
  amount: 8000, frequency: 'annual',
  end_date: '2026-10-31', auto_renew: true, notice_days: 30,
  notice_by_date: '2026-07-01', renewal_term_months: 12,
};

describe('contract_notice — the deadline that costs money', () => {
  it('fires inside the 60-day default lead, anchored to the contract', () => {
    const a = build([CONTRACT]).find((x) => x.focus === 'contract_notice');
    expect(a).toBeTruthy();
    expect(a.date).toBe('2026-07-01');
    expect(a.contract_id).toBe('c1');
    expect(a.property_id).toBe('p1');
    expect(a.corporation_id).toBe('corp1');
    expect(a.vendor_email).toBe('billing@arctic.example');
    expect(a.title).toContain('Cancellation notice due');
    expect(a.detail).toContain('renews');
  });

  // ⚠ alertKey is focus:id:date, and contract_id is already in its anchor chain — so the
  // expiry, the notice and a fee step on the SAME contract must produce three distinct
  // keys. A collapsed key means dismissing one dismisses the others.
  it('does not collide with the expiry alert on the same contract', () => {
    const out = build([CONTRACT]);
    const notice = out.find((x) => x.focus === 'contract_notice');
    const expiry = out.find((x) => x.focus === 'contract');
    expect(alertKey(notice)).toBe('contract_notice:c1:2026-07-01');
    expect(alertKey(expiry)).toBe('contract:c1:2026-10-31');
    expect(alertKey(notice)).not.toBe(alertKey(expiry));
  });

  // The flag drives the WORDING, not the alert's existence: a contract that merely ends
  // still needs the notice served to end cleanly, and one whose renewal terms were never
  // read is exactly the one nobody should rely on silence from.
  it('fires regardless of auto_renew, and says which case it is', () => {
    const renews = build([CONTRACT]).find((x) => x.focus === 'contract_notice');
    expect(renews.detail).toContain('for 12 more months');

    const ends = build([{ ...CONTRACT, auto_renew: false }]).find((x) => x.focus === 'contract_notice');
    expect(ends).toBeTruthy();
    expect(ends.detail).toContain('Written notice due');

    const unknown = build([{ ...CONTRACT, auto_renew: null }]).find((x) => x.focus === 'contract_notice');
    expect(unknown).toBeTruthy();
  });

  it('is silent when no notice date is stored', () => {
    const out = build([{ ...CONTRACT, notice_by_date: null }]);
    expect(out.some((x) => x.focus === 'contract_notice')).toBe(false);
  });

  it('is silenced with the Service-contracts module', () => {
    const out = build([CONTRACT], [], { features: ['leases'] });
    expect(out.some((x) => x.focus === 'contract_notice')).toBe(false);
    expect(out.some((x) => x.focus === 'contract')).toBe(false);
  });

  // A six-month countdown to a window that is itself 30 days wide would sit on the
  // dashboard for four months with nothing to do about it.
  it('uses a 60-day default lead, not the 183 the other contract alerts use', () => {
    expect(DEFAULT_LEAD_DAYS.contract_notice).toBe(60);
    expect(DEFAULT_LEAD_DAYS.contract).toBe(183);
    // Five months out is inside the expiry horizon but outside the notice one.
    const far = build([{ ...CONTRACT, notice_by_date: '2026-11-01', end_date: '2026-12-01' }]);
    expect(far.some((x) => x.focus === 'contract')).toBe(true);
    expect(far.some((x) => x.focus === 'contract_notice')).toBe(false);
  });

  it('honours a custom lead', () => {
    const out = build([{ ...CONTRACT, notice_by_date: '2026-11-01' }], [], { leadDays: { contract_notice: 200 } });
    expect(out.some((x) => x.focus === 'contract_notice')).toBe(true);
  });
});

describe('contract_escalation — a fee step coming due', () => {
  const steps = [
    { contract_id: 'c1', effective_date: '2026-01-01', new_amount: 7000 },
    { contract_id: 'c1', effective_date: '2026-07-15', new_amount: 9000 },
    { contract_id: 'c1', effective_date: '2028-01-01', new_amount: 11000 },
  ];

  it('names the NEXT step and what it costs', () => {
    const a = build([CONTRACT], steps).find((x) => x.focus === 'contract_escalation');
    expect(a).toBeTruthy();
    expect(a.date).toBe('2026-07-15');
    expect(a.new_amount).toBe(9000);
    expect(a.title).toContain('Contract fee increasing');
    expect(alertKey(a)).toBe('contract_escalation:c1:2026-07-15');
  });

  it('says /mo for a monthly contract', () => {
    const a = build([{ ...CONTRACT, frequency: 'monthly' }], steps).find((x) => x.focus === 'contract_escalation');
    expect(a.detail).toContain('/mo');
  });

  it('is silent with no steps, or with the whole schedule in the past', () => {
    expect(build([CONTRACT], []).some((x) => x.focus === 'contract_escalation')).toBe(false);
    expect(build([CONTRACT], [steps[0]]).some((x) => x.focus === 'contract_escalation')).toBe(false);
  });

  it('ignores steps belonging to another contract', () => {
    const out = build([CONTRACT], [{ contract_id: 'other', effective_date: '2026-07-15', new_amount: 9000 }]);
    expect(out.some((x) => x.focus === 'contract_escalation')).toBe(false);
  });
});

describe('the Settings switchboard knows about both', () => {
  it('each has a NOTIFY_TYPES entry so its lead is configurable', () => {
    for (const key of ['contract_notice', 'contract_escalation']) {
      const t = NOTIFY_TYPES.find((x) => x.key === key);
      expect(t).toBeTruthy();
      expect(t.kind).toBe('before');
      expect(t.hint).toBeTruthy();
    }
  });
});
