import { useState } from 'react';
import { addMonths } from '../lib/renewals';

const EMPTY = {
  tenant_name: '',
  tenant_contact_name: '',
  tenant_email: '',
  premises_address: '',
  square_footage: '',
  base_rent: '',
  lease_start: '',
  lease_termination_date: '',
  lease_terms: '',
  share_override_pct: '',
  est_cam_tax: '',
};

// Reusable lease form (create + edit). `extracted` is an optional map of
// field -> {confidence, source_quote} from AI extraction (confidence badges).
export default function LeaseForm({ initial, extracted, onSubmit, submitLabel = 'Save', busy }) {
  const [form, setForm] = useState({ ...EMPTY, ...stringify(initial) });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  // The lease may state its term as a fixed length ("five years and eight months" → 68
  // months) even when it prints no end date (commencement is often a formula). When the
  // user confirms the Lease start, suggest a termination date from that stated term — the
  // term runs through the day before the start + term_months anniversary. Editable, and
  // never overwrites a date the user (or the extraction) already provided.
  const termMonths = Number(extracted?.term_months?.value) || 0;
  // Many leases print no commencement date, so the review screen pre-fills Lease start with
  // the signing / "entered into as of" date. Show a neutral heads-up (derived, so it appears
  // on load) telling the user where the date came from, so they confirm or adjust it.
  const executionDate = extracted?.execution_date?.value || null;
  const startFromSigning = !!(executionDate && form.lease_start && form.lease_start === executionDate);
  const onStartChange = (e) => {
    const startVal = e.target.value;
    setForm((f) => {
      const next = { ...f, lease_start: startVal };
      if (startVal && termMonths > 0 && !f.lease_termination_date) {
        const after = addMonths(startVal, termMonths); // first day AFTER the term
        if (after) {
          const d = new Date(after + 'T12:00:00');
          d.setDate(d.getDate() - 1);
          next.lease_termination_date = d.toISOString().slice(0, 10);
        }
      }
      return next;
    });
  };

  function submit(e) {
    e.preventDefault();
    onSubmit({
      tenant_name: form.tenant_name.trim(),
      tenant_contact_name: form.tenant_contact_name.trim() || null,
      tenant_email: form.tenant_email.trim() || null,
      premises_address: form.premises_address.trim() || null,
      square_footage: numOrNull(form.square_footage),
      base_rent: numOrNull(form.base_rent),
      lease_start: form.lease_start || null,
      lease_termination_date: form.lease_termination_date || null,
      lease_terms: form.lease_terms || null,
      share_override_pct: form.share_override_pct === '' ? null : Number(form.share_override_pct) / 100,
      // ONE combined CAM & tax estimate → the combined convention (whole figure in
      // est_cam_annual, est_tax_annual = 0). Stamp est_confirmed_year so a brand-new
      // lease's estimate reads as confirmed, not "carried over".
      ...combinedEst(estAnnual(form.est_cam_tax)),
    });
  }

  // The combined-estimate payload for one entered annual figure (null = bill actuals).
  function combinedEst(annual) {
    return {
      est_cam_annual: annual,
      est_tax_annual: annual == null ? null : 0,
      est_confirmed_year: annual == null ? null : new Date().getFullYear(),
    };
  }

  // Estimates are quoted in $/SF of the space above (per George); stored annualized.
  // With no square footage typed, the figure is taken as the annual $ directly.
  function estAnnual(v) {
    const n = numOrNull(v);
    // Blank OR zero/negative → no estimate (bill actuals); never store a 0.
    if (!(n > 0)) return null;
    const sqft = numOrNull(form.square_footage);
    return sqft > 0 ? Math.round(n * sqft * 100) / 100 : n;
  }

  return (
    <form onSubmit={submit}>
      <div className="field-grid">
        <Field label="Tenant name" field="tenant_name" extracted={extracted} hint="the business / company on the lease">
          <input className="text-input" value={form.tenant_name} onChange={set('tenant_name')} placeholder="e.g. D & D Dental, LLC" required />
        </Field>
        <Field label="Tenant contact name" field="tenant_contact_name" extracted={extracted} hint="person(s) who run it — the signer or owner">
          <input className="text-input" value={form.tenant_contact_name} onChange={set('tenant_contact_name')} placeholder="e.g. Dr. Ahmed Hegazy" />
        </Field>
        <Field label="Tenant email (for sending)" field="tenant_email" extracted={extracted}>
          <input className="text-input" type="email" value={form.tenant_email} onChange={set('tenant_email')} placeholder="billing@tenant.com" />
        </Field>
        <Field label="Address" field="premises_address" extracted={extracted} hint="the leased unit's street address — used for sorting">
          <input className="text-input" value={form.premises_address} onChange={set('premises_address')} placeholder="e.g. 241 W 116th St — Unit 4" />
        </Field>
        <Field label="Square footage" field="square_footage" extracted={extracted}>
          <input className="text-input num" type="number" step="any" value={form.square_footage} onChange={set('square_footage')} />
        </Field>
        <Field label="Base rent (annual $)" field="base_rent" extracted={extracted}>
          <input className="text-input num" type="number" step="any" value={form.base_rent} onChange={set('base_rent')} />
        </Field>
        <Field label="Lease start" field="lease_start" extracted={extracted}
          hint={startFromSigning ? 'Pre-filled from the signing date (“entered into as of”) — this lease prints no separate start date. Change it if the term actually began later.' : undefined}>
          <input className="text-input" type="date" value={form.lease_start || ''} onChange={onStartChange} />
        </Field>
        <Field label="Lease termination" field="lease_termination_date" extracted={extracted} hint={termMonths ? `suggested from the stated term — ${termMonths} months; editable` : undefined}>
          <input className="text-input" type="date" value={form.lease_termination_date || ''} onChange={set('lease_termination_date')} />
        </Field>
        <Field label="Tax/CAM share override (%)" field="share_override_pct" extracted={extracted} hint="Blank = pro-rata by SF">
          <input className="text-input num" type="number" step="any" placeholder="auto (pro-rata)" value={form.share_override_pct} onChange={set('share_override_pct')} />
        </Field>
        <Field label="Est. CAM & tax ($/SF/yr)" field="est_cam_tax" extracted={extracted} hint="CAM + tax combined — what the tenant pays during the year, per SF of the space above (saved × SF as the annual estimate); reconciled against actuals at year end. Blank = bill actuals.">
          <input className="text-input num" type="number" step="any" placeholder="blank = bill actuals" value={form.est_cam_tax} onChange={set('est_cam_tax')} />
        </Field>
      </div>
      <div className="form-field" style={{ maxWidth: '100%', marginTop: 16 }}>
        <span>Lease terms / notes</span>
        <textarea className="text-input" rows={3} value={form.lease_terms || ''} onChange={set('lease_terms')} />
      </div>
      <button type="submit" disabled={busy} style={{ marginTop: 8 }}>{busy ? 'Saving…' : submitLabel}</button>
    </form>
  );
}

