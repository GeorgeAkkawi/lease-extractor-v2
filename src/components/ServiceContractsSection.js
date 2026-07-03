import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listServiceContracts, addServiceContract, updateServiceContract, deleteServiceContract, extractContract, uploadDoc, askDoc } from '../lib/api';
import { contractAnnualCost } from '../lib/contracts';
import DocAssistant from './DocAssistant';
import { money, fmtDate, currentYear } from '../lib/format';

const TYPES = [['landscaping', 'Landscaping'], ['snow_removal', 'Snow removal'], ['security', 'Security'], ['other', 'Other']];
const FREQ = [['annual', 'per year'], ['monthly', 'per month'], ['one-time', 'one-time']];
const SUGGESTED = ['What is the term and renewal?', 'How much does it cost?', 'What is the cancellation notice?', 'What services are included?'];
const typeLabel = (t) => TYPES.find(([v]) => v === t)?.[1] || 'Other';
const freqLabel = (f) => FREQ.find(([v]) => v === f)?.[1] || '';

// Property service contracts. Starts empty; "Add contract" lets the landlord name
// it and attach the document — the AI extracts the key terms, which are editable.
export default function ServiceContractsSection({ propId }) {
  const qc = useQueryClient();
  const { data: contracts = [] } = useQuery({ queryKey: ['serviceContracts', propId], queryFn: () => listServiceContracts(propId) });
  const [adding, setAdding] = useState(false);
  // A contract change can change what CAM carries each year, which feeds the tenant
  // shares / property totals / corp roll-up — refresh them all so the CAM auto-items
  // re-sync next time that fiscal year is opened.
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['serviceContracts', propId] });
    ['camLineItems', 'expenseRecord', 'propertyTotals', 'tenantShares', 'corpRollups'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  };

  return (
    <div>
      {contracts.length === 0 && !adding && (
        <p className="empty-line muted">No contracts yet. Add your service agreements — landscaping, snow removal, security, and the like.</p>
      )}

      {contracts.length > 0 && (
        <div className="svc-list">
          {contracts.map((c) => <ContractItem key={c.id} c={c} onChange={invalidate} />)}
        </div>
      )}

      {adding ? (
        <AddContract propId={propId} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); invalidate(); }} />
      ) : (
        <button type="button" onClick={() => setAdding(true)}>+ Add contract</button>
      )}
    </div>
  );
}

// One contract row: glanceable terms + Edit + Open & ask.
function ContractItem({ c, onChange }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const remove = useMutation({ mutationFn: () => deleteServiceContract(c.id), onSuccess: onChange });
  const saveFacts = useMutation({ mutationFn: (patch) => updateServiceContract(c.id, patch), onSuccess: () => { setEditing(false); onChange(); } });

  const term = c.start_date || c.end_date ? `${c.start_date ? fmtDate(c.start_date) : '—'} – ${c.end_date ? fmtDate(c.end_date) : '—'}` : '';
  const pct = Number(c.escalation_pct) || 0;
  const thisYear = currentYear();
  const camNow = c.frequency !== 'one-time' ? contractAnnualCost(c, thisYear) : 0;
  const sub = [
    c.vendor && c.vendor !== c.name ? c.vendor : null,
    c.amount != null ? `${money(c.amount)} ${freqLabel(c.frequency)}` : null,
    pct > 0 ? `+${pct}%/yr` : null,
    camNow > 0 ? `CAM ${thisYear}: ${money(camNow)}` : null,
    term,
  ].filter(Boolean).join(' · ');

  return (
    <div className="svc-item">
      <div className="svc-row">
        <span className="badge info">{typeLabel(c.service_type)}</span>
        <div className="svc-main">
          <strong>{c.name || c.vendor || 'Contract'}</strong>
          {sub && <span className="muted">{sub}</span>}
        </div>
        <button type="button" className="ghost" onClick={() => setEditing((e) => !e)}>Edit</button>
        <button type="button" className="ghost" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Open & ask'}</button>
        <button type="button" className="icon-btn danger-btn" title="Delete contract" onClick={() => { if (window.confirm('Delete this contract?')) remove.mutate(); }}>✕</button>
      </div>

      {editing && (
        <div className="svc-doc">
          <ContractFactsForm c={c} busy={saveFacts.isPending} onSave={(vals) => saveFacts.mutate(vals)} onCancel={() => setEditing(false)} />
        </div>
      )}

      {open && (
        <div className="svc-doc">
          <DocAssistant
            label="contract"
            docText={c.contract_text}
            suggested={SUGGESTED}
            canSave
            ask={(q) => askDoc(c.contract_text, q, 'contract')}
            onSave={async (text) => { await updateServiceContract(c.id, { contract_text: text }); onChange(); }}
          />
        </div>
      )}
    </div>
  );
}

