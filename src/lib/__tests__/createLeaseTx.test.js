// createLeaseFromExtraction now writes the lease + its escalations / renewals /
// abatements through the create_lease_tx RPC (one transaction) instead of four
// separate inserts. This verifies the whole bundle lands together (DEMO mocks the
// RPC the same way the SQL function behaves).

import { DEMO_MODE } from '../supabaseClient';
import {
  createCorporation, createProperty, createLeaseFromExtraction,
  listEscalations, listRenewals, listAbatements, getLease,
} from '../api';

beforeAll(() => { expect(DEMO_MODE).toBe(true); });

test('create_lease_tx lands the lease and all its child rows atomically', async () => {
  const corp = await createCorporation('TX Co, LLC');
  const prop = await createProperty({ corporation_id: corp.id, name: 'TX Plaza', address: '1 Main' });

  const lease = await createLeaseFromExtraction({
    propertyId: prop.id,
    leaseFileId: null,
    lease: {
      tenant_name: 'Atomic Tenant, LLC',
      square_footage: 2000,
      base_rent: 48000,
      lease_start: '2024-01-01',
      lease_termination_date: '2029-12-31',
    },
    escalations: [
      { effective_date: '2025-01-01', escalation_type: 'percent', escalation_value: 3, new_base_rent: 49440 },
      { effective_date: '2026-01-01', escalation_type: 'percent', escalation_value: 3, new_base_rent: 50923.2 },
    ],
    renewals: [{ option_label: 'Option 1', term_months: 60, new_rent: 55000, notice_by_date: '2029-06-30' }],
    abatements: [{ start_date: '2024-01-01', end_date: '2024-03-31', kind: 'free', value: null }],
    aiConfidence: 0.9,
    leaseText: 'LEASE …',
  });

  expect(lease).toBeTruthy();
  expect(lease.tenant_name).toBe('Atomic Tenant, LLC');
  expect(lease.source).toBe('ai_extracted');

  const escs = await listEscalations(lease.id);
  const rens = await listRenewals(lease.id);
  const abs = await listAbatements(lease.id);

  // Every child row carries the new lease_id and owner, proving the bundle inserted.
  expect(escs.length).toBeGreaterThanOrEqual(2);
  expect(escs.every((e) => e.lease_id === lease.id && e.owner_id)).toBe(true);
  expect(rens).toHaveLength(1);
  expect(rens[0].lease_id).toBe(lease.id);
  expect(rens[0].status).toBe('pending');
  expect(abs).toHaveLength(1);
  expect(abs[0].lease_id).toBe(lease.id);
  expect(abs[0].kind).toBe('free');
});
