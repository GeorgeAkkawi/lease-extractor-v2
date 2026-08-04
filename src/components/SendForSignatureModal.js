import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uploadDoc, sendForSignature, logSignatureEvent, discardDocument } from '../lib/api';
import { PURPOSE, EXPIRY_CHOICES, DEFAULT_EXPIRY_DAYS, expiryFromNow } from '../lib/envelopes';
import { useModalA11y } from './modalA11y';
import { useConfirm } from './ConfirmDialog';

// Drop a document in and send it out for signature. George, 2026-08-04: *"theres no need for
// the software to create a doc — just make there a place for the user to drop it in so they
// can send from amlak."* So there is deliberately no drafting, no AI and no template here:
// the landlord's own document goes out exactly as he wrote it.
//
// THE ONE QUESTION THAT ISN'T COSMETIC is "what is this document?" — it sets `purpose`, which
// decides what happens after both parties sign. Guessing it from the filename would mean a
// replacement lease quietly filing itself as a rider, so it is asked plainly.
//
// ⚠ THE FILE IS UPLOADED BEFORE THE ENVELOPE EXISTS, and thrown away if the send fails or the
// landlord backs out — the same discardDocument dance AddendumEditor does for an abandoned
// rider review, and for the same reason: an orphaned file in the bucket is invisible and
// permanent. The edge function then hashes those stored bytes itself; a client-supplied
// hash would be a seal chosen by the sealer.
export default function SendForSignatureModal({
  lease, property, corp, defaultPurpose = 'other', defaultTitle = '', renewalOptionId = null, onClose, onSent,
}) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const modalRef = useModalA11y(onClose);

  const [file, setFile] = useState(null);
  const [uploaded, setUploaded] = useState(null); // { path, filename }
  const [purpose, setPurpose] = useState(defaultPurpose);
  const [title, setTitle] = useState(defaultTitle);
  const [signerName, setSignerName] = useState(lease?.tenant_contact_name || lease?.tenant_name || '');
  const [signerEmail, setSignerEmail] = useState(lease?.tenant_email || '');
  const [message, setMessage] = useState('');
  const [days, setDays] = useState(DEFAULT_EXPIRY_DAYS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);

  async function onFile(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setErr(''); setBusy(true);
    try {
      // No entityType yet — the envelope it belongs to doesn't exist until the send
      // succeeds. registerDocument runs then, against the envelope.
      const path = await uploadDoc(f);
      setFile(f);
      setUploaded({ path, filename: f.name });
      // A document with no title of its own gets the filename, minus the extension —
      // better than "Document" and instantly editable.
      if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, '').slice(0, 120));
    } catch (ex) { setErr(ex.message || String(ex)); } finally { setBusy(false); }
  }

  function close({ discard = true } = {}) {
    if (discard && uploaded?.path && !result) discardDocument(uploaded.path).catch(() => {});
    onClose();
  }

  const send = useMutation({
    mutationFn: async () => {
      const res = await sendForSignature({
        leaseId: lease.id,
        propertyId: property.id,
        renewalOptionId,
        purpose,
        title: title.trim(),
        storagePath: uploaded.path,
        filename: uploaded.filename,
        message: message.trim() || null,
        signerName: signerName.trim(),
        signerEmail: signerEmail.trim(),
        expiresAt: expiryFromNow(days),
        replyTo: corp?.contact_email || null,
        landlordName: corp?.name || null,
      });
      await logSignatureEvent({
        propertyId: property.id, leaseId: lease.id, tenantName: lease.tenant_name,
        type: 'signature_sent', title: title.trim(), signerName: signerName.trim(),
      });
      return res;
    },
    onSuccess: (res) => {
      setResult(res);
      ['envelopes', 'historyEvents', 'alerts'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      onSent?.(res);
    },
    onError: (e) => setErr(e.message || String(e)),
  });

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail.trim());
  const canSend = !!uploaded && !!title.trim() && !!signerName.trim() && emailOk && !busy && !send.isPending;

  async function confirmAndSend() {
    if (await askConfirm({
      title: 'Send this for signature?',
      message: `“${title.trim()}” goes to ${signerName.trim()} at ${signerEmail.trim()}.`,
      implications: [
        'They get a private link that opens straight to the document — no account needed.',
        `The link stops working after ${EXPIRY_CHOICES.find((c) => c.days === days)?.label || `${days} days`}, and you can cancel it any time before they sign.`,
        'Nothing changes on this lease until it is signed by both parties and you apply it.',
      ],
      confirmLabel: 'Send it',
      tone: 'warn',
    })) send.mutate();
  }

  // ---- Sent ---------------------------------------------------------------
  if (result) {
    return (
      <div className="modal-scrim" onClick={() => close({ discard: false })}>
        <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1}
          style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-head">
            <strong>{result.emailed ? 'Sent for signature' : 'Ready to send'}</strong>
            <button className="icon-btn" onClick={() => close({ discard: false })}>✕</button>
          </div>
          <div className="modal-body">
            {result.emailed ? (
              <p className="note-msg good">
                ✓ <strong>{title.trim()}</strong> is on its way to {signerName.trim()} at {signerEmail.trim()}.
                You’ll be told here as soon as they sign.
              </p>
            ) : (
              <p className="note-msg warn">
                The document is ready but the email didn’t go out. Send this link yourself — it works
                the same way.
              </p>
            )}
            {/* The raw token is visible EXACTLY ONCE, here. Nothing stores it and no endpoint
                can recover it, so this is the only chance to copy it — which is precisely why
                it is offered even on a successful send. */}
            <label className="form-field">
              <span>Signing link (this is the only time it’s shown)</span>
              <input className="text-input" readOnly value={result.sign_url}
                onFocus={(e) => e.target.select()} />
            </label>
            <div className="row">
              <button type="button" onClick={() => navigator.clipboard?.writeText(result.sign_url)}>
                ⧉ Copy link
              </button>
              <button type="button" className="ghost" onClick={() => close({ discard: false })}>Done</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- Compose ------------------------------------------------------------
  return (
    <div className="modal-scrim" onClick={() => close()}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1}
        style={{ width: 680 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Send a document for signature</strong>
          <button className="icon-btn" onClick={() => close()}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            Your document, sent as it is. {lease?.tenant_name} gets a private link that opens straight
            to it — no account, no software. You sign after they do.
          </p>

          <div className="dropzone">
            <input type="file" accept=".pdf,.docx,image/*" className="file-native"
              onChange={onFile} disabled={busy} aria-label="Choose the document to send" />
            <div className="dropzone-hint muted">
              {busy ? 'Uploading…' : file ? `✓ ${file.name}` : 'Choose the document (PDF, Word .docx, or a scan)'}
            </div>
          </div>
          {file && !/\.pdf$/i.test(file.name) && (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Word documents and scans can’t be stamped, so the signed copy will be your original plus
              a signature and certificate page. <strong>A PDF gives you one combined file.</strong>
            </p>
          )}

          <label className="form-field" style={{ marginTop: 14 }}>
            <span>What is this document?</span>
            <select className="text-input" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {PURPOSE.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
          <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 14 }}>
            {PURPOSE.find((p) => p.key === purpose)?.hint}
          </p>

          <label className="form-field">
            <span>Title (what the tenant sees)</span>
            <input className="text-input" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="First Amendment to Lease" maxLength={300} />
          </label>

          <div className="env-2col">
            <label className="form-field">
              <span>Who signs</span>
              <input className="text-input" value={signerName} onChange={(e) => setSignerName(e.target.value)}
                placeholder="Full name" />
            </label>
            <label className="form-field">
              <span>Their email</span>
              <input className="text-input" type="email" value={signerEmail}
                onChange={(e) => setSignerEmail(e.target.value)} placeholder="name@example.com" />
            </label>
          </div>
          {signerEmail.trim() && !emailOk && (
            <p className="note-msg danger" style={{ marginTop: -6 }}>That email doesn’t look right.</p>
          )}

          <label className="form-field">
            <span>A note in the email (optional)</span>
            <textarea className="text-input" rows={3} value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Here's the extension we discussed — let me know if anything looks off." />
          </label>

          <label className="form-field" style={{ maxWidth: 200 }}>
            <span>Link expires after</span>
            <select className="text-input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRY_CHOICES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
            </select>
          </label>

          {err && <p className="note-msg danger">{err}</p>}

          <div className="row" style={{ marginTop: 6 }}>
            <button type="button" onClick={confirmAndSend} disabled={!canSend}>
              {send.isPending ? 'Sending…' : '✎ Send for signature'}
            </button>
            <button type="button" className="ghost" onClick={() => close()}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
