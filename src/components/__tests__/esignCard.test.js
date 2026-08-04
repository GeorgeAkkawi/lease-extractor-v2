// The landlord's half of e-signature, mounted where George asked for it to live — INSIDE
// the Addendums & riders card. Three things are worth guarding:
//
//   ① the strip states the two facts a landlord could otherwise get wrong: which document is
//      waiting on HIM, and that a signed document has changed nothing on the lease yet
//   ② countersigning executes the envelope and nothing else — no term, no rent, no addendum
//   ③ the feature gate genuinely hides it
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AddendumEditor from '../AddendumEditor';
import AddendumEnvelopeRows from '../AddendumEnvelopeRows';
import { ConfirmProvider } from '../ConfirmDialog';
import { supabase } from '../../lib/supabaseClient';
import { getLease, listAddendums, setEnabledFeatures } from '../../lib/api';
import { FEATURE_KEYS } from '../../lib/features';

const lease = { id: 'lease-1', tenant_name: 'Bright Coffee Co.', tenant_email: 'sam@brightcoffee.example', tenant_contact_name: 'Sam Rivera' };
const property = { id: 'prop-1', name: 'Maple Plaza' };
const corp = { id: 'corp-1', name: 'Acme Holdings', contact_email: 'leasing@acmeholdings.example' };

function mount(Comp, props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <Comp leaseId="lease-1" lease={lease} property={property} corp={corp} {...props} />
      </ConfirmProvider>
    </QueryClientProvider>
  );
}

function stubCanvas() {
  const proto = window.HTMLCanvasElement.prototype;
  proto.getContext = () => ({
    clearRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    measureText: () => ({ width: 100 }),
    set font(_v) {}, set fillStyle(_v) {}, set strokeStyle(_v) {},
    set lineWidth(_v) {}, set lineCap(_v) {}, set lineJoin(_v) {}, set textBaseline(_v) {},
  });
  proto.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
}

// The demo store is module-level, so every test puts the two seeded envelopes back.
const RESET = async () => {
  await supabase.from('signature_envelopes').update({
    status: 'signed', signed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    countersigned_at: null, executed_at: null, executed_path: null, applied_at: null,
    expires_at: new Date(Date.now() + 20 * 86400000).toISOString(),
  }).eq('id', 'env-1');
  await supabase.from('signature_envelopes').update({ status: 'executed', applied_at: null }).eq('id', 'env-2');
  // env-3 is the still-out-with-the-tenant one; a test that expires or deletes it has to
  // put it back or every later suite sees a different card.
  await supabase.from('signature_envelopes').update({
    status: 'sent', signed_at: null,
    expires_at: new Date(Date.now() + 26 * 86400000).toISOString(),
  }).eq('id', 'env-3');
};

beforeEach(async () => { cleanup(); await RESET(); });
afterEach(RESET);

describe('the strip inside Addendums & riders', () => {
  it('lists both envelopes under one heading, newest first', async () => {
    mount(AddendumEnvelopeRows);
    expect(await screen.findByText('Out for signature')).toBeTruthy();
    expect(screen.getByText('Second Amendment to Lease')).toBeTruthy();
    expect(screen.getByText('Estoppel Certificate')).toBeTruthy();
  });

  it('says which one is waiting on HIM', async () => {
    mount(AddendumEnvelopeRows);
    expect(await screen.findByText('Signed — countersign')).toBeTruthy();
    expect(screen.getByText(/waiting on your signature/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '✎ Countersign' })).toBeTruthy();
  });

  // ① The line that stops a signed document reading as a filed one.
  it('says plainly that an executed document has changed nothing yet', async () => {
    mount(AddendumEnvelopeRows);
    await screen.findByText('Estoppel Certificate');
    expect(screen.getByText('Signed, but nothing on this lease has changed yet.')).toBeTruthy();
  });

  it('offers Resend + cancel only while it is still out with the tenant', async () => {
    // Assertions are scoped to a ROW found by its title rather than indexed out of the
    // card — the seed gained a third envelope and every index-based selector broke.
    mount(AddendumEnvelopeRows);
    await screen.findByText('Third Amendment to Lease');

    // env-3 is the only one still out with the tenant.
    const outstanding = screen.getByText('Third Amendment to Lease').closest('.env-row');
    expect(outstanding.textContent).toContain('Waiting on Sam Rivera');
    // The badge names who it waits on rather than echoing the strip's heading.
    expect(outstanding.textContent).toContain('Awaiting tenant');
    expect(outstanding.querySelector('button[title*="Send the link again"]')).toBeTruthy();

    // The signed one has nothing left to chase — it offers Withdraw instead.
    const signed = screen.getByText('Second Amendment to Lease').closest('.env-row');
    expect(signed.textContent).not.toContain('Resend');
    expect(signed.querySelector('button[title*="Withdraw"]')).toBeTruthy();
  });

  it('a lapsed link is badged Expired even though the row still says sent', async () => {
    await supabase.from('signature_envelopes').update({
      expires_at: new Date(Date.now() - 86400000).toISOString(),
    }).eq('id', 'env-3');
    mount(AddendumEnvelopeRows);
    expect(await screen.findByText('Expired')).toBeTruthy();
    const row = screen.getByText('Third Amendment to Lease').closest('.env-row');
    // …and resend is still offered, because a new link is the fix for a dead one.
    expect(row.querySelector('button[title*="Send the link again"]')).toBeTruthy();
  });
});

