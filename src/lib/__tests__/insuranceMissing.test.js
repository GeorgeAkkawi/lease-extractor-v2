// "Make sure to list every property that doesn't yet have insurance, but there needs to
// be nuance. If the insurance was requested, that should be a different type of
// notification. If the insurance hasn't been requested, that should be known as well."
// — George, 2026-07-30
//
// The gap: both insurance alerts that existed needed something to ALREADY be on record —
// `insurance` needs a policy with an expiry date, `insurance_chase` needs a logged
// request. A building nobody had ever entered a policy for, or a tenant nobody had ever
// asked, produced no alert at all. That is precisely the case a landlord most needs told
// about, and it was the one case the bell was silent on.
//
// So three mutually exclusive states, and the tests below pin the exclusivity as hard as
// they pin the presence: saying the same thing twice about one tenant would be worse than
// saying it once too quietly.
import { describe, it, expect } from 'vitest';
import { buildAlerts, alertKey } from '../alerts';

const NOW = new Date('2026-07-30T12:00:00');
const PROPS = [
  { id: 'p1', name: 'Pershing Plaza', corporation_id: 'c1' },
  { id: 'p2', name: 'Joliet', corporation_id: 'c2' },
];
const LEASES = [
  { id: 'l1', property_id: 'p1', tenant_name: 'D & D Dental', is_active: true },
  { id: 'l2', property_id: 'p1', tenant_name: 'Five Points Wings', is_active: true },
];

const build = (data, opts) => buildAlerts(
  { leases: [], properties: [], renewals: [], escalations: [], insurance: [], insuranceRequests: [], ...data },
  undefined, NOW, opts,
);
const missing = (data, opts) => build(data, opts).filter((a) => a.focus === 'insurance_missing');
const insuranceAlerts = (data) => build(data).filter((a) => String(a.focus).startsWith('insurance'));

describe('every building with no policy on file is named', () => {
  it('raises one alert per property that has no landlord policy', () => {
    const out = missing({ properties: PROPS }).filter((a) => a.party === 'landlord');
    expect(out.map((a) => a.title)).toEqual([
      'No building insurance — Pershing Plaza',
      'No building insurance — Joliet',
    ]);
    expect(out[0].property_id).toBe('p1');
    expect(out[0].corporation_id).toBe('c1');
    expect(out[0].detail).toBe('No policy on file for this building');
  });

  it('goes quiet the moment a landlord policy exists for that building', () => {
    const insurance = [{ id: 'i1', party: 'landlord', property_id: 'p1', expiry_date: '2029-01-01' }];
    const out = missing({ properties: PROPS, insurance }).filter((a) => a.party === 'landlord');
    expect(out.map((a) => a.property_id)).toEqual(['p2']);
  });

  it('offers no ✉ — the landlord buys their own policy, there is nobody to write to', () => {
    // Encoded as the absence of a lease_id, which is exactly what alertCanEmail tests.
    const out = missing({ properties: PROPS }).filter((a) => a.party === 'landlord');
    out.forEach((a) => expect(a.lease_id).toBeNull());
  });
});

describe('a tenant with no certificate — and whether anyone has asked', () => {
  it('says plainly when nobody has asked yet', () => {
    const a = missing({ properties: PROPS, leases: LEASES }).find((x) => x.lease_id === 'l1');
    expect(a.title).toBe('No certificate on file — D & D Dental');
    expect(a.detail).toBe('No certificate on file, and none has been requested yet');
    expect(a.bucketLabel).toBe('Never requested');
    expect(a.tone).toBe('warn');
    // Nothing to count down to, so no countdown chip may render (the horizonDays rule).
    expect(a.horizonDays).toBeUndefined();
  });

  it('reads differently once a request has gone out, and calms down', () => {
    const insuranceRequests = [{ lease_id: 'l1', event_date: '2026-07-25' }]; // 5 days ago
    const a = missing({ properties: PROPS, leases: LEASES, insuranceRequests }).find((x) => x.lease_id === 'l1');
    expect(a.title).toBe('Certificate requested — D & D Dental');
    expect(a.detail).toMatch(/Requested .* · waiting for the tenant/);
    expect(a.bucketLabel).toBe('Requested');
    expect(a.tone).toBe('info');   // asked and waiting is not a problem yet
    expect(a.requested).toBe(true);
    expect(a.requested_on).toBe('2026-07-25');
  });

  it('ranks never-asked above asked-and-waiting', () => {
    // Both are standing rows with no deadline, so `days` is the sort weight that separates
    // them — the landlord's own inaction outranks the tenant's.
    const insuranceRequests = [{ lease_id: 'l2', event_date: '2026-07-25' }];
    const out = missing({ properties: PROPS, leases: LEASES, insuranceRequests });
    const never = out.find((a) => a.lease_id === 'l1');
    const asked = out.find((a) => a.lease_id === 'l2');
    expect(never.days).toBeLessThan(asked.days);
  });

  it('hands over to the chase-up once the request is old enough, and never doubles up', () => {
    const insuranceRequests = [{ lease_id: 'l1', event_date: '2026-06-01' }]; // ~60 days ago
    const out = insuranceAlerts({ properties: PROPS, leases: LEASES, insuranceRequests })
      .filter((a) => a.lease_id === 'l1');
    expect(out).toHaveLength(1);
    expect(out[0].focus).toBe('insurance_chase');
    expect(out[0].title).toBe('Insurance not received — D & D Dental');
  });

  it('goes quiet when a certificate is actually on file', () => {
    const insurance = [{ id: 'i2', party: 'tenant', lease_id: 'l1', property_id: 'p1', expiry_date: '2029-06-30' }];
    const out = missing({ properties: PROPS, leases: LEASES, insurance });
    expect(out.some((a) => a.lease_id === 'l1')).toBe(false);
    expect(out.some((a) => a.lease_id === 'l2')).toBe(true);
  });

  it('says nothing about a lease that is no longer active', () => {
    const leases = [{ ...LEASES[0], is_active: false }];
    expect(missing({ properties: PROPS, leases }).some((a) => a.lease_id === 'l1')).toBe(false);
  });
});

describe('the states are dismissible independently', () => {
  it('keys a never-requested row separately from the same tenant once asked', () => {
    // Dismissing "nobody has asked" must not also silence the row that appears after a
    // request goes out — those are two different pieces of news about one tenant.
    const never = missing({ properties: PROPS, leases: LEASES }).find((a) => a.lease_id === 'l1');
    const asked = missing({ properties: PROPS, leases: LEASES, insuranceRequests: [{ lease_id: 'l1', event_date: '2026-07-25' }] })
      .find((a) => a.lease_id === 'l1');
    expect(alertKey(never)).not.toBe(alertKey(asked));
    // …and a building's key is anchored on the property, since it has no lease.
    const building = missing({ properties: PROPS }).find((a) => a.property_id === 'p1');
    expect(alertKey(building)).toContain('p1');
  });
});

describe('the Insurance module switch still silences all of it', () => {
  it('raises nothing at all when Insurance is turned off in Settings', () => {
    const data = { properties: PROPS, leases: LEASES };
    expect(missing(data).length).toBeGreaterThan(0);
    expect(missing(data, { features: ['contracts'] })).toEqual([]);
  });
});
