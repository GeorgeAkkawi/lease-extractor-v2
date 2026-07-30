// An option's own rent steps — "hidden but remembered".
//
// George, 2026-07-30: "if the rent goes up yearly or within a certain term amount the
// user should have to option to update that like 'add rent escalation as part of this
// option' and that should be hidden but be remembered so that when the renewal is
// applied the escalations save."
//
// The load-bearing property is the pair: NOTHING is written to the rent ledger while the
// option is only pending, and the whole schedule lands as real dated steps the moment it
// is applied. A helper test on the parser alone would pass either way — these drive the
// real confirmRenewal against the demo mock and read the escalations back.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { supabase } from '../supabaseClient';
import {
  listRenewals, listEscalations, confirmRenewal, createRenewal, declineRenewal, getLease,
} from '../api';
import { optionScheduleSteps } from '../renewals';

const LEASE = 'lease-1';        // Bright Coffee — no renewal options seeded, so it's ours
const TERM_END = '2027-12-31';
const OPTION_START = '2028-01-01';

// The demo store is a module-level singleton shared across the suite, so each test puts
// the lease back exactly as it found it rather than re-seeding.
const restore = async () => {
  const opts = await listRenewals(LEASE);
  for (const o of opts) await supabase.from('renewal_options').delete().eq('id', o.id);
  const escs = await listEscalations(LEASE);
  for (const e of escs) {
    if (String(e.effective_date) >= TERM_END) await supabase.from('rent_escalations').delete().eq('id', e.id);
  }
  await supabase.from('leases').update({ lease_termination_date: TERM_END, base_rent: 60000, is_active: true }).eq('id', LEASE);
  await supabase.from('history_events').delete().eq('lease_id', LEASE).in('type', ['renewal_confirmed', 'renewal_declined']);
  await supabase.from('notifications').delete().eq('lease_id', LEASE);
};

beforeEach(restore);
afterEach(restore);

const addOption = (rent_schedule) =>
  createRenewal({
    lease_id: LEASE,
    option_label: 'Option 1',
    term_months: 60,
    new_rent: rent_schedule?.[0]?.annual ?? null,
    rent_schedule,
    status: 'pending',
  });

const SCHEDULE = [
  { months_from_option_start: 0, annual: 66000 },
  { months_from_option_start: 12, annual: 68000 },
  { months_from_option_start: 24, annual: 70000 },
];

describe('optionScheduleSteps — the stored shape', () => {
  it('normalizes, sorts and drops rows that price nothing', () => {
    expect(optionScheduleSteps([
      { months_from_option_start: 24, annual: 70000 },
      { months_from_option_start: 0, annual: 66000 },
      { months_from_option_start: 12, annual: 0 },      // blank year — not a $0 rent
      { months_from_option_start: 36 },                  // no amount at all
    ])).toEqual([
      { off: 0, annual: 66000 },
      { off: 24, annual: 70000 },
    ]);
  });

  it('is empty for every option that carries no schedule', () => {
    expect(optionScheduleSteps(null)).toEqual([]);
    expect(optionScheduleSteps(undefined)).toEqual([]);
    expect(optionScheduleSteps([])).toEqual([]);
    expect(optionScheduleSteps('nonsense')).toEqual([]);
  });

  it('keeps the first row when two claim the same year', () => {
    expect(optionScheduleSteps([
      { months_from_option_start: 12, annual: 68000 },
      { months_from_option_start: 12, annual: 99999 },
    ])).toEqual([{ off: 12, annual: 68000 }]);
  });
});

describe('A pending option writes nothing to the rent ledger', () => {
  it('stores the schedule and leaves the escalations untouched', async () => {
    const before = await listEscalations(LEASE);
    await addOption(SCHEDULE);

    const opt = (await listRenewals(LEASE))[0];
    expect(opt.rent_schedule).toHaveLength(3);              // remembered…
    expect(await listEscalations(LEASE)).toHaveLength(before.length); // …and hidden

    // And the lease itself is untouched — an option is a possibility, not a change.
    const lease = await getLease(LEASE);
    expect(Number(lease.base_rent)).toBe(60000);
    expect(lease.lease_termination_date).toBe('2027-12-31');
  });
});

describe('Applying the option turns the schedule into real dated steps', () => {
  it('books one step per priced year, anchored to the option start', async () => {
    await addOption(SCHEDULE);
    const opt = (await listRenewals(LEASE))[0];

    // Confirmed well before the term ends → the future branch: the term extends, today's
    // rent is left alone, and the option's rents land as dated steps.
    const res = await confirmRenewal(opt.id, new Date('2026-07-30T12:00:00'), { acceptDecrease: true });
    expect(res?.needsTermEnd).toBeFalsy();
    expect(res?.needsDecreaseOk).toBeFalsy();

    const steps = (await listEscalations(LEASE))
      .filter((e) => e.effective_date >= OPTION_START)
      .map((e) => [e.effective_date, Number(e.new_base_rent)])
      .sort((a, b) => a[0].localeCompare(b[0]));

    // Year 1 starts the day AFTER the term ends — the tenant occupies through Dec 31 —
    // and each option year chains from there. These are the dates the dialog showed.
    expect(steps).toEqual([
      ['2028-01-01', 66000],
      ['2029-01-01', 68000],
      ['2030-01-01', 70000],
    ]);

    const lease = await getLease(LEASE);
    expect(lease.lease_termination_date).toBe('2032-12-31');  // +60 months
    expect(Number(lease.base_rent)).toBe(60000);              // today's rent is NOT moved
  });

  it('does not double-book a year the lease already prints a step for', async () => {
    // A lease whose imported schedule already carries the option years (Ricki's shape).
    await supabase.from('rent_escalations').insert({
      lease_id: LEASE, owner_id: 'demo-user', effective_date: '2029-01-01',
      escalation_type: 'manual', escalation_value: null, new_base_rent: 68000, status: 'scheduled',
    });
    await addOption(SCHEDULE);
    const opt = (await listRenewals(LEASE))[0];
    await confirmRenewal(opt.id, new Date('2026-07-30T12:00:00'), { acceptDecrease: true });

    const at2029 = (await listEscalations(LEASE)).filter((e) => e.effective_date === '2029-01-01');
    expect(at2029).toHaveLength(1);
  });

  it('leaves an option with no schedule behaving exactly as before', async () => {
    // Flat option, no schedule → the one year-1 step, nothing more. It is dated on the
    // term end itself, which is the pre-existing flat/+%-per-year convention — pinned
    // here so this round can be seen not to have moved it.
    await createRenewal({ lease_id: LEASE, option_label: 'Option 1', term_months: 60, new_rent: 66000, status: 'pending' });
    const opt = (await listRenewals(LEASE))[0];
    await confirmRenewal(opt.id, new Date('2026-07-30T12:00:00'), { acceptDecrease: true });

    const steps = (await listEscalations(LEASE))
      .filter((e) => String(e.effective_date) >= TERM_END)
      .map((e) => [e.effective_date, Number(e.new_base_rent)]);
    expect(steps).toEqual([[TERM_END, 66000]]);
  });

  it('declining the option takes its schedule with it — no orphaned steps', async () => {
    await addOption(SCHEDULE);
    const before = (await listEscalations(LEASE)).length;
    const opt = (await listRenewals(LEASE))[0];
    await declineRenewal(opt.id);

    expect((await listRenewals(LEASE))[0].status).toBe('declined');
    expect(await listEscalations(LEASE)).toHaveLength(before);
  });
});
