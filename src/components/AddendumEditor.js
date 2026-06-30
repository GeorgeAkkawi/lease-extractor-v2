import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listAddendums, createAddendum, deleteAddendum, applyAddendum, extractAddendum, uploadDoc } from '../lib/api';
import { fmtDate } from '../lib/format';

// "Addendums & riders" — a tracked amendment record per lease that ALSO pushes its
// changes (term extension / rent change / new renewal option) into the lease via
// applyAddendum, which re-resolves the current period. Two entry routes: upload a
// rider for AI extraction (a paid call) or enter it by hand. Modeled on
// InsuranceVault + the schedule editors.
const KINDS = [
  { key: 'extension', label: 'Extends the term' },
  { key: 'rent_change', label: 'Changes the rent' },
  { key: 'new_option', label: 'Adds a renewal option' },
  { key: 'other', label: 'Other / note only' },
];

const blankForm = () => ({
  label: '', amendment_date: '', kind: 'extension', summary: '',
  new_termination_date: '', ext_new_rent: '',
  rc_new_rent: '', rc_effective_date: '',
  opt_label: '', opt_term_months: '', opt_new_rent: '', opt_notice_by: '',
  _aiEscalations: [], _aiRenewals: [], storage_path: null, addendum_text: null, extraction_raw: null,
});

const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

