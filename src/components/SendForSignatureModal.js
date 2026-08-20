import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { uploadDoc, sendForSignature, logSignatureEvent, discardDocument, addServiceContract } from '../lib/api';
import { PURPOSE, EXPIRY_CHOICES, DEFAULT_EXPIRY_DAYS, expiryFromNow, CONTRACT_PURPOSE } from '../lib/envelopes';
import { useModalA11y } from './modalA11y';
import { useConfirm } from './ConfirmDialog';
import { FilePickerZone } from './FileDrop';
import SelectMenu from './SelectMenu';

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
//
// ── THE CONTRACTS TAB USES THE SAME DIALOG (0093) ───────────────────────────────────────
// Pass `contracts` instead of `lease` and it sends to a VENDOR. Three things change and
// nothing else: the counterparty defaults to the vendor rather than the tenant, the purpose
// question disappears (an executed service contract IS the contract — there is no filing
// decision left to make), and a "which contract?" question appears in its place, because an
// envelope has to have a home before it can be sent.
//
// ⚠ "A new contract" CREATES THE SHELL FIRST, deliberately. The alternative — send now, file
// it later — means an executed agreement with nowhere to land, which is the state this whole
// feature exists to prevent. The shell carries a name and nothing else: no fee, no term, no
// CAM line. The signed document fills it in, after the landlord has seen the diff.
const NEW_CONTRACT = '__new__';

