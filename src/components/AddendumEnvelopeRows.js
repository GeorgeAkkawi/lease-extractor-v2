import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listEnvelopes, signDocUrl, voidEnvelope, resendEnvelope, countersignEnvelope, logSignatureEvent,
} from '../lib/api';
import {
  sortEnvelopes, statusBadge, envelopeLine, canVoid, canResend, needsCountersign,
  envelopeStatus, expiryFromNow, DEFAULT_EXPIRY_DAYS, purposeLabel,
} from '../lib/envelopes';
import SignaturePad from './SignaturePad';
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
                {canVoid(env) && (
                  <button type="button" className="icon-btn danger-btn" title="Cancel this signature request"
                    disabled={busy}
                    onClick={async () => {
                      if (await askConfirm({
                        title: 'Cancel this signature request?',
                        message: `“${env.title}” is withdrawn.`,
                        implications: [
                          'The link stops working — if the tenant opens it they’re told it was cancelled.',
                          'The document itself stays on file. Nothing on the lease changes.',
                          'To send it again you’ll start a new request.',
                        ],
                        confirmLabel: 'Cancel request',
                        tone: 'danger',
                      })) {
                        setBusyId(env.id); setErr('');
                        try { await voidEnvelope(env.id); refresh(); }
                        catch (e) { setErr(e.message || String(e)); }
                        finally { setBusyId(null); }
                      }
                    }}>✕</button>
                )}
              </span>
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

// The landlord's half. He sees what the tenant signed before committing his own name to it —
// which is the whole reason George chose "tenant signs, then you countersign" over signing
// on the way out.
function CountersignModal({ envelope, lease, property, corp, onClose, onDone }) {
  const modalRef = useModalA11y(onClose);
  const [name, setName] = useState(corp?.name || '');
  const [signature, setSignature] = useState('');
  const [err, setErr] = useState('');

  const sign = useMutation({
    mutationFn: async () => {
      const res = await countersignEnvelope({
        envelopeId: envelope.id, typedName: name.trim(), signaturePng: signature,
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
        style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Countersign — {envelope.title}</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="note-msg info" style={{ marginTop: 0 }}>
            <strong>{envelope.signer_typed_name || envelope.signer_name}</strong> signed this
            {envelope.signed_at ? ` on ${new Date(envelope.signed_at).toLocaleDateString()}` : ''}.
            Adding your signature completes it.
          </p>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Amlak builds the signed PDF — the document, both signatures, and a certificate recording
            the whole trail — and emails a copy to both of you. <strong>Nothing on this lease changes</strong>;
            you decide separately whether to apply it.
          </p>

          <label className="form-field" style={{ maxWidth: 340 }}>
            <span>Your name</span>
            <input className="text-input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Full name or business name" />
          </label>

          <SignaturePad value={signature} onChange={setSignature} typedName={name} disabled={sign.isPending} />

          {err && <p className="note-msg danger">{err}</p>}

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
