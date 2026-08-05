// Sending a CONTRACT out for signature, and reading back the copy that comes in signed.
//
// George, 2026-08-05: *"i dont see how it actually works to send a document to someone. on
// the contracts tab next to add contract it should say send one for signature like it does
// on the lease addendums and riders. none of that is there so i cant send one for signature.
// then it should send and only when its countersigned the user should be prompted with
// extract info with AI then it should upload."*
//
// THE GAP WAS ONE COLUMN, not a missing button: signature_envelopes.lease_id was `not null
// references leases` (0085), so an envelope had exactly one kind of home. 0093 makes it
// nullable and adds contract_id, with a check that exactly one is set — and everything else
// in the feature generalises, because nothing else in it was ever lease-shaped.
//
// What these tests hold down, in the order the landlord meets them:
//   ① the control exists, next to "+ Add contract", and asks WHICH CONTRACT rather than
//      "what kind of lease document is this?"
//   ② sending files the envelope against that contract — lease_id null, contract_id set
//   ③ "a new contract" creates the shell FIRST, so an executed agreement always has a home
//   ④ the strip says VENDOR, never tenant, off one derivation rather than a passed-in prop
//   ⑤ the prompt to read it appears ONLY once it is countersigned
//   ⑥ reading is not applying — the text moves, not one figure does
//   ⑦ applying carries the fee through to the CAM line, cam_total and the stored invoice,
//      and stamps the envelope so the prompt (and the dashboard alert) go quiet
//
// Drives the real UI with the demo mock as the database, including its canned
// extract-contract answer — so the review screen is exercised against the same shape the
// live edge function returns.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ServiceContractsSection from '../ServiceContractsSection';
import { ConfirmProvider } from '../ConfirmDialog';
import {
  listContractEnvelopes, listServiceContracts, getServiceContract, listCamLineItems,
  getExpenseRecord, ensureInvoice, getYearInvoice, getLease, listContractEscalations,
  syncContractCamItems, resyncPropertyBilling,
} from '../../lib/api';
import { supabase } from '../../lib/supabaseClient';
import { currentYear } from '../../lib/format';

const Y = currentYear();
const PROP = 'prop-2';

// The mock database is shared for the whole FILE, and half of what follows deliberately
// changes svc-2's fee and stamps its envelope. Put both back — including the derived CAM row
// and the stored invoice that the carry-through moved — so each test starts from the seed
// rather than from whatever the one above it left behind.
//
// It runs the app's own two functions in the app's own order (sync, then resync) rather than
// hand-writing figures back: a reset that reconstructed them by hand would be a third copy
// of the CAM arithmetic, and the first one to drift.
const SEEDED_ENVELOPES = ['env-1', 'env-2', 'env-3', 'env-4', 'env-5'];
const SEEDED_CONTRACTS = ['svc-1', 'svc-2'];

beforeEach(async () => {
  // Sending is the other half of what this file exercises, and each send leaves a real
  // envelope (and sometimes a whole new contract) behind. Sweep them, or "the contract out
  // for signature" becomes three of them and every count assertion below reads the residue
  // of the test above it.
  const envs = await supabase.from('signature_envelopes').select('id');
  for (const e of envs.data || []) {
    if (!SEEDED_ENVELOPES.includes(e.id)) {
      await supabase.from('envelope_events').delete().eq('envelope_id', e.id);
      await supabase.from('envelope_signers').delete().eq('envelope_id', e.id);
      await supabase.from('signature_envelopes').delete().eq('id', e.id);
    }
  }
  const cons = await supabase.from('service_contracts').select('id').eq('property_id', PROP);
  for (const c of cons.data || []) {
    if (!SEEDED_CONTRACTS.includes(c.id)) await supabase.from('service_contracts').delete().eq('id', c.id);
  }
  await supabase.from('signature_envelopes').update({ applied_at: null, status: 'executed' }).eq('id', 'env-5');
  await supabase.from('contract_escalations').delete().eq('contract_id', 'svc-2');
  await supabase.from('service_contracts').update({
    service_type: 'landscaping', vendor: 'GreenScape Inc.', vendor_email: 'ar@greenscape.example',
    amount: 1000, frequency: 'monthly', escalation_pct: 3,
    start_date: `${Y - 1}-01-01`, end_date: null,
    auto_renew: null, notice_days: null, notice_by_date: null, renewal_term_months: null,
    additional_insured: true,
  }).eq('id', 'svc-2');
  await syncContractCamItems(PROP, Y);
  await resyncPropertyBilling(PROP, Y);
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <ServiceContractsSection propId={PROP} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

afterEach(cleanup);

const type = (el, value) => fireEvent.change(el, { target: { value } });

// Walk the send dialog as far as a filled-in, sendable form.
async function openSend() {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '✎ Send one for signature' }));
  return screen.findByRole('combobox', { name: /Which contract is this for/ });
}

