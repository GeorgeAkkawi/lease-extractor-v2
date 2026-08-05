// The signed copy — George, 2026-08-05: *"after the contract is signed the signed copy
// should be saved as a pdf in the contracts tab - that should be the same of the leases in
// the respective tab as well."*
//
// ONE nullable column on `documents` (0092), the registry every uploaded file for every
// record type already files into — which is what makes "and the same on the leases" free
// rather than a second implementation.
//
// ⚠ The design rejected here is the one that looks obvious: a second `documents` row
// pointing at an envelope's executed PDF. deleteEnvelope sweeps the storage object, so
// that row would survive and offer "Open" on a file that is gone; and symmetrically
// deleteDocumentsFor('lease', …) would delete the object out from under a live envelope.
// Two rows, one object, two owners. The lease side therefore renders the ENVELOPE.
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DocumentsList from '../DocumentsList';
import { ConfirmProvider } from '../ConfirmDialog';
import {
  listDocuments, markDocumentSigned, unmarkDocumentSigned, registerDocument,
} from '../../lib/api';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function mount(entityType, entityId) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <DocumentsList entityType={entityType} entityId={entityId} title="Saved copies" />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

afterEach(cleanup);

describe('the seed', () => {
  it('ships a signed contract copy AND a signed lease copy, so both halves are visible', async () => {
    const contractDocs = await listDocuments('service_contract', 'svc-1');
    expect(contractDocs.some((d) => d.signed_at)).toBe(true);
    const leaseDocs = await listDocuments('lease', 'lease-2');
    expect(leaseDocs.some((d) => d.signed_at)).toBe(true);
  });
});

describe('marking a copy signed', () => {
  it('works by document id, so it serves every entity type without a branch', async () => {
    const doc = await registerDocument({
      entityType: 'insurance_policy', entityId: 'ins-1',
      storagePath: 'demo/policy-signed.pdf', filename: 'policy-signed.pdf',
    });
    expect(doc.signed_at ?? null).toBe(null);

    const marked = await markDocumentSigned(doc.id);
    expect(marked.signed_at).toBeTruthy();

    const cleared = await unmarkDocumentSigned(doc.id);
    expect(cleared.signed_at).toBe(null);
  });

  // Deliberately NOT exclusive. An amended contract legitimately has an original signed
  // copy and a signed amendment; deciding which is "the" one for the landlord would be wrong.
  it('does not unmark the other copies', async () => {
    const a = await registerDocument({ entityType: 'service_contract', entityId: 'svc-2', storagePath: 'demo/a.pdf', filename: 'a.pdf' });
    const b = await registerDocument({ entityType: 'service_contract', entityId: 'svc-2', storagePath: 'demo/b.pdf', filename: 'b.pdf' });
    await markDocumentSigned(a.id);
    await markDocumentSigned(b.id);
    const docs = await listDocuments('service_contract', 'svc-2');
    expect(docs.filter((d) => d.signed_at).length).toBe(2);
  });
});

describe('the documents list', () => {
  it('badges the signed copy and offers the toggle', async () => {
    mount('service_contract', 'svc-1');
    await waitFor(() => expect(document.querySelector('.doc-row')).toBeTruthy());
    expect(screen.getByText('Signed copy')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unmark signed' })).toBeTruthy();
  });

  it('an ordinary copy offers "Mark signed", and clicking it sticks', async () => {
    const doc = await registerDocument({
      entityType: 'annual_report', entityId: 'ar-1',
      storagePath: 'demo/annual-signed.pdf', filename: 'annual.pdf',
    });
    mount('annual_report', 'ar-1');
    const btn = await screen.findByRole('button', { name: 'Mark signed' });
    fireEvent.click(btn);
    await screen.findByRole('button', { name: 'Unmark signed' });
    const docs = await listDocuments('annual_report', 'ar-1');
    expect(docs.find((d) => d.id === doc.id).signed_at).toBeTruthy();
  });
});

describe('the edge function stamps the executed copy itself', () => {
  // countersign-envelope already inserts a documents row for the executed PDF. One field on
  // that insert is why the lease side needs no second row of its own.
  it('countersign-envelope writes signed_at on the row it files', () => {
    const src = readFileSync(join(process.cwd(), 'supabase/functions/countersign-envelope/index.ts'), 'utf8');
    const insert = src.slice(src.indexOf("from('documents').insert("));
    expect(insert.slice(0, 600)).toMatch(/signed_at:\s*now/);
  });

  // If the lease panel ever grows its own documents row for an envelope's file, this is the
  // guard that should stop it — see the header note.
  it('LeaseDocs renders the ENVELOPE, never a documents row on executed_path', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/LeaseDocs.js'), 'utf8');
    expect(src).toMatch(/executed\.map/);
    expect(src).toMatch(/env\.executed_path/);
    expect(src).not.toMatch(/registerDocument/);
  });
});
