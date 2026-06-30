import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getPropertyInsurance, getTenantInsurance, saveInsurance, extractInsurance, uploadDoc, askDoc,
  listInsuranceDocuments, addInsuranceDocument, removeInsuranceDocument, signDocUrl,
  listArchivedInsurance, archiveInsurance, deleteInsurance,
} from '../lib/api';
import DocAssistant from './DocAssistant';
import { money, fmtDate } from '../lib/format';

const SUGGESTED = [
  'What is the coverage limit?',
  'Is the landlord listed as additional insured?',
  'When does the policy expire?',
  'What is the deductible?',
];

// Insurance vault for one scope: landlord (per property) or tenant (per lease).
// Add a policy (paste or upload) → key-facts auto-fill + a copy is saved once →
// glanceable card + ask-anything Q&A. Extra documents (renewals, premium notices)
// can be attached, and a removed policy can be archived to history.
export default function InsuranceVault({ party, propertyId, leaseId }) {
  const qc = useQueryClient();
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

  async function intake(getExtract) {
    setBusy(true); setErr('');
    try {
      const { fields, policy_text } = await getExtract();
      await saveInsurance({
        party, propertyId, leaseId,
        insurer: fields.insurer ?? null,
        coverage_amount: fields.coverage_amount ?? null,
        expiry_date: fields.expiry_date ?? null,
        additional_insured: fields.additional_insured ?? null,
        policy_text,
      });
      setText(''); setReplacing(false); invalidate();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }
  const onPaste = () => { if (text.trim()) intake(() => extractInsurance({ text: text.trim() })); };
  const onFile = (e) => {
    const f = e.target.files?.[0];
    if (f) intake(async () => extractInsurance({ storagePath: await uploadDoc(f) }));
    e.target.value = '';
  };

  if (isLoading) return <p className="muted">Loading…</p>;

  return (
    <div>
      {policy && !replacing && (
        <>
          {editFacts ? (
            <FactsForm policy={policy} party={party} busy={saveFacts.isPending} onSave={(vals) => saveFacts.mutate(vals)} onCancel={() => setEditFacts(false)} />
          ) : (
            <div className="ins-card">
              <div><span className="ins-k">Insurer</span><span className="ins-v">{policy.insurer || '—'}</span></div>
              <div><span className="ins-k">Coverage limit</span><span className="ins-v">{policy.coverage_amount != null ? money(policy.coverage_amount) : '—'}</span></div>
              <div><span className="ins-k">Premium</span><span className="ins-v">{policy.premium_amount != null ? money(policy.premium_amount) : '—'}</span></div>
              <div><span className="ins-k">Expires</span><span className="ins-v">{policy.expiry_date ? fmtDate(policy.expiry_date) : '—'}</span></div>
              {/* Additional insured only matters on the tenant's policy (does it name the landlord?). */}
              {party === 'tenant' && (
                <div><span className="ins-k">Additional insured</span><span className={`badge ${policy.additional_insured ? 'good' : 'warn'}`} style={{ alignSelf: 'flex-start', marginTop: 4 }}>{policy.additional_insured ? 'Yes' : 'No'}</span></div>
              )}
            </div>
          )}
          {!editFacts && (
            <div className="row" style={{ marginBottom: 14, gap: 14 }}>
              <button type="button" className="ghost" onClick={() => setEditFacts(true)}>Edit facts</button>
              <button type="button" className="ghost" onClick={() => setReplacing(true)}>Replace policy</button>
              <button type="button" className="ghost danger-btn" onClick={() => setRemoving(true)}>Remove policy</button>
            </div>
          )}
          <DocAssistant label="policy" docText={policy.policy_text} suggested={SUGGESTED} ask={(q) => askDoc(policy.policy_text, q, 'insurance')} />
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
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
            Upload the policy or certificate of insurance (PDF, scan, or photo). It reads the document once to fill in the key facts, then lets you ask questions about it.
          </div>
          <div className="dropzone">
            <input type="file" accept=".pdf,.docx,image/*" className="file-native" onChange={onFile} disabled={busy} aria-label="Upload insurance policy file" />
            <div className="dropzone-hint muted">{busy ? 'Reading the policy…' : 'Choose the policy file to auto-fill the key facts'}</div>
          </div>
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

  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState(null);
  const [err, setErr] = useState('');

  const add = useMutation({
    mutationFn: () => addInsuranceDocument({ policyId, label: label.trim(), file, note: note.trim() }),
    onSuccess: () => { setLabel(''); setNote(''); setFile(null); qc.invalidateQueries({ queryKey: key }); },
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
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input className="text-input" style={{ flex: '1 1 200px' }} placeholder="Label (e.g. 2026 Renewal, Premium notice)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <input className="text-input" style={{ flex: '1 1 160px' }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <label className="ghost" style={{ cursor: 'pointer', position: 'relative', overflow: 'hidden' }}>
          {file ? `📎 ${file.name.slice(0, 20)}` : '📎 Attach file'}
          <input type="file" accept=".pdf,.docx,image/*" style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </label>
        <button type="button" onClick={() => add.mutate()} disabled={!label.trim() || add.isPending}>{add.isPending ? 'Adding…' : 'Add document'}</button>
      </div>
      {err && <p className="badge danger" style={{ marginTop: 8 }}>{err}</p>}
    </div>
  );
}

// "Expired & archived" — policies removed via Remove policy → Save to history.
// Read-only, collapsed by default; each can be permanently deleted from history.
function ArchivedSection({ party, propertyId, leaseId, archivedKey }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: archived = [] } = useQuery({
    queryKey: archivedKey,
    queryFn: () => listArchivedInsurance({ party, propertyId, leaseId }),
  });
  const del = useMutation({
    mutationFn: (id) => deleteInsurance(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: archivedKey }),
  });
  if (!archived.length) return null;

  return (
    <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <button type="button" className="ghost" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Expired & archived ({archived.length})
      </button>
      {open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {archived.map((p) => (
            <div key={p.id} className="ins-card" style={{ opacity: 0.9 }}>
              <div><span className="ins-k">Insurer</span><span className="ins-v">{p.insurer || '—'}</span></div>
              <div><span className="ins-k">Coverage</span><span className="ins-v">{p.coverage_amount != null ? money(p.coverage_amount) : '—'}</span></div>
              <div><span className="ins-k">Expired</span><span className="ins-v">{p.expiry_date ? fmtDate(p.expiry_date) : '—'}</span></div>
              <div><span className="ins-k">Archived</span><span className="ins-v">{p.archived_at ? fmtDate(String(p.archived_at).slice(0, 10)) : '—'}</span></div>
              <button
                type="button"
                className="icon-btn danger-btn"
                title="Delete permanently from history"
                style={{ alignSelf: 'center', marginLeft: 'auto' }}
                onClick={() => { if (window.confirm('Permanently delete this archived policy and its documents?')) del.mutate(p.id); }}
              >🗑</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Remove-policy confirmation with the archive-or-delete choice.
function RemovePolicyModal({ onArchive, onDelete, onCancel, busy }) {
  return (
    <div className="modal-scrim" onClick={onCancel}>
      <div className="modal" style={{ width: 470 }} onClick={(e) => e.stopPropagation()}>
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