describe('countersigning', () => {
  beforeEach(stubCanvas);

  // ② The guarantee that keeps this off the money spine.
  it('executes the envelope and touches neither the lease nor its addendums', async () => {
    const before = await getLease('lease-1');
    const addendumsBefore = await listAddendums('lease-1');

    mount(AddendumEnvelopeRows);
    fireEvent.click(await screen.findByRole('button', { name: '✎ Countersign' }));

    // It shows him who signed before he commits his own name. Scoped to the dialog — the
    // strip behind it names Sam Rivera too.
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('Sam Rivera');
    expect(dialog.textContent).toContain('Nothing on this lease changes');
    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign and complete' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Sign and complete' }));

    await waitFor(async () => {
      const { data } = await supabase.from('signature_envelopes').select('*').eq('id', 'env-1').maybeSingle();
      expect(data.status).toBe('executed');
      expect(data.executed_path).toBeTruthy();
    });

    const after = await getLease('lease-1');
    expect(after.base_rent).toBe(before.base_rent);
    expect(after.lease_termination_date).toBe(before.lease_termination_date);
    expect(after.square_footage).toBe(before.square_footage);
    // No rider is filed either — an addendum row means "an amendment that HAS been applied".
    expect((await listAddendums('lease-1')).length).toBe(addendumsBefore.length);
  });

  // George, 2026-08-04: *"make sure the user knows that when he saves his signature a copy
  // will be sent to the tenant."* It has to be against the button, not in the grey paragraph
  // at the top — and it has to name who it reaches, because that is the irreversible half.
  it('warns, beside the button, that signing emails the tenant', async () => {
    mount(AddendumEnvelopeRows);
    fireEvent.click(await screen.findByRole('button', { name: '✎ Countersign' }));
    const warn = await screen.findByText(/Signing sends it/);
    const note = warn.closest('.note-msg');
    expect(note.textContent).toContain('Sam Rivera');
    expect(note.textContent).toContain('sam@brightcoffee.example');
    expect(note.textContent).toContain('can’t be recalled');
    // Directly above the control it is warning about — not scrolled off the top of a dialog.
    expect(note.nextElementSibling.querySelector('button').textContent).toContain('Sign and complete');
  });

  it('will not complete without a name and a signature', async () => {
    mount(AddendumEnvelopeRows);
    fireEvent.click(await screen.findByRole('button', { name: '✎ Countersign' }));
    const btn = await screen.findByRole('button', { name: 'Sign and complete' });
    // The name is pre-filled from the corporation, so the signature is what's missing.
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText('Full name or business name'), { target: { value: '' } });
    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign and complete' }).disabled).toBe(true));
  });
});

describe('the card it lives in', () => {
  it('shows the send button and the strip alongside the addendum table', async () => {
    mount(AddendumEditor, { leaseInactive: false, squareFootage: 2000, currentTermEnd: '2027-12-31' });
    expect(await screen.findByRole('button', { name: '✎ Send one for signature' })).toBeTruthy();
    // The strip arrives with its own query, so it lands after the button.
    expect(await screen.findByText('Out for signature')).toBeTruthy();
    // The card's original control is untouched.
    expect(screen.getByRole('button', { name: '+ Add addendum / rider' })).toBeTruthy();
  });

  // ③ The gate. This is the failure mode that shipped `announcements` invisible on
  // 2026-08-04 — a stored ARRAY without the key reads as OFF.
  it('is hidden when the e-signature module is switched off', async () => {
    await setEnabledFeatures(FEATURE_KEYS.filter((k) => k !== 'esign'));
    mount(AddendumEditor, { leaseInactive: false, squareFootage: 2000, currentTermEnd: '2027-12-31' });
    expect(await screen.findByRole('button', { name: '+ Add addendum / rider' })).toBeTruthy();
    // isFeatureOn reads a still-loading (undefined) set as "everything on" so nothing
    // flash-hides — so the controls are present for a beat and then go. Waiting for the
    // disappearance is the real assertion; a synchronous check would pass on a broken gate.
    await waitFor(() => expect(screen.queryByRole('button', { name: '✎ Send one for signature' })).toBe(null));
    expect(screen.queryByText('Out for signature')).toBe(null);
    await setEnabledFeatures(null);
  });
});