function attach(name = 'arctic-renewal.pdf') {
  const input = screen.getByLabelText('Choose the document to send');
  fireEvent.change(input, { target: { files: [new File(['%PDF-1.4 renewal'], name, { type: 'application/pdf' })] } });
}

describe('the control George could not find', () => {
  it('sits next to "+ Add contract"', async () => {
    mount();
    await screen.findByRole('button', { name: '+ Add contract' });
    expect(await screen.findByRole('button', { name: '✎ Send one for signature' })).toBeTruthy();
  });

  // ⚠ The lease dialog asks "what is this document?" because the answer decides where an
  // executed copy files itself. A service contract's answer is always the same — so that
  // question is replaced by the one that ISN'T answered: which contract does this belong to?
  it('asks which contract, not what kind of lease document it is', async () => {
    const select = await openSend();
    expect(select).toBeTruthy();
    expect(screen.queryByText('What is this document?')).toBe(null);
    // Every contract on the property, plus the escape hatch for one Amlak has never seen.
    const options = [...select.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toContain('Snow removal — Arctic');
    expect(options).toContain('Landscaping — GreenScape');
    expect(options).toContain('A new contract…');
  });

  // ⚠ NOTHING IS PRE-SELECTED. An envelope filed against the wrong contract is a signed
  // agreement that re-prices the wrong vendor's CAM line the moment it is read in.
  it('will not send until a contract is chosen', async () => {
    const select = await openSend();
    expect(select.value).toBe('');
    attach();
    await waitFor(() => expect(screen.getByText(/✓ arctic-renewal\.pdf/)).toBeTruthy());
    expect(screen.getByRole('button', { name: '✎ Send for signature' }).disabled).toBe(true);
  });

  it('fills the vendor in from the contract once one is chosen', async () => {
    const select = await openSend();
    type(select, 'svc-1');
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Full name').value).toBe('Arctic Snow Services');
      expect(screen.getByPlaceholderText('name@example.com').value).toBe('billing@arcticsnow.example');
    });
  });
});

