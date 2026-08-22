import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getPropertyInsurance, getTenantInsurance, saveInsurance, supersedeInsurance, extractInsurance,
  uploadDoc, askDoc, listInsuranceDocuments, addInsuranceDocument, removeInsuranceDocument,
  signDocUrl, listArchivedInsurance, archiveInsurance, deleteInsurance, listAlertStates,
  upsertAlertState, attachDocument, listDocuments,
} from '../lib/api';
import DocAssistant from './DocAssistant';
import DocumentsList from './DocumentsList';
import FileDrop, { FilePickerZone } from './FileDrop';
import { money, fmtDate } from '../lib/format';
import { useModalA11y } from './modalA11y';
import { missingAdditionalInsured, additionalInsuredAlertKey } from '../lib/insuranceNotices';
import { useConfirm } from './ConfirmDialog';
import { useOptimisticRemove } from './useOptimisticRemove';
import MutationError from './MutationError';

// Expiry status of a policy by its date: green while current, amber within a month,
// red once expired. Drives the badge on the card and whether a tenant policy shows the
// "Request renewed certificate" button. null date → no status.
export function expiryStatus(expiryDate, now = new Date()) {
  if (!expiryDate) return null;
  const days = Math.round((new Date(expiryDate + 'T12:00:00') - now) / 86400000);
  if (days < 0) return { key: 'expired', tone: 'danger', label: 'Expired', stale: true };
  if (days <= 31) return { key: 'expiring', tone: 'warn', label: 'Expiring soon', stale: true };
  return { key: 'current', tone: 'good', label: 'Current', stale: false };
}

