// Renewing an insurance policy KEEPS the one it replaces.
//
// George, 2026-08-05: *"add a place to add a new policy for the insurance i want a history but
// able to upload new ones so once a new one is uploaded (not replaced) it is moved to history
// within that and then the new one is uploaded and read and saved."*
//
// ⚠ WHAT WAS WRONG WAS THE WRITE, not the storage. `archived_at`, listArchivedInsurance and
// the archive/delete choice have existed since 0032, and every reader — the expiry alerts,
// the nightly email sweep, the Ask snapshot — already filters `archived_at is null`. But the
// button was called "Replace policy" and it meant it: saveInsurance UPDATEs the active row,
// so uploading this year's certificate overwrote last year's insurer, coverage limit,
// premium, expiry and cached text. The FILE survived (it registers under the policy id);
// what it said did not — which is the wrong half to keep, because "what were we covered for
// in 2024" is the only question a history exists to answer.
//
// So the intake path now supersedes: archive the row on file, insert a new one, file the new
// certificate against the NEW id. No migration — this is one function and a label.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import InsuranceVault from '../InsuranceVault';
import { ConfirmProvider } from '../ConfirmDialog';
import {
  getPropertyInsurance, getTenantInsurance, listArchivedInsurance, supersedeInsurance,
  saveInsurance, listDocuments, fetchAlertData,
} from '../../lib/api';
import { buildAlerts } from '../../lib/alerts';
import { supabase } from '../../lib/supabaseClient';

const PROP = 'prop-1';

