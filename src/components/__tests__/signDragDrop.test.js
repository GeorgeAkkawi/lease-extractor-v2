// Drag-to-sign, end to end through the demo mock: place the mark, sign, and check the point
// survives the round trip. Plus the two controls that were missing until a signed envelope
// got stuck on George's lease card — Withdraw and Delete.
//
// ⚠ pdf.js CANNOT RENDER IN jsdom (no canvas backend, no Web Worker), so PdfSignCanvas is
// stubbed here and the coordinate maths it calls is covered exhaustively by
// src/lib/__tests__/signPlacement.test.js instead. The stub deliberately reports a FAILURE
// path too, because "the document wouldn't render" is a state a real tenant will hit and
// signing must still work through it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfirmProvider } from '../ConfirmDialog';
import { supabase } from '../../lib/supabaseClient';

// Stand in for the real canvas: a button that "places" at a fixed point, and one that
// reports the renderer gave up. Hoisted so the mock factory can see it.
const PLACED = { page: 1, x: 320, y: 402, w: 170 };
vi.mock('../PdfSignCanvas', () => ({
  default: ({ signature, placement, onPlace, onFail }) => (
    <div data-testid="pdfcanvas">
      <span>{placement ? `placed:${placement.page}:${Math.round(placement.x)}` : 'not placed'}</span>
      <button type="button" disabled={!signature} onClick={() => onPlace(PLACED)}>drop-signature</button>
      <button type="button" onClick={() => onPlace(null)}>clear-placement</button>
      <button type="button" onClick={() => onFail?.()}>break-renderer</button>
    </div>
  ),
}));

const SignPage = (await import('../../pages/SignPage')).default;
const AddendumEnvelopeRows = (await import('../AddendumEnvelopeRows')).default;

const lease = { id: 'lease-1', tenant_name: 'Bright Coffee Co.', tenant_email: 'sam@brightcoffee.example' };
const property = { id: 'prop-1', name: 'Maple Plaza' };
const corp = { id: 'corp-1', name: 'Acme Holdings', contact_email: 'leasing@acmeholdings.example' };

function mountCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <AddendumEnvelopeRows leaseId="lease-1" lease={lease} property={property} corp={corp} />
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

const future = () => new Date(Date.now() + 20 * 86400000).toISOString();

// The demo store is module-level. Put both seeded envelopes back after every test.
const RESET = async () => {
  await supabase.from('signature_envelopes').update({
    status: 'signed', signed_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    countersigned_at: null, executed_at: null, executed_path: null, applied_at: null,
    expires_at: future(),
  }).eq('id', 'env-1');
  await supabase.from('envelope_signers').update({
    signed_at: new Date(Date.now() - 2 * 86400000).toISOString(), typed_name: 'Sam Rivera',
    place_page: null, place_x: null, place_y: null, place_w: null,
  }).eq('id', 'sgn-1t');
  await supabase.from('signature_envelopes').update({ status: 'executed', applied_at: null }).eq('id', 'env-2');
  // env-3 is the still-out-with-the-tenant one; a test that expires or deletes it has to
  // put it back or every later suite sees a different card.
  await supabase.from('signature_envelopes').update({
    status: 'sent', signed_at: null,
    expires_at: new Date(Date.now() + 26 * 86400000).toISOString(),
  }).eq('id', 'env-3');
};

beforeEach(async () => { cleanup(); stubCanvas(); await RESET(); });
afterEach(RESET);

// Reopen env-1 so the tenant page has something live to sign.
const reopen = () => supabase.from('signature_envelopes')
  .update({ status: 'sent', signed_at: null, expires_at: future() }).eq('id', 'env-1');

