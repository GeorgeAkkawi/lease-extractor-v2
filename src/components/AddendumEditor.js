import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listAddendums, createAddendum, deleteAddendum, applyAddendum, extractAddendum, uploadDoc, isoDateOrNull, discardDocument } from '../lib/api';
import { fmtDate, money } from '../lib/format';
import { stripVerdicts, mismatchPhrase } from '../lib/analystBrief';
import { coversLabel } from '../lib/riders';
import { settleBillingChange, settleLeaseScheduleChange } from '../lib/invalidate';
import { useFeatures } from '../lib/features';
import { useConfirm } from './ConfirmDialog';
import AddendumEnvelopeRows from './AddendumEnvelopeRows';
import SendForSignatureModal from './SendForSignatureModal';
import { FilePickerZone } from './FileDrop';
import { useOptimisticRemove } from './useOptimisticRemove';
import MutationError from './MutationError';

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
  // amendment_date is the day the rider was SIGNED. effective_from/to are the period
  // it GOVERNS — George, 2026-07-30: "input the dates of the rider". They are usually
  // different: the Denny's rider is dated June 2023 and governs Jul 2023 → Apr 2033.
  label: '', amendment_date: '', effective_from: '', effective_to: '', summary: '',
  fx_extension: false, fx_rent: false, fx_option: false, fx_assignment: false, fx_abatement: false, fx_estimate: false,
  fx_sqft: false, new_square_footage: '', sqft_quote: '',
  est_camtax: '', est_roof: '', est_quote: '',
  new_termination_date: '',
  rentSteps: [], // [{ effective_date, new_base_rent, escalation_type, escalation_value }]
  opt_label: '', opt_term_months: '', opt_new_rent: '', opt_annual_pct: '', opt_notice_by: '',
  _optSchedule: [], // the first option's year-by-year rent table, when it prices one
  _aiRenewals: [], // any additional options beyond the first (rare)
  asg_tenant_name: '', asg_contact_name: '', asg_email: '', asg_email_2: '', asg_effective_date: '',
  ab_start: '', ab_months: '', ab_kind: 'free', ab_value: '', ab_note: '',
  _aiAbatements: [], // any additional abatement windows beyond the first (rare)
  storage_path: null, addendum_text: null, extraction_raw: null, _rentFlag: null, _fromAI: false,
  _superseded: [], _termFlag: null, _mismatch: [], _brief: '',
});

// Why the rent schedule needs a human eye. The banner used to say "$/SF" no matter the
// reason, which was simply wrong for a model-math divergence and would be wrong again for a
// rider whose only rent figures are quotations of the clause it replaces.
const RENT_FLAG_MSG = {
  missing_sqft_for_psf: 'Some amounts were read from a $/SF rate — double-check them against the addendum before saving.',
  model_math_divergence: 'The amounts here were recomputed from the rates in the document and differ from what the AI first wrote — check them against the addendum.',
  all_rent_rows_superseded: 'Every rent figure in this rider looks like a quotation of the clause it replaces, so none was applied. If the rider does set a new rent, enter it below.',
  _default: 'Double-check these amounts against the addendum before saving.',
};

const numOrNull = (v) => (v === '' || v == null ? null : Number(v));

// Is this rent step worth keeping? A plain step carries a dollar amount. A PERCENT (or CPI)
// step carries no dollars at all — buildEscalations → computeEscalatedRent prices it off the
// prior rent when it's applied — so it qualifies on its type + value instead. Used by intake,
// the save mapping and canSave alike, so the three can't disagree about what a step is.
// Accepts both the AI's shape (numbers) and the form's (strings).
const stepIsUsable = (s) => {
  if (!s) return false;
  if (s.new_base_rent !== '' && s.new_base_rent != null) return true;
  const t = s.escalation_type;
  return (t === 'percent' || t === 'cpi') && s.escalation_value !== '' && s.escalation_value != null && Number(s.escalation_value) > 0;
};

// Primary kind stored on the addendum row (for the History badge). An addendum can
// do several things; this is just the headline. 'assignment' requires migration 0035.
function primaryKind(f) {
  if (f.fx_assignment && f.asg_tenant_name) return 'assignment';
  if (f.fx_extension && f.new_termination_date) return 'extension';
  if (f.fx_option) return 'new_option';
  if (f.fx_rent) return 'rent_change';
  return 'other';
}

