import { useState } from 'react';

const EMPTY = {
  tenant_name: '',
  tenant_contact_name: '',
  tenant_email: '',
  tenant_email_2: '',
  square_footage: '',
  base_rent: '',
  lease_start: '',
  lease_termination_date: '',
  lease_terms: '',
  share_override_pct: '',
};

// Reusable lease form (create + edit). `extracted` is an optional map of
// field -> {confidence, source_quote} from AI extraction (confidence badges).
export default function LeaseForm({ initial, extracted, onSubmit, submitLabel = 'Save', busy }) {
  const [form, setForm] = useState({ ...EMPTY, ...stringify(initial) });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  function submit(e) {
    e.preventDefault();
    onSubmit({
      tenant_name: form.tenant_name.trim(),
      tenant_contact_name: form.tenant_contact_name.trim() || null,
      tenant_email: form.tenant_email.trim() || null,
      tenant_email_2: form.tenant_email_2.trim() || null,
      square_footage: numOrNull(form.square_footage),
      base_rent: numOrNull(form.base_rent),
      lease_start: form.lease_start || null,
      lease_termination_date: form.lease_termination_date || null,
      lease_terms: form.lease_terms || null,
      share_override_pct: form.share_override_pct === '' ? null : Number(form.share_override_pct) / 100,
    });
  }

  return (
    <form onSubmit={submit}>
      <div className="field-grid">
        <Field label="Tenant name" field="tenant_name" extracted={extracted}>
          <input className="text-input" value={form.tenant_name} onChange={set('tenant_name')} required />
        </Field>
        <Field label="Tenant contact name" field="tenant_contact_name" extracted={extracted}>
          <input className="text-input" value={form.tenant_contact_name} onChange={set('tenant_contact_name')} placeholder="e.g. Dana Lee" />
        </Field>
        <Field label="Tenant email (for sending)" field="tenant_email" extracted={extracted}>
          <input className="text-input" type="email" value={form.tenant_email} onChange={set('tenant_email')} placeholder="billing@tenant.com" />
        </Field>
        <Field label="Second email (optional)" field="tenant_email_2" extracted={extracted}>
          <input className="text-input" type="email" value={form.tenant_email_2} onChange={set('tenant_email_2')} placeholder="owner@tenant.com" />
        </Field>
        <Field label="Square footage" field="square_footage" extracted={extracted}>
          <input className="text-input num" type="number" step="any" value={form.square_footage} onChange={set('square_footage')} />
        </Field>
        <Field label="Base rent (annual $)" field="base_rent" extracted={extracted}>
          <input className="text-input num" type="number" step="any" value={form.base_rent} onChange={set('base_rent')} />
        </Field>
        <Field label="Lease start" field="lease_start" extracted={extracted}>
          <input className="text-input" type="date" value={form.lease_start || ''} onChange={set('lease_start')} />
        </Field>
        <Field label="Lease termination" field="lease_termination_date" extracted={extracted}>
          <input className="text-input" type="date" value={form.lease_termination_date || ''} onChange={set('lease_termination_date')} />
        </Field>
        <Field label="Tax/CAM share override (%)" field="share_override_pct" extracted={extracted} hint="Blank = pro-rata by SF">
          <input className="text-input num" type="number" step="any" placeholder="auto (pro-rata)" value={form.share_override_pct} onChange={set('share_override_pct')} />
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

function Field({ label, field, extracted, hint, children }) {
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
  return {
    ...obj,
    share_override_pct: obj.share_override_pct == null || obj.share_override_pct === '' ? '' : Number(obj.share_override_pct) * 100,
  };
}

function numOrNull(v) {
  return v === '' || v == null ? null : Number(v);
}