describe('the tenant places their own signature on the document', () => {
  it('stores the point they dropped it on, in PDF coordinates', async () => {
    await reopen();
    await supabase.from('envelope_signers').update({ signed_at: null, consent_at: null }).eq('id', 'sgn-1t');
    render(<SignPage token="env-1" />);
    await screen.findByText('Second Amendment to Lease');

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('⌨ Type'));            // gives us a signature PNG
    await waitFor(() => expect(screen.getByText('drop-signature').disabled).toBe(false));
    fireEvent.click(screen.getByText('drop-signature'));
    await screen.findByText('placed:1:320');

    fireEvent.click(screen.getByRole('button', { name: 'Sign document' }));
    await screen.findByText('Signed');

    const { data } = await supabase.from('envelope_signers').select('*').eq('id', 'sgn-1t').maybeSingle();
    expect(data.place_page).toBe(1);
    expect(Number(data.place_x)).toBeCloseTo(320);
    expect(Number(data.place_y)).toBeCloseTo(402);
    expect(Number(data.place_w)).toBeCloseTo(170);
  });

  it('tells them it is placed, and where', async () => {
    await reopen();
    await supabase.from('envelope_signers').update({ signed_at: null }).eq('id', 'sgn-1t');
    render(<SignPage token="env-1" />);
    await screen.findByText('Second Amendment to Lease');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(screen.getByText('drop-signature').disabled).toBe(false));

    expect(screen.getByText(/drag your signature onto the signature line/i)).toBeTruthy();
    fireEvent.click(screen.getByText('drop-signature'));
    expect(await screen.findByText(/Your signature is placed on page 1/)).toBeTruthy();
  });

  // ⚠ THE ONE THAT MATTERS MOST. Placement is a nicety; signing is the product.
  it('still signs when they never place it — placement stays null', async () => {
    await reopen();
    await supabase.from('envelope_signers').update({ signed_at: null }).eq('id', 'sgn-1t');
    render(<SignPage token="env-1" />);
    await screen.findByText('Second Amendment to Lease');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign document' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Sign document' }));

    await screen.findByText('Signed');
    const { data } = await supabase.from('envelope_signers').select('*').eq('id', 'sgn-1t').maybeSingle();
    expect(data.signed_at).toBeTruthy();
    expect(data.place_page).toBe(null);   // → the executed PDF appends a signature page
  });

  it('still signs when the document refuses to render at all', async () => {
    await reopen();
    await supabase.from('envelope_signers').update({ signed_at: null }).eq('id', 'sgn-1t');
    render(<SignPage token="env-1" />);
    await screen.findByText('Second Amendment to Lease');
    fireEvent.click(screen.getByText('break-renderer'));

    // The canvas is gone, replaced by an explanation — and signing is still possible.
    await waitFor(() => expect(screen.queryByTestId('pdfcanvas')).toBe(null));
    expect(screen.getByText(/can’t be shown here/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign document' }).disabled).toBe(false));
  });
});

