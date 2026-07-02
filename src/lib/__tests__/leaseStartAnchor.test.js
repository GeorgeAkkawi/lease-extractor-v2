// Token-free replay of the "no start date on file → landlord enters it → the whole rent
// schedule dates itself" flow (Ricki's Cafe lease). No AI / Anthropic calls — pure
// functions + the in-memory demo client (no env keys → DEMO_MODE). Covers:
//   1) The supplement's relative rent table (per-month rows labeled by lease year, NO
//      printed dates) rebuilds to base + undated steps carrying months_from_start.
//   2) Saving a lease with no start date keeps everything: the undated steps aren't
//      inserted (they can't be placed yet) but the full read stays cached on lease_files.
//   3) anchorLeaseSchedule(start) dates every step off the entered start, fills the end
//      date from term_months, and rolls the current rent forward.
//   4) Guard: re-running never duplicates steps or overwrites ones already on the lease.

import { DEMO_MODE, supabase } from '../supabaseClient';
import {
  createCorporation, createProperty, createLeaseFromExtraction,
  buildEscalations, anchorLeaseSchedule, getLease, listEscalations,
} from '../api';
import { rebuildRentSchedule } from '../../../supabase/functions/_shared/rentSchedule.js';

beforeAll(() => {
  // Guard: if real Supabase keys ever leak into the test env, fail loudly rather than
  // silently hammering the live backend.
  expect(DEMO_MODE).toBe(true);
});

// Ricki's Year 1–5 base rent, printed only as a monthly dollar per lease year (no dates).
const RICKIS_RAW = {
  base_rent: { value: 22800 },   // Year 1: $1,900/mo × 12 (rebuilt in code below)
  term_months: { value: 60 },
  escalations: [
    { effective_date: null, months_from_start: 12, escalation_type: 'manual', escalation_value: null, new_base_rent: 23256 },
    { effective_date: null, months_from_start: 24, escalation_type: 'manual', escalation_value: null, new_base_rent: 23721.12 },
    { effective_date: null, months_from_start: 36, escalation_type: 'manual', escalation_value: null, new_base_rent: 24195.6 },
    { effective_date: null, months_from_start: 48, escalation_type: 'manual', escalation_value: null, new_base_rent: 24679.44 },
  ],
  abatements: [],
};

test('a lease-year rent table (no dates) rebuilds to base + undated relative steps', () => {
  const { baseRent, baseDate, escalations } = rebuildRentSchedule({
    rentSchedule: [
      { effective_date: null, months_from_start: 0, amount: 1900, period: 'per_month' },
      { effective_date: null, months_from_start: 12, amount: 1938, period: 'per_month' },
      { effective_date: null, months_from_start: 24, amount: 1976.76, period: 'per_month' },
    ],
    sqft: 1180,
  });
  expect(baseRent).toBe(22800);      // 1900 × 12, in code
  expect(baseDate).toBeNull();       // relative mode — no printed dates
  expect(escalations).toHaveLength(2);
  expect(escalations[0]).toMatchObject({ effective_date: null, months_from_start: 12, new_base_rent: 23256 });
});

async function seedStartlessLease() {
  const corp = await createCorporation("Ricki's Holdings, LLC");
  const prop = await createProperty({ corporation_id: corp.id, name: 'End-cap', building_sf: 13750 });
  // The edge function persists the raw AI read onto the lease_files row.
  const { data: fileRow } = await supabase
    .from('lease_files')
    .insert({ owner_id: 'demo-user', storage_path: 'x/rickis.pdf', original_filename: "Ricki's Cafe Lease.pdf", extraction_raw: RICKIS_RAW })
    .select()
    .single();
  // Saved with NO start date: buildEscalations(…, null) drops the undated steps.
  const lease = await createLeaseFromExtraction({
    propertyId: prop.id,
    leaseFileId: fileRow.id,
    lease: { tenant_name: "Ricki's – Lyons, LLC", square_footage: 1180, base_rent: 22800, lease_start: null, lease_termination_date: null },
    escalations: buildEscalations(22800, RICKIS_RAW.escalations, null),
    renewals: [],
    abatements: [],
    aiConfidence: null,
    leaseText: null,
  });
  return lease;
}

test('saving with no start date keeps the lease + cached read, but leaves steps undated', async () => {
  const lease = await seedStartlessLease();
  expect(lease.lease_start == null).toBe(true);
  const escs = await listEscalations(lease.id);
  expect(escs).toHaveLength(0);              // undated steps can't be placed yet — not inserted
  // The full read survives on the linked lease_files row (the "cache").
  const { data: fileRow } = await supabase.from('lease_files').select('*').eq('id', lease.lease_file_id).single();
  expect(fileRow.extraction_raw.escalations).toHaveLength(4);
});

test('anchorLeaseSchedule dates the whole schedule from the entered start + term', async () => {
  const lease = await seedStartlessLease();

  const after = await anchorLeaseSchedule(lease.id, '2016-01-01');

  // Start recorded; end filled from term_months (60 mo → through the day before +60mo).
  expect(after.lease_start).toBe('2016-01-01');
  expect(after.lease_termination_date).toBe('2020-12-31');

  // Every relative step now carries a real date anchored to the start.
  const escs = await listEscalations(lease.id);
  expect(escs.map((e) => e.effective_date).sort()).toEqual(['2017-01-01', '2018-01-01', '2019-01-01', '2020-01-01']);

  // Term is long past "now", so the lease rolls to outdated at its last-known rent.
  expect(after.is_active).toBe(false);
  expect(Number(after.base_rent)).toBeCloseTo(24679.44, 2);
});

test('re-anchoring never duplicates steps or overwrites ones already on the lease', async () => {
  const lease = await seedStartlessLease();
  await anchorLeaseSchedule(lease.id, '2016-01-01');
  const first = await listEscalations(lease.id);
  expect(first).toHaveLength(4);

  // Landlord corrects the start date later. Steps already exist → guard skips re-insert;
  // it just moves the start date, leaving the (already-dated) steps untouched.
  const after = await anchorLeaseSchedule(lease.id, '2016-06-01');
  const second = await listEscalations(lease.id);
  expect(second).toHaveLength(4);            // no duplicates
  expect(after.lease_start).toBe('2016-06-01');
  expect(second.map((e) => e.effective_date).sort()).toEqual(['2017-01-01', '2018-01-01', '2019-01-01', '2020-01-01']);
});