function mount(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <InsuranceVault {...props} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

// The mock database is shared for the whole file and every test here files a new policy.
// Sweep anything this file created and put the seeded pair back where they started.
const SEEDED = ['ins-1', 'ins-2', 'ins-3', 'ins-4', 'ins-5'];
beforeEach(async () => {
  const all = await supabase.from('insurance_policies').select('id');
  for (const p of all.data || []) {
    if (!SEEDED.includes(p.id)) await supabase.from('insurance_policies').delete().eq('id', p.id);
  }
  await supabase.from('insurance_policies')
    .update({ archived_at: null, insurer: 'Granite Mutual Insurance', coverage_amount: 2000000 })
    .eq('id', 'ins-1');
});
afterEach(cleanup);

const pickFile = (name = 'coi-2027.pdf') => {
  const input = screen.getByLabelText('Upload insurance policy file');
  fireEvent.change(input, { target: { files: [new File(['%PDF-1.4 coi'], name, { type: 'application/pdf' })] } });
};

describe('the seed', () => {
  it('ships a policy history on both a property and a tenant, so it is visible at all', async () => {
    expect((await listArchivedInsurance({ party: 'landlord', propertyId: PROP })).length).toBeGreaterThan(0);
    expect((await listArchivedInsurance({ party: 'tenant', leaseId: 'lease-2' })).length).toBeGreaterThan(0);
  });

  // ⚠ An archived policy is invisible to every reader in the app. That is what makes the
  // history free of consequences — nothing re-prices, re-alerts or re-emails because of it.
  it('an archived policy raises no expiry alert', async () => {
    const data = await fetchAlertData({ ledgerOn: false, esignOn: false });
    expect(data.insurance.some((p) => p.id === 'ins-4')).toBe(false);
    const alerts = buildAlerts(data, undefined, new Date(), { features: null });
    expect(alerts.some((a) => a.focus === 'insurance' && a.detail?.includes('Keystone'))).toBe(false);
  });
});

describe('uploading a new policy', () => {
  it('archives the one on file instead of overwriting it — and keeps every figure', async () => {
    const before = await getPropertyInsurance(PROP);
    expect(before.id).toBe('ins-1');

    const { policy, supersededId } = await supersedeInsurance({
      party: 'landlord', propertyId: PROP,
      insurer: 'Granite Mutual Insurance', coverage_amount: 3000000,
      expiry_date: '2028-03-31', policy_text: 'renewed',
    });

    expect(supersededId).toBe('ins-1');
    // A NEW row is the active one…
    expect(policy.id).not.toBe('ins-1');
    expect((await getPropertyInsurance(PROP)).id).toBe(policy.id);
    expect(Number(policy.coverage_amount)).toBe(3000000);

    // …and last year's is intact in history, not a shell.
    const history = await listArchivedInsurance({ party: 'landlord', propertyId: PROP });
    const old = history.find((p) => p.id === 'ins-1');
    expect(old).toBeTruthy();
    expect(old.insurer).toBe('Granite Mutual Insurance');
    expect(Number(old.coverage_amount)).toBe(2000000); // NOT 3,000,000
    expect(old.archived_at).toBeTruthy();
  });

  // ⚠ THE ORDER IS FORCED. getPropertyInsurance uses .maybeSingle() on `archived_at is null`,
  // which ERRORS on more than one row — so inserting before archiving would leave every
  // reader in the app throwing until the archive landed.
  it('never leaves two active policies for one scope', async () => {
    await supersedeInsurance({ party: 'landlord', propertyId: PROP, insurer: 'A', expiry_date: '2029-01-01' });
    await supersedeInsurance({ party: 'landlord', propertyId: PROP, insurer: 'B', expiry_date: '2030-01-01' });
    // maybeSingle would throw if this were ever ambiguous.
    const active = await getPropertyInsurance(PROP);
    expect(active.insurer).toBe('B');
    const all = await supabase.from('insurance_policies').select('*')
      .eq('property_id', PROP).eq('party', 'landlord').is('archived_at', null);
    expect(all.data).toHaveLength(1);
  });

  // The reminders are deduped per threshold on expiry_notice_bucket. A brand-new row starts
  // null, so a renewal re-arms them for its own date without anyone clearing anything.
  it('the new policy starts with its expiry reminders re-armed', async () => {
    await supabase.from('insurance_policies').update({ expiry_notice_bucket: '1w' }).eq('id', 'ins-1');
    const { policy } = await supersedeInsurance({
      party: 'landlord', propertyId: PROP, insurer: 'Granite', expiry_date: '2029-06-30',
    });
    expect(policy.expiry_notice_bucket ?? null).toBe(null);
  });

  it('works on a scope that has no policy yet — nothing to supersede', async () => {
    const { policy, supersededId } = await supersedeInsurance({
      party: 'tenant', leaseId: 'lease-3', propertyId: 'prop-2', insurer: 'Fresh Co', expiry_date: '2029-01-01',
    });
    expect(supersededId).toBe(null);
    expect((await getTenantInsurance('lease-3')).id).toBe(policy.id);
  });

  // ⚠ "Edit facts" is NOT a renewal. Correcting a typo in an insurer's name must not create a
  // history entry, or the real policy years get buried in corrections.
  it('editing the facts still updates in place, with no history entry', async () => {
    const historyBefore = (await listArchivedInsurance({ party: 'landlord', propertyId: PROP })).length;
    const saved = await saveInsurance({ party: 'landlord', propertyId: PROP, insurer: 'Granite Mutual Insurance Co.' });
    expect(saved.id).toBe('ins-1');
    expect((await listArchivedInsurance({ party: 'landlord', propertyId: PROP })).length).toBe(historyBefore);
  });
});

describe('the vault, driven', () => {
  it('offers "+ Add a new policy" and says where the current one goes', async () => {
    mount({ party: 'landlord', propertyId: PROP });
    fireEvent.click(await screen.findByRole('button', { name: '+ Add a new policy' }));
    // The sentence that separates "my last policy is gone" from "my last policy is filed".
    const note = await screen.findByText(/moves into/);
    expect(note.textContent).toMatch(/Granite Mutual Insurance/);
    expect(note.textContent).toMatch(/Policy history/);
    expect(note.textContent).toMatch(/Nothing is overwritten/);
  });

  it('reads the uploaded certificate, saves it as the new policy, and files the old one', async () => {
    mount({ party: 'landlord', propertyId: PROP });
    fireEvent.click(await screen.findByRole('button', { name: '+ Add a new policy' }));
    pickFile();

    // The demo extractor answers with a $2m Granite certificate expiring next 31 March.
    await waitFor(async () => {
      const active = await getPropertyInsurance(PROP);
      expect(active.id).not.toBe('ins-1');
    }, { timeout: 4000 });

    const active = await getPropertyInsurance(PROP);
    expect(active.insurer).toBe('Granite Mutual Insurance');
    expect(active.policy_text).toContain('CERTIFICATE OF LIABILITY INSURANCE');

    // ⚠ The certificate files against the NEW policy id, which is what keeps each year's
    // paper with the year it belongs to instead of piling every copy onto one record.
    const docs = await listDocuments('insurance_policy', active.id);
    expect(docs.length).toBe(1);
    expect(docs[0].filename).toBe('coi-2027.pdf');
    expect((await listDocuments('insurance_policy', 'ins-1')).length).toBe(0);

    const history = await listArchivedInsurance({ party: 'landlord', propertyId: PROP });
    expect(history.some((p) => p.id === 'ins-1')).toBe(true);
  });

  it('shows the history, and offers the certificate it is keeping', async () => {
    mount({ party: 'landlord', propertyId: PROP });
    const toggle = await screen.findByRole('button', { name: /Policy history \(\d+\)/ });
    fireEvent.click(toggle);
    // ins-4 — a different insurer at a lower limit, with a stored certificate.
    expect(await screen.findByText('Keystone Property & Casualty')).toBeTruthy();
    expect(screen.getByText('$1,500,000.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open certificate/ })).toBeTruthy();
  });

  // ⚠ This section read the PARENT component's askConfirm binding, which is not in its
  // scope: clicking 🗑 threw a ReferenceError and the dialog never opened, so nothing could
  // be removed from history at all.
  it('the delete-from-history dialog actually opens', async () => {
    mount({ party: 'landlord', propertyId: PROP });
    fireEvent.click(await screen.findByRole('button', { name: /Policy history \(\d+\)/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete permanently from history' }));
    await screen.findByText('Delete archived policy?');
    expect(screen.getByText(/The policy currently on file is not affected/)).toBeTruthy();
  });
});