// George, 2026-08-05: *"make the prompt for the signature signing and placing way more
// obvious right now its hidden theres needs to be clear instructions same thing for the
// contract signer after they input their signature. it has to be way more clear and
// straightforward for both users that they sign and tap where they place the signature."*
//
// Nothing about the MECHANISM changed — the tests above still pass unedited, and placement
// is still never a gate. What changed is that the instruction is now stated before the
// document, restated as a block the size of a paragraph once there is a mark to place, and
// carries a button back to the page. Both sides of a signature get the identical treatment,
// which is what the second describe below is for.
describe('the signer is told what to do, before they have to do it', () => {
  const openLive = async () => {
    await reopen();
    await supabase.from('envelope_signers').update({ signed_at: null, consent_at: null }).eq('id', 'sgn-1t');
    render(<SignPage token="env-1" />);
    await screen.findByText('Second Amendment to Lease');
  };

  it('lists the steps — including the placing one — above the document', async () => {
    await openLive();
    const steps = document.querySelector('.sign-steps');
    expect(steps).toBeTruthy();
    expect(steps.textContent).toContain('Read the document');
    expect(steps.textContent).toContain('Sign your name');
    expect(steps.textContent).toContain('Tap where your signature goes');
    expect(steps.textContent).toContain('Send it back');
    // ⚠ ABOVE the document, not below it — the whole complaint was that the instruction
    // lived under a box tall enough to push it off the screen.
    const doc = document.querySelector('.sign-doc');
    expect(steps.compareDocumentPosition(doc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('turns into a block with a way back to the document the moment a signature exists', async () => {
    await openLive();
    expect(document.querySelector('.sign-cta')).toBe(null);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('⌨ Type'));
    const cta = await waitFor(() => {
      const el = document.querySelector('.sign-cta');
      expect(el).toBeTruthy();
      return el;
    });
    expect(cta.textContent).toMatch(/Now tap where your signature goes/);
    // Placing is offered, never required — the way past it is stated in the same block.
    expect(cta.textContent).toMatch(/You can still sign/);
    expect(screen.getByRole('button', { name: 'Take me to the document' })).toBeTruthy();
    // …and the step line moves on with them.
    expect(document.querySelector('.sign-steps').textContent).toContain('Tap where your signature goes');
  });

  it('replaces the ask with a confirmation once the mark is on the page', async () => {
    await openLive();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(screen.getByText('drop-signature').disabled).toBe(false));
    fireEvent.click(screen.getByText('drop-signature'));

    await waitFor(() => expect(document.querySelector('.sign-cta')).toBe(null));
    expect(screen.getByText(/Your signature is placed on page 1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move it' })).toBeTruthy();
  });

  // ⚠ THE ACTUAL FAULT. On a phone the document is a full screen above the pad, so drawing
  // a signature leaves the person looking at a instruction about something they can't see.
  it('carries them back to the document as soon as they have a mark', async () => {
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    await openLive();
    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
  });
});

describe('the landlord countersigns on the same document', () => {
  it('places his own mark and completes the envelope', async () => {
    mountCard();
    fireEvent.click(await screen.findByRole('button', { name: '✎ Countersign' }));
    await screen.findByTestId('pdfcanvas');

    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(screen.getByText('drop-signature').disabled).toBe(false));
    fireEvent.click(screen.getByText('drop-signature'));
    await screen.findByText(/Your signature is placed on page 1/);

    fireEvent.click(screen.getByRole('button', { name: 'Sign and complete' }));
    await waitFor(async () => {
      const { data } = await supabase.from('signature_envelopes').select('*').eq('id', 'env-1').maybeSingle();
      expect(data.status).toBe('executed');
    });
    const { data: landlord } = await supabase.from('envelope_signers').select('*').eq('id', 'sgn-1l').maybeSingle();
    expect(landlord.place_page).toBe(1);
    expect(Number(landlord.place_x)).toBeCloseTo(320);
  });

  // The same instructions, on the other side of the same signature. Two screens explaining
  // one act differently is how one of them becomes the screen people get stuck on.
  it('gets the identical steps and the identical call to action', async () => {
    mountCard();
    fireEvent.click(await screen.findByRole('button', { name: '✎ Countersign' }));
    const dialog = await screen.findByRole('dialog');
    const steps = dialog.querySelector('.sign-steps');
    expect(steps.textContent).toContain('Read what the tenant signed');
    expect(steps.textContent).toContain('Tap where your signature goes');

    fireEvent.click(screen.getByText('⌨ Type'));
    const cta = await waitFor(() => {
      const el = dialog.querySelector('.sign-cta');
      expect(el).toBeTruthy();
      return el;
    });
    expect(cta.textContent).toMatch(/Now tap where your signature goes/);
    expect(screen.getByRole('button', { name: 'Take me to the document' })).toBeTruthy();
  });

  it('says where the tenant put theirs, before he commits his own', async () => {
    await supabase.from('envelope_signers')
      .update({ place_page: 1, place_x: 56, place_y: 402, place_w: 170 }).eq('id', 'sgn-1t');
    mountCard();
    fireEvent.click(await screen.findByRole('button', { name: '✎ Countersign' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('placed their signature on page 1');
  });
});

describe('the signature record — what is actually stored', () => {
  it('shows the document fingerprint, the signer’s details and the audit trail', async () => {
    mountCard();
    await screen.findByText('Second Amendment to Lease');
    fireEvent.click(screen.getAllByRole('button', { name: 'Signature record' })[0]);

    // Scoped to the panel: the OTHER envelope's unclicked button carries the same words.
    await waitFor(() => expect(document.querySelector('.env-record')).toBeTruthy());
    const panel = document.querySelector('.env-record');
    await waitFor(() => expect(panel.textContent).toContain('CREATED'));

    // The hash is the thing that turns an assertion into evidence.
    expect(panel.textContent).toContain('a3f1c0de');
    expect(panel.textContent).toContain('no longer match it');
    expect(panel.textContent).toContain('203.0.113.10');
    expect(panel.textContent).toContain('Sam Rivera');
    // Consent and signature are separate legal facts and both are recorded.
    expect(panel.textContent).toContain('Agreed to sign electronically');
    // Every audit event.
    ['CREATED', 'SENT', 'VIEWED', 'CONSENTED', 'SIGNED'].forEach((k) => {
      expect(panel.textContent).toContain(k);
    });
  });

  it('says whether the mark went on the document or on a page at the end', async () => {
    mountCard();
    await screen.findByText('Second Amendment to Lease');
    fireEvent.click(screen.getAllByRole('button', { name: 'Signature record' })[0]);
    await waitFor(() => expect(document.querySelector('.env-record')?.textContent)
      .toContain('Added on a signature page at the end'));

    await supabase.from('envelope_signers')
      .update({ place_page: 4, place_x: 56, place_y: 402, place_w: 170 }).eq('id', 'sgn-1t');
    cleanup();
    mountCard();
    await screen.findByText('Second Amendment to Lease');
    fireEvent.click(screen.getAllByRole('button', { name: 'Signature record' })[0]);
    await waitFor(() => expect(document.querySelector('.env-record')?.textContent)
      .toContain('Placed on page 4 of the document'));
  });
});

// George, 2026-08-04: *"i was just doing a test run on the hair salon one for joliet and i
// want to remove it"* — and there was no way to. Void was offered only while an envelope was
// still out with the tenant, so anything signed was stuck on the card permanently.
describe('getting a signed envelope off the card', () => {
  it('offers Withdraw on a signed envelope and keeps the record', async () => {
    mountCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));
    expect(await screen.findByText('Withdraw this signed document?')).toBeTruthy();
    // The dialog must promise what it actually does: the signature survives.
    expect(screen.getByText(/audit trail are KEPT/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw it' }));

    await waitFor(async () => {
      const { data } = await supabase.from('signature_envelopes').select('*').eq('id', 'env-1').maybeSingle();
      expect(data.status).toBe('voided');
    });
    // The signature record is still there — that is the whole difference from delete.
    const { data: signer } = await supabase.from('envelope_signers').select('*').eq('id', 'sgn-1t').maybeSingle();
    expect(signer.signed_at).toBeTruthy();
  });

  it('deletes an executed envelope only after naming exactly what is destroyed', async () => {
    mountCard();
    await screen.findByText('Estoppel Certificate');
    // Find the ✕ that belongs to the EXECUTED envelope by walking up from its title —
    // indexing into getAllByTitle() breaks the moment the seed gains another envelope,
    // which is exactly what happened when env-3 was added.
    const row = screen.getByText('Estoppel Certificate').closest('.env-row');
    fireEvent.click(row.querySelector('[title="Delete this document and its record"]'));

    expect(await screen.findByText('Delete a signed document?')).toBeTruthy();
    expect(screen.getByText(/SIGNED BY BOTH PARTIES/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));

    await waitFor(async () => {
      const { data } = await supabase.from('signature_envelopes').select('*').eq('id', 'env-2').maybeSingle();
      expect(data).toBeFalsy();
    });
    // Its signers went with it (ON DELETE CASCADE live; explicit in the mock).
    const { data: gone } = await supabase.from('envelope_signers').select('*').eq('envelope_id', 'env-2');
    expect(gone?.length ?? 0).toBe(0);
  });

  it('a plain unsigned request gets the gentler dialog', async () => {
    mountCard();
    // env-3 is seeded still-out-with-the-tenant — nothing signed, so the gentler dialog.
    await screen.findByText('Third Amendment to Lease');
    const row = screen.getByText('Third Amendment to Lease').closest('.env-row');
    fireEvent.click(row.querySelector('[title="Delete this document and its record"]'));
    expect(await screen.findByText('Delete this document?')).toBeTruthy();
    expect(screen.queryByText(/SIGNED BY BOTH PARTIES/)).toBe(null);
  });
});
