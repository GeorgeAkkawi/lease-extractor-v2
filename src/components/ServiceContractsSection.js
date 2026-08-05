import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listServiceContracts, listContractEscalationsByProperty, addServiceContract,
  createServiceContractFromDocument, updateServiceContract, deleteServiceContract,
  replaceContractEscalations, extractContract, uploadDoc, askDoc, listDocuments, signDocUrl,
} from '../lib/api';
import { contractAnnualCost, stepsByContract, nextContractStep } from '../lib/contracts';
import { contractChanges, contractTargets, buildContractFeeSteps, hasNoContractChanges } from '../lib/contractTerms';
import { settleBillingChange, settleContractChange } from '../lib/invalidate';
import ContractDocs, { ContractReview } from './ContractDocs';
import DocAssistant from './DocAssistant';
import DocumentsList from './DocumentsList';
import { money, fmtDate, currentYear } from '../lib/format';
import MutationError from './MutationError';
import { useConfirm } from './ConfirmDialog';

const TYPES = [['landscaping', 'Landscaping'], ['snow_removal', 'Snow removal'], ['security', 'Security'], ['other', 'Other']];
const FREQ = [['annual', 'per year'], ['monthly', 'per month'], ['one-time', 'one-time']];
const SUGGESTED = ['What is the term and renewal?', 'How much does it cost?', 'What is the cancellation notice?', 'What services are included?'];
const typeLabel = (t) => TYPES.find(([v]) => v === t)?.[1] || 'Other';
const freqLabel = (f) => FREQ.find(([v]) => v === f)?.[1] || '';
const todayIso = () => new Date().toISOString().slice(0, 10);

