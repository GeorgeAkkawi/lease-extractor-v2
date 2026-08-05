import { useCallback, useEffect, useRef, useState } from 'react';
import SignaturePad from '../components/SignaturePad';
import PdfSignCanvas from '../components/PdfSignCanvas';
import SignSteps from '../components/SignSteps';
import { callSignEndpoint } from '../lib/signPublic';
import { fmtDate } from '../lib/format';

// THE ONLY PAGE IN AMLAK A PERSON WITHOUT AN ACCOUNT CAN SEE.
//
// George, 2026-08-04: *"i want to make sure all the tenant sees is the document"* and
// *"make sure there are no holes in the link where people can access the users account."*
// So, structurally:
//
//   • It is rendered in App.js BEFORE the auth gate, so it never waits on a session and
//     never falls through to <Login />.
//   • It is OUTSIDE <Layout> — no sidebar, no top bar, no nav, no route back into the app.
//   • It calls supabase.from(...) ZERO times. Its only outside contact is callSignEndpoint
//     (src/lib/signPublic.js), a bare fetch to one function that is gated by the token and
//     nothing else. There is no code path from this file into app data.
//   • Everything shown comes from that one response: the document, the tenant's own name,
//     the business name, the property name, the title, the expiry. No rent, no other
//     tenant, no lease id — the endpoint does not return them and this page cannot ask.
//
// The consent checkbox is not decoration. ESIGN/UETA turn on intent, consent, attribution
// and retention; this is where the first two are collected, and the edge function refuses
// to sign without consent === true rather than trusting the box.

const CONSENT_TEXT =
  'I agree to sign this document electronically, and I understand that my electronic signature '
  + 'is legally binding and has the same effect as a handwritten signature.';

