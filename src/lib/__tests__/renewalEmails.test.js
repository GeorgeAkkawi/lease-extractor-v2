// Token-free replay of the three tenant renewal emails. No AI / Anthropic calls — the
// letters are generated in code. Runs against the in-memory demo client (no env keys →
// DEMO_MODE), so it's deterministic and costs nothing.
//
// Covers the flow George asked for:
//   1) APPROACHING — a "renewal is coming up" tenant email is attached to the
//      "Is X renewing?" decision prompt the moment it becomes due.
//   1b) A bare prompt (as the SQL cron drops it, with no email) gets enriched on the
//       next pass — and is never duplicated.
//   2) RENEWED — confirming carries the existing "lease renewed" email.
//   3) NOT RENEWED — declining drops a "not renewing" notice with a lease-end email;
//      undoing the decline removes that stale notice and reopens the prompt.

import { DEMO_MODE, supabase } from '../supabaseClient';
import {
  createCorporation, updateCorporation, createProperty, createLease, createRenewal,
  promptDueRenewalDecisions, confirmRenewal, declineRenewal, restoreRenewal,
  listNotifications, listRenewals,
} from '../api';

// Pin "today" so due-ness doesn't depend on the wall clock. Term ends 2026-09-30, so a
// decision is due from ~2026-06-30 (3 months before) — July 1 is inside the window.
const TODAY = new Date('2026-07-01T12:00:00');

async function seedDueLease() {
  const corp = await createCorporation('Test Holdings, LLC');
  await updateCorporation(corp.id, {
    address: '1 Main St, Chicago, IL', contact_email: 'owner@test.com', contact_phone: '555-1000',
  });
  const prop = await createProperty({ corporation_id: corp.id, name: 'Suite 200', address: '1 Main St', building_sf: 1000 });
  const lease = await createLease({
    property_id: prop.id,
    tenant_name: 'Acme Corp',
    tenant_contact_name: 'Jane Doe',
    tenant_email: 'jane@acme.com',
    tenant_email_2: 'ap@acme.com',
    square_footage: 1000,
    base_rent: 24000,
    lease_start: '2021-10-01',
    lease_termination_date: '2026-09-30',
  });
  await createRenewal({
    lease_id: lease.id, option_label: 'Option 1', term_months: 60,
    annual_escalation_pct: 5, new_rent: null, notice_by_date: null, status: 'pending',
  });
  return { corp, prop, lease };
}

const decisionFor = async (leaseId) =>
  (await listNotifications()).find((n) => n.lease_id === leaseId && n.kind === 'renewal_decision');
const declinedFor = async (leaseId) =>
  (await listNotifications()).find((n) => n.lease_id === leaseId && n.kind === 'renewal_declined');
const appliedFor = async (leaseId) =>
  (await listNotifications()).find((n) => n.lease_id === leaseId && n.kind === 'renewal_applied');

beforeAll(() => {
  // Guard: if real Supabase keys ever leak into the test env, fail loudly rather than
  // silently hammering the live backend.
  expect(DEMO_MODE).toBe(true);
});

test('the decision prompt carries the "renewal approaching" tenant email', async () => {
  const { lease } = await seedDueLease();

  await promptDueRenewalDecisions(TODAY);

  const prompt = await decisionFor(lease.id);
  expect(prompt).toBeTruthy();
  expect(prompt.email_subject).toMatch(/Upcoming Lease Renewal/);
  expect(prompt.email_body).toMatch(/approaching its end/);
  expect(prompt.email_to).toBe('jane@acme.com');
  expect(prompt.email_to_2).toBe('ap@acme.com');
  expect(prompt.email_from).toBe('owner@test.com');
});

test('a bare (cron-created) prompt is enriched with the email and not duplicated', async () => {
  const { lease, prop } = await seedDueLease();

  // Simulate the SQL cron: drop a renewal_decision with NO email fields.
  await supabase.from('notifications').insert({
    owner_id: 'demo-user', lease_id: lease.id, property_id: prop.id,
    corporation_id: prop.corporation_id, kind: 'renewal_decision',
    title: `Is ${lease.tenant_name} renewing?`, body: 'A renewal option is due.', read: false,
  });

  await promptDueRenewalDecisions(TODAY);

  const prompts = (await listNotifications()).filter((n) => n.lease_id === lease.id && n.kind === 'renewal_decision');
  expect(prompts).toHaveLength(1); // enriched in place, not duplicated
  expect(prompts[0].email_body).toMatch(/approaching its end/);
});

test('confirming a renewal carries the "lease renewed" tenant email', async () => {
  const { lease } = await seedDueLease();
  const [option] = await listRenewals(lease.id);

  await confirmRenewal(option.id, TODAY);

  const applied = await appliedFor(lease.id);
  expect(applied).toBeTruthy();
  expect(applied.email_subject).toMatch(/Lease Renewal Confirmation/);
  expect(applied.email_body).toMatch(/has been renewed/);
  expect(applied.email_to).toBe('jane@acme.com');
  // the open decision prompt is cleared once confirmed
  expect(await decisionFor(lease.id)).toBeFalsy();
});

test('declining drops a "not renewing" notice with a lease-end email; undo clears it', async () => {
  const { lease } = await seedDueLease();
  await promptDueRenewalDecisions(TODAY);
  const [option] = await listRenewals(lease.id);

  await declineRenewal(option.id);

  const declined = await declinedFor(lease.id);
  expect(declined).toBeTruthy();
  expect(declined.email_subject).toMatch(/Notice of Lease Expiration/);
  expect(declined.email_body).toMatch(/will not be renewed/);
  expect(declined.email_to).toBe('jane@acme.com');
  // the decision prompt is gone once decided
  expect(await decisionFor(lease.id)).toBeFalsy();

  // Undo: the stale "not renewing" notice is removed and the decision reopens.
  await restoreRenewal(option.id);
  expect(await declinedFor(lease.id)).toBeFalsy();
  expect((await listRenewals(lease.id))[0].status).toBe('pending');
  expect(await decisionFor(lease.id)).toBeTruthy();
});