export default function AddendumEditor({ leaseId, leaseInactive }) {
  const qc = useQueryClient();
  const { data: addendums = [] } = useQuery({ queryKey: ['addendums', leaseId], queryFn: () => listAddendums(leaseId) });

  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState('upload'); // 'upload' | 'manual'
  const [form, setForm] = useState(blankForm());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const refresh = () => {
    ['addendums', 'lease', 'leases', 'escalations', 'renewals', 'propertyTotals', 'tenantShares', 'alerts', 'expiredLeases', 'searchIndex']
      .forEach((key) => qc.invalidateQueries({ queryKey: [key] }));
  };

  const remove = useMutation({ mutationFn: (id) => deleteAddendum(id), onSuccess: refresh });

  function resetAdd() { setForm(blankForm()); setErr(''); setMode('upload'); setAdding(false); }

  // Map the form's chosen change-kind into the normalized `changes` applyAddendum wants.
  function formToChanges(f) {
    const extra = { escalations: f._aiEscalations || [], renewals: f._aiRenewals || [] };
    if (f.kind === 'extension') {
      return { ...extra, extensionEnd: f.new_termination_date || null, newRent: numOrNull(f.ext_new_rent) };
    }
    if (f.kind === 'rent_change') {
      const eff = f.rc_effective_date || f.amendment_date || null;
      const row = { effective_date: eff, escalation_type: 'manual', escalation_value: null, new_base_rent: Number(f.rc_new_rent) };
      return { ...extra, escalations: [row, ...extra.escalations] };
    }
    if (f.kind === 'new_option') {
      const row = { option_label: f.opt_label || null, term_months: numOrNull(f.opt_term_months), new_rent: numOrNull(f.opt_new_rent), notice_by_date: f.opt_notice_by || null };
      return { ...extra, renewals: [row, ...extra.renewals] };
    }
    return extra; // 'other' — tracked note, no schedule change beyond any AI extras
  }

  const save = useMutation({
    mutationFn: async () => {
      const addendum = await createAddendum({
        lease_id: leaseId,
        label: form.label || null,
        amendment_date: form.amendment_date || null,
        kind: form.kind,
        summary: form.summary || null,
        storage_path: form.storage_path || null,
        addendum_text: form.addendum_text || null,
        extraction_raw: form.extraction_raw || null,
      });
      return applyAddendum(addendum, formToChanges(form));
    },
    onSuccess: () => { resetAdd(); refresh(); },
    onError: (e) => setErr(e.message || String(e)),
  });

  // AI extraction → prefill the review form (always shown for confirmation).
  async function intake(getExtract) {
    setBusy(true); setErr('');
    try {
      const { fields, addendum_text } = await getExtract();
      const kind = fields.new_termination_date ? 'extension'
        : (fields.renewal_options || []).length ? 'new_option'
        : (fields.new_base_rent != null || (fields.escalations || []).length) ? 'rent_change'
        : 'other';
      setForm((f) => ({
        ...f,
        label: fields.label || '',
        amendment_date: fields.amendment_date || '',
        kind,
        summary: fields.summary || '',
        new_termination_date: fields.new_termination_date || '',
        ext_new_rent: kind === 'extension' && fields.new_base_rent != null ? String(fields.new_base_rent) : '',
        rc_new_rent: kind === 'rent_change' && fields.new_base_rent != null ? String(fields.new_base_rent) : '',
        rc_effective_date: fields.new_base_rent_effective_date || '',
        // Carry any extra schedule rows the rider also contained (not the primary kind's).
        _aiEscalations: kind === 'rent_change' ? [] : (fields.escalations || []),
        _aiRenewals: kind === 'new_option' ? [] : (fields.renewal_options || []),
        addendum_text: addendum_text || null,
        extraction_raw: fields || null,
      }));
      setMode('manual'); // show the prefilled form for review
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }

  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const onFile = (e) => {
    const file = e.target.files?.[0];
    if (file) intake(async () => extractAddendum({ storagePath: await uploadDoc(file) }));
    e.target.value = '';
  };
  const onPaste = () => { if (pasteText.trim()) intake(() => extractAddendum({ text: pasteText.trim() })); };

  const canSave = form.kind === 'extension' ? !!form.new_termination_date
    : form.kind === 'rent_change' ? form.rc_new_rent !== ''
    : form.kind === 'new_option' ? (form.opt_term_months !== '' || form.opt_new_rent !== '')
    : true;

  return (
    <div>
      {leaseInactive && (
        <p className="muted" style={{ marginTop: -6, marginBottom: 14, fontSize: 12.5 }}>
          This lease is outdated. Add the <strong>extension or rider</strong> that carries it forward and the term, rent,
          and financials will update automatically.
        </p>
      )}

      {addendums.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table style={{ minWidth: 0 }}>
            <thead><tr><th>Addendum</th><th>Dated</th><th>Type</th><th>What it changed</th><th></th></tr></thead>
            <tbody>
              {addendums.map((a) => (
                <tr key={a.id}>
                  <td>{a.label || '—'}</td>
                  <td>{fmtDate(a.amendment_date)}</td>
                  <td>{KINDS.find((k) => k.key === a.kind)?.label || a.kind}</td>
                  <td>{a.summary || '—'}</td>
                  <td className="num">
                    <button type="button" className="icon-btn danger-btn" title="Delete this addendum (does not undo its applied changes)"
                      disabled={remove.isPending}
                      onClick={() => { if (window.confirm('Delete this addendum record? Note: this removes the record but does not reverse changes it already applied to the lease.')) remove.mutate(a.id); }}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!adding ? (
        <button type="button" className="secondary" onClick={() => { setForm(blankForm()); setAdding(true); }}>
          + Add addendum / rider
        </button>
      ) : (
        <div className="callout" style={{ marginTop: 4 }}>
          <div className="between" style={{ marginBottom: 10 }}>
            <strong style={{ fontFamily: 'var(--display)', fontSize: 18 }}>Add an addendum / rider</strong>
            <div className="seg">
              <button type="button" className={`seg-btn${mode === 'upload' ? ' on' : ''}`} onClick={() => setMode('upload')}>Upload (AI)</button>
              <button type="button" className={`seg-btn${mode === 'manual' ? ' on' : ''}`} onClick={() => setMode('manual')}>Enter manually</button>
            </div>
          </div>

          {mode === 'upload' ? (
            <>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
                Upload the rider (PDF, scan, photo, or Word .docx). The AI reads it and pre-fills the change for you to review.
                <strong> This uses a paid AI call.</strong>
              </div>
              <div className="dropzone">
                <input type="file" accept=".pdf,.docx,image/*" className="file-native" onChange={onFile} disabled={busy} aria-label="Upload addendum file" />
                <div className="dropzone-hint muted">{busy ? 'Reading the rider…' : 'Choose the rider file to auto-fill the change'}</div>
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button type="button" className="ghost" onClick={() => setShowPaste((p) => !p)}>{showPaste ? 'Hide paste' : 'Paste text instead'}</button>
                <button type="button" className="ghost" onClick={resetAdd}>Cancel</button>
              </div>
              {showPaste && (
                <div style={{ marginTop: 10 }}>
                  <textarea className="text-input" rows={5} style={{ width: '100%' }} placeholder="Paste the addendum / rider text…" value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
                  <div className="row" style={{ marginTop: 8 }}>
                    <button type="button" onClick={onPaste} disabled={busy || !pasteText.trim()}>{busy ? 'Reading…' : 'Extract with AI'}</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); if (canSave) save.mutate(); }}>
              <div className="field-grid">
                <label className="form-field" style={{ marginBottom: 0 }}><span>Label</span><input className="text-input" placeholder="First Amendment" value={form.label} onChange={set('label')} /></label>
                <label className="form-field" style={{ marginBottom: 0 }}><span>Dated</span><input className="text-input" type="date" value={form.amendment_date} onChange={set('amendment_date')} /></label>
              </div>

              <div className="field" style={{ marginTop: 16 }}>
                <span className="field-label">This addendum…</span>
                <div className="seg" style={{ flexWrap: 'wrap' }}>
                  {KINDS.map((k) => (
                    <button type="button" key={k.key} className={`seg-btn${form.kind === k.key ? ' on' : ''}`} onClick={() => setForm((f) => ({ ...f, kind: k.key }))}>{k.label}</button>
                  ))}
                </div>
              </div>

              <div className="field-grid" style={{ marginTop: 16 }}>
                {form.kind === 'extension' && (
                  <>
                    <label className="form-field" style={{ marginBottom: 0 }}><span>New termination date</span><input className="text-input" type="date" value={form.new_termination_date} onChange={set('new_termination_date')} /></label>
                    <label className="form-field" style={{ marginBottom: 0 }}><span>New base rent (annual $) — optional</span><input className="text-input num" type="number" step="any" placeholder="unchanged" value={form.ext_new_rent} onChange={set('ext_new_rent')} /></label>
                  </>
                )}
                {form.kind === 'rent_change' && (
                  <>
                    <label className="form-field" style={{ marginBottom: 0 }}><span>New base rent (annual $)</span><input className="text-input num" type="number" step="any" value={form.rc_new_rent} onChange={set('rc_new_rent')} /></label>
                    <label className="form-field" style={{ marginBottom: 0 }}><span>Effective date</span><input className="text-input" type="date" value={form.rc_effective_date} onChange={set('rc_effective_date')} /></label>
                  </>
                )}
                {form.kind === 'new_option' && (
                  <>
                    <label className="form-field" style={{ marginBottom: 0 }}><span>Option label</span><input className="text-input" placeholder="Option 2" value={form.opt_label} onChange={set('opt_label')} /></label>
                    <label className="form-field" style={{ marginBottom: 0 }}><span>Term (months)</span><input className="text-input num" type="number" value={form.opt_term_months} onChange={set('opt_term_months')} /></label>
                    <label className="form-field" style={{ marginBottom: 0 }}><span>New rent (annual $)</span><input className="text-input num" type="number" step="any" value={form.opt_new_rent} onChange={set('opt_new_rent')} /></label>
                    <label className="form-field" style={{ marginBottom: 0 }}><span>Notice by</span><input className="text-input" type="date" value={form.opt_notice_by} onChange={set('opt_notice_by')} /></label>
                  </>
                )}
              </div>

              <div className="form-field" style={{ maxWidth: '100%', marginTop: 16 }}>
                <span>Summary / note</span>
                <input className="text-input" value={form.summary} onChange={set('summary')} placeholder="e.g. Extends term 5 years at a new rent" />
              </div>

              <div className="row" style={{ marginTop: 14 }}>
                <button type="submit" disabled={!canSave || save.isPending}>{save.isPending ? 'Applying…' : 'Save & apply'}</button>
                <button type="button" className="secondary" onClick={resetAdd}>Cancel</button>
              </div>
            </form>
          )}
          {err && <p className="badge danger" style={{ marginTop: 10 }}>{err}</p>}
        </div>
      )}
    </div>
  );
}