describe('sending it', () => {
  it('files the envelope against the contract — not against a lease', async () => {
    const before = await listContractEnvelopes('svc-1');

    const select = await openSend();
    type(select, 'svc-1');
    attach();
    await waitFor(() => expect(screen.getByRole('button', { name: '✎ Send for signature' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '✎ Send for signature' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send it' }));
    await screen.findByText(/is on its way to/);

    const after = await listContractEnvelopes('svc-1');
    expect(after.length).toBe(before.length + 1);
    const env = after.find((e) => !before.some((b) => b.id === e.id));
    expect(env.contract_id).toBe('svc-1');
    // ⚠ The half that could not exist before 0093.
    expect(env.lease_id).toBe(null);
    expect(env.property_id).toBe(PROP);
    expect(env.purpose).toBe('service_contract');
    expect(env.status).toBe('sent');
    // The link goes to the VENDOR's signer row — stored under role 'tenant', because that
    // names the side holding the link, not the kind of person (0085).
    expect(env.signer_email).toBe('billing@arcticsnow.example');
  });

  // ⚠ THE SHELL IS CREATED FIRST. "Send now, file it later" would leave an executed
  // agreement with nowhere to land, which is the state this whole feature exists to prevent.
  it('"a new contract" adds the contract before the envelope exists', async () => {
    const before = await listServiceContracts(PROP);

    const select = await openSend();
    type(select, '__new__');
    type(await screen.findByPlaceholderText('e.g. Snow removal — Arctic'), 'Elevator — LiftCo');
    type(screen.getByPlaceholderText('Full name'), 'LiftCo Elevator Services');
    type(screen.getByPlaceholderText('name@example.com'), 'service@liftco.example');
    attach('liftco-agreement.pdf');
    await waitFor(() => expect(screen.getByRole('button', { name: '✎ Send for signature' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '✎ Send for signature' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send it' }));
    await screen.findByText(/is on its way to/);

    const after = await listServiceContracts(PROP);
    expect(after.length).toBe(before.length + 1);
    const created = after.find((c) => c.name === 'Elevator — LiftCo');
    expect(created).toBeTruthy();
    // A NAME AND NOTHING ELSE. No fee, no term — so it contributes nothing to CAM until the
    // signed copy is read in and confirmed.
    expect(created.amount ?? null).toBe(null);
    expect(created.start_date ?? null).toBe(null);
    const envs = await listContractEnvelopes(created.id);
    expect(envs).toHaveLength(1);
    expect(envs[0].lease_id).toBe(null);
  });
});

describe('the strip on the contract row', () => {
  it('says vendor, never tenant', async () => {
    mount();
    // env-4 is seeded out with Arctic; env-5 came back signed by GreenScape.
    await waitFor(() => expect(screen.getAllByText('Out for signature').length).toBeGreaterThan(0));
    expect(screen.getByText('Awaiting vendor')).toBeTruthy();
    expect(screen.queryByText('Awaiting tenant')).toBe(null);
    expect(screen.getByText(/Waiting on Arctic Snow Services/)).toBeTruthy();
  });

  // The executed one has changed nothing yet, and on a contract that is a money statement:
  // the tenants are still being billed off the old fee.
  it('says an executed contract has not moved a figure yet', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Out for signature').length).toBeGreaterThan(0));
    expect(screen.getByText(/the fee, term and renewal on this contract are still the old ones/)).toBeTruthy();
  });
});

describe('reading the signed copy', () => {
  // ⚠ ONLY once it is countersigned. env-4 is still out with the vendor and offers nothing.
  it('is offered on the executed contract and not on the one still out', async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText('Out for signature').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('button', { name: '✨ Read the signed contract' })).toHaveLength(1);
  });

  it('reads the SIGNED copy, replaces the text, and moves no figure', async () => {
    const before = await getServiceContract('svc-2');
    expect(Number(before.amount)).toBe(1000);

    mount();
    fireEvent.click(await screen.findByRole('button', { name: '✨ Read the signed contract' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read the signed contract' }));
    await screen.findByRole('button', { name: 'Apply the signed contract' });

    const after = await getServiceContract('svc-2');
    // The document's text IS this contract's text from this moment…
    expect(after.contract_text).toContain('GreenScape');
    // …and not one figure has moved.
    expect(Number(after.amount)).toBe(1000);
    expect(after.frequency).toBe('monthly');
    expect(after.auto_renew ?? null).toBe(null);
    // …and the envelope is still asking to be dealt with.
    const [env] = await listContractEnvelopes('svc-2');
    expect(env.applied_at ?? null).toBe(null);
  });

  it('shows the diff, the fee schedule and the insurance answer it read', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '✨ Read the signed contract' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read the signed contract' }));
    await screen.findByRole('button', { name: 'Apply the signed contract' });

    const rows = [...document.querySelectorAll('.terms-diff:not(.schedule) tbody tr')]
      .map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    expect(rows.some((r) => /Fee.*\$1,000.*\$12,000/.test(r))).toBe(true);
    expect(rows.some((r) => /Frequency.*per month.*per year/.test(r))).toBe(true);
    // ⚠ 0094, and the wording is field-specific: a shared "Yes/No" pair for kind==='bool'
    // printed "Yes — renews unless cancelled" against the insurance answer.
    expect(rows.some((r) => /additional insured.*Yes.*No — not required by this contract/i.test(r))).toBe(true);
  });

  it('applying it carries the fee into CAM and stops the prompt', async () => {
    await ensureInvoice('lease-3', PROP, Y);
    const invBefore = await getYearInvoice('lease-3', Y);
    const camBefore = await getExpenseRecord(PROP, Y);

    mount();
    fireEvent.click(await screen.findByRole('button', { name: '✨ Read the signed contract' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read the signed contract' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply the signed contract' }));
    await screen.findByRole('button', { name: 'Done' });

    const c = await getServiceContract('svc-2');
    expect(Number(c.amount)).toBe(12000);
    expect(c.frequency).toBe('annual');
    expect(c.additional_insured).toBe(false);
    // The name is the CAM line's label and the alert's title — never taken from a document.
    expect(c.name).toBe('Landscaping — GreenScape');

    const steps = await listContractEscalations('svc-2');
    expect(steps.map((s) => Number(s.new_amount)).sort((a, b) => a - b)).toEqual([12000, 12500]);

    const item = (await listCamLineItems(PROP, Y)).find((i) => i.contract_id === 'svc-2');
    expect(Number(item.amount)).toBe(12000);
    const camAfter = await getExpenseRecord(PROP, Y);
    expect(Number(camAfter.cam_total)).toBeCloseTo(Number(camBefore.cam_total) - 360, 2);

    // ⚠ THE POINT. The stored invoice is a frozen copy that does not rebuild itself.
    // Northwind has no estimate and a 40% share override.
    const invAfter = await getYearInvoice('lease-3', Y);
    expect(Number(invAfter.cam_annual)).toBeCloseTo(Number(camAfter.cam_total) * 0.4, 2);
    expect(Number(invAfter.cam_annual)).not.toBeCloseTo(Number(invBefore.cam_annual), 2);

    // …and the envelope stops asking, which is also what silences the dashboard alert.
    const [env] = await listContractEnvelopes('svc-2');
    expect(env.applied_at).toBeTruthy();
    expect(screen.queryByRole('button', { name: '✨ Read the signed contract' })).toBe(null);
  });

  // George's standing constraint, on this path too. Nothing here may write an estimate:
  // billedComponents prefers a tenant's estimate and falls back to the actual share, so
  // writing nothing is the whole mechanism.
  it('writes no estimate on any lease at the property', async () => {
    const before = await Promise.all(['lease-3', 'lease-4'].map((id) => getLease(id)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '✨ Read the signed contract' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read the signed contract' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply the signed contract' }));
    await screen.findByRole('button', { name: 'Done' });
    const after = await Promise.all(['lease-3', 'lease-4'].map((id) => getLease(id)));
    after.forEach((l, i) => {
      expect(l.est_cam_annual ?? null).toBe(before[i].est_cam_annual ?? null);
      expect(l.est_tax_annual ?? null).toBe(before[i].est_tax_annual ?? null);
      expect(l.est_confirmed_year ?? null).toBe(before[i].est_confirmed_year ?? null);
    });
  });

  // ⚠ READING IT AND DECIDING NOTHING CHANGES IS STILL ACTING ON IT. Leaving the prompt up
  // would teach him to ignore the one signal that means money hasn't moved yet.
  it('"file it" clears the prompt without touching a figure', async () => {
    const before = await getServiceContract('svc-2');

    mount();
    fireEvent.click(await screen.findByRole('button', { name: '✨ Read the signed contract' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read the signed contract' }));
    fireEvent.click(await screen.findByRole('button', { name: 'File it — keep the current figures' }));
    await screen.findByRole('button', { name: 'Done' });

    const after = await getServiceContract('svc-2');
    expect(Number(after.amount)).toBe(Number(before.amount));
    expect(after.frequency).toBe(before.frequency);
    const [env] = await listContractEnvelopes('svc-2');
    expect(env.applied_at).toBeTruthy();
  });
});

// ── 0094 ───────────────────────────────────────────────────────────────────────────────
// George: *"the contracts should also be read to see if the user is listed as additional
// insured and if they are not the same email as the insurance template should be added as a
// button."* The vendor exposure is the larger of the two: a vendor is on the property
// WORKING, and their policy answers for them, not for the owner, unless the owner is
// endorsed onto it.
describe('additional insured', () => {
  it('warns on the contract that does not name him, and offers the letter', async () => {
    mount();
    // svc-1 (Arctic) is seeded false — the contract requires $1m cover and never names the
    // Owner on it.
    await screen.findByText(/You are not named as additional insured/);
    expect(screen.getByRole('button', { name: '✉ Request additional insured endorsement' })).toBeTruthy();
  });

  // ⚠ ONLY ON AN EXPLICIT FALSE. Null means "the document doesn't say", and accusing a
  // vendor of being uninsured because nobody uploaded their agreement is the wrong this
  // three-state column exists to avoid.
  it('says nothing on a contract that DOES name him, or one never read', async () => {
    mount();
    await screen.findByText(/You are not named as additional insured/);
    // Exactly one warning across the two seeded contracts — svc-2 is true.
    expect(screen.getAllByText(/You are not named as additional insured/)).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '✉ Request additional insured endorsement' })).toHaveLength(1);
  });

  it('drafts a letter addressed to the VENDOR, asking for the endorsement', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '✉ Request additional insured endorsement' }));
    // ⚠ Not "Email to tenant" — this modal has been sending vendor letters since contracts
    // got their own alerts, and the header said otherwise.
    await screen.findByText('Email to vendor');
    const to = screen.getByPlaceholderText('tenant@email.com');
    expect(to.value).toBe('billing@arcticsnow.example');
    const body = document.querySelector('textarea');
    expect(body.value).toMatch(/additional insured/i);
    expect(body.value).toMatch(/Arctic Snow Services/);
    // It DRAFTS. Nothing has been sent by opening it.
  });
});
