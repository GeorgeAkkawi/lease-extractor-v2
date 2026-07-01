import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listAddendums, createAddendum, deleteAddendum, applyAddendum, extractAddendum, uploadDoc } from '../lib/api';
import { fmtDate } from '../lib/format';

// "Addendums & riders" — a tracked amendment per lease that ALSO pushes its changes
// into the lease via applyAddendum. The AI reads the document and LEADS: it pre-fills
// every effect it detects (a single addendum can do several at once — extend the term,
// change the rent, add a renewal option, assign to a new tenant) and the landlord just
// confirms or corrects. Each effect is an independent, toggleable card (the override).
// Renewal options are always framed as *pending* — they never change the term here.

const KIND_LABEL = {
  extension: 'Extends the term',
  rent_change: 'Changes the rent',
  new_option: 'Adds a renewal option',
  assignment: 'Assigns to a new tenant',
  other: 'Other / note only',
};

const blankForm = () => ({
  label: '', amendment_date: '', summary: '',
  fx_extension: false, fx_rent: false, fx_option: false, fx_assignment: false,
  new_termination_date: '',
  rentSteps: [], // [{ effective_date, new_base_rent }]
  opt_label: '', opt_term_months: '', opt_new_rent: '', opt_annual_pct: '', opt_notice_by: '',
  _aiRenewals: [], // any additional options beyond the first (rare)
  asg_tenant_name: '', asg_contact_name: '', asg_email: '', asg_email_2: '', asg_effective_date: '',
  storage_path: null, addendum_text: null, extraction_raw: null, _fromAI: false,
});

const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

// Primary kind stored on the addendum row (for the History badge). An addendum can
// do several things; this is just the headline. 'assignment' requires migration 0035.
function primaryKind(f) {
  if (f.fx_assignment && f.asg_tenant_name) return 'assignment';
  if (f.fx_extension && f.new_termination_date) return 'extension';
  if (f.fx_option) return 'new_option';
  if (f.fx_rent) return 'rent_change';
  return 'other';
}

