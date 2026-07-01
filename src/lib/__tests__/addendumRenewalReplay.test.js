// Token-free replay of George's real Vibhakar / D&D lease documents through the
// FIXED apply pipeline. No AI / Anthropic calls — the extraction was never the bug;
// this exercises the apply + term logic that was. Runs against the in-memory demo
// client (no env keys in test → DEMO_MODE), so it costs nothing and is deterministic.
//
// Proves the two things George flagged:
//   1) A renewal OPTION (Second Extension §4, 2026→2031) never extends the committed
//      term — it stays Pending and the term stays Sep 30 2026.
//   2) A committed EXTENSION moves the term directly and never spawns a phantom
//      "extension-as-renewal" row.
// Plus: confirming the option is what rolls the term to 2031.

import { DEMO_MODE } from '../supabaseClient';
import {
  createCorporation, createProperty, createLease, createAddendum, applyAddendum,
  getLease, listRenewals, listEscalations, confirmRenewal,
} from '../api';

// Pin "today" so assertions don't depend on the wall clock (George's context date).
const TODAY = new Date('2026-07-01T12:00:00');

async function freshLease() {
  const corp = await createCorporation('NASA Property, LLC');
  const prop = await createProperty({ corporation_id: corp.id, name: '3902 S Harlem Ave', address: 'Lyons, IL 60534', building_sf: 2156 });
  // Doc 1 — Original Store Lease + Rider: Vibhakar & Vibhakar, PC, Oct 2001 → Sep
  // 2011, base rent $18/SF × 2156 SF = $38,808/yr.
  const lease = await createLease({
    property_id: prop.id,
    tenant_name: 'Vibhakar & Vibhakar, PC',
    tenant_contact_name: 'Kamal Vibhakar',
    square_footage: 2156,
    base_rent: 38808,
    lease_start: '2001-10-01',
    lease_termination_date: '2011-09-30',
  });
  return lease;
}

// Mirror what AddendumEditor.formToChanges() would hand applyAddendum for each doc —
// derived by hand from the documents, so no AI call is needed.
async function applyDoc(leaseId, meta, changes) {
  const add = await createAddendum({ lease_id: leaseId, ...meta });
  return applyAddendum(add, changes, TODAY);
}

// Doc 1 (First Lease Extension, 2011): committed extension to Sep 2021 + rent steps.
const FIRST_EXTENSION = [
  { label: 'First Lease Extension', amendment_date: '2011-01-01', kind: 'extension', summary: 'Extends the term to 2021' },
  {
    extensionEnd: '2021-09-30', newRent: 42000, // $3,500/mo from Oct 2011
    escalations: [{ effective_date: '2012-10-01', escalation_type: 'manual', new_base_rent: 48000 }], // $4,000/mo
    renewals: [],
  },
];

// Doc 2 (Second Lease Extension, Jan 2021): committed extension to Sep 2026 + three
// rent steps, PLUS the Section 4 renewal OPTION (5 yrs, 5%/yr) — a right, not a deal.
const SECOND_EXTENSION = [
  { label: 'Second Lease Extension', amendment_date: '2021-01-18', kind: 'extension', summary: 'Extends the term to 2026; adds a 5-year renewal option at 5%/yr' },
  {
    extensionEnd: '2026-09-30', newRent: 43128, // $3,594/mo ($20/SF) from Oct 2021
    escalations: [
      { effective_date: '2023-10-01', escalation_type: 'manual', new_base_rent: 45276 }, // $21/SF
      { effective_date: '2024-10-01', escalation_type: 'manual', new_base_rent: 47436 }, // $22/SF
    ],
    renewals: [
      { option_label: 'Option to Renew for One (1) Term of Five (5) Years', term_months: 60, annual_escalation_pct: 5, new_rent: null, notice_by_date: null },
    ],
  },
];

beforeAll(() => {
  // Guard: if real Supabase keys ever leak into the test env, fail loudly rather
  // than silently hammering the live backend.
  expect(DEMO_MODE).toBe(true);
});

test('a renewal option never extends the committed term; extensions move it directly', async () => {
  const lease = await freshLease();

  await applyDoc(lease.id, ...FIRST_EXTENSION);
  await applyDoc(lease.id, ...SECOND_EXTENSION);

  const after = await getLease(lease.id);
  const renewals = await listRenewals(lease.id);

  // Committed term is Sep 30 2026 — NOT 2031 (the un-exercised option's end).
  expect(after.lease_termination_date).toBe('2026-09-30');
  expect(after.is_active).toBe(true);

  // As of Jul 2026 the tenant is in the Oct-2024 step: $22/SF × 2156 = $47,436/yr.
  expect(Number(after.base_rent)).toBe(47436);

  // Exactly ONE renewal row — the real option — and it is still Pending. No phantom
  // "extension-as-renewal" rows (the old bug produced a duplicate 180-mo row).
  expect(renewals).toHaveLength(1);
  expect(renewals[0].status).toBe('pending');
  expect(renewals[0].term_months).toBe(60);
});

test('confirming the option is what rolls the term forward to 2031', async () => {
  const lease = await freshLease();
  await applyDoc(lease.id, ...FIRST_EXTENSION);
  await applyDoc(lease.id, ...SECOND_EXTENSION);

  const [option] = await listRenewals(lease.id);
  await confirmRenewal(option.id, TODAY);

  const after = await getLease(lease.id);
  const renewals = await listRenewals(lease.id);

  // Now — and only now — the committed term reaches Sep 30 2031.
  expect(after.lease_termination_date).toBe('2031-09-30');
  expect(renewals[0].status).toBe('applied');

  // The +5%/yr option materialized dated rent steps for years 2..5 of the new term.
  const escs = await listEscalations(lease.id);
  const renewalSteps = escs.filter((e) => e.escalation_type === 'percent' && Number(e.escalation_value) === 5);
  expect(renewalSteps.length).toBe(4);
});
