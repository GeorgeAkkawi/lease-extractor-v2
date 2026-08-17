import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listAbatements, createAbatement, deleteAbatement, resyncLeaseBilling } from '../lib/api';
import { settleBillingChange } from '../lib/invalidate';
import { abatementEnd, abatementMonthCount, abatementKindLabel } from '../lib/abatement';
import { money, fmtDate } from '../lib/format';
import MutationError from './MutationError';
import { useConfirm } from './ConfirmDialog';
import { useOptimisticRemove } from './useOptimisticRemove';

// Lists, adds & removes rent-abatement windows (free / reduced BASE rent for a stretch
// of the term). The base rent itself is never changed — a window just credits those
// months on the invoice, receivables, and the monthly tracker. CAM / taxes still apply.
// Mirrors EscalationScheduleEditor / RenewalOptionsEditor.
export default function AbatementEditor({ lease }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const leaseId = lease.id;
  const { data: abatements = [] } = useQuery({ queryKey: ['abatements', leaseId], queryFn: () => listAbatements(leaseId) });

  const [start, setStart] = useState(lease.lease_start || '');
  const [months, setMonths] = useState('');
  const [kind, setKind] = useState('free');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');

  const propId = lease.property_id || null;
  const fy = new Date().getFullYear();

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['abatements', leaseId] });
    settleBillingChange(qc, { propertyId: propId, leaseId, year: fy });
  };
  // A free / reduced window credits those months, so the year's stored invoice and its
  // system-marked paid months have to move with it — the Ledger and the breakdown
  // rebuild themselves from the live windows, the invoice does not.
  const carryThrough = () => resyncLeaseBilling(leaseId, propId, fy);

  const end = start && months ? abatementEnd(start, Number(months)) : null;
  const monthlyBase = (Number(lease.base_rent) || 0) / 12;
  // Preview the base still owed per month during the window.
  const previewOwed = kind === 'free' ? 0
    : kind === 'percent' ? Math.max(0, monthlyBase * (1 - (Number(value) || 0) / 100))
    : kind === 'amount' ? Math.min(monthlyBase, Math.max(0, Number(value) || 0))
    : monthlyBase;

  const add = useMutation({
    mutationFn: async () => {
      await createAbatement({
        lease_id: leaseId,
        start_date: start,
        end_date: end,
        kind,
        value: kind === 'free' ? null : (value === '' ? null : Number(value)),
        note: note || null,
      });
      await carryThrough();
    },
    onSuccess: () => { setMonths(''); setValue(''); setNote(''); refresh(); },
  });

  const remove = useOptimisticRemove({
    queryKey: ['abatements', leaseId],
    idOf: (id) => id,
    mutationFn: async (id) => { await deleteAbatement(id); await carryThrough(); },
    onSuccess: refresh,
  });

  const valueLabel = kind === 'percent' ? '% abated' : kind === 'amount' ? 'Reduced $/mo' : '';

  return (
    <div>
      <MutationError of={[add, remove]} />
      {abatements.length === 0 ? (
        <p className="empty-line muted">No rent abatement on file.</p>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table style={{ minWidth: 0 }}>
            <thead><tr><th>Period</th><th>Months</th><th>Type</th><th className="num">Base owed / mo</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {[...abatements].sort((a, b) => String(a.start_date).localeCompare(String(b.start_date))).map((a) => {
                const owed = a.kind === 'free' ? 0
                  : a.kind === 'percent' ? Math.max(0, monthlyBase * (1 - (Number(a.value) || 0) / 100))
                  : Math.min(monthlyBase, Math.max(0, Number(a.value) || 0));
                return (
                  <tr key={a.id}>
                    <td>{fmtDate(a.start_date)} – {fmtDate(a.end_date)}</td>
                    <td>{abatementMonthCount(a) ?? '—'}</td>
                    <td>{abatementKindLabel(a)}</td>
                    <td className="num">{a.kind === 'free' ? <span className="badge good">Free</span> : money(owed)}</td>
                    <td className="muted" style={{ fontSize: 12.5 }}>{a.note || '—'}</td>
                    <td className="num">
                      <button
                        type="button"
                        className="icon-btn danger-btn"
                        title="Delete this abatement"
                        disabled={remove.isPending}
                        onClick={async () => {
                          if (await askConfirm({
                            title: 'Delete rent abatement?',
                            message: 'Delete this rent abatement?',
                            implications: [
                              'The credited (free / reduced) months go back to full rent.',
                              'Invoices and the ledger re-price accordingly.',
                              'This can’t be undone.',
                            ],
                            confirmLabel: 'Delete',
                          })) remove.mutate(a.id);
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <form className="row" onSubmit={(e) => { e.preventDefault(); if (start && months && end) add.mutate(); }} style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 170 }}>
          <span>Starts</span>
          <input className="text-input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 120 }}>
          <span>For (months)</span>
          <input className="text-input num" type="number" min="1" step="1" placeholder="e.g. 8" value={months} onChange={(e) => setMonths(e.target.value)} />
        </label>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 160 }}>
          <span>Type</span>
          <select className="text-input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="free">Free (no base rent)</option>
            <option value="percent">Reduced by %</option>
            <option value="amount">Reduced to fixed $/mo</option>
          </select>
        </label>
        {kind !== 'free' && (
          <label className="form-field" style={{ marginBottom: 0, maxWidth: 140 }}>
            <span>{valueLabel}</span>
            <input className="text-input num" type="number" step="any" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        )}
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 220 }}>
          <span>Note (optional)</span>
          <input className="text-input" placeholder="e.g. build-out abatement" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="submit" disabled={!start || !months || !end || add.isPending}>+ Add abatement</button>
      </form>
      {start && months && end && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
          → {months} month{Number(months) === 1 ? '' : 's'} ({fmtDate(start)} – {fmtDate(end)}) ·
          {' '}base rent {previewOwed > 0 ? `reduced to ${money(previewOwed)}/mo` : 'free'} during the window
          {monthlyBase > 0 ? ` (full base ${money(monthlyBase)}/mo)` : ''}.
        </p>
      )}
    </div>
  );
}
