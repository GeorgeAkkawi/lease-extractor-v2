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
