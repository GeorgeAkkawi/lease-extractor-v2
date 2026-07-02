import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listEscalations, createEscalation, deleteEscalation, backfillLeaseToToday } from '../lib/api';
import { computeEscalatedRent, priorRentBefore } from '../lib/escalations';
import { money, fmtDate } from '../lib/format';

// Lists, adds & removes rent escalations. New rent is computed BY CODE (no AI).
// New escalations are 'scheduled' until accepted on the recommendation card.
// Delete is here so an AI mis-read can be corrected (remove the wrong row).
export default function EscalationScheduleEditor({ lease }) {
  const qc = useQueryClient();
  const leaseId = lease.id;
  const { data: escalations = [] } = useQuery({ queryKey: ['escalations', leaseId], queryFn: () => listEscalations(leaseId) });

  const [type, setType] = useState('percent');
  const [value, setValue] = useState('');
  const [date, setDate] = useState('');
  const [showAll, setShowAll] = useState(false);

  // A long lease can carry 15-20 dated steps; that's a lot of scrolling. When there are
  // many, collapse to the slice that matters NOW — the next few upcoming steps + the few
  // most recent — and let the landlord expand to the full schedule on demand.
  const COLLAPSE_OVER = 8;
  const sortedEsc = [...escalations].sort((a, b) => String(b.effective_date).localeCompare(String(a.effective_date)));
  const pad = (n) => String(n).padStart(2, '0');
  const nowD = new Date();
  const todayIso = `${nowD.getFullYear()}-${pad(nowD.getMonth() + 1)}-${pad(nowD.getDate())}`;
  const collapsible = sortedEsc.length > COLLAPSE_OVER && !showAll;
  let visibleEsc = sortedEsc;
  let hiddenFuture = 0;
  let hiddenPast = 0;
  if (collapsible) {
    const future = sortedEsc.filter((e) => String(e.effective_date) > todayIso); // descending: far-future first
    const past = sortedEsc.filter((e) => String(e.effective_date) <= todayIso);  // descending: most-recent first
    const visFuture = future.slice(-3); // the 3 nearest upcoming
    const visPast = past.slice(0, 3);   // the 3 most recent
    visibleEsc = [...visFuture, ...visPast];
    hiddenFuture = future.length - visFuture.length;
    hiddenPast = past.length - visPast.length;
  }

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['escalations', leaseId] });
    qc.invalidateQueries({ queryKey: ['lease', leaseId] }); // base rent up top may have changed
    qc.invalidateQueries({ queryKey: ['propertyEscalations'] });
    qc.invalidateQueries({ queryKey: ['propertyTotals'] });
    qc.invalidateQueries({ queryKey: ['tenantShares'] });
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['corpRollups'] }); // escalations change current rent → corp revenue
  };

  // Adding or removing a step can change the rent in effect TODAY — re-resolve the
  // lease's current base rent so the header, financials, and this table always agree
  // (a past-dated step takes effect immediately instead of waiting for a reload).
  const remove = useMutation({
    mutationFn: async (id) => { await deleteEscalation(id); await backfillLeaseToToday(leaseId); },
    onSuccess: refresh,
  });

  const priorRent = priorRentBefore(lease, escalations, date);
  const preview = value !== '' && date
    ? computeEscalatedRent(priorRent, { escalation_type: type, escalation_value: Number(value) })
    : null;

  const add = useMutation({
    mutationFn: async () => {
      await createEscalation({
        lease_id: leaseId,
        effective_date: date,
        escalation_type: type,
        escalation_value: type === 'manual' ? null : Number(value),
        new_base_rent: type === 'manual' ? Number(value) : computeEscalatedRent(priorRent, { escalation_type: type, escalation_value: Number(value) }),
        status: 'scheduled',
      });
      // A step dated today or earlier takes effect now; backfill applies it and updates
      // the lease's base rent (future-dated steps stay scheduled until their date).
      await backfillLeaseToToday(leaseId);
    },
    onSuccess: () => { setValue(''); setDate(''); refresh(); },
  });

  return (
    <div>
      {escalations.length === 0 ? (
        <p className="empty-line muted">No escalations scheduled.</p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table style={{ minWidth: 0 }}>
            <thead><tr><th>Effective</th><th>Type</th><th className="num">Value</th><th className="num">New base rent</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {visibleEsc.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDate(e.effective_date)}</td>
                  <td>{e.escalation_type}</td>
                  <td className="num">{e.escalation_type === 'percent' ? `${e.escalation_value}%` : e.escalation_type === 'fixed' ? money(e.escalation_value) : '—'}</td>
                  <td className="num">{money(e.new_base_rent)}</td>
                  <td><span className={`badge ${e.status === 'applied' ? 'good' : 'warn'}`}>{e.status}</span></td>
                  <td className="num">
                    <button
                      type="button"
                      className="icon-btn danger-btn"
                      title="Delete this escalation"
                      disabled={remove.isPending}
                      onClick={() => { if (window.confirm('Delete this escalation? This removes it from the lease.')) remove.mutate(e.id); }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {escalations.length > COLLAPSE_OVER && (
        <div className="row" style={{ alignItems: 'center', gap: 10, marginTop: -6, marginBottom: 16 }}>
          <button type="button" className="ghost" style={{ padding: '3px 10px', fontSize: 12 }} onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show fewer' : `Show all ${escalations.length} steps`}
          </button>
          {collapsible && (hiddenPast > 0 || hiddenFuture > 0) && (
            <span className="muted" style={{ fontSize: 12 }}>
              {[hiddenPast > 0 ? `${hiddenPast} earlier` : null, hiddenFuture > 0 ? `${hiddenFuture} later` : null].filter(Boolean).join(' · ')} step{hiddenPast + hiddenFuture > 1 ? 's' : ''} hidden
            </span>
          )}
        </div>
      )}

      <form className="row" onSubmit={(e) => { e.preventDefault(); if (date && value !== '') add.mutate(); }} style={{ alignItems: 'flex-end' }}>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 150 }}>
          <span>Type</span>
          <select className="text-input" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="percent">Percent</option>
            <option value="fixed">Fixed $ step</option>
            <option value="cpi">CPI — enter resolved %</option>
            <option value="manual">Manual new rent</option>
          </select>
        </label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 150 }}>
          <span>{type === 'manual' ? 'New rent' : type === 'fixed' ? '$ amount' : '%'}</span>
          <input className="text-input num" type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 170 }}>
          <span>Effective date</span>
          <input className="text-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button type="submit" disabled={!date || value === '' || add.isPending}>+ Add escalation</button>
        {preview != null && <span className="muted" style={{ alignSelf: 'flex-end' }}>→ {money(priorRent)} to <strong>{money(preview)}</strong></span>}
      </form>
      {type === 'cpi' && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          CPI isn't pulled automatically — enter the <strong>already-resolved</strong> percentage (the CPI adjustment you've
          calculated for this effective date). It's applied just like a percent step.
        </p>
      )}
    </div>
  );
}
