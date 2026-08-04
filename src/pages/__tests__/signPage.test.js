// The public signing page, driven against the demo mock's stand-in for the one
// unauthenticated edge function. What matters here is not the layout — it is the three
// guarantees the whole feature rests on:
//
//   ① a tenant cannot sign without CONSENTING first (ESIGN/UETA intent + consent)
//   ② the page shows the document and NOTHING about the landlord's portfolio
//   ③ a dead link (expired, already signed, cancelled) says so calmly instead of leaking
//      the document or reading as a crash
//
// It also covers the one thing that would silently break the page: SignPage takes its token
// as a PROP, because App.js renders it outside any <Route> and useParams() would be empty.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import SignPage from '../SignPage';
import { supabase } from '../../lib/supabaseClient';

// The demo's "token" is the envelope id — see the note in mockClient.js. env-1 is seeded
// 'signed'; we reopen it so there is something live to sign.
const LIVE = 'env-1';
const EXECUTED = 'env-2';

const future = () => new Date(Date.now() + 20 * 86400000).toISOString();

beforeEach(async () => {
  cleanup();
  await supabase.from('signature_envelopes')
    .update({ status: 'sent', signed_at: null, expires_at: future() }).eq('id', LIVE);
  await supabase.from('envelope_signers')
    .update({ signed_at: null, consent_at: null, typed_name: null }).eq('id', 'sgn-1t');
});

afterEach(async () => {
  // The demo store is module-level; put the seeded state back for anything after us.
  await supabase.from('signature_envelopes')
    .update({ status: 'signed', expires_at: future() }).eq('id', LIVE);
});

// jsdom has no canvas backend, so SignaturePad's toDataURL would return '' and no test
// could ever reach the Sign button. Stub the two calls the pad actually makes.
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

describe('SignPage — what the tenant sees', () => {
  it('shows the document, the business and their own name — and nothing else', async () => {
    render(<SignPage token={LIVE} />);
    expect(await screen.findByText('Second Amendment to Lease')).toBeTruthy();
    expect(screen.getByText('Acme Holdings')).toBeTruthy();
    expect(screen.getByText(/Sam Rivera/)).toBeTruthy();

    // ② The landlord's portfolio must not be reachable from here. These are real values
    // from the same demo lease the envelope points at.
    const page = document.body.textContent;
    expect(page).not.toContain('60,000');          // base_rent
    expect(page).not.toContain('City Dental');     // the OTHER tenant in this property
    expect(page).not.toContain('lease-1');         // no ids of any kind
    expect(page).not.toContain('Oak Center');      // no other property
    // …and no app chrome to navigate away into.
    expect(screen.queryByText('Financials')).toBe(null);
    expect(screen.queryByText('Dashboard')).toBe(null);
  });

  it('carries the landlord’s covering note through', async () => {
    render(<SignPage token={LIVE} />);
    expect(await screen.findByText(/extension we discussed/)).toBeTruthy();
  });
});

describe('SignPage — consent is a gate, not decoration', () => {
  beforeEach(stubCanvas);

  it('Sign stays disabled until consent, a name AND a signature are all present', async () => {
    render(<SignPage token={LIVE} />);
    await screen.findByText('Second Amendment to Lease');

    const signBtn = screen.getByRole('button', { name: 'Sign document' });
    expect(signBtn.disabled).toBe(true);
    expect(screen.getByText('Tick the box above to continue.')).toBeTruthy();

    // The name is pre-filled from the envelope, so consent is what's missing first.
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(screen.getByText('Add your signature above.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Sign document' }).disabled).toBe(true);

    // Typing the signature (the ⌨ Type path) completes the set.
    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign document' }).disabled).toBe(false));
  });

  it('clearing the name disables Sign again', async () => {
    render(<SignPage token={LIVE} />);
    await screen.findByText('Second Amendment to Lease');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign document' }).disabled).toBe(false));

    fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign document' }).disabled).toBe(true));
  });

  it('signing moves the envelope to “signed” and thanks them', async () => {
    render(<SignPage token={LIVE} />);
    await screen.findByText('Second Amendment to Lease');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('⌨ Type'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign document' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Sign document' }));

    expect(await screen.findByText('Signed')).toBeTruthy();
    const { data } = await supabase.from('signature_envelopes').select('*').eq('id', LIVE).maybeSingle();
    expect(data.status).toBe('signed');
    // The consent timestamp is a separate legal fact from the signature — both are recorded.
    const { data: signer } = await supabase.from('envelope_signers').select('*').eq('id', 'sgn-1t').maybeSingle();
    expect(signer.consent_at).toBeTruthy();
    expect(signer.signed_at).toBeTruthy();
    expect(signer.typed_name).toBe('Sam Rivera');
  });
});

describe('SignPage — a link that no longer works', () => {
  it('an EXPIRED link shows the expiry, not the document', async () => {
    await supabase.from('signature_envelopes')
      .update({ expires_at: new Date(Date.now() - 86400000).toISOString() }).eq('id', LIVE);
    render(<SignPage token={LIVE} />);
    expect(await screen.findByText('This link has expired')).toBeTruthy();
    // ③ The document must not be reachable past the expiry.
    expect(screen.queryByTitle('Document')).toBe(null);
    expect(screen.queryByRole('button', { name: 'Sign document' })).toBe(null);
  });

  it('an ALREADY-EXECUTED envelope says so instead of offering to sign it again', async () => {
    render(<SignPage token={EXECUTED} />);
    expect(await screen.findByText('Already handled')).toBeTruthy();
    expect(screen.getByText(/already been completed/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign document' })).toBe(null);
  });

  it('an unknown token is a dead end that reveals nothing', async () => {
    render(<SignPage token={'x'.repeat(43)} />);
    expect(await screen.findByText('This link isn’t valid')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Acme Holdings');
  });
});

describe('SignPage — declining', () => {
  it('records a decline and changes nothing else', async () => {
    render(<SignPage token={LIVE} />);
    await screen.findByText('Second Amendment to Lease');
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    fireEvent.change(await screen.findByPlaceholderText('The sender will see this.'),
      { target: { value: 'The dates are wrong.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decline to sign' }));

    expect(await screen.findByText('Declined')).toBeTruthy();
    const { data } = await supabase.from('signature_envelopes').select('*').eq('id', LIVE).maybeSingle();
    expect(data.status).toBe('declined');
    expect(data.declined_reason).toBe('The dates are wrong.');
  });
});