// Property service contracts. "Add contract" reads the document and shows a review before
// anything is written; an existing contract can have a NEW document uploaded over it, which
// is the flow George asked for on 2026-08-05 ("the same system as the leases").
export default function ServiceContractsSection({ propId }) {
  const qc = useQueryClient();
  const { data: contracts = [] } = useQuery({ queryKey: ['serviceContracts', propId], queryFn: () => listServiceContracts(propId) });
  // ONE query for every contract's dated fee steps (0091), read at the section level and
  // passed down — never a useQuery per row, which on a property with eight contracts is
  // eight round trips for a figure the list needs before it can print anything.
  const { data: stepRows = [] } = useQuery({
    queryKey: ['contractEscalations', propId],
    queryFn: () => listContractEscalationsByProperty(propId),
    enabled: !!propId,
  });
  const steps = stepsByContract(stepRows);
  const [adding, setAdding] = useState(false);

  // A contract change reaches money: its fee becomes a CAM line item → cam_total → every
  // tenant's share → a stored invoice. So BOTH named sets fire — the contract's own screens
  // and the shared money screens — rather than the hand-rolled list that used to live here
  // and never invalidated ['alerts'] (so the dashboard bell kept showing an end date the
  // landlord had already changed).
  const invalidate = () => {
    settleContractChange(qc, propId);
    settleBillingChange(qc, { propertyId: propId, year: currentYear() });
  };

  return (
    <div>
      {contracts.length === 0 && !adding && (
        <p className="empty-line muted">No contracts yet. Add your service agreements — landscaping, snow removal, security, and the like.</p>
      )}

      {contracts.length > 0 && (
        <div className="svc-list">
          {contracts.map((c) => (
            <ContractItem key={c.id} c={c} steps={steps.get(c.id) || []} onChange={invalidate} />
          ))}
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

// One contract row: glanceable terms + Edit + Upload + Open & ask.
function ContractItem({ c, steps, onChange }) {
  const askConfirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const remove = useMutation({ mutationFn: () => deleteServiceContract(c.id), onSuccess: onChange });
  const saveFacts = useMutation({
    // Through updateServiceContract (the notice-date derivation and both bucket re-arms live
    // there) and then the SAME carry-through an applied document runs — a fee typed by hand
    // moves CAM exactly as much as a fee read off a PDF does.
    mutationFn: async ({ patch, feeSteps }) => {
      await updateServiceContract(c.id, patch);
      if (feeSteps) await replaceContractEscalations(c.id, feeSteps);
    },
    onSuccess: () => { setEditing(false); onChange(); },
  });

  const term = c.start_date || c.end_date ? `${c.start_date ? fmtDate(c.start_date) : '—'} – ${c.end_date ? fmtDate(c.end_date) : '—'}` : '';
  const pct = Number(c.escalation_pct) || 0;
  const thisYear = currentYear();
  const camNow = c.frequency !== 'one-time' ? contractAnnualCost(c, thisYear, steps) : 0;
  const upcoming = nextContractStep(steps, todayIso());
  const sub = [
    c.vendor && c.vendor !== c.name ? c.vendor : null,
    c.amount != null ? `${money(c.amount)} ${freqLabel(c.frequency)}` : null,
    steps.length ? `${steps.length} dated step${steps.length === 1 ? '' : 's'}` : (pct > 0 ? `+${pct}%/yr` : null),
    camNow > 0 ? `CAM ${thisYear}: ${money(camNow)}` : null,
    term,
  ].filter(Boolean).join(' · ');

  return (
    <div className="svc-item">
      <MutationError of={[remove, saveFacts]} />
      <div className="svc-row">
        <span className="badge info">{typeLabel(c.service_type)}</span>
        <div className="svc-main">
          <strong>{c.name || c.vendor || 'Contract'}</strong>
          {sub && <span className="muted">{sub}</span>}
        </div>
        <button type="button" className="ghost" onClick={() => setEditing((e) => !e)}>Edit</button>
        <ContractDocs contract={c} onChanged={onChange} />
        <button type="button" className="ghost" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Open & ask'}</button>
        <button type="button" className="icon-btn danger-btn" title="Delete contract" onClick={async () => {
          if (await askConfirm({
            title: 'Delete contract?',
            message: 'Delete this service contract?',
            implications: [
              'Removes it from this property, along with its dated fee schedule.',
              `Its ${money(camNow)} contribution to ${thisYear}'s CAM stops immediately, and this year's bills are rebuilt without it. A closed year is left alone.`,
              'Tenants on a CAM & tax estimate keep paying it and settle at ⚖ Reconcile.',
              'This can’t be undone.',
            ],
            confirmLabel: 'Delete',
          })) remove.mutate();
        }}>✕</button>
      </div>

      {/* The renewal / notice line, always visible — this is the deadline that costs money
          if it is missed, so it does not live behind a disclosure. */}
      {(c.notice_by_date || c.auto_renew != null) && (
        <div className="svc-sub muted" style={{ fontSize: 12.5, marginTop: 2 }}>
          {c.auto_renew === true ? 'Renews automatically' : c.auto_renew === false ? 'Ends at the term' : 'Renewal not stated'}
          {c.notice_by_date && <> · notice by <strong>{fmtDate(c.notice_by_date)}</strong>{c.notice_days ? ` (${c.notice_days} days)` : ''}</>}
          {c.renewal_term_months ? ` · next term ${c.renewal_term_months} months` : ''}
        </div>
      )}
      {upcoming && (
        <div className="svc-sub muted" style={{ fontSize: 12.5 }}>
          Next fee step {fmtDate(upcoming.effective_date)} — {money(upcoming.new_amount)} {freqLabel(c.frequency)}
        </div>
      )}
      <SignedCopyRow contractId={c.id} />

      {editing && (
        <div className="svc-doc">
          <ContractFactsForm
            c={c} steps={steps} busy={saveFacts.isPending}
            onSave={(vals) => saveFacts.mutate(vals)} onCancel={() => setEditing(false)}
          />
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
          <DocumentsList
            entityType="service_contract"
            entityId={c.id}
            title="Saved copies"
            addLabel="Add a copy"
            emptyText="No file on file for this contract. Add one to keep the signed copy here."
          />
        </div>
      )}
    </div>
  );
}

// The executed copy, on the contract row itself — George, 2026-08-05: *"after the contract is
// signed the signed copy should be saved as a pdf in the contracts tab."* Always visible, not
// behind "Open & ask": a signed copy nobody can see is the same as not having one. Marking a
// copy signed happens in the documents list; this row is where it is then found.
function SignedCopyRow({ contractId }) {
  const { data: docs = [] } = useQuery({
    queryKey: ['documents', 'service_contract', contractId],
    queryFn: () => listDocuments('service_contract', contractId),
    enabled: !!contractId,
  });
  const signed = docs.filter((d) => d.signed_at);
  if (!signed.length) return null;
  const openFile = async (path) => {
    const url = await signDocUrl(path);
    if (url) window.open(url, '_blank', 'noopener');
  };
  return (
    <div className="svc-sub" style={{ fontSize: 12.5, marginTop: 2 }}>
      {signed.map((d) => (
        <span key={d.id} style={{ marginRight: 10 }}>
          <span className="badge good">Signed copy</span>{' '}
          <button type="button" className="ghost btn-sm" onClick={() => openFile(d.storage_path)}>
            {d.filename || 'Open'}
          </button>
          <span className="muted"> · {fmtDate(d.signed_at)}</span>
        </span>
      ))}
    </div>
  );
}

// Add flow: name it + attach the document → the AI reads it → the SAME review screen the
// replace path uses → only then is anything written. Before this, Add spread the extraction
// straight into an insert: no diff, no confirmation, no history entry, and a vendor the AI
// missed silently became the landlord's own label (and therefore the 1099 payee name).
function AddContract({ propId, onClose, onAdded }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [paste, setPaste] = useState(false);
  const [phase, setPhase] = useState('form'); // form | reading | review | saving
  const [err, setErr] = useState('');
  const [read, setRead] = useState(null);     // { extraction, contract_text, storagePath }
  const [changes, setChanges] = useState(null);
  const [plan, setPlan] = useState(null);

  // A brand-new contract has nothing to diff against, so every field the document states
  // reads as an addition — which is exactly what the review should say.
  const blank = { property_id: propId, name: name.trim() };

  async function readIt(getExtract) {
    if (!name.trim()) { setErr('Give the contract a name first.'); return; }
    setPhase('reading'); setErr('');
    try {
      const ex = await getExtract();
      const fields = ex.fields || {};
      setRead({ ...ex, fields });
      const fieldsOnly = contractChanges({ contract: blank, extraction: fields });
      const built = buildContractFeeSteps(fields, contractTargets(blank, fieldsOnly));
      setPlan(built);
      setChanges(contractChanges({ contract: blank, extraction: fields, plan: built }));
      setPhase('review');
    } catch (e) { setErr(e.message || String(e)); setPhase('form'); }
  }

  async function save() {
    setPhase('saving'); setErr('');
    try {
      await createServiceContractFromDocument({
        propertyId: propId,
        name: name.trim(),
        changes: changes || { fields: [] },
        plan,
        extraction: read?.fields || null,
        contractText: read?.contract_text || null,
        storagePath: read?.storagePath || null,
      });
      onAdded();
    } catch (e) { setErr(e.message || String(e)); setPhase('review'); }
  }

  // "Add without a document" stays a one-click path — there is nothing to review.
  async function createBare() {
    if (!name.trim()) { setErr('Give the contract a name first.'); return; }
    setPhase('saving'); setErr('');
    try {
      await addServiceContract({ property_id: propId, name: name.trim() });
      onAdded();
    } catch (e) { setErr(e.message || String(e)); setPhase('form'); }
  }

  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!name.trim()) { setErr('Give the contract a name first.'); e.target.value = ''; return; }
    readIt(async () => {
      const storagePath = await uploadDoc(file, { entityType: 'service_contract' });
      const res = await extractContract({ storagePath, name });
      return { ...res, storagePath };
    });
    e.target.value = '';
  };

  const busy = phase === 'reading' || phase === 'saving';

  if (phase === 'review' || phase === 'saving') {
    return (
      <div className="svc-item" style={{ padding: 16 }}>
        <p className="note-msg good" style={{ marginTop: 0 }}>
          ✓ Read <strong>{Number(read?.contract_text?.length || 0).toLocaleString()} characters</strong>.
          Nothing is saved until you add it.
        </p>
        <ContractReview contract={blank} extraction={read?.fields} changes={changes} plan={plan} isNew />
        <div className="row" style={{ marginTop: 16 }}>
          <button type="button" onClick={save} disabled={busy}>
            {phase === 'saving' ? 'Adding…' : 'Add this contract'}
          </button>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
        {hasNoContractChanges(changes) && (
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            The AI read no terms it could use. The contract is still added with its name and
            document — fill the terms in with Edit.
          </p>
        )}
        {err && <p className="badge danger" style={{ marginTop: 8 }}>{err}</p>}
      </div>
    );
  }

  return (
    <div className="svc-item" style={{ padding: 16 }}>
      <label className="form-field" style={{ maxWidth: 360, marginBottom: 12 }}>
        <span>Contract name</span>
        <input className="text-input" placeholder="e.g. Snow removal — Arctic" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>

      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        Upload the contract (PDF, Word .docx, scan, or photo) — the AI reads its fee, term,
        renewal and cancellation notice, and shows you everything before anything is saved. You
        can also add it without a document and fill the terms yourself.
      </div>
      <div className="dropzone">
        <input type="file" accept=".pdf,.docx,image/*" className="file-native" onChange={onFile} disabled={busy} aria-label="Upload contract file" />
        <div className="dropzone-hint muted">{busy ? 'Reading the contract…' : 'Choose the contract file to read the terms'}</div>
      </div>

      <div className="row" style={{ marginTop: 12, gap: 12, alignItems: 'center' }}>
        <button type="button" className="ghost" onClick={() => setPaste((p) => !p)}>{paste ? 'Hide paste' : 'Paste text instead'}</button>
        <button type="button" className="secondary" onClick={createBare} disabled={busy}>Add without a document</button>
        <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
      </div>

      {paste && (
        <div style={{ marginTop: 10 }}>
          <textarea className="text-input" rows={5} style={{ width: '100%' }} placeholder="Paste the contract text…" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => { if (text.trim()) readIt(() => extractContract({ text: text.trim(), name })); }} disabled={busy || !text.trim()}>{busy ? 'Reading…' : 'Read the pasted text'}</button>
          </div>
        </div>
      )}

      {err && <p className="badge danger" style={{ marginTop: 8 }}>{err}</p>}
    </div>
  );
}

// Inline editor for a contract's key terms — now including the renewal / notice terms and the
// dated fee schedule, because a schedule the AI can write and the landlord can't correct is
// a schedule he can't trust.
function ContractFactsForm({ c, steps, busy, onSave, onCancel }) {
  const [f, setF] = useState({
    service_type: c.service_type || 'other',
    vendor: c.vendor || '',
    vendor_email: c.vendor_email || '',
    amount: c.amount ?? '',
    frequency: c.frequency || 'annual',
    escalation_pct: c.escalation_pct ?? '',
    start_date: c.start_date || '',
    end_date: c.end_date || '',
    auto_renew: c.auto_renew === true ? 'yes' : c.auto_renew === false ? 'no' : '',
    notice_days: c.notice_days ?? '',
    notice_by_date: c.notice_by_date || '',
    renewal_term_months: c.renewal_term_months ?? '',
  });
  const [rows, setRows] = useState(
    (steps || []).map((s) => ({ effective_date: s.effective_date || '', new_amount: s.new_amount ?? '' }))
  );
  const [dirtySteps, setDirtySteps] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const setRow = (i, k) => (e) => {
    setDirtySteps(true);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: e.target.value } : r)));
  };

  const num = (v) => (v === '' ? null : Number(v));

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
        <label className="form-field" style={{ marginBottom: 0 }}>
          <span>Renews itself?</span>
          <select className="text-input" value={f.auto_renew} onChange={set('auto_renew')}>
            <option value="">Not stated</option>
            <option value="yes">Yes — unless cancelled</option>
            <option value="no">No — ends at the term</option>
          </select>
        </label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Notice (days)</span><input className="text-input num" type="number" step="1" placeholder="e.g. 30" value={f.notice_days} onChange={set('notice_days')} /></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Notice due by</span><input className="text-input" type="date" value={f.notice_by_date} onChange={set('notice_by_date')} /></label>
        <label className="form-field" style={{ marginBottom: 0 }}><span>Renewal term (months)</span><input className="text-input num" type="number" step="1" placeholder="e.g. 12" value={f.renewal_term_months} onChange={set('renewal_term_months')} /></label>
      </div>

      <p className="doc-choice-head">Fee schedule</p>
      <p className="muted" style={{ fontSize: 12, marginTop: -6 }}>
        Dated steps beat the amount and the yearly percent above: the step in effect for a
        fiscal year is the last one dated in that year or earlier. Amounts are in the
        contract’s own frequency ({freqLabel(f.frequency) || 'per year'}). Leave it empty and
        the amount + percent apply as before.
      </p>
      {rows.map((r, i) => (
        <div className="row" key={i} style={{ gap: 8, marginBottom: 6, alignItems: 'center' }}>
          <input className="text-input" type="date" value={r.effective_date} onChange={setRow(i, 'effective_date')} aria-label="Step effective date" />
          <input className="text-input num" type="number" step="any" value={r.new_amount} onChange={setRow(i, 'new_amount')} aria-label="Step amount" />
          <button type="button" className="icon-btn danger-btn" title="Remove this step"
            onClick={() => { setDirtySteps(true); setRows((rs) => rs.filter((_, j) => j !== i)); }}>✕</button>
        </div>
      ))}
      <button type="button" className="ghost btn-sm" onClick={() => { setDirtySteps(true); setRows((rs) => [...rs, { effective_date: '', new_amount: '' }]); }}>
        + Add a fee step
      </button>

      <div className="row" style={{ marginTop: 14 }}>
        <button type="button" disabled={busy} onClick={() => onSave({
          patch: {
            service_type: f.service_type,
            vendor: f.vendor || null,
            vendor_email: f.vendor_email || null,
            amount: num(f.amount),
            frequency: f.frequency,
            escalation_pct: num(f.escalation_pct),
            start_date: f.start_date || null,
            end_date: f.end_date || null,
            auto_renew: f.auto_renew === 'yes' ? true : f.auto_renew === 'no' ? false : null,
            notice_days: num(f.notice_days),
            // ⚠ Only sent when he TYPED one. updateServiceContract derives the date from
            // end_date − notice_days when the key is absent, and skips the derivation
            // entirely when it is present — so sending `null` for an empty box would mean a
            // landlord who fills in "30 days" and leaves the date blank gets no notice date
            // at all, and therefore no reminder.
            ...(f.notice_by_date ? { notice_by_date: f.notice_by_date } : {}),
            renewal_term_months: num(f.renewal_term_months),
          },
          // Only rewritten when he actually touched the schedule: an untouched list must not
          // delete-and-reinsert every step (and lose the notes read off the document).
          feeSteps: dirtySteps
            ? rows
              .filter((r) => r.effective_date && r.new_amount !== '')
              .map((r) => ({
                effective_date: r.effective_date, new_amount: Number(r.new_amount),
                escalation_type: 'manual', escalation_value: null, source: 'manual', note: null,
              }))
            : null,
        })}>{busy ? 'Saving…' : 'Save terms'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
