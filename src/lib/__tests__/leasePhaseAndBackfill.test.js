// Token-free replay of the lease-page fixes George reported. No AI / Anthropic calls —
// pure functions + the in-memory demo client (no env keys → DEMO_MODE). Covers:
//   1) An addendum rent step now reaches the lease's base rent even when the committed
//      term already ended (the "$24,200 escalation applied but base rent unchanged" bug).
//   2) currentPhase reports the current slice (label / window / rent / next step), not
//      the lease from its original start.
//   3) The shared rent math annualizes a $/SF rate in CODE (base date + amount), the
//      same fix now used by the addendum extractor.
//   4) A pending renewal option whose term has lapsed stops prompting — an open
//      "Is X renewing?" prompt is cleared once the term end has passed.

import { DEMO_MODE, supabase } from '../supabaseClient';
import {
  createCorporation, createProperty, createLease, createAddendum, applyAddendum,
  createRenewal, promptDueRenewalDecisions, listNotifications,
  getLease, listEscalations,
} from '../api';
import { currentPhase } from '../leaseTerm';
import { rebuildRentSchedule } from '../../../supabase/functions/_shared/rentSchedule.js';

const TODAY = new Date('2026-07-01T12:00:00');

beforeAll(() => {
  // Guard: if real Supabase keys ever leak into the test env, fail loudly rather than
  // silently hammering the live backend.
  expect(DEMO_MODE).toBe(true);
});

test('an addendum rent step updates the base rent even when the term already ended', async () => {
  const corp = await createCorporation('Acme Holdings, LLC');
  const prop = await createProperty({ corporation_id: corp.id, name: 'Unit 5', building_sf: 1100 });
  const lease = await createLease({
    property_id: prop.id, tenant_name: 'Old Tenant', square_footage: 1100,
    base_rent: 20000, lease_start: '2018-01-01', lease_termination_date: '2023-12-31',
  });

  // A rider adds a rent step (Jun 1 2020 → $24,200) but does NOT extend the term. Before
  // the fix, backfill's expired branch marked the step "applied" but never wrote the rent.
  const add = await createAddendum({ lease_id: lease.id, label: 'Rent Rider', amendment_date: '2020-05-01', kind: 'rent_change' });
  await applyAddendum(add, {
    escalations: [{ effective_date: '2020-06-01', escalation_type: 'manual', new_base_rent: 24200 }],
    renewals: [],
  }, TODAY);

  const after = await getLease(lease.id);
  expect(Number(after.base_rent)).toBe(24200);   // now reflects the applied step
  expect(after.is_active).toBe(false);            // term ended, nothing carrying it → outdated
  const escs = await listEscalations(lease.id);
  expect(escs.find((e) => e.effective_date === '2020-06-01').status).toBe('applied');
});

describe('currentPhase', () => {
  const lease = { lease_start: '2021-10-01', lease_termination_date: '2026-09-30', base_rent: 43128, is_active: true };
  const escalations = [
    { effective_date: '2023-10-01', new_base_rent: 45276 },
    { effective_date: '2024-10-01', new_base_rent: 47436 },
  ];

  test('reports the current rent slice, the rent in effect, and the next step', () => {
    const addendums = [{ kind: 'extension', label: 'Second Lease Extension', amendment_date: '2021-01-18' }];
    const ph = currentPhase({ lease, escalations, renewals: [], addendums, today: new Date('2024-07-01T12:00:00') });
    expect(ph.label).toBe('Extended term — Second Lease Extension');
    expect(ph.phaseStart).toBe('2023-10-01');    // latest step on/before today, not the 2021 start
    expect(ph.rent).toBe(45276);
    expect(ph.nextStep).toEqual({ date: '2024-10-01', rent: 47436 });
    expect(ph.termEnd).toBe('2026-09-30');
  });

  test('before any step, falls back to the lease start + base rent (Original term)', () => {
    const ph = currentPhase({ lease, escalations: [], renewals: [], addendums: [], today: new Date('2022-01-01T12:00:00') });
    expect(ph.label).toBe('Original term');
    expect(ph.phaseStart).toBe('2021-10-01');
    expect(ph.rent).toBe(43128);
    expect(ph.nextStep).toBeNull();
  });
});

describe('rebuildRentSchedule — the addendum $/SF fix (math in code)', () => {
  test('annualizes a $/SF/year rate and reports the base row date', () => {
    const { baseRent, baseDate } = rebuildRentSchedule({
      rentSchedule: [{ effective_date: '2020-06-01', amount: 22, period: 'per_sqft_year' }],
      sqft: 1100,
    });
    expect(baseDate).toBe('2020-06-01');
    expect(baseRent).toBe(24200); // 22 × 1100, to the cent — never the model's own multiply
  });

  test('annualizes a $/SF/month rate as rate × sqft × 12', () => {
    const { baseRent } = rebuildRentSchedule({
      rentSchedule: [{ effective_date: '2020-06-01', amount: 1.8333, period: 'per_sqft_month' }],
      sqft: 1100,
    });
    expect(baseRent).toBeCloseTo(24199.56, 2); // 1.8333 × 1100 × 12
  });
});

test('a lapsed renewal option stops prompting — an open decision is cleared', async () => {
  const corp = await createCorporation('Lapsed Holdings, LLC');
  const prop = await createProperty({ corporation_id: corp.id, name: 'Suite 9', building_sf: 1000 });
  // Term already ended before "today" (2026-07-01).
  const lease = await createLease({
    property_id: prop.id, tenant_name: 'Gone Tenant', square_footage: 1000,
    base_rent: 24000, lease_start: '2019-01-01', lease_termination_date: '2024-12-31',
  });
  await createRenewal({ lease_id: lease.id, option_label: 'Option 1', term_months: 60, annual_escalation_pct: 5, status: 'pending' });

  // A prompt was dropped earlier, while the option was still live.
  await supabase.from('notifications').insert({
    owner_id: 'demo-user', lease_id: lease.id, property_id: prop.id,
    corporation_id: prop.corporation_id, kind: 'renewal_decision',
    title: `Is ${lease.tenant_name} renewing?`, body: 'A renewal option is due.', read: false,
  });

  await promptDueRenewalDecisions(TODAY);

  const open = (await listNotifications()).filter((n) => n.lease_id === lease.id && n.kind === 'renewal_decision');
  expect(open).toHaveLength(0); // lapsed → the stale prompt is cleared, none re-created
});
