// Token-free replay of the renewal-option ↔ rent-schedule sync (Ricki's Cafe). No AI —
// pure functions + the in-memory demo client (no env keys → DEMO_MODE). The lease prints
// rents for ALL 20 years (initial term + three 5-year option periods), so its rent schedule
// steps right through option windows the tenant evidently exercised — yet the option rows
// stayed "Pending" with no rent / no notice date, and a long-past option still showed
// Renew/Not-renewing. reconcileRenewalOptions reads that evidence and syncs the options.

import { DEMO_MODE, supabase } from '../supabaseClient';
import {
  createCorporation, createProperty, createLeaseFromExtraction,
  reconcileRenewalOptions, createRenewal, getLease, listRenewals, listEscalations,
} from '../api';
import { currentTermLabel } from '../leaseTerm';

const NOTES_180 = 'Lessee must give written notice to renew no later than 180 days prior to the expiration of the Original Term or the Option Period then in effect';
const TODAY = new Date('2026-07-02T12:00:00'); // matches the live situation

beforeAll(() => { expect(DEMO_MODE).toBe(true); });

// Build a lease shaped like the live Ricki's row: start 2015-05-01, 60-mo initial term,
// annual rent steps dated through 2034, three pending 5-year options with the "180 days
// prior" notes and no rent / no notice date.
async function seedRickis({ termEnd = '2031-05-01', withFile = true, options = 3 } = {}) {
  const corp = await createCorporation("Ricki's Holdings, LLC");
  const prop = await createProperty({ corporation_id: corp.id, name: 'End-cap', building_sf: 13750 });

  const annual = [
    22800, 23256, 23721.12, 24195.6, 24679.44, // yrs 1-5 (initial term)
    25173, 25676.52, 26190, 26713.8, 27248.16, // yrs 6-10 (option 1)
    27793.08, 28348.92, 28915.92, 29494.2, 30084.12, // yrs 11-15 (option 2)
    30685.8, 31299.48, 31925.52, 32564.04, 33215.28, // yrs 16-20 (option 3)
  ];
  const escalations = annual.slice(1).map((rent, i) => ({
    effective_date: null, months_from_start: (i + 1) * 12, escalation_type: 'manual', escalation_value: null, new_base_rent: rent,
  }));

  let leaseFileId = null;
  if (withFile) {
    const { data: fileRow } = await supabase.from('lease_files')
      .insert({ owner_id: 'demo-user', storage_path: 'x/rickis.pdf', original_filename: "Ricki's.pdf", extraction_raw: { term_months: { value: 60 } } })
      .select().single();
    leaseFileId = fileRow.id;
  }

  const lease = await createLeaseFromExtraction({
    propertyId: prop.id, leaseFileId,
    lease: { tenant_name: "Ricki's-Lyons, LLC", square_footage: 1180, base_rent: 22800, lease_start: '2015-05-01', lease_termination_date: termEnd },
    escalations: escalations.map((e) => ({ effective_date: __import_anchor('2015-05-01', e.months_from_start), escalation_type: 'manual', escalation_value: null, new_base_rent: e.new_base_rent })),
    renewals: [], abatements: [], aiConfidence: null, leaseText: null,
  });
  for (let i = 0; i < options; i++) {
    await createRenewal({ lease_id: lease.id, option_label: ['First', 'Second', 'Third'][i] + ' Option Period', term_months: 60, notes: NOTES_180, status: 'pending' });
  }
  // Options are added after import (as in the real app, where the sync runs on app load via
  // promptDueRenewalDecisions). Trigger the same reconcile with a fixed "today".
  await reconcileRenewalOptions(await getLease(lease.id), TODAY);
  return await getLease(lease.id);
}

