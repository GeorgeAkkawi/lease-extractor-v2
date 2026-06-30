import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPropertyInsurance, getTenantInsurance, saveInsurance, extractInsurance, uploadDoc, askDoc } from '../lib/api';
import DocAssistant from './DocAssistant';
import { money, fmtDate } from '../lib/format';

const SUGGESTED = [
  'What is the coverage limit?',
  'Is the landlord listed as additional insured?',
  'When does the policy expire?',
  'What is the deductible?',
];

// Insurance vault for one scope: landlord (per property) or tenant (per lease).
// Add a policy (paste or upload) → AI fills key-facts + caches the text once →
// glanceable card + ask-anything Q&A (cheap: cached text via ask-doc).
export default function InsuranceVault({ party, propertyId, leaseId }) {
  const qc = useQueryClient();
  const scopeKey = party === 'landlord' ? propertyId : leaseId;
  const queryKey = ['insurance', party, scopeKey];
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

  const invalidate = () => qc.invalidateQueries({ queryKey });

  const saveFacts = useMutation({
    mutationFn: (vals) => saveInsurance({ party, propertyId, leaseId, ...vals }),
    onSuccess: () => { setEditFacts(false); invalidate(); },
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
            </div>
          )}
          <DocAssistant label="policy" docText={policy.policy_text} suggested={SUGGESTED} ask={(q) => askDoc(policy.policy_text, q, 'insurance')} />
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
            Upload the policy or certificate of insurance (PDF, scan, or photo). The AI reads it once to fill the key facts and lets you ask questions — cheap, since the text is cached.
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
    </div>
  );
}

// Inline editor for the key-facts (manual override of the AI values). Additional
// insured only applies to a tenant's policy.
function FactsForm({ policy, party, busy, onSave, onCancel }) {
  const [f, setF] = useState({
    insurer: policy.insurer || '',
    coverage_amount: policy.coverage_amount ?? '',
    expiry_date: policy.expiry_date || '',
    additional_insured: !!policy.additional_insured,
  });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const save = () => {
    const vals = {
      insurer: f.insurer || null,
      coverage_amount: f.coverage_amount === '' ? null : Number(f.coverage_amount),
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
