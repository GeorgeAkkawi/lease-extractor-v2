// Recording a renewal that happened years ago — the third answer a lapsed option needs.
//
// The case (George, 2026-07-29): a 2004 lease's "First Option to Renew", notice by
// 2008-09-01. The tenant took it, back then; every term since has been carried by
// addendums, so the lease already reads the right rent and the right end date. But the
// option row still sat *pending*, so the bell kept asking — and both answers on offer
// were wrong. "Renew" would have extended the term AGAIN and booked the 2008-era rent
// ($19,386 against a current $31,800.96); "Not renewing" would have been a lie.
//
// The binding property of the new path, and the reason every assertion below re-reads the
// lease: it records history and touches NOTHING else.
import { describe, it, expect, afterEach } from 'vitest';
import { markRenewalRenewedHistoric, listRenewals, getLease, listHistoryEvents, listNotifications } from '../api';
import { currentTermLabel } from '../leaseTerm';
import { supabase } from '../supabaseClient';

// lease-2 (City Dental) carries ren-1 — pending, and lapsed because its term ended in May.
const LEASE = 'lease-2';
const OPTION = 'ren-1';

// The demo store is seeded once per module, so each test puts back what it wrote.
afterEach(async () => {
  await supabase.from('renewal_options').update({ status: 'pending', applied_at: null }).eq('id', OPTION);
  await supabase.from('history_events').delete().eq('type', 'renewal_confirmed');
  await supabase.from('notifications').delete().eq('kind', 'renewal_decision');
});

describe('markRenewalRenewedHistoric', () => {
  it('marks the option applied on the day given, and changes NOTHING on the lease', async () => {
    const before = await getLease(LEASE);

    await markRenewalRenewedHistoric(OPTION, '2008-09-01');

    const opt = (await listRenewals(LEASE)).find((r) => r.id === OPTION);
    expect(opt.status).toBe('applied');
    // Noon UTC, so the calendar day survives the trip through a timestamptz in any timezone.
    expect(String(opt.applied_at).slice(0, 10)).toBe('2008-09-01');

    // The whole point: the money and the dates are untouched.
    const after = await getLease(LEASE);
    expect(after.base_rent).toBe(before.base_rent);
    expect(after.lease_termination_date).toBe(before.lease_termination_date);
    expect(after.lease_start).toBe(before.lease_start);
    expect(after.is_active).toBe(before.is_active);
  });

  it('books no rent step — an option applied as history must not re-price anything', async () => {
    const before = await supabase.from('rent_escalations').select('*').eq('lease_id', LEASE);
    await markRenewalRenewedHistoric(OPTION, '2008-09-01');
    const after = await supabase.from('rent_escalations').select('*').eq('lease_id', LEASE);
    expect((after.data || []).length).toBe((before.data || []).length);
  });

  it('shows on the property timeline, dated when it happened', async () => {
    await markRenewalRenewedHistoric(OPTION, '2008-09-01');
    const ev = (await listHistoryEvents('prop-1')).find((e) => e.type === 'renewal_confirmed');
    expect(ev).toBeTruthy();
    expect(ev.event_date).toBe('2008-09-01');
    expect(ev.tenant_name).toBe('City Dental');
    expect(ev.description).toMatch(/recorded after the fact/i);
    expect(ev.description).toMatch(/were not changed/i);
    expect(ev.meta.historic).toBe(true);
  });

  it('stops the bell asking — the open "Is X renewing?" prompt is cleared', async () => {
    await supabase.from('notifications').insert({
      id: 'notif-hist-test', lease_id: LEASE, property_id: 'prop-1', kind: 'renewal_decision',
      title: 'Is City Dental renewing?', body: 'An option…', read: false, created_at: new Date().toISOString(),
    });
    expect((await listNotifications()).some((n) => n.kind === 'renewal_decision')).toBe(true);

    await markRenewalRenewedHistoric(OPTION, '2008-09-01');
    expect((await listNotifications()).some((n) => n.kind === 'renewal_decision')).toBe(false);
  });

  it('falls back to today rather than writing a junk date', async () => {
    const res = await markRenewalRenewedHistoric(OPTION, 'sometime in 2008');
    expect(res.renewedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const opt = (await listRenewals(LEASE)).find((r) => r.id === OPTION);
    expect(opt.status).toBe('applied');
  });

  it('returns null for an option that no longer exists', async () => {
    expect(await markRenewalRenewedHistoric('no-such-option', '2008-09-01')).toBeNull();
  });
});

describe('currentTermLabel — whichever act moved the term LAST', () => {
  const lease = { is_active: true };
  const option = { status: 'applied', option_label: 'First Option to Renew', applied_at: '2008-09-01T12:00:00Z' };
  const ext = { kind: 'extension', label: 'Fourth Addendum', amendment_date: '2021-06-01' };

  it('keeps the addendum when it came after the option — the phase the lease is actually in', () => {
    // The regression this guards: recording a 2008 renewal must not relabel a term that
    // an addendum carried thirteen years later.
    expect(currentTermLabel(lease, [option], [ext])).toBe('Extended term — Fourth Addendum');
  });

  it('the option wins when IT came later', () => {
    const recent = { ...option, applied_at: '2026-07-29T12:00:00Z' };
    expect(currentTermLabel(lease, [recent], [ext])).toBe('First Option to Renew');
  });

  it('unchanged when only one of the two exists', () => {
    expect(currentTermLabel(lease, [option], [])).toBe('First Option to Renew');
    expect(currentTermLabel(lease, [], [ext])).toBe('Extended term — Fourth Addendum');
    expect(currentTermLabel(lease, [], [])).toBe('Original term');
  });

  it('with no date to compare, the option still wins — the prior behaviour', () => {
    expect(currentTermLabel(lease, [{ ...option, applied_at: null }], [ext])).toBe('First Option to Renew');
    expect(currentTermLabel(lease, [option], [{ ...ext, amendment_date: null }])).toBe('First Option to Renew');
  });

  it('an outdated lease still reads Outdated, whatever it carries', () => {
    expect(currentTermLabel({ is_active: false }, [option], [ext])).toBe('Outdated');
  });
});
