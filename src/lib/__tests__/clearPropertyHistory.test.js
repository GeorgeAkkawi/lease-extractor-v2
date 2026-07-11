// "Clear history" (History page) — clearPropertyHistory must wipe ONE property's
// activity timeline (history_events) and nothing else: the other property's timeline
// and the "Expired & renewed leases" archive stay untouched. Runs against the
// in-memory demo client (no env keys in test → DEMO_MODE), so it's deterministic.

import { DEMO_MODE } from '../supabaseClient';
import {
  createCorporation, createProperty,
  logHistoryEvent, listHistoryEvents, clearPropertyHistory,
  logInsuranceRequest, listInsuranceRequests, listExpiredLeases,
} from '../api';

async function freshProperty(name) {
  const corp = await createCorporation(`${name} Holdings`);
  return createProperty({ corporation_id: corp.id, name, address: '1 Main St', building_sf: 1000 });
}

test('clearPropertyHistory wipes only that property timeline', async () => {
  expect(DEMO_MODE).toBe(true);

  const propA = await freshProperty('Prop A');
  const propB = await freshProperty('Prop B');

  await logHistoryEvent({ property_id: propA.id, lease_id: null, type: 'term_extended', description: 'Term extended to 2030', tenant_name: 'Tenant A1' });
  await logHistoryEvent({ property_id: propA.id, lease_id: null, type: 'renewal_confirmed', description: 'Renewal confirmed', tenant_name: 'Tenant A2' });
  await logInsuranceRequest({ propertyId: propA.id, leaseId: 'lease-clear-test', tenantName: 'Tenant A1', to: 'a1@example.com', subject: 'Certificate' });
  await logHistoryEvent({ property_id: propB.id, lease_id: null, type: 'tenant_assigned', description: 'Assigned to new tenant', tenant_name: 'Tenant B1' });

  expect((await listHistoryEvents(propA.id)).length).toBe(3);
  expect((await listHistoryEvents(propB.id)).length).toBe(1);
  expect((await listInsuranceRequests('lease-clear-test')).length).toBe(1);

  await clearPropertyHistory(propA.id);

  // Prop A's timeline is gone — including its insurance-request trail…
  expect(await listHistoryEvents(propA.id)).toEqual([]);
  expect(await listInsuranceRequests('lease-clear-test')).toEqual([]);
  // …but Prop B's timeline is untouched.
  const bEvents = await listHistoryEvents(propB.id);
  expect(bEvents.length).toBe(1);
  expect(bEvents[0].description).toBe('Assigned to new tenant');
});

test('clearPropertyHistory leaves the expired-lease archive alone', async () => {
  expect(DEMO_MODE).toBe(true);

  // The demo seed archives 2 expired leases on prop-1 (Maple Plaza).
  const before = await listExpiredLeases('prop-1');
  expect(before.length).toBeGreaterThan(0);

  await clearPropertyHistory('prop-1');

  expect((await listHistoryEvents('prop-1')).length).toBe(0);
  expect((await listExpiredLeases('prop-1')).length).toBe(before.length);
});