export default function AddendumEditor({ leaseId, leaseInactive, squareFootage, currentTermEnd, lease, property, corp }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const { isOn } = useFeatures();
  const { data: addendums = [] } = useQuery({ queryKey: ['addendums', leaseId], queryFn: () => listAddendums(leaseId) });

  const [adding, setAdding] = useState(false);
  // E-signature lives in this card too (George, 2026-08-04). An amendment arrives one of two
  // ways — already signed on paper and uploaded, or sent out from here to be signed — and
  // both belong to the same card because both end up as the same thing.
  const [sending, setSending] = useState(false);
  const [mode, setMode] = useState('upload'); // 'upload' | 'manual'
  const [form, setForm] = useState(blankForm());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const toggle = (k) => (e) => { const on = e.target.checked; setForm((f) => ({ ...f, [k]: on })); };

  // rent-step list editing
  const setStep = (i, k) => (e) => setForm((f) => ({ ...f, rentSteps: f.rentSteps.map((s, j) => (j === i ? { ...s, [k]: e.target.value } : s)) }));
  const addStep = () => setForm((f) => ({ ...f, rentSteps: [...f.rentSteps, { effective_date: '', new_base_rent: '', escalation_type: 'manual', escalation_value: '' }] }));
  const removeStep = (i) => setForm((f) => ({ ...f, rentSteps: f.rentSteps.filter((_, j) => j !== i) }));

  const propId = property?.id || lease?.property_id || null;
  const refresh = () => {
    // A rider can move the term, the rent AND the CAM & tax estimate — and any of those
    // resyncs the year invoice + the recorded paid months, so the Ledger boxes, the monthly
    // tracker and the invoices/payments panels must repaint too.
    //
    // The two SHARED sets do the money and the schedule (CLAUDE.md §6). This used to be a
    // third hand-rolled list, and it had already drifted by omission — no `abatements` (a
    // rider can grant one), no `adjustments`, no `statementContext`, no `corpRollups`, no
    // `portfolioCollected`. Hand-rolled lists always drift; that is why the sets exist.
    settleBillingChange(qc, { propertyId: propId, leaseId, year: new Date().getFullYear() });
    settleLeaseScheduleChange(qc, leaseId);
    // What is genuinely local to this screen: the rider list itself and the surfaces a rider
    // moves that a billed figure does not.
    ['addendums', 'expiredLeases', 'searchIndex', 'notifications', 'historyEvents']
      .forEach((key) => qc.invalidateQueries({ queryKey: [key] }));
  };

  const remove = useOptimisticRemove({
    queryKey: ['addendums', leaseId], idOf: (id) => id,
    mutationFn: (id) => deleteAddendum(id), onSuccess: refresh,
  });

  // `discard` is set when the user is BACKING OUT rather than saving: the file that
  // was uploaded for a review that never became a rider is thrown away with it.
  // (After a successful save the rider owns the file, so it must stay.)
  function resetAdd({ discard = false } = {}) {
    if (discard && form.storage_path) discardDocument(form.storage_path).catch(() => {});
    setForm(blankForm()); setErr(''); setMode('upload'); setAdding(false);
  }

  // Collect every ENABLED effect into the normalized `changes` applyAddendum wants.
  function formToChanges(f) {
    const changes = { escalations: [], renewals: [] };
    if (f.fx_extension && f.new_termination_date) changes.extensionEnd = f.new_termination_date;
    if (f.fx_rent) {
      changes.escalations = (f.rentSteps || [])
        .filter(stepIsUsable)
        .map((s) => {
          const pct = s.escalation_type === 'percent' || s.escalation_type === 'cpi';
          return {
            effective_date: s.effective_date || f.amendment_date || null,
            escalation_type: pct ? s.escalation_type : 'manual',
            escalation_value: pct ? numOrNull(s.escalation_value) : null,
            // A percent step's dollars are computed at apply time from the prior rent —
            // never carry a stale figure here or it would win over the formula.
            new_base_rent: pct ? null : Number(s.new_base_rent),
          };
        });
    }
    if (f.fx_option) {
      // rent_schedule (an option priced year by year) rides along untouched — it isn't
      // editable on this form, but dropping it would lose the whole option rent table.
      const primary = {
        option_label: f.opt_label || null, term_months: numOrNull(f.opt_term_months), new_rent: numOrNull(f.opt_new_rent),
        annual_escalation_pct: numOrNull(f.opt_annual_pct), notice_by_date: f.opt_notice_by || null,
        rent_schedule: f._optSchedule || [],
      };
      changes.renewals = [primary, ...(f._aiRenewals || []).map((r) => ({
        option_label: r.option_label ?? null, term_months: r.term_months ?? null, new_rent: r.new_rent ?? null,
        annual_escalation_pct: r.annual_escalation_pct ?? null, notice_by_date: r.notice_by_date ?? null,
        rent_schedule: Array.isArray(r.rent_schedule) ? r.rent_schedule : [],
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
    // The CAM & tax the rider says the tenant pays during the year. Stored the merged
    // way the whole app bills from (one combined figure), and the year's invoice +
    // recorded months resync to it — the estimate is the source of truth all year.
    if (f.fx_estimate && (f.est_camtax !== '' || f.est_roof !== '')) {
      changes.estimates = {
        camTaxAnnual: numOrNull(f.est_camtax),
        roofAnnual: numOrNull(f.est_roof),
        effectiveDate: f.amendment_date || null,
      };
    }
    // The size of the premises. applyAddendum ignores a figure equal to what the lease
    // already carries, so re-confirming an unchanged size is a no-op rather than a
    // pointless re-split of the year's CAM.
    if (f.fx_sqft && f.new_square_footage !== '') changes.squareFootage = numOrNull(f.new_square_footage);
    if (f.fx_abatement && f.ab_start && f.ab_months !== '') {
      const primary = { start_date: f.ab_start, months: Number(f.ab_months), kind: f.ab_kind, value: numOrNull(f.ab_value), note: f.ab_note || null };
      changes.abatements = [primary, ...(f._aiAbatements || []).map((a) => ({
        start_date: a.start_date ?? null, months: a.months ?? null, kind: a.kind || 'free', value: a.value ?? null, note: a.note ?? null,
      }))];
    }
    return changes;
  }

  const save = useMutation({
    mutationFn: async () => {
      const addendum = await createAddendum({
        lease_id: leaseId,
        label: form.label || null,
        amendment_date: form.amendment_date || null,
        // A rider that prints an impossible date ("April 31") must not abort the save —
        // isoDateOrNull drops it the same way every other date field is guarded.
        effective_from: isoDateOrNull(form.effective_from),
        effective_to: isoDateOrNull(form.effective_to),
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
      const { fields, addendum_text, storagePath } = await getExtract();
      const asg = fields.assignment || null;

      // Rent steps: the opening base rent + every later period, as dated steps.
      // A PERCENT step ("then 3% each year") carries no dollar figure — it's priced
      // downstream off the prior rent by computeEscalatedRent — so it must be kept on its
      // type + value, not on new_base_rent. Requiring a dollar amount here silently dropped
      // every percent step the extractor found (the demo mock's own canned rider is a live
      // reproduction: its summary promises a 3% bump the form never showed).
      const steps = [];
      if (fields.new_base_rent != null) {
        steps.push({
          effective_date: fields.new_base_rent_effective_date || fields.amendment_date || '',
          new_base_rent: String(fields.new_base_rent),
          escalation_type: 'manual',
          escalation_value: '',
        });
      }
      (fields.escalations || []).forEach((e) => {
        if (!stepIsUsable(e)) return;
        steps.push({
          effective_date: e.effective_date || '',
          new_base_rent: e.new_base_rent != null ? String(e.new_base_rent) : '',
          escalation_type: e.escalation_type === 'percent' || e.escalation_type === 'cpi' ? e.escalation_type : 'manual',
          escalation_value: e.escalation_value != null ? String(e.escalation_value) : '',
        });
      });
      const opts = fields.renewal_options || [];
      const first = opts[0] || null;
      const abs = fields.abatements || [];
      const ab0 = abs[0] || null;
      // CAM & tax the rider states, already annualized in code by the extractor. Merged
      // into the ONE combined figure the app bills from (2026-07-20 convention).
      const estCamTax =
        fields.est_cam_annual != null || fields.est_tax_annual != null
          ? Number(fields.est_cam_annual || 0) + Number(fields.est_tax_annual || 0)
          : null;

      setForm((f) => ({
        ...f,
        label: fields.label || '',
        amendment_date: fields.amendment_date || '',
        // The period the rider governs, pre-filled from what the extractor already read
        // and editable. It starts where its rent starts (or, failing that, the day it
        // was signed) and runs to the term end it sets, if it sets one.
        effective_from: fields.new_base_rent_effective_date || fields.amendment_date || '',
        effective_to: fields.new_termination_date || '',
        summary: fields.summary || '',
        // Keep the card ON when the rider clearly extends but printed a date we can't use
        // ("April 31") and there was no length to compute from — otherwise the extension
        // would silently vanish. canSave then holds the save until a real date is entered.
        fx_extension: !!fields.new_termination_date || fields.term_extension_flag?.reason === 'impossible_date_printed',
        new_termination_date: fields.new_termination_date || '',
        fx_rent: steps.length > 0,
        rentSteps: steps,
        fx_option: opts.length > 0,
        opt_label: first?.option_label || '',
        opt_term_months: first?.term_months ?? '',
        opt_new_rent: first?.new_rent ?? '',
        opt_annual_pct: first?.annual_escalation_pct ?? '',
        opt_notice_by: first?.notice_by_date || '',
        _optSchedule: Array.isArray(first?.rent_schedule) ? first.rent_schedule : [],
        _aiRenewals: opts.slice(1),
        fx_assignment: !!(asg && asg.is_assignment && asg.new_tenant_name),
        asg_tenant_name: asg?.new_tenant_name || '',
        asg_contact_name: asg?.new_tenant_contact_name || '',
        asg_email: asg?.new_tenant_email || '',
        asg_email_2: asg?.new_tenant_email_2 || '',
        asg_effective_date: asg?.assignment_effective_date || '',
        fx_abatement: abs.length > 0,
        ab_start: ab0?.start_date || '',
        ab_months: ab0?.months ?? '',
        ab_kind: ab0?.kind || 'free',
        ab_value: ab0?.value ?? '',
        ab_note: ab0?.note || '',
        _aiAbatements: abs.slice(1),
        // A re-sized premises. Ticked only when the figure the rider states actually
        // DIFFERS from the size on file — a rider that merely recites the existing area
        // shouldn't ask the landlord to confirm a change that isn't one. Filled either
        // way, so an unticked card still shows what was read.
        fx_sqft: fields.new_square_footage != null && Number(fields.new_square_footage) !== Number(squareFootage),
        new_square_footage: fields.new_square_footage != null ? String(fields.new_square_footage) : '',
        sqft_quote: fields.square_footage_quote || '',
        fx_estimate: estCamTax != null || fields.est_roof_annual != null,
        est_camtax: estCamTax != null ? String(estCamTax) : '',
        est_roof: fields.est_roof_annual != null ? String(fields.est_roof_annual) : '',
        est_quote: fields.est_quote || '',
        storage_path: storagePath || f.storage_path || null,
        addendum_text: addendum_text || null,
        extraction_raw: fields || null,
        _rentFlag: fields.rent_schedule_flag || null,
        _superseded: Array.isArray(fields.superseded_rent) ? fields.superseded_rent : [],
        _termFlag: fields.term_extension_flag || null,
        _mismatch: Array.isArray(fields.extraction_mismatch) ? fields.extraction_mismatch : [],
        _brief: fields.analysis_brief || '',
        _fromAI: true,
      }));
      setMode('manual'); // the review form (pre-filled)
    } catch (e) { setErr(e.message || String(e)); } finally { setBusy(false); }
  }

  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const onFile = (file) => {
    // Return the storage path alongside the extraction so `intake` can carry it into the
    // form — until now it was uploaded and then thrown away, so every saved rider had
    // storage_path null and the document itself was unreachable from its record. Threaded
    // through the return value (rather than a setForm before intake) so a failed read can't
    // strand a path on a form that's about to be reset.
    if (file) intake(async () => {
      // entityId is null until the rider is saved — createAddendum adopts it, and
      // Cancel (resetAdd) discards both the row and the file.
      const storagePath = await uploadDoc(file, { entityType: 'addendum' });
      const res = await extractAddendum({ storagePath, squareFootage, currentTermEnd });
      return { ...res, storagePath };
    });
  };
  const onPaste = () => { if (pasteText.trim()) intake(() => extractAddendum({ text: pasteText.trim(), squareFootage, currentTermEnd })); };

  const anyEffect = form.fx_extension || form.fx_rent || form.fx_option || form.fx_assignment || form.fx_abatement || form.fx_estimate || form.fx_sqft;
  const canSave =
    (!form.fx_estimate || form.est_camtax !== '' || form.est_roof !== '') &&
    // A size that isn't a positive number would re-split the year's CAM by zero.
    (!form.fx_sqft || Number(form.new_square_footage) > 0) &&
    // A real calendar date, not just a filled box: an impossible one (a date input shows
    // it blank while the value is still there) would fail the write, not the form.
    (!form.fx_extension || !!isoDateOrNull(form.new_termination_date)) &&
    (!form.fx_option || (form.opt_term_months !== '' || form.opt_new_rent !== '' || form.opt_annual_pct !== '')) &&
    (!form.fx_assignment || !!form.asg_tenant_name) &&
    (!form.fx_abatement || (!!form.ab_start && form.ab_months !== '')) &&
    (!form.fx_rent || (form.rentSteps || []).some(stepIsUsable));

  return (
    <div>
      {leaseInactive && (
        <p className="muted" style={{ marginTop: -6, marginBottom: 14, fontSize: 12.5 }}>
          This lease is outdated. Add the <strong>extension or rider</strong> that carries it forward and the term, rent,
          and financials will update automatically.
        </p>
      )}

      {/* Anything currently out for signature, above the settled amendments. A row leaves
          this strip and joins the table below only when it is actually applied. */}
      {isOn('esign') && lease && (
        <AddendumEnvelopeRows leaseId={leaseId} lease={lease} property={property} corp={corp} />
      )}

      {addendums.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table style={{ minWidth: 0 }}>
            <thead><tr><th>Addendum</th><th>Dated</th><th>Covers</th><th>Type</th><th>What it changed</th><th></th></tr></thead>
            <tbody>
              {addendums.map((a) => (
                <tr key={a.id}>
                  <td>{a.label || '—'}</td>
                  <td>{fmtDate(a.amendment_date)}</td>
                  <td>{coversLabel(a)}</td>
                  <td>{KIND_LABEL[a.kind] || a.kind}</td>
                  <td>{a.summary || '—'}</td>
                  <td className="num">
                    <button type="button" className="icon-btn danger-btn" title="Delete this addendum (does not undo its applied changes)"
                      disabled={remove.isPending}
                      onClick={async () => {
                        if (await askConfirm({
                          title: 'Delete addendum record?',
                          message: 'Delete this addendum record?',
                          implications: [
                            'Removes the record from this lease.',
                            'Does NOT reverse changes it already applied (rent steps, term extension, assignment) — those stay on the lease.',
                            'This can’t be undone.',
                          ],
                          confirmLabel: 'Delete',
                        })) remove.mutate(a.id);
                      }}>
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
        <div className="row">
          <button type="button" className="secondary" onClick={() => { setForm(blankForm()); setAdding(true); }}>
            + Add addendum / rider
          </button>
          {/* The second way an amendment gets here: not signed yet. Same card, because it
              becomes the same thing. */}
          {isOn('esign') && lease && property && (
            <button type="button" className="secondary" onClick={() => setSending(true)}
              title="Send a document to this tenant to sign electronically">
              ✎ Send one for signature
            </button>
          )}
        </div>
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
                you just confirm or correct.
              </div>
              <FilePickerZone
                onFile={onFile}
                accept=".pdf,.docx,image/*"
                busy={busy}
                ariaLabel="Upload addendum file"
                hint="Choose the rider file — or drag it straight in here"
                dropHint="Drop the rider here"
                busyHint="Reading the rider…"
              />
              <div className="row" style={{ marginTop: 12 }}>
                <button type="button" className="ghost" onClick={() => setShowPaste((p) => !p)}>{showPaste ? 'Hide paste' : 'Paste text instead'}</button>
                <button type="button" className="ghost" onClick={() => resetAdd({ discard: true })}>Cancel</button>
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

              {/* The analyst read the whole rider; the form-filler works to a fixed shape. When
                  the two disagree, say so — a change the cards can't hold must never vanish. */}
              {(form._mismatch || []).length > 0 && (
                <p className="note-msg warn" style={{ marginBottom: 12 }}>
                  ⚠ The AI analyst read the whole rider and found <strong>{mismatchPhrase(form._mismatch)}</strong>, but{' '}
                  {form._mismatch.length === 1 ? 'it was' : 'they were'} not captured below. Open{' '}
                  <em>the AI analyst's notes</em> at the bottom to see what it read, then tick the matching card and enter{' '}
                  {form._mismatch.length === 1 ? 'it' : 'them'} by hand before saving.
                </p>
              )}

              <div className="field-grid">
                <label className="form-field" style={{ marginBottom: 0 }}><span>Label</span><input className="text-input" placeholder="First Amendment" value={form.label} onChange={set('label')} /></label>
                <label className="form-field" style={{ marginBottom: 0 }}><span>Dated</span><input className="text-input" type="date" value={form.amendment_date} onChange={set('amendment_date')} /></label>
              </div>

              {/* The period the rider GOVERNS — distinct from the day it was signed, and
                  the thing you actually want to see beside it in the list. */}
              <div className="field-grid">
                <label className="form-field" style={{ marginBottom: 0 }}>
                  <span>Covers from</span>
                  <input className="text-input" type="date" value={form.effective_from} onChange={set('effective_from')} />
                  <span className="field-note">The date this rider takes effect.</span>
                </label>
                <label className="form-field" style={{ marginBottom: 0 }}>
                  <span>Covers to</span>
                  <input className="text-input" type="date" value={form.effective_to} onChange={set('effective_to')} />
                  <span className="field-note">Leave blank if it runs to the end of the lease.</span>
                </label>
              </div>

              {/* Extends the term */}
              <EffectCard on={form.fx_extension} onToggle={toggle('fx_extension')} title="Extends the term" hint="Commits a longer term — moves the lease's end date.">
                <div className="field-grid">
                  <label className="form-field" style={{ marginBottom: 0 }}><span>New termination date</span><input className="text-input" type="date" value={form.new_termination_date} onChange={set('new_termination_date')} /></label>
                </div>
                {/* A rider often states the extension as a LENGTH ("an additional five (5) years")
                    and prints an end date that's wrong, or impossible — Denny's says "April 31".
                    We compute old end + N months and say when the two disagree. */}
                {form._termFlag && (
                  <p className={form._termFlag.reason === 'computed_from_length' ? 'muted' : 'note-msg warn'} style={{ fontSize: 12.5, marginTop: 8 }}>
                    {form._termFlag.reason === 'computed_from_length'
                      ? `Computed from “${form._termFlag.months} months” added to the current end${form._termFlag.currentEnd ? ` (${fmtDate(form._termFlag.currentEnd)})` : ''} — the rider states a length, not a usable date.`
                      : form._termFlag.reason === 'impossible_date_printed'
                        ? `⚠ The rider prints “${form._termFlag.stated}”, which isn't a real date${form._termFlag.computed ? ` — its own “additional ${form._termFlag.months} months” lands on ${fmtDate(form._termFlag.computed)}, filled in above` : '. Enter the intended end date above'}.`
                        : `⚠ The rider extends by ${form._termFlag.months} months, which lands on ${fmtDate(form._termFlag.computed)} — but the date it prints is ${fmtDate(form._termFlag.stated)}. Check which is right before saving.`}
                  </p>
                )}
              </EffectCard>

              {/* Changes the rent */}
              <EffectCard on={form.fx_rent} onToggle={toggle('fx_rent')} title="Changes the rent" hint="One row per rent step. Amounts are ANNUAL base rent.">
                {form._rentFlag && (
                  <p className="note-msg warn" style={{ marginBottom: 8 }}>⚠ {RENT_FLAG_MSG[form._rentFlag.reason] || RENT_FLAG_MSG._default}</p>
                )}
                {/* A rider recites the clause it replaces. Those rows are recognized and left
                    OUT of the schedule — say so out loud rather than dropping them silently. */}
                {(form._superseded || []).length > 0 && (
                  <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
                    This rider quotes {form._superseded.length === 1 ? 'a prior rent it replaces' : 'prior rents it replaces'} — not applied:{' '}
                    {form._superseded.map((s, i) => (
                      <span key={i}>
                        {i > 0 && ' · '}
                        {s.annual != null ? money(s.annual) : '—'}{s.effective_date ? ` from ${fmtDate(s.effective_date)}` : ''}
                      </span>
                    ))}.
                  </p>
                )}
                <div className="table-wrap">
                  <table style={{ minWidth: 0 }}>
                    <thead><tr><th>Effective date</th><th>Type</th><th className="num">Amount</th><th></th></tr></thead>
                    <tbody>
                      {(form.rentSteps || []).map((s, i) => {
                        const pct = s.escalation_type === 'percent' || s.escalation_type === 'cpi';
                        return (
                          <tr key={i}>
                            <td><input className="text-input" type="date" value={s.effective_date} onChange={setStep(i, 'effective_date')} /></td>
                            <td>
                              <select className="text-input" value={s.escalation_type || 'manual'} onChange={setStep(i, 'escalation_type')}>
                                <option value="manual">Amount ($/yr)</option>
                                <option value="percent">+% per step</option>
                              </select>
                            </td>
                            {/* A percent step has no dollar figure of its own — it's priced from the
                                rent in effect just before it, when the addendum is applied. */}
                            <td className="num">
                              {pct ? (
                                <input className="text-input num" type="number" step="any" placeholder="e.g. 3" value={s.escalation_value} onChange={setStep(i, 'escalation_value')} />
                              ) : (
                                <input className="text-input num" type="number" step="any" value={s.new_base_rent} onChange={setStep(i, 'new_base_rent')} />
                              )}
                            </td>
                            <td className="num"><button type="button" className="icon-btn danger-btn" title="Remove step" onClick={() => removeStep(i)}>✕</button></td>
                          </tr>
                        );
                      })}
                      {(form.rentSteps || []).length === 0 && <tr><td colSpan={4} className="muted" style={{ fontSize: 12.5 }}>No steps — add one.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {(form.rentSteps || []).some((s) => s.escalation_type === 'percent' || s.escalation_type === 'cpi') && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    A <strong>+% per step</strong> row is computed from the rent in effect just before it — enter the
                    percent, not a dollar figure.
                  </p>
                )}
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
                {(form._optSchedule || []).length > 1 && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    This option is priced year by year — {form._optSchedule.length} steps from {money(form._optSchedule[0].annual)}/yr
                    to {money(form._optSchedule[form._optSchedule.length - 1].annual)}/yr. They're saved as pending-renewal steps and
                    only take effect if you confirm the option.
                  </p>
                )}
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

              {/* Sets the CAM & tax estimate */}
              {/* Changes the size of the premises */}
              <EffectCard on={form.fx_sqft} onToggle={toggle('fx_sqft')} title="Changes the size of the premises"
                hint="The tenant took on more space, or gave some back. This is the number the CAM, tax and roof shares are split by — saving it re-splits what this tenant is billed for the year.">
                <div className="field-grid">
                  <label className="form-field" style={{ marginBottom: 0 }}>
                    <span>New size (SF)</span>
                    <input className="text-input num" type="number" min="1" step="any" placeholder="e.g. 3400"
                      value={form.new_square_footage} onChange={set('new_square_footage')} />
                    <span className="field-note">
                      {squareFootage
                        ? `Currently ${Number(squareFootage).toLocaleString()} SF on this lease.`
                        : 'No size on file for this lease yet.'}
                    </span>
                  </label>
                </div>
                {form.sqft_quote && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>From the rider: “{form.sqft_quote}”</p>
                )}
                <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                  Applies to the <strong>whole year</strong> — the share isn’t pro-rated from the date the rider
                  takes effect, so this year’s CAM and tax are split at the new size throughout.
                </p>
              </EffectCard>

              <EffectCard on={form.fx_estimate} onToggle={toggle('fx_estimate')} title="Sets the CAM &amp; tax estimate"
                hint="What the tenant pays toward real-estate taxes and CAM during the year. Saved on the lease and billed from here on — the actual expenses only settle it at year-end ⚖ Reconcile.">
                <div className="field-grid">
                  <label className="form-field" style={{ marginBottom: 0 }}>
                    <span>CAM &amp; tax (annual $)</span>
                    <input className="text-input num" type="number" step="any" placeholder="e.g. 13200" value={form.est_camtax} onChange={set('est_camtax')} />
                    <PerMonth annual={form.est_camtax} sqft={squareFootage} />
                  </label>
                  <label className="form-field" style={{ marginBottom: 0 }}>
                    <span>Roof (annual $) — optional</span>
                    <input className="text-input num" type="number" step="any" placeholder="only if billed separately" value={form.est_roof} onChange={set('est_roof')} />
                    <PerMonth annual={form.est_roof} sqft={squareFootage} />
                  </label>
                </div>
                {form.est_quote && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>From the rider: “{form.est_quote}”</p>
                )}
              </EffectCard>

              {/* Grants free / reduced rent (abatement) */}
              <EffectCard on={form.fx_abatement} onToggle={toggle('fx_abatement')} title="Grants free / reduced rent"
                hint="A stretch of free or reduced BASE rent. Credited on the invoice & monthly tracker — CAM / taxes still apply; base rent itself is unchanged.">
                <div className="field-grid">
                  <label className="form-field" style={{ marginBottom: 0 }}><span>Starts</span><input className="text-input" type="date" value={form.ab_start} onChange={set('ab_start')} /></label>
                  <label className="form-field" style={{ marginBottom: 0 }}><span>For (months)</span><input className="text-input num" type="number" min="1" step="1" placeholder="e.g. 8" value={form.ab_months} onChange={set('ab_months')} /></label>
                  <label className="form-field" style={{ marginBottom: 0 }}><span>Type</span>
                    <select className="text-input" value={form.ab_kind} onChange={set('ab_kind')}>
                      <option value="free">Free (no base rent)</option>
                      <option value="percent">Reduced by %</option>
                      <option value="amount">Reduced to fixed $/mo</option>
                    </select>
                  </label>
                  {form.ab_kind !== 'free' && (
                    <label className="form-field" style={{ marginBottom: 0 }}><span>{form.ab_kind === 'percent' ? '% abated' : 'Reduced $/mo'}</span><input className="text-input num" type="number" step="any" value={form.ab_value} onChange={set('ab_value')} /></label>
                  )}
                </div>
                {(form._aiAbatements || []).length > 0 && (
                  <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>+ {form._aiAbatements.length} more abatement window{form._aiAbatements.length > 1 ? 's' : ''} the AI found will also be added.</p>
                )}
              </EffectCard>

              <div className="form-field" style={{ maxWidth: '100%', marginTop: 16 }}>
                <span>Summary / note</span>
                <input className="text-input" value={form.summary} onChange={set('summary')} placeholder="e.g. Extends term 5 years and adds a renewal option" />
              </div>

              {form._brief && (
                <details style={{ marginTop: 12 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 12.5 }}>Read the AI analyst's notes</summary>
                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    What the AI understood from reading the whole rider — including which clauses it merely quotes.
                    Check it against the cards above before saving.
                  </div>
                  <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 6, fontFamily: 'inherit' }}>{stripVerdicts(form._brief)}</pre>
                </details>
              )}

              <div className="row" style={{ marginTop: 14 }}>
                <button type="submit" disabled={!canSave || save.isPending}>{save.isPending ? 'Applying…' : 'Save & apply'}</button>
                <button type="button" className="secondary" onClick={() => resetAdd({ discard: true })}>Cancel</button>
              </div>
            </form>
          )}
          {err && <p className="note-msg danger" style={{ marginTop: 10 }}>{err}</p>}
          {/* ⚠ REQUIRED by useOptimisticRemove — a rider that reappears without a reason
              reads as the app putting it back by itself. */}
          <MutationError of={[remove]} />
        </div>
      )}

      {sending && (
        <SendForSignatureModal
          lease={lease}
          property={property}
          corp={corp}
          defaultPurpose="extension"
          onClose={() => setSending(false)}
          onSent={() => { /* the strip repaints off the invalidated ['envelopes'] key */ }}
        />
      )}
    </div>
  );
}

// Riders print these figures MONTHLY ("Real Estate Taxes & CAM: $1,100.00"), while the
// lease stores them annually — so the annual field states its own monthly back, and the
// $/SF rate beside it. Entering the annual keeps the figure exact: 12 × a rounded $/SF
// would land $4 off the rider.
function PerMonth({ annual, sqft }) {
  const n = Number(annual);
  if (annual === '' || annual == null || !isFinite(n) || n <= 0) return null;
  const sf = Number(sqft) || 0;
  return (
    <span className="est-preview" style={{ marginTop: 4 }}>
      = {money(n / 12)}/mo{sf > 0 ? ` · $${(n / sf).toFixed(2)}/SF/yr` : ''}
    </span>
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
