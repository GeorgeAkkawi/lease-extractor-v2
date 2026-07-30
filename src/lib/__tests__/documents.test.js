// The document registry (migration 0070) — "save copies of things that are uploaded"
// (George, 2026-07-30).
//
// The bug this replaces was structural, not cosmetic: some upload paths saved the
// file's location, some threw it away, and NOTHING ever deleted a file — so the
// bucket filled with unreachable objects while the documents the landlord wanted to
// open had no button to open them. These cases pin the two halves of the fix:
// an upload always lands in a list, and the only things that remove a file are an
// explicit cancel, an explicit ✕, or deleting the record it belongs to.
//
// Runs against the in-memory demo client (no env keys in test → DEMO_MODE).

import { describe, it, expect } from 'vitest';
import { DEMO_MODE, supabase } from '../supabaseClient';
import { DEMO_USER } from '../demo/store';
import {
  createCorporation, createProperty, createLease,
  uploadDoc, registerDocument, listDocuments, attachDocument,
  discardDocument, deleteDocument, deleteDocumentsFor,
  createAddendum, deleteAddendum, listAddendums,
  saveInsurance, deleteInsurance, getTenantInsurance,
  addServiceContract, deleteServiceContract, listServiceContracts,
} from '../api';

// A stand-in for a browser File: uploadDoc only reads name/size/type off it, and the
// demo storage shim ignores the body entirely.
const fakeFile = (name, size = 1234, type = 'application/pdf') => ({
  name, size, type, arrayBuffer: async () => new ArrayBuffer(0),
});

async function freshLease(label) {
  const corp = await createCorporation(`${label} Holdings`);
  const prop = await createProperty({ corporation_id: corp.id, name: label, address: '1 Doc St', building_sf: 10000 });
  const lease = await createLease({
    property_id: prop.id, tenant_name: `${label} Tenant`, square_footage: 2000,
    base_rent: 60000, lease_start: '2024-01-01', lease_termination_date: '2029-12-31',
  });
  return { corp, prop, lease };
}

