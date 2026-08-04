import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listEnvelopes, signDocUrl, voidEnvelope, resendEnvelope, countersignEnvelope, logSignatureEvent,
  listEnvelopeEvents, listEnvelopeSigners, deleteEnvelope,
} from '../lib/api';
import {
  sortEnvelopes, statusBadge, envelopeLine, canVoid, canResend, needsCountersign,
  envelopeStatus, expiryFromNow, DEFAULT_EXPIRY_DAYS, purposeLabel, deleteSeverity,
} from '../lib/envelopes';
import SignaturePad from './SignaturePad';
import PdfSignCanvas from './PdfSignCanvas';
import { useModalA11y } from './modalA11y';
import { useConfirm } from './ConfirmDialog';

// Documents out for signature, shown INSIDE the Addendums & riders card (George, 2026-08-04:
// *"i want this to be a part of the add addendums and riders card on each lease page"*).
//
// ⚠ A DELIBERATELY SEPARATE STRIP, NOT ROWS IN THE ADDENDUM TABLE. That table's columns are
// "Covers" and "What it changed" — an unsigned document has neither, and an executed one has
// neither *until it is applied*. Forcing it in would fill those cells with dashes and quietly
// imply the lease had been amended when it hasn't been. So it sits directly above the table
// instead: a row leaves here and appears there the moment it is actually applied, which is
// the continuity that matters.
//
// ⚠ AN EXECUTED ENVELOPE HAS CHANGED NOTHING ON THE LEASE. Nothing here writes a term, a rent
// or an addendum row — the strip says so in as many words, because a signed document that
// looks filed but isn't is exactly the kind of thing that goes stale unnoticed.
export default function AddendumEnvelopeRows({ leaseId, lease, property, corp }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [countersigning, setCountersigning] = useState(null);
  // Which row has its signature record open. George: *"i just need to see how its stored
  // after the fact."*
  const [recordId, setRecordId] = useState(null);

  const { data: envelopes = [] } = useQuery({
    queryKey: ['envelopes', leaseId],
    queryFn: () => listEnvelopes(leaseId),
    enabled: !!leaseId,
  });

  const refresh = () => {
    ['envelopes', 'alerts', 'historyEvents'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  };

  async function open(path) {
    setErr('');
    try {
      const url = await signDocUrl(path);
      if (url) window.open(url, '_blank', 'noopener');
      else setErr('That file is no longer in storage.');
    } catch (e) { setErr(e.message || String(e)); }
  }

  const resend = useMutation({
    mutationFn: (env) => resendEnvelope({
      envelopeId: env.id,
      expiresAt: expiryFromNow(DEFAULT_EXPIRY_DAYS),
      replyTo: corp?.contact_email || null,
      signerEmail: env.signer_email,
      signerName: env.signer_name,
    }),
    onSuccess: refresh,
    onError: (e) => setErr(e.message || String(e)),
  });

  const ordered = sortEnvelopes(envelopes);
  if (!ordered.length) return null;

  return (
    <div className="env-strip">
      <div className="env-head">Out for signature</div>
      <div className="env-rows">
        {ordered.map((env) => {
          const state = envelopeStatus(env);
          const badge = statusBadge(env);
          const busy = busyId === env.id || (resend.isPending && resend.variables?.id === env.id);
          return (
            <div className="env-row" key={env.id}>
              <span className="env-row-main">
                <span className="env-row-name">{env.title}</span>
                <span className="env-row-sub">
                  {envelopeLine(env)}
                  {env.purpose !== 'other' && <> · {purposeLabel(env.purpose).toLowerCase()}</>}
                </span>
                {/* The one thing a landlord could otherwise get wrong: a signed document is
                    not an applied one. Said on the row, not in a tooltip. */}
                {state === 'executed' && !env.applied_at && (
                  <span className="env-row-note">Signed, but nothing on this lease has changed yet.</span>
                )}
              </span>
              <span className={`badge ${badge.cls} env-badge`} title={badge.title}>{badge.label}</span>
              <span className="env-row-acts">
                {needsCountersign(env) && (
                  <button type="button" className="btn-sm" onClick={() => setCountersigning(env)}>
                    ✎ Countersign
                  </button>
                )}
                {state === 'executed' && env.executed_path && (
                  <button type="button" className="ghost btn-sm" onClick={() => open(env.executed_path)}>
                    Open signed copy
                  </button>
                )}
                {state !== 'executed' && (
                  <button type="button" className="ghost btn-sm" onClick={() => open(env.storage_path)}>
                    Open document
                  </button>
                )}
                {canResend(env) && (
                  <button type="button" className="ghost btn-sm" disabled={busy}
                    title="Send the link again — this replaces the old one, so the previous link stops working"
                    onClick={async () => {
                      if (await askConfirm({
                        title: 'Send the link again?',
                        message: `A fresh link goes to ${env.signer_name || 'the tenant'}${env.signer_email ? ` at ${env.signer_email}` : ''}.`,
                        implications: [
                          'The previous link stops working immediately.',
                          `The new one expires in ${DEFAULT_EXPIRY_DAYS} days.`,
                        ],
                        confirmLabel: 'Resend',
                      })) resend.mutate(env);
                    }}>
                    {busy ? '…' : 'Resend'}
                  </button>
                )}
                {/* The evidence, in the app. Offered from the moment anyone has signed —
                    this is what answers "how do I prove they signed it" without opening
                    a PDF. */}
                {['signed', 'executed', 'declined'].includes(state) && (
                  <button type="button" className="ghost btn-sm"
                    onClick={() => setRecordId((id) => (id === env.id ? null : env.id))}>
                    {recordId === env.id ? 'Hide record' : 'Signature record'}
                  </button>
                )}
                {canVoid(env) && (
                  <button type="button" className="ghost btn-sm" disabled={busy}
                    title={state === 'signed'
                      ? 'Withdraw this document — the signature record is kept'
                      : 'Cancel this signature request'}
                    onClick={async () => {
                      const isSigned = state === 'signed';
                      if (await askConfirm({
                        title: isSigned ? 'Withdraw this signed document?' : 'Cancel this signature request?',
                        message: `“${env.title}” is withdrawn.`,
                        implications: isSigned ? [
                          `${env.signer_typed_name || env.signer_name || 'The tenant'} has already signed this — withdrawing it means it will never be countersigned or completed.`,
                          'Their signature and the full audit trail are KEPT, badged “Voided”. Nothing is destroyed.',
                          'Nothing on the lease changes.',
                          'To go ahead after all, you’d send it again as a new request.',
                        ] : [
                          'The link stops working — if the tenant opens it they’re told it was cancelled.',
                          'The document itself stays on file. Nothing on the lease changes.',
                          'To send it again you’ll start a new request.',
                        ],
                        confirmLabel: isSigned ? 'Withdraw it' : 'Cancel request',
                        tone: 'danger',
                      })) {
                        setBusyId(env.id); setErr('');
                        try { await voidEnvelope(env.id); refresh(); }
                        catch (e) { setErr(e.message || String(e)); }
                        finally { setBusyId(null); }
                      }
                    }}>{state === 'signed' ? 'Withdraw' : 'Cancel'}</button>
                )}
                {/* Delete is offered on EVERY status, because a test run has to be removable
                    and there was no way off this card once anyone had signed. The dialog is
                    graded by what actually gets destroyed. */}
                <button type="button" className="icon-btn danger-btn" title="Delete this document and its record"
                  disabled={busy}
                  onClick={async () => {
                    const sev = deleteSeverity(env);
                    const implications = sev === 'executed' ? [
                      '⚠ This document is SIGNED BY BOTH PARTIES. Deleting it destroys the executed PDF, both signatures, the certificate of completion and the whole audit trail.',
                      'If this was a real agreement, there will be no record of it in Amlak afterwards.',
                      'Nothing on the lease changes — but you lose the evidence that it was signed.',
                      'This can’t be undone.',
                    ] : sev === 'record' ? [
                      `${env.signer_typed_name || env.signer_name || 'The tenant'} signed this — their signature, IP, timestamp and the audit trail are all destroyed with it.`,
                      'The document file is deleted from storage too.',
                      'Nothing on the lease changes. This can’t be undone.',
                    ] : [
                      'The document, the request and the link are removed.',
                      'Nothing on the lease changes. This can’t be undone.',
                    ];
                    if (await askConfirm({
                      title: sev === 'executed' ? 'Delete a signed document?' : 'Delete this document?',
                      message: `“${env.title}” and everything recorded about it.`,
                      implications,
                      confirmLabel: 'Delete permanently',
                      tone: 'danger',
                    })) {
                      setBusyId(env.id); setErr('');
                      try { await deleteEnvelope(env.id); setRecordId(null); refresh(); }
                      catch (e) { setErr(e.message || String(e)); }
                      finally { setBusyId(null); }
                    }
                  }}>✕</button>
              </span>
              {/* Full-width inside the flex row, so the record reads as a block under its
                  own envelope rather than squeezing into the actions column. */}
              {recordId === env.id && <SignatureRecord envelope={env} />}
            </div>
          );
        })}
      </div>
      {err && <p className="note-msg danger" style={{ marginTop: 8 }}>{err}</p>}

      {countersigning && (
        <CountersignModal
          envelope={countersigning}
          lease={lease}
          property={property}
          corp={corp}
          onClose={() => setCountersigning(null)}
          onDone={() => { setCountersigning(null); refresh(); }}
        />
      )}
    </div>
  );
}

// George, 2026-08-04: *"i just need to see how its stored after the fact."*
//
// Everything Amlak holds as proof, in the app, without opening a PDF — because the answer to
// "how do I prove they signed it" should not require finding a file. This is the same data
// the certificate page of the executed PDF is printed from: `envelope_events` is the ESIGN/
// UETA attribution evidence (UETA §9 — "may be proved in any manner, including a showing of
// the efficacy of any security procedure"), not a debug log.
//
// The document hash is the part people underestimate. It is what turns "they say they signed
// this" into "these exact bytes were signed, and here is the proof they haven't changed".
function SignatureRecord({ envelope }) {
  const { data: events = [], isLoading: loadingEvents } = useQuery({
    queryKey: ['envelopeEvents', envelope.id],
    queryFn: () => listEnvelopeEvents(envelope.id),
  });
  const { data: signers = [] } = useQuery({
    queryKey: ['envelopeSigners', envelope.id],
    queryFn: () => listEnvelopeSigners(envelope.id),
  });

  const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '—');

  return (
    <div className="env-record">
      <div className="env-record-head">Signature record</div>

      <div className="env-record-row">
        <span className="env-record-key">Document fingerprint</span>
        <span className="env-record-val mono">{envelope.doc_sha256 || '—'}</span>
      </div>
      <p className="env-record-note">
        A SHA-256 of the exact file that was sent. It is printed on the certificate page of the
        signed copy — if a single byte of the document were changed afterwards, this would no
        longer match it.
      </p>

      {signers.filter((s) => s.signed_at).map((s) => (
        <div key={s.id} className="env-record-signer">
          <strong>{s.typed_name || s.name}</strong>
          <span className="muted"> · {s.role === 'tenant' ? 'tenant' : 'landlord'}</span>
          {s.email && <div className="env-record-sub">{s.email}</div>}
          <div className="env-record-sub">Signed {when(s.signed_at)}</div>
          {s.consent_at && (
            <div className="env-record-sub">Agreed to sign electronically {when(s.consent_at)}</div>
          )}
          {s.ip && <div className="env-record-sub">From {s.ip}</div>}
          {s.user_agent && <div className="env-record-sub tiny">{s.user_agent}</div>}
          <div className="env-record-sub">
            {s.place_page
              ? `Placed on page ${s.place_page} of the document`
              : 'Added on a signature page at the end'}
          </div>
        </div>
      ))}

      <div className="env-record-head" style={{ marginTop: 12 }}>Audit trail</div>
      {loadingEvents ? (
        <p className="muted" style={{ fontSize: 12 }}>Loading…</p>
      ) : events.length === 0 ? (
        <p className="muted" style={{ fontSize: 12 }}>No events recorded.</p>
      ) : (
        <ul className="env-record-events">
          {events.map((e) => (
            <li key={e.id}>
              <span className="mono">{when(e.at)}</span>
              {' · '}<strong>{String(e.kind).toUpperCase()}</strong>
              {' · '}{e.actor}
              {e.ip ? <> · <span className="mono">{e.ip}</span></> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The landlord's half. He sees what the tenant signed before committing his own name to it —
// which is the whole reason George chose "tenant signs, then you countersign" over signing
// on the way out.
function CountersignModal({ envelope, lease, property, corp, onClose, onDone }) {
  const modalRef = useModalA11y(onClose);
  const [name, setName] = useState(corp?.name || '');
  const [signature, setSignature] = useState('');
  const [placement, setPlacement] = useState(null);
  const [err, setErr] = useState('');
  const [docUrl, setDocUrl] = useState(null);
  const [noRender, setNoRender] = useState(false);

  // The signers, so the tenant's mark can be drawn exactly where they put it. This is the
  // point of "tenant signs, then you countersign": he sees their placement before his own.
  const { data: signers = [] } = useQuery({
    queryKey: ['envelopeSigners', envelope.id],
    queryFn: () => listEnvelopeSigners(envelope.id),
  });
  const tenantSigner = signers.find((s) => s.role === 'tenant');

  // Short-lived signed URLs for the document and for the tenant's signature image.
  const [tenantSigPng, setTenantSigPng] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const u = await signDocUrl(envelope.storage_path);
        if (live) setDocUrl(u || null);
        if (!u) setNoRender(true);
      } catch { if (live) setNoRender(true); }
    })();
    return () => { live = false; };
  }, [envelope.storage_path]);

  useEffect(() => {
    if (!tenantSigner?.signature_path) return undefined;
    let live = true;
    (async () => {
      try { const u = await signDocUrl(tenantSigner.signature_path); if (live) setTenantSigPng(u || null); }
      catch { /* their mark not rendering must not stop him countersigning */ }
    })();
    return () => { live = false; };
  }, [tenantSigner?.signature_path]);

  const sign = useMutation({
    mutationFn: async () => {
      const res = await countersignEnvelope({
        envelopeId: envelope.id, typedName: name.trim(), signaturePng: signature, placement,
      });
      await logSignatureEvent({
        propertyId: property?.id, leaseId: lease?.id, tenantName: lease?.tenant_name,
        type: 'signature_executed', title: envelope.title, signerName: envelope.signer_typed_name || envelope.signer_name,
      });
      return res;
    },
    onSuccess: onDone,
    onError: (e) => setErr(e.message || String(e)),
  });

  const ready = !!name.trim() && !!signature && !sign.isPending;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1}
        style={{ width: 820 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Countersign — {envelope.title}</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="note-msg info" style={{ marginTop: 0 }}>
            <strong>{envelope.signer_typed_name || envelope.signer_name}</strong> signed this
            {envelope.signed_at ? ` on ${new Date(envelope.signed_at).toLocaleDateString()}` : ''}
            {tenantSigner?.place_page ? ` and placed their signature on page ${tenantSigner.place_page}` : ''}.
            Adding your signature completes it.
          </p>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Amlak builds the signed PDF — the document with both signatures on it, plus a certificate
            recording the whole trail.
            <strong> Nothing on this lease changes</strong>; you decide separately whether to apply it.
          </p>

          {/* Their signature is already on the page. He is looking at exactly what he is
              about to countersign, which is the entire reason the tenant signs first. */}
          {docUrl && !noRender && (
            <PdfSignCanvas
              url={docUrl}
              signature={signature}
              placement={placement}
              onPlace={setPlacement}
              disabled={sign.isPending}
              onFail={() => setNoRender(true)}
              existing={tenantSigPng && tenantSigner?.place_page ? [{
                png: tenantSigPng,
                place_page: tenantSigner.place_page,
                place_x: Number(tenantSigner.place_x),
                place_y: Number(tenantSigner.place_y),
                place_w: Number(tenantSigner.place_w),
                label: `${tenantSigner.typed_name || tenantSigner.name} (tenant)`,
              }] : []}
            />
          )}
          {noRender && (
            <p className="note-msg info">
              This document can’t be shown here, so signatures will be added on a page at the end
              instead of on the document itself. The certificate of completion is unaffected.
            </p>
          )}

          <label className="form-field" style={{ maxWidth: 340 }}>
            <span>Your name</span>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Full name or business name" />
          </label>

          <SignaturePad value={signature} onChange={setSignature} typedName={name} disabled={sign.isPending} />

          {signature && !noRender && docUrl && (
            <p className={`note-msg ${placement ? 'good' : 'info'}`}>
              {placement
                ? `✓ Your signature is placed on page ${placement.page}. Drag it if you want to move it.`
                : 'Drag your signature onto the signature line above — or just tap where it goes. You can complete it without placing it: it will go on a page at the end instead.'}
            </p>
          )}

          {err && <p className="note-msg danger">{err}</p>}

          {/* George, 2026-08-04: *"make sure the user knows that when he saves his signature a
              copy will be sent to the tenant."* It WAS said — in the grey 12.5px paragraph at
              the top of the dialog, which is where a warning goes to die. Sending is the
              irreversible half of this button, so it says so against the button, names the
              person it reaches, and says there is no separate send step to change your mind at. */}
          <p className="note-msg warn" style={{ marginBottom: 0 }}>
            ✉ <strong>Signing sends it.</strong> The moment you click below, the completed PDF is
            emailed to <strong>{envelope.signer_typed_name || envelope.signer_name || 'the tenant'}</strong>
            {envelope.signer_email ? <> at <strong>{envelope.signer_email}</strong></> : null} and a
            copy to you. There is no separate send step, and it can’t be recalled.
          </p>

          <div className="row" style={{ marginTop: 14 }}>
            <button type="button" onClick={() => sign.mutate()} disabled={!ready}>
              {sign.isPending ? 'Completing…' : 'Sign and complete'}
            </button>
            <button type="button" className="ghost" onClick={onClose} disabled={sign.isPending}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
