// The History page's tenant record. The property this pins hardest is the one that made
// the old timeline useless: a card must be POPULATED without a single history_event,
// because every event type is a side effect of some other action and nothing writes one
// when a lease is created or when a tenant leaves.
import { describe, it, expect } from 'vitest';
import { buildTenantStories, ledgerEvents, isStoryEvent, STORY_EVENTS, LEDGER_EVENTS } from '../tenantStory';

const TODAY = '2026-07-30';

const lease = (over = {}) => ({
  id: 'l1', tenant_name: 'D & D Dental', square_footage: 1077, base_rent: 31800.96,
  lease_start: '2004-01-01', lease_termination_date: '2026-09-30', ...over,
});
const expiredLease = (over = {}) => ({
  id: 'x1', tenant_name: 'Old Bakery', sf: 900, base_rent: 21000,
  lease_start: '2015-01-01', lease_end: '2019-12-31', status: 'Vacated', ...over,
});
const ev = (over = {}) => ({ id: 'e1', type: 'term_extended', event_date: '2020-01-25', description: 'Third Addendum', ...over });

describe('tenantStory — a card is never blank', () => {
  it('gives a lease with NO history events a real timeline from its own dates', () => {
    const [s] = buildTenantStories({ leases: [lease()], today: TODAY });
    expect(s.tenant).toBe('D & D Dental');
    expect(s.status).toBe('current');
    expect(s.events.map((e) => e.type)).toEqual(['moved_in', 'term_ends']);
    expect(s.events[0].date).toBe('2004-01-01');
    expect(s.events[1].date).toBe('2026-09-30');
  });

  it('reads a term end already passed as a holdover, not an upcoming date', () => {
    const [s] = buildTenantStories({ leases: [lease({ lease_termination_date: '2025-05-31' })], today: TODAY });
    expect(s.holdover).toBe(true);
    expect(s.events.at(-1).type).toBe('term_ended');
    expect(s.events.at(-1).label).toMatch(/still in place/i);
  });

  it('keeps an outdated (is_active false) lease as a CURRENT tenant, flagged', () => {
    // Same rule the property card and the Leases page follow: the tenant still occupies
    // the space and still owes rent until the landlord removes them.
    const [s] = buildTenantStories({ leases: [lease({ is_active: false })], today: TODAY });
    expect(s.status).toBe('current');
    expect(s.needsExtension).toBe(true);
  });

  it('gives a former tenant its ending, taken from the archive row', () => {
    const [s] = buildTenantStories({ expired: [expiredLease()], today: TODAY });
    expect(s.status).toBe('former');
    expect(s.outcome).toBe('Vacated');
    expect(s.events.at(-1)).toMatchObject({ type: 'left', date: '2019-12-31' });
  });
});

describe('tenantStory — attaching real events', () => {
  it('attaches a current tenant’s events by lease_id', () => {
    const [s] = buildTenantStories({ leases: [lease()], events: [ev({ lease_id: 'l1' })], today: TODAY });
    expect(s.events.map((e) => e.type)).toEqual(['moved_in', 'term_extended', 'term_ends']);
  });

  it('attaches a FORMER tenant’s events by tenant_name — its lease row is gone', () => {
    // history_events.lease_id is ON DELETE SET NULL, so the archive can only be matched
    // through the tenant_name denormalized onto the event in migration 0040.
    const e = ev({ id: 'e2', lease_id: null, tenant_name: 'Old Bakery', event_date: '2017-06-01', type: 'renewal_confirmed' });
    const [s] = buildTenantStories({ expired: [expiredLease()], events: [e], today: TODAY });
    expect(s.events.map((x) => x.type)).toEqual(['moved_in', 'renewal_confirmed', 'left']);
  });

  it('sorts a story oldest-first by its BUSINESS date, not the row stamp', () => {
    // The old table sorted by created_at while displaying event_date, so a renewal
    // backdated to 2008 sat at the top of the list reading "2008".
    const backdated = ev({ id: 'e3', lease_id: 'l1', type: 'renewal_confirmed', event_date: '2008-09-01', created_at: '2026-07-29T15:24:00Z' });
    const recent = ev({ id: 'e4', lease_id: 'l1', type: 'term_extended', event_date: '2020-01-25', created_at: '2020-01-25T00:00:00Z' });
    const [s] = buildTenantStories({ leases: [lease()], events: [recent, backdated], today: TODAY });
    expect(s.events.map((e) => e.date)).toEqual(['2004-01-01', '2008-09-01', '2020-01-25', '2026-09-30']);
  });
});

describe('tenantStory — filtering the noise', () => {
  it('keeps bookkeeping events out of every tenant story', () => {
    const noise = LEDGER_EVENTS.map((type, i) => ev({ id: `n${i}`, type, lease_id: 'l1', tenant_name: 'D & D Dental' }));
    const [s] = buildTenantStories({ leases: [lease()], events: noise, today: TODAY });
    expect(s.events.filter((e) => !e.synthetic)).toEqual([]);
  });

  it('routes them to the bookkeeping log instead, newest first', () => {
    const rows = [
      ev({ id: 'a', type: 'cam_reconciled', event_date: '2025-01-01' }),
      ev({ id: 'b', type: 'statement_imported', event_date: '2026-03-01' }),
      ev({ id: 'c', type: 'term_extended', event_date: '2026-06-01' }),
    ];
    expect(ledgerEvents(rows).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('sends an UNKNOWN event type to the log rather than dropping it', () => {
    expect(isStoryEvent('something_new')).toBe(false);
    expect(ledgerEvents([ev({ id: 'z', type: 'something_new' })]).map((e) => e.id)).toEqual(['z']);
  });

  it('classifies every story event as a story event', () => {
    expect(STORY_EVENTS.every(isStoryEvent)).toBe(true);
    expect(LEDGER_EVENTS.some(isStoryEvent)).toBe(false);
  });
});

describe('tenantStory — order', () => {
  it('puts current tenants first (soonest term end leading), then former, most recent first', () => {
    const stories = buildTenantStories({
      leases: [
        lease({ id: 'la', tenant_name: 'Later', lease_termination_date: '2030-01-01' }),
        lease({ id: 'lb', tenant_name: 'Sooner', lease_termination_date: '2026-12-31' }),
        lease({ id: 'lc', tenant_name: 'No end', lease_termination_date: null }),
      ],
      expired: [
        expiredLease({ id: 'xa', tenant_name: 'Older', lease_end: '2015-12-31' }),
        expiredLease({ id: 'xb', tenant_name: 'Newer', lease_end: '2021-12-31' }),
      ],
      today: TODAY,
    });
    expect(stories.map((s) => s.tenant)).toEqual(['Sooner', 'Later', 'No end', 'Newer', 'Older']);
    expect(stories.slice(0, 3).every((s) => s.status === 'current')).toBe(true);
  });

  it('returns nothing at all for a property with no tenants', () => {
    expect(buildTenantStories({ today: TODAY })).toEqual([]);
  });
});