export default function SignPage({ token }) {
  const [state, setState] = useState({ phase: 'loading' });
  const [consent, setConsent] = useState(false);
  const [name, setName] = useState('');
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  // Where they dropped their signature on the page: { page, x, y, w } in PDF points, or null.
  const [placement, setPlacement] = useState(null);
  // The renderer gave up (a scan pdf.js can't parse, a .docx, an old browser). Signing must
  // still work — it falls back to the appended signature page, exactly as before this
  // feature existed. A tenant who can't see the document must still be able to sign it.
  const [noRender, setNoRender] = useState(false);
  // The document box, so the page can take them back to it the moment their mark exists.
  const docRef = useRef(null);
  const sentToDoc = useRef(false);

  // The page has its own <title> and its own background — a tenant landing here should not
  // be able to tell it apart from a purpose-built signing service, because that is what it
  // is to them.
  useEffect(() => {
    const prev = document.title;
    document.title = 'Review & sign';
    document.body.classList.add('sign-body');
    return () => { document.title = prev; document.body.classList.remove('sign-body'); };
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await callSignEndpoint({ action: 'view', token });
      setState({ phase: 'ready', ...data });
      setName((n) => n || data.signer_name || '');
    } catch (e) {
      // A 410 is a real answer ("you already signed this", "it expired"), not a failure —
      // it gets the same calm treatment as a success.
      if (e.status === 410) setState({ phase: 'closed', message: e.message, state: e.payload?.state });
      else if (e.status === 404) setState({ phase: 'invalid' });
      else setState({ phase: 'error', message: e.message });
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const toDocument = useCallback(() => {
    // jsdom has no scrollIntoView, and neither do some older mobile browsers — the optional
    // call is what keeps a missing scroll from throwing on the one page that must never break.
    docRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, []);

  // ⚠ THE MOMENT A SIGNATURE EXISTS, THE DOCUMENT IS WHERE THEY NEED TO BE LOOKING.
  // The signature pad sits below a document box up to 70vh tall, so drawing a mark leaves
  // the page scrolled well past the thing they now have to tap. This carries them back
  // exactly once — a second automatic scroll would fight anyone deliberately reading on.
  useEffect(() => {
    if (!signature || placement || sentToDoc.current) return;
    if (!state.document_url || noRender) return;
    sentToDoc.current = true;
    toDocument();
  }, [signature, placement, state.document_url, noRender, toDocument]);

  async function sign() {
    setBusy(true); setErr('');
    try {
      await callSignEndpoint({
        action: 'sign', token, consent: true,
        typed_name: name.trim(), signature_png: signature,
        // Null when they couldn't or didn't place it — the executed PDF then appends a
        // signature page instead of stamping. Never a reason to refuse a signature.
        placement,
      });
      setState((s) => ({ ...s, phase: 'done' }));
    } catch (e) {
      if (e.status === 410) setState({ phase: 'closed', message: e.message, state: e.payload?.state });
      else setErr(e.message);
    } finally { setBusy(false); }
  }

  async function decline() {
    setBusy(true); setErr('');
    try {
      await callSignEndpoint({ action: 'decline', token, reason: reason.trim() || null });
      setState((s) => ({ ...s, phase: 'declined' }));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  if (state.phase === 'loading') return <Shell><p className="muted">Loading the document…</p></Shell>;

  if (state.phase === 'invalid') {
    return (
      <Shell>
        <h1 className="sign-title">This link isn’t valid</h1>
        <p className="muted">
          The address may have been copied incompletely. Try opening the link from your email again,
          or ask the sender to resend it.
        </p>
      </Shell>
    );
  }

  if (state.phase === 'error') {
    return (
      <Shell>
        <h1 className="sign-title">Something went wrong</h1>
        <p className="muted">{state.message}</p>
        <button type="button" onClick={load}>Try again</button>
      </Shell>
    );
  }

  if (state.phase === 'closed') {
    return (
      <Shell>
        <h1 className="sign-title">{state.state === 'expired' ? 'This link has expired' : 'Already handled'}</h1>
        <p className="muted">{state.message}</p>
      </Shell>
    );
  }

  if (state.phase === 'done') {
    return (
      <Shell business={state.business_name}>
        <div className="sign-done">✓</div>
        <h1 className="sign-title">Signed</h1>
        <p className="muted">
          Thank you. <strong>{state.title}</strong> has been signed. A completed copy will be emailed to
          you once {state.business_name} adds their signature.
        </p>
        <p className="muted" style={{ fontSize: 12.5 }}>You can close this page.</p>
      </Shell>
    );
  }

  if (state.phase === 'declined') {
    return (
      <Shell business={state.business_name}>
        <h1 className="sign-title">Declined</h1>
        <p className="muted">
          {state.business_name} has been told you didn’t sign this document. Nothing else happens —
          you can close this page.
        </p>
      </Shell>
    );
  }

  const canSign = consent && name.trim().length > 0 && !!signature && !busy;
  // Whether there is a page to put a mark ON. Everything about placement — the step, the
  // call to action, the automatic scroll — is silent when the document can't be rendered,
  // because there is nothing to tap and saying so would only confuse.
  const canPlace = !!state.document_url && !noRender;

  // George, 2026-08-05: *"it has to be way more clear and straightforward for both users
  // that they sign and tap where they place the signature."* Four short steps, up front,
  // before the document — so the placing step is known about BEFORE it is reached, rather
  // than discovered in a grey line under the signature pad.
  const steps = [
    { label: 'Read the document', done: consent },
    { label: 'Sign your name', done: !!signature && !!name.trim() },
    ...(canPlace ? [{ label: 'Tap where your signature goes', done: !!placement }] : []),
    { label: 'Send it back', done: false },
  ];

  return (
    <Shell business={state.business_name}>
      <h1 className="sign-title">{state.title}</h1>
      <p className="sign-sub muted">
        {[state.signer_name, state.property_name].filter(Boolean).join(' · ')}
      </p>
      {state.message && <p className="sign-note">{state.message}</p>}
      <p className="muted" style={{ fontSize: 12.5 }}>
        Please review the document below and sign. This link expires {fmtDate(state.expires_at)}.
      </p>

      <SignSteps steps={steps} />

      {/* The document, and the thing they sign ON. Once they've drawn a signature it becomes
          a mark they place on the page themselves — which is both what George asked for and
          the better demonstration of intent to sign that ESIGN/UETA ask about. */}
      <div className="sign-doc" ref={docRef}>
        {state.document_url && !noRender ? (
          <PdfSignCanvas
            url={state.document_url}
            signature={signature}
            placement={placement}
            onPlace={setPlacement}
            disabled={busy}
            onFail={() => setNoRender(true)}
          />
        ) : (
          <p className="muted" style={{ padding: 24 }}>
            {state.document_url
              ? 'This document can’t be shown here — download it below to read it. You can still sign: your signature will be added on a signature page at the end.'
              : 'The document couldn’t be loaded. Please contact the sender.'}
          </p>
        )}
      </div>
      {state.document_url && (
        <p className="sign-dl">
          <a href={state.document_url} target="_blank" rel="noopener noreferrer">⭳ Download a copy</a>
        </p>
      )}

      {declining ? (
        <div className="sign-block">
          <label className="form-field">
            <span>Why are you declining? (optional)</span>
            <textarea className="text-input" rows={3} value={reason}
              onChange={(e) => setReason(e.target.value)} placeholder="The sender will see this." />
          </label>
          <div className="row">
            <button type="button" className="danger-btn" onClick={decline} disabled={busy}>
              {busy ? 'Sending…' : 'Decline to sign'}
            </button>
            <button type="button" className="ghost" onClick={() => setDeclining(false)} disabled={busy}>Back</button>
          </div>
        </div>
      ) : (
        <div className="sign-block">
          <label className="sign-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>{CONSENT_TEXT}</span>
          </label>

          <label className="form-field" style={{ maxWidth: 340 }}>
            <span>Your name</span>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Full name" autoComplete="name" />
          </label>

          <SignaturePad value={signature} onChange={setSignature} typedName={name} disabled={busy} />

          {/* A nudge, never a gate. Placing the mark on the line is the better outcome — it
              is what makes the signed PDF look signed — but refusing to accept a signature
              because someone didn't drag it would be a far worse failure than an appended
              signature page. So this only ever informs.
              ⚠ It is now a BLOCK, not a 12.5px line, and it carries a button back to the
              document. The instruction was never missing; it was unreadable at the size and
              position it was given, half a screen away from the thing it referred to. */}
          {signature && canPlace && (placement ? (
            <p className="note-msg good">
              ✓ Your signature is placed on page {placement.page}.{' '}
              <button type="button" className="ghost btn-sm" onClick={toDocument}>Move it</button>
            </p>
          ) : (
            <div className="sign-cta">
              <strong>👆 Now tap where your signature goes</strong>
              <span>
                Go up to the document and tap the signature line — your signature lands right
                there. You can also drag your signature onto the signature line to line it up.
              </span>
              <button type="button" onClick={toDocument}>Take me to the document</button>
              <span className="sign-cta-alt">
                Rather not? You can still sign — it goes on a signature page at the end.
              </span>
            </div>
          ))}

          {err && <p className="note-msg danger">{err}</p>}

          <div className="row" style={{ marginTop: 14 }}>
            <button type="button" onClick={sign} disabled={!canSign}>
              {busy ? 'Signing…' : 'Sign document'}
            </button>
            <button type="button" className="ghost" onClick={() => setDeclining(true)} disabled={busy}>Decline</button>
          </div>
          {!canSign && !busy && (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              {!consent ? 'Tick the box above to continue.'
                : !name.trim() ? 'Enter your name.'
                : 'Add your signature above.'}
            </p>
          )}
        </div>
      )}

      <p className="sign-legal muted">
        Signed electronically through Amlak. Your signature, the time, and your network address are
        recorded on a certificate attached to the completed document.
      </p>
    </Shell>
  );
}

// Deliberately minimal chrome: the business name, a rule, and the content. Nothing that
// looks like an app, nothing to navigate to.
function Shell({ business, children }) {
  return (
    <div className="sign-page">
      <div className="sign-card">
        <div className="sign-brand">{business || 'Amlak'}</div>
        <hr className="sign-rule" />
        {children}
      </div>
    </div>
  );
}
