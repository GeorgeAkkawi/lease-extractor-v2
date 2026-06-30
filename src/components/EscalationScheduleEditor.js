import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listEscalations, createEscalation, deleteEscalation } from '../lib/api';
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

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['escalations', leaseId] });
    qc.invalidateQueries({ queryKey: ['propertyEscalations'] });
    qc.invalidateQueries({ queryKey: ['propertyTotals'] });
    qc.invalidateQueries({ queryKey: ['tenantShares'] });
    qc.invalidateQueries({ queryKey: ['alerts'] });
  };

  const remove = useMutation({
    mutationFn: (id) => deleteEscalation(id),
    onSuccess: refresh,
  });

  const priorRent = priorRentBefore(lease, escalations, date);
  const preview = value !== '' && date
    ? computeEscalatedRent(priorRent, { escalation_type: type, escalation_value: Number(value) })
    : null;

  const add = useMutation({
    mutationFn: () =>
      createEscalation({
        lease_id: leaseId,
        effective_date: date,
        escalation_type: type,
        escalation_value: type === 'manual' ? null : Number(value),
        new_base_rent: type === 'manual' ? Number(value) : computeEscalatedRent(priorRent, { escalation_type: type, escalation_value: Number(value) }),
        status: 'scheduled',
      }),
    onSuccess: () => { setValue(''); setDate(''); qc.invalidateQueries({ queryKey: ['escalations', leaseId] }); },
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
              {[...escalations].sort((a, b) => String(b.effective_date).localeCompare(String(a.effective_date))).map((e) => (
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