export default function SendForSignatureModal({
  lease, contracts = null, property, corp,
  defaultPurpose = 'other', defaultTitle = '', renewalOptionId = null, onClose, onSent,
}) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const modalRef = useModalA11y(onClose);
  const forContract = Array.isArray(contracts);

  const [file, setFile] = useState(null);
  const [uploaded, setUploaded] = useState(null); // { path, filename }
  const [purpose, setPurpose] = useState(forContract ? CONTRACT_PURPOSE : defaultPurpose);
  const [title, setTitle] = useState(defaultTitle);
  // ⚠ NO DEFAULT. '' is "not chosen yet" and NEW is "a contract that doesn't exist yet";
  // pre-selecting the first contract on the list would silently attach a renewal to whatever
  // happened to sort first, and an envelope filed against the wrong contract is a signed
  // agreement that re-prices the wrong vendor's CAM line when it is read in.
  const [contractId, setContractId] = useState('');
  const [newName, setNewName] = useState('');
  const isNewContract = contractId === NEW_CONTRACT;
  const picked = forContract && !isNewContract ? contracts.find((c) => c.id === contractId) || null : null;
  const [signerName, setSignerName] = useState(
    forContract ? '' : (lease?.tenant_contact_name || lease?.tenant_name || '')
  );
  const [signerEmail, setSignerEmail] = useState(forContract ? '' : (lease?.tenant_email || ''));
  const [message, setMessage] = useState('');
  const [days, setDays] = useState(DEFAULT_EXPIRY_DAYS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);

  // Choosing a contract fills in whoever Amlak already knows to write to — overwritable, and
  // only ever a default: a vendor's billing address and its signatory are often different
  // people, and the person who signs is the one who needs the link.
  function chooseContract(id) {
    setContractId(id);
    const c = contracts.find((x) => x.id === id);
    if (c) {
      setSignerName((n) => n || c.vendor || '');
      setSignerEmail((e) => e || c.vendor_email || '');
      setTitle((t) => t || (c.name ? `${c.name} — renewal` : ''));
    }
  }

  async function onFile(f) {
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
      // The shell, when he chose "a new contract". Created BEFORE the send so a successful
      // send always has a home; a failed create stops here, before an envelope exists.
      let targetContract = picked;
      if (forContract && isNewContract) {
        targetContract = await addServiceContract({ property_id: property.id, name: newName.trim() });
        if (!targetContract?.id) throw new Error('The contract could not be created.');
      }
      const res = await sendForSignature({
        leaseId: forContract ? null : lease.id,
        contractId: forContract ? targetContract.id : null,
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
        propertyId: property.id,
        leaseId: forContract ? null : lease.id,
        tenantName: forContract ? null : lease.tenant_name,
        type: 'signature_sent', title: title.trim(), signerName: signerName.trim(),
      });
      return res;
    },
    onSuccess: (res) => {
      setResult(res);
      // ['serviceContracts'] too, because "a new contract" just added a row to the list this
      // dialog was opened from — without it the shell is invisible until a reload.
      ['envelopes', 'historyEvents', 'alerts', 'serviceContracts'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      onSent?.(res);
    },
    onError: (e) => setErr(e.message || String(e)),
  });

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail.trim());
  const homeOk = !forContract || (isNewContract ? !!newName.trim() : !!picked);
  const canSend = !!uploaded && !!title.trim() && !!signerName.trim() && emailOk && homeOk && !busy && !send.isPending;

  async function confirmAndSend() {
    if (await askConfirm({
      title: 'Send this for signature?',
      message: `“${title.trim()}” goes to ${signerName.trim()} at ${signerEmail.trim()}.`,
      implications: [
        'They get a private link that opens straight to the document — no account needed.',
        `The link stops working after ${EXPIRY_CHOICES.find((c) => c.days === days)?.label || `${days} days`}, and you can cancel it any time before they sign.`,
        forContract && isNewContract
          ? `“${newName.trim()}” is added to this property’s contracts now, with a name and nothing else — no fee, no term, and nothing in CAM until you read the signed copy in.`
          : null,
        forContract
          ? 'No figure on the contract changes until it comes back signed and you read it in — and Amlak shows you what moves before it moves.'
          : 'Nothing changes on this lease until it is signed by both parties and you apply it.',
      ].filter(Boolean),
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
          <strong>{forContract ? 'Send a contract for signature' : 'Send a document for signature'}</strong>
          <button className="icon-btn" onClick={() => close()}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            {forContract
              ? 'Your contract, sent as it is. The vendor gets a private link that opens straight to it — no account, no software. You countersign after they do, and read the signed copy in afterwards.'
              : <>Your document, sent as it is. {lease?.tenant_name} gets a private link that opens straight
                to it — no account, no software. You sign after they do.</>}
          </p>

          <FilePickerZone
            onFile={onFile}
            accept=".pdf,.docx,image/*"
            busy={busy}
            ariaLabel="Choose the document to send"
            hint={file ? `✓ ${file.name}` : 'Choose the document (PDF, Word .docx, or a scan) — or drag it in here'}
            dropHint="Drop the document here"
            busyHint="Uploading…"
          />
          {file && !/\.pdf$/i.test(file.name) && (
            <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Word documents and scans can’t be stamped, so the signed copy will be your original plus
              a signature and certificate page. <strong>A PDF gives you one combined file.</strong>
            </p>
          )}

          {/* The lease dialog asks WHAT the document is, because that decides where an
              executed copy files itself. The contract dialog asks WHICH CONTRACT instead:
              a service contract's filing question has one answer, but its home does not. */}
          {forContract ? (
            <>
              <label className="form-field" style={{ marginTop: 14 }}>
                <span>Which contract is this for?</span>
                <SelectMenu className="text-input" value={contractId}
                  onChange={(e) => chooseContract(e.target.value)}>
                  <option value="">Choose the contract…</option>
                  {contracts.map((c) => (
                    <option key={c.id} value={c.id}>{c.name || c.vendor || 'Contract'}</option>
                  ))}
                  <option value={NEW_CONTRACT}>A new contract…</option>
                </SelectMenu>
              </label>
              {isNewContract ? (
                <>
                  <label className="form-field">
                    <span>Name the new contract</span>
                    <input className="text-input" value={newName} onChange={(e) => setNewName(e.target.value)}
                      placeholder="e.g. Snow removal — Arctic" maxLength={120} />
                  </label>
                  <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 14 }}>
                    It’s added to this property now with a name and nothing else. Its fee, term and
                    renewal are filled in from the signed copy, after you’ve seen what changes.
                  </p>
                </>
              ) : (
                <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 14 }}>
                  {picked
                    ? 'When it comes back signed, Amlak reads it and shows you what changes on this contract before any figure moves.'
                    : 'The signed copy files itself against this contract, so pick the one it replaces.'}
                </p>
              )}
            </>
          ) : (
            <>
              <label className="form-field" style={{ marginTop: 14 }}>
                <span>What is this document?</span>
                <SelectMenu className="text-input" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                  {PURPOSE.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </SelectMenu>
              </label>
              <p className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 14 }}>
                {PURPOSE.find((p) => p.key === purpose)?.hint}
              </p>
            </>
          )}

          <label className="form-field">
            <span>Title (what the {forContract ? 'vendor' : 'tenant'} sees)</span>
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
            <SelectMenu className="text-input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRY_CHOICES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
            </SelectMenu>
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