// Insurance vault for one scope: landlord (per property) or tenant (per lease).
// Add a policy (paste or upload) → key-facts auto-fill + a copy is saved once →
// glanceable card + ask-anything Q&A. Extra documents (renewals, premium notices)
// can be attached, and a removed policy can be archived to history.
// `onRequestRenewal(policy, reason?)` (tenant scope only) is called by the "Request
// renewed certificate" button on an expiring/expired policy and — with reason
// 'additional_insured' — by the not-listed-as-additional-insured banner/pop-up; the
// lease page opens the matching professional request email with it.
export default function InsuranceVault({ party, propertyId, leaseId, onRequestRenewal }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const scopeKey = party === 'landlord' ? propertyId : leaseId;
  const queryKey = ['insurance', party, scopeKey];
  const archivedKey = ['insurance-archived', party, scopeKey];
  const { data: policy, isLoading } = useQuery({
    queryKey,
    queryFn: () => (party === 'landlord' ? getPropertyInsurance(propertyId) : getTenantInsurance(leaseId)),
  });

  const [text, setText] = useState('');
  const [paste, setPaste] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [editFacts, setEditFacts] = useState(false);
  const [removing, setRemoving] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey });

  const saveFacts = useMutation({
    mutationFn: (vals) => saveInsurance({ party, propertyId, leaseId, ...vals }),
    onSuccess: () => { setEditFacts(false); invalidate(); },
  });

  // Remove policy → archive to history (keep the row + documents) or delete for good.
  const removeMut = useMutation({
    mutationFn: ({ mode, id }) => (mode === 'archive' ? archiveInsurance(id) : deleteInsurance(id)),
    onSuccess: () => { setRemoving(false); invalidate(); qc.invalidateQueries({ queryKey: archivedKey }); },
  });

  // Read a policy document and file it.
  //
  // ⚠ A POLICY ON FILE IS NEVER OVERWRITTEN. George, 2026-08-05: *"once a new one is uploaded
  // (not replaced) it is moved to history within that and then the new one is uploaded and
  // read and saved."* Until now this called saveInsurance, which UPDATEs the active row — so
  // renewing a certificate destroyed the insurer, coverage, premium and expiry of the year
  // before it, keeping only the file. Now the old row is archived (it keeps its own
  // certificate and its own extra documents) and the read becomes a NEW row.
  //
  // The very first policy for a scope has nothing to supersede, and supersedeInsurance
  // handles that case itself — so there is one write path here, not two that could disagree.
  async function intake(getExtract) {
    setBusy(true); setErr('');
    try {
      const { fields, policy_text, storagePath } = await getExtract();
      // The certificate itself is kept. Until now the file was uploaded and its path
      // thrown on the floor — all 7 live policies had storage_path null, so not one
      // certificate could be opened from the record it belonged to.
      const { policy: saved } = await supersedeInsurance({
        party, propertyId, leaseId,
        insurer: fields.insurer ?? null,
        coverage_amount: fields.coverage_amount ?? null,
        expiry_date: fields.expiry_date ?? null,
        additional_insured: fields.additional_insured ?? null,
        policy_text,
        ...(storagePath ? { storage_path: storagePath } : {}),
      });
      // ⚠ Against the NEW policy's id, which is what keeps each year's certificate with the
      // year it belongs to instead of piling every copy onto one record.
      if (storagePath && saved?.id) {
        await attachDocument(storagePath, { entityType: 'insurance_policy', entityId: saved.id });
      }
      setText(''); setReplacing(false);
      invalidate();
      qc.invalidateQueries({ queryKey: archivedKey });
      // The superseded policy stops raising its expiry alert the moment it is archived —
      // every reader filters archived_at is null — but the dashboard has to be told to look.
      qc.invalidateQueries({ queryKey: ['alerts'] });
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }
  const onPaste = () => { if (text.trim()) intake(() => extractInsurance({ text: text.trim() })); };
  const onFile = (f) => {
    // The path rides back on the return value so a failed read can't strand it: the
    // registry row exists either way, and attachDocument only runs once a policy
    // row is there to own it.
    if (f) intake(async () => {
      const storagePath = await uploadDoc(f, { entityType: 'insurance_policy' });
      const res = await extractInsurance({ storagePath });
      return { ...res, storagePath };
    });
  };

  // Additional-insured notice (tenant scope): a cert on file that doesn't name the
  // landlord shows a red banner + a one-time center pop-up. The pop-up's dismissal
  // is stored in alert_states keyed per certificate (policy id + expiry), so a
  // renewed cert that still leaves the landlord off re-arms it.
  const missingAI = party === 'tenant' && missingAdditionalInsured(policy);
  const { data: alertStates, isSuccess: statesLoaded } = useQuery({
    queryKey: ['alertStates'],
    queryFn: listAlertStates,
    enabled: missingAI,
  });
  const aiKey = missingAI ? additionalInsuredAlertKey(policy) : null;
  const aiDismissed = !!alertStates?.some((s) => s.alert_key === aiKey && s.dismissed);
  const dismissAiPopup = useMutation({
    mutationFn: () => upsertAlertState({ alert_key: aiKey, dismissed: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alertStates'] }),
  });

  if (isLoading) return <p className="muted">Loading…</p>;

  const status = policy ? expiryStatus(policy.expiry_date) : null;
  // Only pop up once the dismiss store has actually loaded — no flicker for a
  // certificate that was already dismissed.
  const showAiPopup = missingAI && statesLoaded && !aiDismissed && !replacing && !removing;

  return (
    <div>
      {/* Editing the facts, removing the policy and dismissing the additional-insured
          warning were all silent on failure — the form simply closed and the old figures
          came back. */}
      <MutationError of={[saveFacts, removeMut, dismissAiPopup]} />
      {policy && !replacing && (
        <>
          {/* Persistent in-place signal — stays after the pop-up is dismissed, until a
              cert naming the landlord is on file. */}
          {!editFacts && missingAI && (
            <div className="note-msg danger" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <span>⚠ You are not listed as additional insured on this certificate. Ask the tenant for a corrected copy.</span>
              {onRequestRenewal && (
                <button type="button" onClick={() => onRequestRenewal(policy, 'additional_insured')}>✉ Request corrected certificate</button>
              )}
            </div>
          )}
          {editFacts ? (
            <FactsForm policy={policy} party={party} busy={saveFacts.isPending} onSave={(vals) => saveFacts.mutate(vals)} onCancel={() => setEditFacts(false)} />
          ) : (
            <div className="ins-card">
              <div><span className="ins-k">Insurer</span><span className="ins-v">{policy.insurer || '—'}</span></div>
              <div><span className="ins-k">Coverage limit</span><span className="ins-v">{policy.coverage_amount != null ? money(policy.coverage_amount) : '—'}</span></div>
              <div><span className="ins-k">Premium</span><span className="ins-v">{policy.premium_amount != null ? money(policy.premium_amount) : '—'}</span></div>
              <div>
                <span className="ins-k">Expires</span>
                <span className="ins-v" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {policy.expiry_date ? fmtDate(policy.expiry_date) : '—'}
                  {status && <span className={`badge ${status.tone}`}>{status.label}</span>}
                </span>
              </div>
              {/* Additional insured only matters on the tenant's policy (does it name the landlord?). */}
              {party === 'tenant' && (
                <div><span className="ins-k">Additional insured</span><span className={`badge ${policy.additional_insured ? 'good' : 'danger'}`} style={{ alignSelf: 'flex-start', marginTop: 4 }}>{policy.additional_insured ? 'Yes' : 'No — not listed'}</span></div>
              )}
            </div>
          )}
          {/* Request a certificate from the tenant, always available while a policy is on
              file. On an expiring/expired one it's a prominent warning; on a current one
              it's a quiet "keep our copy up to date" action. */}
          {!editFacts && party === 'tenant' && policy && onRequestRenewal && (
            status?.stale ? (
              <div className="note-msg warn" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <span>{status.key === 'expired' ? 'This certificate has expired.' : 'This certificate is expiring soon.'} Ask the tenant for the renewed copy.</span>
                <button type="button" onClick={() => onRequestRenewal(policy)}>✉ Request renewed certificate</button>
              </div>
            ) : (
              <div className="row" style={{ marginBottom: 12, gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="muted" style={{ fontSize: 12.5 }}>Need the latest copy on file?</span>
                <button type="button" className="ghost" onClick={() => onRequestRenewal(policy)}>✉ Request updated certificate</button>
              </div>
            )
          )}
          {!editFacts && (
            <div className="row" style={{ marginBottom: 14, gap: 14 }}>
              <button type="button" className="ghost" onClick={() => setEditFacts(true)}>Edit facts</button>
              {/* ⚠ NOT "Replace policy" any more, because it no longer replaces one. The old
                  label described what the code did — overwrite the row — and that was the
                  bug. The word is now the thing that actually happens. */}
              <button type="button" className="ghost" onClick={() => setReplacing(true)}>+ Add a new policy</button>
              <button type="button" className="ghost danger-btn" onClick={() => setRemoving(true)}>Remove policy</button>
            </div>
          )}
          <DocAssistant label="policy" docText={policy.policy_text} ask={(q) => askDoc(policy.policy_text, q, 'insurance')} />
          {/* Every certificate ever uploaded for this policy, newest first. Until
              migration 0070 the file was uploaded and its path discarded, so not one
              of the live certificates could be opened from the record it belonged to. */}
          <DocumentsList
            entityType="insurance_policy"
            entityId={policy.id}
            title="Saved certificates"
            addLabel="Add a copy"
            emptyText="No certificate file on file for this policy — the facts above were pasted in, or the copy predates document keeping. Add one to keep it here."
          />
          <DocumentsSection policyId={policy.id} />
        </>
      )}

      {(!policy || replacing) && (
        <div>
          {replacing && (
            <div className="row" style={{ marginBottom: 8 }}>
              <button type="button" className="ghost" onClick={() => { setReplacing(false); setErr(''); }}>Cancel</button>
            </div>
          )}
          {/* Say what happens to the one already on file, BEFORE the file picker — this is
              the difference between "my last policy is gone" and "my last policy is filed". */}
          {replacing && policy && (
            <div className="note-msg info" style={{ marginTop: 0, marginBottom: 10 }}>
              The policy on file{policy.insurer ? <> from <strong>{policy.insurer}</strong></> : null}
              {policy.expiry_date ? <> (expiring {fmtDate(policy.expiry_date)})</> : null} moves into{' '}
              <strong>Policy history</strong> below, with its certificate and any documents kept
              alongside it. Nothing is overwritten, and it stops sending you expiry reminders.
            </div>
          )}
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
            Upload the policy or certificate of insurance (PDF, scan, or photo). It reads the document once to fill in the key facts, then lets you ask questions about it.
          </div>
          <FilePickerZone
            onFile={onFile}
            accept=".pdf,.docx,image/*"
            busy={busy}
            ariaLabel="Upload insurance policy file"
            hint="Choose the policy file — or drag it straight in here"
            dropHint="Drop the policy here"
            busyHint="Reading the policy…"
          />
          <div className="row" style={{ marginTop: 12 }}>
            <button type="button" className="ghost" onClick={() => setPaste((p) => !p)}>{paste ? 'Hide paste' : 'Paste text instead'}</button>
          </div>
          {paste && (
            <div style={{ marginTop: 10 }}>
              <textarea
                className="text-input"
                rows={5}
                style={{ width: '100%' }}
                placeholder="Paste the policy / certificate of insurance text…"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="row" style={{ marginTop: 8 }}>
                <button type="button" onClick={onPaste} disabled={busy || !text.trim()}>{busy ? 'Reading…' : 'Extract & save'}</button>
              </div>
            </div>
          )}
          {err && <p className="badge danger" style={{ marginTop: 8 }}>{err}</p>}
        </div>
      )}

      <ArchivedSection party={party} propertyId={propertyId} leaseId={leaseId} archivedKey={archivedKey} />

      {removing && policy && (
        <RemovePolicyModal
          busy={removeMut.isPending}
          onArchive={() => removeMut.mutate({ mode: 'archive', id: policy.id })}
          onDelete={() => removeMut.mutate({ mode: 'delete', id: policy.id })}
          onCancel={() => setRemoving(false)}
        />
      )}

      {showAiPopup && (
        <AdditionalInsuredPopup
          policy={policy}
          busy={dismissAiPopup.isPending}
          onDismiss={() => dismissAiPopup.mutate()}
          onRequest={onRequestRenewal ? () => { dismissAiPopup.mutate(); onRequestRenewal(policy, 'additional_insured'); } : null}
        />
      )}
    </div>
  );
}

// Center-screen "you are not listed as additional insured" notice, shown once per
// certificate when the tenant's policy loads. Dismiss (button / ✕ / Escape) keeps it
// quiet for THIS certificate; a renewed cert that still omits the landlord re-arms it.
function AdditionalInsuredPopup({ policy, onRequest, onDismiss, busy }) {
  const modalRef = useModalA11y(onDismiss);
  return (
    <div className="modal-scrim" onClick={onDismiss}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 500 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>⚠ Not listed as additional insured</strong>
          <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss">✕</button>
        </div>
        <div className="modal-body">
          <p style={{ marginTop: 0 }}>
            This tenant's certificate of insurance{policy.insurer ? ` (${policy.insurer})` : ''} does{' '}
            <strong>not</strong> name you as additional insured. Most leases require the tenant's policy to
            include you — without it, their coverage may not protect you in a claim.
          </p>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
            Dismiss keeps this quiet for this certificate — you'll be reminded again if a new certificate
            still leaves you off. The red note stays on the policy below.
          </p>
        </div>
        <div className="modal-foot">
          <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="secondary" onClick={onDismiss} disabled={busy}>Dismiss</button>
            {onRequest && <button onClick={onRequest} disabled={busy}>✉ Request corrected certificate</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// Inline editor for the key-facts (manual override of the auto-filled values).
// Additional insured only applies to a tenant's policy.
function FactsForm({ policy, party, busy, onSave, onCancel }) {
  const [f, setF] = useState({
    insurer: policy.insurer || '',
    coverage_amount: policy.coverage_amount ?? '',
    premium_amount: policy.premium_amount ?? '',
    expiry_date: policy.expiry_date || '',
    additional_insured: !!policy.additional_insured,
  });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = () => {
    const vals = {
      insurer: f.insurer || null,
      coverage_amount: f.coverage_amount === '' ? null : Number(f.coverage_amount),
      premium_amount: f.premium_amount === '' ? null : Number(f.premium_amount),
      expiry_date: f.expiry_date || null,
    };
    if (party === 'tenant') vals.additional_insured = f.additional_insured;
    onSave(vals);
  };
  return (
    <div className="ins-card" style={{ flexDirection: 'column', gap: 14 }}>
      <div className="field-grid" style={{ width: '100%' }}>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Insurer</span><input className="text-input" value={f.insurer} onChange={set('insurer')} /></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Coverage limit ($)</span><input className="text-input num" type="number" step="any" value={f.coverage_amount} onChange={set('coverage_amount')} /></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Premium ($)</span><input className="text-input num" type="number" step="any" value={f.premium_amount} onChange={set('premium_amount')} /></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Expiry</span><input className="text-input" type="date" value={f.expiry_date} onChange={set('expiry_date')} /></label>
        {party === 'tenant' && (
          <div className="field"><span className="field-label">Additional insured</span>
            <div className="seg">
              <button type="button" className={`seg-btn${f.additional_insured ? ' on' : ''}`} onClick={() => setF((s) => ({ ...s, additional_insured: true }))}>Yes</button>
              <button type="button" className={`seg-btn${!f.additional_insured ? ' on' : ''}`} onClick={() => setF((s) => ({ ...s, additional_insured: false }))}>No</button>
            </div>
          </div>
        )}
      </div>
      <div className="row">
        <button type="button" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save facts'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Extra files kept with a policy — renewals, premium notices, endorsements, any
// PDF. Plain stored documents (no AI); each has a free-form label + optional note.
function DocumentsSection({ policyId }) {
  const qc = useQueryClient();
  const key = ['insurance-docs', policyId];
  const { data: docs = [] } = useQuery({ queryKey: key, queryFn: () => listInsuranceDocuments(policyId), enabled: !!policyId });

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [err, setErr] = useState('');

  const add = useMutation({
    mutationFn: () => addInsuranceDocument({ policyId, label: label.trim(), file, note: note.trim() }),
    onSuccess: () => { setLabel(''); setNote(''); setFile(null); setAdding(false); qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => setErr(e.message || String(e)),
  });
  const del = useMutation({
    mutationFn: (id) => removeInsuranceDocument(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  async function open(path) {
    try { const url = await signDocUrl(path); if (url) window.open(url, '_blank', 'noopener'); }
    catch (e) { setErr(e.message || String(e)); }
  }

  return (
    <div style={{ marginTop: 18 }}>
      <strong style={{ fontSize: 13 }}>Additional documents</strong>
      <p className="muted" style={{ marginTop: 4, marginBottom: 10, fontSize: 12.5 }}>
        Renewals, premium notices, endorsements — anything you want to keep with this policy.
      </p>
      {docs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {docs.map((d) => (
            <div key={d.id} className="ins-card" style={{ padding: '10px 14px', marginBottom: 0, alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ flexDirection: 'row', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{d.label}</span>
                {d.note && <span className="muted" style={{ fontSize: 12.5 }}>· {d.note}</span>}
              </div>
              <div className="row" style={{ gap: 6 }}>
                {d.storage_path && <button type="button" className="ghost" onClick={() => open(d.storage_path)}>Open</button>}
                <button type="button" className="icon-btn" title="Remove document" onClick={() => del.mutate(d.id)}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        // The whole add-a-document row is the target, so a file can be dragged in before or
        // after the label is typed — it only sets `file`, it never submits.
        <FileDrop
          onFile={setFile}
          accept=".pdf,.docx,image/*"
          title="Drop it here"
          hint="It attaches to this document — you still choose the label and press Add."
        >
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input className="text-input" style={{ flex: '1 1 200px' }} placeholder="Label (e.g. 2026 Renewal, Premium notice)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <input className="text-input" style={{ flex: '1 1 160px' }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <label className="ghost" style={{ cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>
              {file ? `📎 ${file.name.slice(0, 20)}` : '📎 Attach file — or drag one in'}
              <input type="file" accept=".pdf,.docx,image/*" style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
            </label>
            <button type="button" onClick={() => add.mutate()} disabled={!label.trim() || add.isPending}>{add.isPending ? 'Adding…' : 'Add document'}</button>
            <button type="button" className="ghost" onClick={() => { setAdding(false); setLabel(''); setNote(''); setFile(null); setErr(''); }}>Cancel</button>
          </div>
        </FileDrop>
      ) : (
        <button type="button" className="ghost" onClick={() => setAdding(true)}>+ Add document</button>
      )}
      {err && <p className="badge danger" style={{ marginTop: 8 }}>{err}</p>}
    </div>
  );
}

// POLICY HISTORY — every policy this property or tenant has had, newest first.
//
// Two things put a row here: uploading a new policy over one already on file (the renewal
// path — supersedeInsurance archives the old one), and Remove policy → Save to history.
//
// ⚠ IT HAS TO OFFER THE CERTIFICATE, or it is a list of dates rather than a record. Each
// archived policy keeps its OWN saved copies, because attachDocument files them against the
// policy id that was active when they were uploaded — which is exactly what makes "what were
// we covered for in 2024, and where is the paper" answerable.
function ArchivedSection({ party, propertyId, leaseId, archivedKey }) {
  const qc = useQueryClient();
  // ⚠ Its own useConfirm. This read the parent component's `askConfirm` binding, which is
  // not in scope here — clicking the delete button threw a ReferenceError and the dialog
  // never opened, so nothing could be removed from history at all.
  const askConfirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  const { data: archived = [] } = useQuery({
    queryKey: archivedKey,
    queryFn: () => listArchivedInsurance({ party, propertyId, leaseId }),
  });
  const del = useOptimisticRemove({
    queryKey: archivedKey, idOf: (id) => id,
    mutationFn: (id) => deleteInsurance(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: archivedKey }),
  });
  if (!archived.length) return null;

  return (
    <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <button type="button" className="ghost" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Policy history ({archived.length})
      </button>
      {open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {archived.map((p) => (
            <div key={p.id} className="ins-card" style={{ opacity: 0.9, flexWrap: 'wrap' }}>
              <div><span className="ins-k">Insurer</span><span className="ins-v">{p.insurer || '—'}</span></div>
              <div><span className="ins-k">Coverage</span><span className="ins-v">{p.coverage_amount != null ? money(p.coverage_amount) : '—'}</span></div>
              <div><span className="ins-k">Premium</span><span className="ins-v">{p.premium_amount != null ? money(p.premium_amount) : '—'}</span></div>
              <div><span className="ins-k">Expired</span><span className="ins-v">{p.expiry_date ? fmtDate(p.expiry_date) : '—'}</span></div>
              <div><span className="ins-k">Replaced</span><span className="ins-v">{p.archived_at ? fmtDate(String(p.archived_at).slice(0, 10)) : '—'}</span></div>
              {party === 'tenant' && (
                <div>
                  <span className="ins-k">Additional insured</span>
                  <span className={`badge ${p.additional_insured ? 'good' : 'danger'}`} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                    {p.additional_insured ? 'Yes' : 'No'}
                  </span>
                </div>
              )}
              <div className="row" style={{ marginLeft: 'auto', alignSelf: 'center', gap: 6 }}>
                <ArchivedCertificates policy={p} onError={setErr} />
                <button
                  type="button"
                  className="icon-btn danger-btn"
                  title="Delete permanently from history"
                  // The button's only content is an emoji, so `title` alone leaves a screen
                  // reader announcing "🗑" — and leaves the action unnameable in a test.
                  aria-label="Delete permanently from history"
                  onClick={async () => {
                    if (await askConfirm({
                      title: 'Delete archived policy?',
                      message: `Permanently delete the ${p.insurer || 'archived'} policy${p.expiry_date ? ` that expired ${fmtDate(p.expiry_date)}` : ''}?`,
                      implications: [
                        'The policy record and every certificate stored with it are permanently deleted.',
                        'The policy currently on file is not affected.',
                        'This can’t be undone.',
                      ],
                      confirmLabel: 'Delete permanently',
                      tone: 'danger',
                    })) del.mutate(p.id);
                  }}
                >🗑</button>
              </div>
            </div>
          ))}
          {err && <p className="note-msg danger">{err}</p>}
          {/* ⚠ REQUIRED by useOptimisticRemove — see its header note. */}
          <MutationError of={[del]} />
        </div>
      )}
    </div>
  );
}

// The certificate(s) filed against ONE archived policy. `storage_path` on the policy row is
// the copy read at intake; the documents registry holds any other copies added while it was
// the active one. Deduped by path so the intake copy isn't offered twice.
function ArchivedCertificates({ policy, onError }) {
  const { data: docs = [] } = useQuery({
    queryKey: ['documents', 'insurance_policy', policy.id],
    queryFn: () => listDocuments('insurance_policy', policy.id),
    enabled: !!policy.id,
  });
  const paths = [...new Set([policy.storage_path, ...docs.map((d) => d.storage_path)].filter(Boolean))];
  if (!paths.length) return <span className="muted" style={{ fontSize: 12 }}>No file kept</span>;

  const open = async (path) => {
    try {
      const url = await signDocUrl(path);
      if (url) window.open(url, '_blank', 'noopener');
      else onError?.('That file is no longer in storage.');
    } catch (e) { onError?.(e.message || String(e)); }
  };
  return (
    <button type="button" className="ghost btn-sm" onClick={() => open(paths[0])}>
      Open certificate{paths.length > 1 ? ` (1 of ${paths.length})` : ''}
    </button>
  );
}

// Remove-policy confirmation with the archive-or-delete choice.
function RemovePolicyModal({ onArchive, onDelete, onCancel, busy }) {
  // Escape closes; focus is trapped in the dialog and returned on close.
  const modalRef = useModalA11y(onCancel);
  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 470 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Remove policy</strong>
          <button className="icon-btn" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ marginTop: 0 }}>Do you want to save this to your expired items in history?</p>
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
            <strong>Save to history</strong> keeps the policy and its documents in an archive you can view
            later. <strong>Delete permanently</strong> removes it for good.
          </p>
        </div>
        <div className="modal-foot">
          <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="secondary" onClick={onCancel} disabled={busy}>Cancel</button>
            <button className="danger-solid" onClick={onDelete} disabled={busy}>Delete permanently</button>
            <button onClick={onArchive} disabled={busy}>{busy ? 'Saving…' : 'Save to history'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