export default function AddendumEditor({ leaseId, leaseInactive }) {
  const qc = useQueryClient();
  const { data: addendums = [] } = useQuery({ queryKey: ['addendums', leaseId], queryFn: () => listAddendums(leaseId) });

  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState('upload'); // 'upload' | 'manual'
  const [form, setForm] = useState(blankForm());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (k) => (e) => { const on = e.target.checked; setForm((f) => ({ ...f, [k]: on })); };

  // rent-step list editing
  const setStep = (i, k) => (e) => setForm((f) => ({ ...f, rentSteps: f.rentSteps.map((s, j) => (j === i ? { ...s, [k]: e.target.value } : s)) }));
  const addStep = () => setForm((f) => ({ ...f, rentSteps: [...f.rentSteps, { effective_date: '', new_base_rent: '' }] }));
  const removeStep = (i) => setForm((f) => ({ ...f, rentSteps: f.rentSteps.filter((_, j) => j !== i) }));

  const refresh = () => {
    ['addendums', 'lease', 'leases', 'escalations', 'renewals', 'propertyTotals', 'tenantShares', 'alerts', 'expiredLeases', 'searchIndex', 'notifications']
      .forEach((key) => qc.invalidateQueries({ queryKey: [key] }));
  };

  const remove = useMutation({ mutationFn: (id) => deleteAddendum(id), onSuccess: refresh });

  function resetAdd() { setForm(blankForm()); setErr(''); setMode('upload'); setAdding(false); }

  // Collect every ENABLED effect into the normalized `changes` applyAddendum wants.
  function formToChanges(f) {
    const changes = { escalations: [], renewals: [] };
    if (f.fx_extension && f.new_termination_date) changes.extensionEnd = f.new_termination_date;
    if (f.fx_rent) {
      changes.escalations = (f.rentSteps || [])
        .filter((s) => s.new_base_rent !== '' && s.new_base_rent != null)
        .map((s) => ({ effective_date: s.effective_date || f.amendment_date || null, escalation_type: 'manual', escalation_value: null, new_base_rent: Number(s.new_base_rent) }));
    }
    if (f.fx_option) {
      const primary = { option_label: f.opt_label || null, term_months: numOrNull(f.opt_term_months), new_rent: numOrNull(f.opt_new_rent), annual_escalation_pct: numOrNull(f.opt_annual_pct), notice_by_date: f.opt_notice_by || null };
      changes.renewals = [primary, ...(f._aiRenewals || []).map((r) => ({
        option_label: r.option_label ?? null, term_months: r.term_months ?? null, new_rent: r.new_rent ?? null,
        annual_escalation_pct: r.annual_escalation_pct ?? null, notice_by_date: r.notice_by_date ?? null,
      }))];
    }
    if (f.fx_assignment && f.asg_tenant_name) {
      changes.assignment = {
        newTenantName: f.asg_tenant_name,
        newTenantContact: f.asg_contact_name || null,
        newTenantEmail: f.asg_email || null,
        newTenantEmail2: f.asg_email_2 || null,
        effectiveDate: f.asg_effective_date || null,
      };
    }
    return changes;
  }

  const save = useMutation({
    mutationFn: async () => {
      const addendum = await createAddendum({
        lease_id: leaseId,
        label: form.label || null,
        amendment_date: form.amendment_date || null,
        kind: primaryKind(form),
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

  // AI extraction → pre-fill EVERY detected effect, then show the review for confirm.
  async function intake(getExtract) {
    setBusy(true); setErr('');
    try {
      const { fields, addendum_text } = await getExtract();
      const asg = fields.assignment || null;

      // Rent steps: the opening base rent + every later period, as dated steps.
      const steps = [];
      if (fields.new_base_rent != null) steps.push({ effective_date: fields.new_base_rent_effective_date || fields.amendment_date || '', new_base_rent: String(fields.new_base_rent) });
      (fields.escalations || []).forEach((e) => {
        if (e.new_base_rent != null) steps.push({ effective_date: e.effective_date || '', new_base_rent: String(e.new_base_rent) });
      });
      const opts = fields.renewal_options || [];
      const first = opts[0] || null;

      setForm((f) => ({
        ...f,
        label: fields.label || '',
        amendment_date: fields.amendment_date || '',
        summary: fields.summary || '',
        fx_extension: !!fields.new_termination_date,
        new_termination_date: fields.new_termination_date || '',
        fx_rent: steps.length > 0,
        rentSteps: steps,
        fx_option: opts.length > 0,
        opt_label: first?.option_label || '',
        opt_term_months: first?.term_months ?? '',
        opt_new_rent: first?.new_rent ?? '',
        opt_annual_pct: first?.annual_escalation_pct ?? '',
        opt_notice_by: first?.notice_by_date || '',
        _aiRenewals: opts.slice(1),
        fx_assignment: !!(asg && asg.is_assignment && asg.new_tenant_name),
        asg_tenant_name: asg?.new_tenant_name || '',
        asg_contact_name: asg?.new_tenant_contact_name || '',
        asg_email: asg?.new_tenant_email || '',
        asg_email_2: asg?.new_tenant_email_2 || '',
        asg_effective_date: asg?.assignment_effective_date || '',
        addendum_text: addendum_text || null,
        extraction_raw: fields || null,
        _fromAI: true,
      }));
      setMode('manual'); // the review form (pre-filled)
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

  const anyEffect = form.fx_extension || form.fx_rent || form.fx_option || form.fx_assignment;
  const canSave =
    (!form.fx_extension || !!form.new_termination_date) &&
    (!form.fx_option || (form.opt_term_months !== '' || form.opt_new_rent !== '' || form.opt_annual_pct !== '')) &&
    (!form.fx_assignment || !!form.asg_tenant_name) &&
    (!form.fx_rent || (form.rentSteps || []).some((s) => s.new_base_rent !== '' && s.new_base_rent != null));

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
                  <td>{KIND_LABEL[a.kind] || a.kind}</td>
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
                Upload the rider (PDF, scan, photo, or Word .docx). The AI reads it and pre-fills every change it finds —
                you just confirm or correct. <strong>This uses a paid AI call.</strong>
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
              {form._fromAI && (
                <div className="callout" style={{ marginBottom: 14, borderLeftColor: 'var(--accent)' }}>
                  <strong>Here's what the AI read from this addendum.</strong>
                  <span className="muted" style={{ display: 'block', fontSize: 12.5 }}>
                    Everything it found is turned on and filled in below — untick anything it got wrong, tick anything it
                    missed, and edit the values. {anyEffect ? '' : "It didn't detect a term/rent/option/tenant change — you can add one or save it as a note."}
                  </span>
                </div>
              )}

              <div className="field-grid">
                <label className="form-field" style={{ marginBottom: 0 }}><span>Label</span><input className="text-input" placeholder="First Amendment" value={form.label} onChange={set('label')} /></label>
                <label className="form-field" style={{ marginBottom: 0 }}><span>Dated</span><input className="text-input" type="date" value={form.amendment_date} onChange={set('amendment_date')} /></label>
              </div>

              {/* Extends the term */}
              <EffectCard on={form.fx_extension} onToggle={toggle('fx_extension')} title="Extends the term" hint="Commits a longer term — moves the lease's end date.">
                <div className="field-grid">
                  <label className="form-field" style={{ marginBottom: 0 }}><span>New termination date</span><input className="text-input" type="date" value={form.new_termination_date} onChange={set('new_termination_date')} /></label>
                </div>
              </EffectCard>

              {/* Changes the rent */}
              <EffectCard on={form.fx_rent} onToggle={toggle('fx_rent')} title="Changes the rent" hint="One row per rent step. Amounts are ANNUAL base rent.">
                <div className="table-wrap">
                  <table style={{ minWidth: 0 }}>
                    <thead><tr><th>Effective date</th><th className="num">Annual base rent ($)</th><th></th></tr></thead>
                    <tbody>
                      {(form.rentSteps || []).map((s, i) => (
                        <tr key={i}>
                          <td><input className="text-input" type="date" value={s.effective_date} onChange={setStep(i, 'effective_date')} /></td>
                          <td className="num"><input className="text-input num" type="number" step="any" value={s.new_base_rent} onChange={setStep(i, 'new_base_rent')} /></td>
                          <td className="num"><button type="button" className="icon-btn danger-btn" title="Remove step" onClick={() => removeStep(i)}>✕</button></td>
                        </tr>
                      ))}
                      {(form.rentSteps || []).length === 0 && <tr><td colSpan={3} className="muted" style={{ fontSize: 12.5 }}>No steps — add one.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <button type="button" className="ghost" style={{ marginTop: 6 }} onClick={addStep}>+ Add rent step</button>
              </EffectCard>

              {/* Adds a renewal option (always PENDING) */}
              <EffectCard on={form.fx_option} onToggle={toggle('fx_option')} title="Adds a renewal option"
                hint="The tenant's right to extend later. Saved as Pending — it won't change your term until you confirm the tenant is exercising it.">
                <div className="field-grid">
                  <label className="form-field" style={{ marginBottom: 0 }}><span>Option label</span><input className="text-input" placeholder="Option to Renew" value={form.opt_label} onChange={set('opt_label')} /></label>
                  <label className="form-field" style={{ marginBottom: 0 }}><span>Term (months)</span><input className="text-input num" type="number" value={form.opt_term_months} onChange={set('opt_term_months')} /></label>
                  <label className="form-field" style={{ marginBottom: 0 }}><span>New rent (annual $)</span><input className="text-input num" type="number" step="any" placeholder="flat $/yr — optional" value={form.opt_new_rent} onChange={set('opt_new_rent')} /></label>
                  <label className="form-field" style={{ marginBottom: 0 }}><span>or +%/yr</span><input className="text-input num" type="number" step="any" placeholder="e.g. 5" value={form.opt_annual_pct} onChange={set('opt_annual_pct')} /></label>
                  <label className="form-field" style={{ marginBottom: 0 }}><span>Notice by</span><input className="text-input" type="date" value={form.opt_notice_by} onChange={set('opt_notice_by')} /></label>
                </div>
                {(form._aiRenewals || []).length > 0 && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>+ {form._aiRenewals.length} more option{form._aiRenewals.length > 1 ? 's' : ''} the AI found will also be added.</p>
                )}
              </EffectCard>

              {/* Assigns to a new tenant */}
              <EffectCard on={form.fx_assignment} onToggle={toggle('fx_assignment')} title="Assigns to a new tenant"
                hint="The lease was handed to a new party — updates the tenant on this lease as of the effective date. The prior tenant stays in this addendum record.">
                <div className="field-grid">
                  <label className="form-field" style={{ marginBottom: 0 }}><span>New tenant name</span><input className="text-input" placeholder="e.g. D & D Dental, LLC" value={form.asg_tenant_name} onChange={set('asg_tenant_name')} /></label>
                  <label className="form-field" style={{ marginBottom: 0 }}><span>New contact / guarantor</span><input className="text-input" placeholder="e.g. Dr. Ahmed Hegazy" value={form.asg_contact_name} onChange={set('asg_contact_name')} /></label>
                  <label className="form-field" style={{ marginBottom: 0 }}><span>New tenant email</span><input className="text-input" value={form.asg_email} onChange={set('asg_email')} /></label>
                  <label className="form-field" style={{ marginBottom: 0 }}><span>Second email (optional)</span><input className="text-input" value={form.asg_email_2} onChange={set('asg_email_2')} /></label>
                  <label className="form-field" style={{ marginBottom: 0 }}><span>Effective date</span><input className="text-input" type="date" value={form.asg_effective_date} onChange={set('asg_effective_date')} /></label>
                </div>
              </EffectCard>

              <div className="form-field" style={{ maxWidth: '100%', marginTop: 16 }}>
                <span>Summary / note</span>
                <input className="text-input" value={form.summary} onChange={set('summary')} placeholder="e.g. Extends term 5 years and adds a renewal option" />
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

// One toggleable effect. Header carries a checkbox + title + hint; the body (fields)
// shows only when the effect is on. Pre-checked when the AI detected it.
function EffectCard({ on, onToggle, title, hint, children }) {
  return (
    <div className="callout" style={{ marginTop: 12, borderLeftColor: on ? 'var(--accent)' : 'var(--line)' }}>
      <label className="between" style={{ cursor: 'pointer', gap: 10, alignItems: 'flex-start' }}>
        <span>
          <strong>{title}</strong>
          {hint && <span className="muted" style={{ display: 'block', fontSize: 12 }}>{hint}</span>}
        </span>
        <input type="checkbox" checked={on} onChange={onToggle} style={{ marginTop: 3 }} />
      </label>
      {on && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}