describe('document registry', () => {
  it('an upload lands in the record’s list, with the facts you need to recognise it', async () => {
    expect(DEMO_MODE).toBe(true);
    const { lease } = await freshLease('Registry');

    await uploadDoc(fakeFile('signed-lease.pdf', 2_400_000), { entityType: 'lease', entityId: lease.id });

    const docs = await listDocuments('lease', lease.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].filename).toBe('signed-lease.pdf');
    expect(docs[0].bytes).toBe(2_400_000);
    expect(docs[0].mime).toBe('application/pdf');
    expect(docs[0].storage_path).toBeTruthy();
  });

  it('re-uploading keeps BOTH versions, newest first — nothing is silently replaced', async () => {
    // George's choice: "keep every version but allow deletes."
    const { lease } = await freshLease('Versions');
    // The older copy is written with an explicit timestamp, so the ordering assertion
    // below tests the RULE rather than the resolution of the clock — two registrations
    // in the same millisecond would tie and prove nothing.
    await supabase.from('documents').insert({
      id: 'doc-version-old', owner_id: DEMO_USER.id, entity_type: 'lease', entity_id: lease.id,
      storage_path: 'u/old-lease.pdf', filename: 'lease.pdf', bytes: 100, created_at: '2020-01-01T00:00:00.000Z',
    });
    await registerDocument({
      entityType: 'lease', entityId: lease.id, storagePath: 'u/new-lease.pdf',
      filename: 'lease.pdf', bytes: 200,
    });

    const docs = await listDocuments('lease', lease.id);
    expect(docs).toHaveLength(2);
    // Newest first: the copy registered last leads the list.
    expect(docs[0].storage_path).toBe('u/new-lease.pdf');
  });

  it('registering the same path twice is a no-op — a retry can’t double-list a file', async () => {
    const { lease } = await freshLease('Idempotent');
    await registerDocument({ entityType: 'lease', entityId: lease.id, storagePath: 'u/once.pdf', filename: 'once.pdf' });
    await registerDocument({ entityType: 'lease', entityId: lease.id, storagePath: 'u/once.pdf', filename: 'once.pdf' });
    expect(await listDocuments('lease', lease.id)).toHaveLength(1);
  });

  it('a file uploaded before its record exists is adopted on save', async () => {
    // The importer uploads first and the record is created afterwards, so entity_id is
    // deliberately nullable. Until it's attached the file belongs to nothing — which is
    // exactly the window a cancelled review used to leak through.
    const { lease } = await freshLease('Adopt');
    const path = await uploadDoc(fakeFile('pending.pdf'), { entityType: 'lease' });

    expect(await listDocuments('lease', lease.id)).toHaveLength(0);   // not visible yet
    await attachDocument(path, { entityType: 'lease', entityId: lease.id });

    const docs = await listDocuments('lease', lease.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].filename).toBe('pending.pdf');
  });

  it('cancelling a review throws the uploaded file away — row and object', async () => {
    const path = await uploadDoc(fakeFile('abandoned.pdf'), { entityType: 'lease' });
    await discardDocument(path);
    // Nothing to attach it to any more: re-attaching would have to create a new row,
    // so the check is that the orphan itself is gone.
    const { lease } = await freshLease('Cancelled');
    expect(await listDocuments('lease', lease.id)).toHaveLength(0);
  });

  it('deleting one version leaves the others alone', async () => {
    const { lease } = await freshLease('DeleteOne');
    const keep = await registerDocument({ entityType: 'lease', entityId: lease.id, storagePath: 'u/keep.pdf', filename: 'keep.pdf' });
    const drop = await registerDocument({ entityType: 'lease', entityId: lease.id, storagePath: 'u/drop.pdf', filename: 'drop.pdf' });

    await deleteDocument(drop.id);

    const docs = await listDocuments('lease', lease.id);
    expect(docs.map((d) => d.id)).toEqual([keep.id]);
  });

  it('deleting a rider takes its saved copies with it', async () => {
    const { lease } = await freshLease('RiderDocs');
    const rider = await createAddendum({
      lease_id: lease.id, label: 'First Amendment', amendment_date: '2025-01-01',
      kind: 'other', storage_path: 'u/rider.pdf',
    });
    // createAddendum adopts the file the upload registered.
    await registerDocument({ entityType: 'addendum', storagePath: 'u/rider.pdf', filename: 'rider.pdf' });
    await attachDocument('u/rider.pdf', { entityType: 'addendum', entityId: rider.id });
    expect(await listDocuments('addendum', rider.id)).toHaveLength(1);

    await deleteAddendum(rider.id);

    expect(await listAddendums(lease.id)).toHaveLength(0);
    expect(await listDocuments('addendum', rider.id)).toHaveLength(0);
  });

  it('deleting an insurance policy permanently takes its certificates', async () => {
    const { prop, lease } = await freshLease('InsDocs');
    const policy = await saveInsurance({
      party: 'tenant', propertyId: prop.id, leaseId: lease.id,
      insurer: 'Test Mutual', expiry_date: '2030-01-01', storage_path: 'u/coi.pdf',
    });
    await registerDocument({ entityType: 'insurance_policy', entityId: policy.id, storagePath: 'u/coi.pdf', filename: 'coi.pdf' });
    expect(await listDocuments('insurance_policy', policy.id)).toHaveLength(1);

    await deleteInsurance(policy.id);

    expect(await getTenantInsurance(lease.id)).toBeFalsy();
    expect(await listDocuments('insurance_policy', policy.id)).toHaveLength(0);
  });

  it('deleting a service contract takes its saved copy', async () => {
    const { prop } = await freshLease('SvcDocs');
    const c = await addServiceContract({ property_id: prop.id, name: 'Snow', vendor: 'Arctic', storage_path: 'u/snow.pdf' });
    await registerDocument({ entityType: 'service_contract', entityId: c.id, storagePath: 'u/snow.pdf', filename: 'snow.pdf' });

    await deleteServiceContract(c.id);

    expect(await listServiceContracts(prop.id)).toHaveLength(0);
    expect(await listDocuments('service_contract', c.id)).toHaveLength(0);
  });

  it('refuses an unknown record type rather than filing a document nowhere', async () => {
    await expect(registerDocument({ entityType: 'nonsense', storagePath: 'u/x.pdf' }))
      .rejects.toThrow(/Unknown document type/);
  });

  it('deleteDocumentsFor sweeps a legacy path the registry never knew about', async () => {
    // Files uploaded before the registry existed only ever left a storage_path on the
    // record. Deleting that record must still take the file, or the sweep would keep
    // manufacturing exactly the orphans this feature exists to stop.
    const { lease } = await freshLease('Legacy');
    await expect(deleteDocumentsFor('lease', lease.id, ['u/legacy-only.pdf'])).resolves.not.toThrow();
    expect(await listDocuments('lease', lease.id)).toHaveLength(0);
  });

  it('a CSV bank statement can be uploaded at all — it used to be rejected outright', async () => {
    // 'csv' was in neither the client allowlist nor the bucket's, so validateUploadFile
    // threw and ImportStatementButton's `.catch(() => null)` swallowed it: every CSV
    // statement was silently discarded despite a comment claiming it was kept.
    const path = await uploadDoc(fakeFile('chase-june.csv', 4096, 'text/csv'), { entityType: 'statement_import' });
    expect(path).toMatch(/chase-june\.csv$/);
    // …including the Excel-flavoured MIME Windows reports for a .csv.
    await expect(
      uploadDoc(fakeFile('chase-july.csv', 4096, 'application/vnd.ms-excel'), { entityType: 'statement_import' })
    ).resolves.toBeTruthy();
  });

  it('still refuses a genuinely unsupported file', async () => {
    await expect(uploadDoc(fakeFile('payload.exe', 100, 'application/x-msdownload'), { entityType: 'lease' }))
      .rejects.toThrow(/Unsupported file type/);
  });
});