function Field({ label, field, extracted, hint, warn, children }) {
  const meta = extracted?.[field];
  return (
    <div className="form-field" style={{ maxWidth: '100%', marginBottom: 0 }}>
      {/* Reserve a constant label-row height so the AI badge (taller than the label
          text) never bumps this field's input box below its un-badged neighbours.
          Keep labels short (one line) for the same reason — long explanations go in
          `hint` below the input, not in the label. */}
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 20 }}>
        {label}
        {meta && <ConfidenceBadge meta={meta} />}
      </span>
      {children}
      {warn && <span className="field-note" style={{ color: 'var(--gold)', fontWeight: 600 }}>{warn}</span>}
      {hint && <span className="field-note">{hint}</span>}
      {meta?.source_quote && (
        <span className="muted" style={{ fontSize: 11, textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
          📄 “{meta.source_quote}”{meta.page != null ? ` (p.${meta.page})` : ''}
        </span>
      )}
    </div>
  );
}

function ConfidenceBadge({ meta }) {
  if (meta.confidence == null) return null;
  const c = Number(meta.confidence);
  const cls = c >= 0.8 ? 'info' : 'warn';
  return <span className={`badge ${cls}`}>{c >= 0.8 ? 'AI' : 'review AI'}</span>;
}

function stringify(obj) {
  if (!obj) return {};
  // Accept a pre-combined est_cam_tax (from initialFromExtraction) or, for safety, sum
  // legacy split est_cam/est_tax rates into the one combined field.
  const combined =
    obj.est_cam_tax != null && obj.est_cam_tax !== ''
      ? obj.est_cam_tax
      : (Number(obj.est_cam_annual) || 0) + (Number(obj.est_tax_annual) || 0) || '';
  return {
    ...obj,
    est_cam_tax: combined === 0 ? '' : combined,
    share_override_pct: obj.share_override_pct == null || obj.share_override_pct === '' ? '' : Number(obj.share_override_pct) * 100,
  };
}

function numOrNull(v) {
  return v === '' || v == null ? null : Number(v);
}