// Add flow: name it + attach the document → AI extracts the terms (editable after).
function AddContract({ propId, onClose, onAdded }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [paste, setPaste] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function create(getExtract) {
    if (!name.trim()) { setErr('Give the contract a name first.'); return; }
    setBusy(true); setErr('');
    try {
      const ex = getExtract ? await getExtract() : { fields: {}, contract_text: null };
      const f = ex.fields || {};
      await addServiceContract({
        property_id: propId,
        name: name.trim(),
        service_type: f.service_type || null,
        vendor: f.vendor || name.trim(),
        vendor_email: f.vendor_email || null,
        amount: f.amount ?? null,
        frequency: f.frequency || null,
        escalation_pct: f.escalation_pct ?? null,
        start_date: f.start_date || null,
        end_date: f.end_date || null,
        contract_text: ex.contract_text || null,
      });
      onAdded();
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!name.trim()) { setErr('Give the contract a name first.'); e.target.value = ''; return; }
    create(async () => extractContract({ storagePath: await uploadDoc(file), name }));
    e.target.value = '';
  };

  return (
    <div className="svc-item" style={{ padding: 16 }}>
      <label className="form-field" style={{ maxWidth: 360, marginBottom: 12 }}>
        <span>Contract name</span>
        <input className="text-input" placeholder="e.g. Snow removal — Arctic" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>

      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        Upload the contract (PDF, Word .docx, scan, or photo) — the AI fills in the key terms, which you can edit. You can also add it without a document and fill the terms yourself.
      </div>
      <div className="dropzone">
        <input type="file" accept=".pdf,.docx,image/*" className="file-native" onChange={onFile} disabled={busy} aria-label="Upload contract file" />
        <div className="dropzone-hint muted">{busy ? 'Reading the contract…' : 'Choose the contract file to auto-fill the terms'}</div>
      </div>

      <div className="row" style={{ marginTop: 12, gap: 12, alignItems: 'center' }}>
        <button type="button" className="ghost" onClick={() => setPaste((p) => !p)}>{paste ? 'Hide paste' : 'Paste text instead'}</button>
        <button type="button" className="secondary" onClick={() => create(null)} disabled={busy}>Add without a document</button>
        <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
      </div>

      {paste && (
        <div style={{ marginTop: 10 }}>
          <textarea className="text-input" rows={5} style={{ width: '100%' }} placeholder="Paste the contract text…" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => { if (text.trim()) create(() => extractContract({ text: text.trim(), name })); }} disabled={busy || !text.trim()}>{busy ? 'Reading…' : 'Add & extract from text'}</button>
          </div>
        </div>
      )}

      {err && <p className="badge danger" style={{ marginTop: 8 }}>{err}</p>}
    </div>
  );
}

// Inline editor for a contract's key terms.
function ContractFactsForm({ c, busy, onSave, onCancel }) {
  const [f, setF] = useState({
    service_type: c.service_type || 'other',
    vendor: c.vendor || '',
    vendor_email: c.vendor_email || '',
    amount: c.amount ?? '',
    frequency: c.frequency || 'annual',
    escalation_pct: c.escalation_pct ?? '',
    start_date: c.start_date || '',
    end_date: c.end_date || '',
  });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  return (
    <div>
      <div className="field-grid" style={{ marginBottom: 14 }}>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Type</span><select className="text-input" value={f.service_type} onChange={set('service_type')}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Vendor</span><input className="text-input" value={f.vendor} onChange={set('vendor')} /></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Vendor email</span><input className="text-input" type="email" placeholder="for renewal reminders" value={f.vendor_email} onChange={set('vendor_email')} /></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Amount ($)</span><input className="text-input num" type="number" step="any" value={f.amount} onChange={set('amount')} /></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Frequency</span><select className="text-input" value={f.frequency} onChange={set('frequency')}>{FREQ.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Escalation %/yr</span><input className="text-input num" type="number" step="any" placeholder="e.g. 3" value={f.escalation_pct} onChange={set('escalation_pct')} /></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Start</span><input className="text-input" type="date" value={f.start_date} onChange={set('start_date')} /></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>End</span><input className="text-input" type="date" value={f.end_date} onChange={set('end_date')} /></label>
      </div>
      <div className="row">
        <button type="button" onClick={() => onSave({ service_type: f.service_type, vendor: f.vendor || null, vendor_email: f.vendor_email || null, amount: f.amount === '' ? null : Number(f.amount), frequency: f.frequency, escalation_pct: f.escalation_pct === '' ? null : Number(f.escalation_pct), start_date: f.start_date || null, end_date: f.end_date || null })} disabled={busy}>{busy ? 'Saving…' : 'Save terms'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