// Local re-implementation of buildEscalations' anchoring (avoid importing to keep the
// fixture explicit): start + N months, first-of-month.
function __import_anchor(start, months) {
  const d = new Date(start + 'T12:00:00');
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

test('marks exercised options applied, fills the future option rent + notice date', async () => {
  const lease = await seedRickis();               // createLeaseFromExtraction already back-fills → reconciles
  const rens = (await listRenewals(lease.id)).sort((a, b) => a.option_label.localeCompare(b.option_label));

  const first = rens.find((r) => r.option_label.startsWith('First'));
  const second = rens.find((r) => r.option_label.startsWith('Second'));
  const third = rens.find((r) => r.option_label.startsWith('Third'));

  // Option 1 window 2020-05→2025-05 (past) + Option 2 window 2025-05→2030-05 (contains today)
  // both have matching rent steps → applied with the step's rent.
  expect(first.status).toBe('applied');
  expect(Number(first.new_rent)).toBe(25173);
  expect(second.status).toBe('applied');
  expect(Number(second.new_rent)).toBe(27793.08);

  // Option 3 is still future → stays pending, but gets its rent + a real notice-by date
  // (committed term end 2031-05-01 − 180 days).
  expect(third.status).toBe('pending');
  expect(Number(third.new_rent)).toBe(30685.8);
  expect(third.notice_by_date).toBe('2030-11-02');
});

test('the header phase label follows the exercised option (Second Option Period)', async () => {
  const lease = await seedRickis();
  const rens = await listRenewals(lease.id);
  expect(currentTermLabel(lease, rens, [])).toBe('Second Option Period');
});

test('committed term end is preserved (never shrunk below the landlord-entered date)', async () => {
  const lease = await seedRickis({ termEnd: '2031-05-01' });
  const after = await getLease(lease.id);
  expect(after.lease_termination_date).toBe('2031-05-01'); // kept — window ends 2030-05-01 < 2031
});

test('a too-short committed end is extended to cover the option in effect today', async () => {
  // Landlord entered an end (2027-05-01) that falls inside the option-2 window; reconcile
  // extends it to that window's boundary so the header/term reflect where the lease is now.
  const lease = await seedRickis({ termEnd: '2027-05-01' });
  const after = await getLease(lease.id);
  expect(after.lease_termination_date).toBe('2030-05-01'); // option-2 window boundary
});

test('idempotent — re-running does not change already-applied options or duplicate history', async () => {
  const lease = await seedRickis();
  const before = await listRenewals(lease.id);
  const changed = await reconcileRenewalOptions(await getLease(lease.id), TODAY);
  expect(changed).toBe(false); // options no longer all-pending → whole lease skipped
  const after = await listRenewals(lease.id);
  expect(after.filter((r) => r.status === 'applied')).toHaveLength(before.filter((r) => r.status === 'applied').length);
});

test('guard: a manually-entered lease (no cached file) is left untouched', async () => {
  const lease = await seedRickis({ withFile: false });
  const rens = await listRenewals(lease.id);
  expect(rens.every((r) => r.status === 'pending')).toBe(true); // no evidence source → no changes
});

test('guard: no rent evidence past the initial term → options stay pending (never guess)', async () => {
  const corp = await createCorporation('Vibhakar Holdings, LLC');
  const prop = await createProperty({ corporation_id: corp.id, name: 'Suite 2', building_sf: 2000 });
  const { data: fileRow } = await supabase.from('lease_files')
    .insert({ owner_id: 'demo-user', storage_path: 'x/v.pdf', original_filename: 'V.pdf', extraction_raw: { term_months: { value: 60 } } })
    .select().single();
  // Active lease (term end 2028, in the future) but the rent schedule stops WITHIN the
  // initial term — no step past 2028-05-01, so nothing proves the option was exercised.
  const lease = await createLeaseFromExtraction({
    propertyId: prop.id, leaseFileId: fileRow.id,
    lease: { tenant_name: 'Vibhakar, PC', square_footage: 2000, base_rent: 40000, lease_start: '2023-05-01', lease_termination_date: '2028-05-01' },
    escalations: [
      { effective_date: '2024-05-01', escalation_type: 'manual', escalation_value: null, new_base_rent: 41000 },
      { effective_date: '2025-05-01', escalation_type: 'manual', escalation_value: null, new_base_rent: 42000 },
    ],
    renewals: [], abatements: [], aiConfidence: null, leaseText: null,
  });
  await createRenewal({ lease_id: lease.id, option_label: 'First Option Period', term_months: 60, notes: NOTES_180, status: 'pending' });
  const changed = await reconcileRenewalOptions(await getLease(lease.id), TODAY);
  expect(changed).toBe(false); // no escalation past the initial term end → evidence gate fails
  const rens = await listRenewals(lease.id);
  expect(rens.every((r) => r.status === 'pending')).toBe(true);
});
