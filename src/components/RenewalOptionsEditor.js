import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listRenewals, createRenewal, deleteRenewal, confirmRenewal, declineRenewal } from '../lib/api';
import { money, fmtDate } from '../lib/format';

// Badge tone + label for an option's lifecycle status.
function statusBadge(status) {
  if (status === 'applied') return { cls: 'good', label: 'Applied' };
  if (status === 'declined') return { cls: 'danger', label: 'Declined' };
  return { cls: 'warn', label: 'Pending' };
}

// The rent shown for an option: an explicit new_rent, else the computed first
// renewal-year rent from the annual % (prior rent × (1+pct%)), else a dash.
function renewalRent(r, lease) {
  if (r.new_rent != null) return money(r.new_rent);
  const pct = Number(r.annual_escalation_pct) || 0;
  if (pct > 0) {
    const base = Number(lease?.base_rent) || 0;
    const firstYr = base > 0 ? Math.round(base * (1 + pct / 100)) : null;
    return firstYr ? `≈ ${money(firstYr)} · +${pct}%/yr` : `+${pct}%/yr`;
  }
  return '—';
}

export default function RenewalOptionsEditor({ leaseId, lease }) {
  const qc = useQueryClient();
  const { data: renewals = [] } = useQuery({ queryKey: ['renewals', leaseId], queryFn: () => listRenewals(leaseId) });
  const [form, setForm] = useState({ option_label: '', notice_by_date: '', term_months: '', new_rent: '', annual_escalation_pct: '', notes: '' });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['renewals', leaseId] });
    qc.invalidateQueries({ queryKey: ['alerts'] });
  };
  // Confirming/declining a renewal changes the lease term + rent, so refresh those too.
  const refreshAll = () => {
    ['renewals', 'alerts', 'lease', 'leases', 'escalations', 'expiredLeases', 'notifications', 'searchIndex']
      .forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  };
  const remove = useMutation({ mutationFn: (id) => deleteRenewal(id), onSuccess: refresh });
  const confirm = useMutation({ mutationFn: (id) => confirmRenewal(id), onSuccess: refreshAll });
  const decline = useMutation({ mutationFn: (id) => declineRenewal(id), onSuccess: refreshAll });
  const acting = confirm.isPending || decline.isPending;

  const add = useMutation({
    mutationFn: () =>
      createRenewal({
        lease_id: leaseId,
        option_label: form.option_label || null,
        notice_by_date: form.notice_by_date || null,
        term_months: form.term_months === '' ? null : Number(form.term_months),
        new_rent: form.new_rent === '' ? null : Number(form.new_rent),
        annual_escalation_pct: form.annual_escalation_pct === '' ? null : Number(form.annual_escalation_pct),
        notes: form.notes || null,
      }),
    onSuccess: () => { setForm({ option_label: '', notice_by_date: '', term_months: '', new_rent: '', annual_escalation_pct: '', notes: '' }); qc.invalidateQueries({ queryKey: ['renewals', leaseId] }); },
  });

  return (
    <div>
      {renewals.length === 0 ? (
        <p className="empty-line muted">No renewal options.</p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table style={{ minWidth: 0 }}>
            <thead><tr><th>Option</th><th>Notice by</th><th className="num">Term (mo)</th><th className="num">New rent</th><th>Status</th><th>Decision</th><th></th></tr></thead>
            <tbody>
              {renewals.map((r) => { const badge = statusBadge(r.status); return (
                <tr key={r.id}>
                  <td>{r.option_label || '—'}</td>
                  <td>{fmtDate(r.notice_by_date)}</td>
                  <td className="num">{r.term_months ?? '—'}</td>
                  <td className="num">{renewalRent(r, lease)}</td>
                  <td><span className={`badge ${badge.cls}`}>{badge.label}</span></td>
                  <td>
                    {r.status === 'pending' ? (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button type="button" className="secondary" style={{ padding: '3px 8px', fontSize: 12 }} disabled={acting}
                          title="Tenant is exercising this option — apply it (extends the term + new rent)"
                          onClick={() => { if (window.confirm('Confirm the tenant is renewing? This extends the term and applies the new rent.')) confirm.mutate(r.id); }}>
                          Renew
                        </button>
                        <button type="button" className="ghost" style={{ padding: '3px 8px', fontSize: 12 }} disabled={acting}
                          title="Tenant is not exercising this option"
                          onClick={() => { if (window.confirm('Mark this option as not being exercised?')) decline.mutate(r.id); }}>
                          Not renewing
                        </button>
                      </div>
                    ) : (
                      <span className="muted" style={{ fontSize: 12 }}>{r.notes || '—'}</span>
                    )}
                  </td>
                  <td className="num">
                    <button
                      type="button"
                      className="icon-btn danger-btn"
                      title="Delete this renewal option"
                      disabled={remove.isPending}
                      onClick={() => { if (window.confirm('Delete this renewal option?')) remove.mutate(r.id); }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      )}

      <form className="row" onSubmit={(e) => { e.preventDefault(); add.mutate(); }} style={{ alignItems: 'flex-end' }}>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 150 }}><span>Label</span><input className="text-input" placeholder="Option 1" value={form.option_label} onChange={set('option_label')} /></label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 160 }}><span>Notice by</span><input className="text-input" type="date" value={form.notice_by_date} onChange={set('notice_by_date')} /></label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 120 }}><span>Term (mo)</span><input className="text-input num" type="number" value={form.term_months} onChange={set('term_months')} /></label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 130 }}><span>New rent</span><input className="text-input num" type="number" step="any" placeholder="flat $/yr" value={form.new_rent} onChange={set('new_rent')} /></label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 120 }}><span>or +%/yr</span><input className="text-input num" type="number" step="any" placeholder="e.g. 5" value={form.annual_escalation_pct} onChange={set('annual_escalation_pct')} /></label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 170 }}><span>Notes</span><input className="text-input" value={form.notes} onChange={set('notes')} /></label>
        <button type="submit" disabled={add.isPending}>+ Add option</button>
      </form>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        Use <strong>New rent</strong> for a flat option rent, or <strong>+%/yr</strong> for an annual increase (e.g. "5% annual increase").
        When the option is exercised, a +%/yr option auto-creates one rent step per year of the term. Notice-by is only set if the lease states a deadline.
      </p>
    </div>
  );
}
