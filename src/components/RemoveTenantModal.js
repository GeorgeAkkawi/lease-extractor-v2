import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { archiveLease } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useModalA11y } from './modalA11y';

const today = () => new Date().toISOString().slice(0, 10);

// Removes a tenant but keeps the lease in History's "Expired & renewed" log with
// an outcome + note, so the landlord retains a full record of past tenants.
export default function RemoveTenantModal({ lease, onClose, onDone }) {
  // Escape closes; focus is trapped in the dialog and returned on close.
  const modalRef = useModalA11y(onClose);
  const [status, setStatus] = useState('Terminated');
  const [endDate, setEndDate] = useState(today());
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);

  // Auto-suggest a note from the outcome + date until the user edits it.
  const suggested = `${lease.tenant_name} ${status.toLowerCase()} on ${fmtDate(endDate)}.`;
  const noteValue = touched ? note : suggested;

  const remove = useMutation({
    mutationFn: () => archiveLease(lease, { status, note: noteValue, endDate }),
    onSuccess: onDone,
  });

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 540 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Remove {lease.tenant_name}</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            This ends the active lease but keeps it in <strong>History → Expired &amp; renewed leases</strong>, so you
            always have a complete record of who has occupied the space. The tenant's invoices and recorded
            payments are saved with that archived record and removed from active receivables.
          </p>
          <label className="form-field" style={{ maxWidth: '100%' }}>
            <span>Outcome</span>
            <select className="text-input" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="Terminated">Terminated</option>
              <option value="Vacated">Vacated (lease ended / did not renew)</option>
            </select>
          </label>
          <label className="form-field" style={{ maxWidth: 220 }}>
            <span>Effective date</span>
            <input className="text-input" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
          <label className="form-field" style={{ maxWidth: '100%', marginBottom: 0 }}>
            <span>Note (kept in the archive)</span>
            <input className="text-input" value={noteValue} onChange={(e) => { setTouched(true); setNote(e.target.value); }} />
          </label>
        </div>
        <div className="modal-foot">
          <div className="modal-actions">
            <span className="muted">{remove.isError ? 'Could not remove' : 'Saved to History, then removed from active leases'}</span>
            <div className="row">
              <button className="secondary" onClick={onClose}>Cancel</button>
              <button className="danger-solid" onClick={() => remove.mutate()} disabled={remove.isPending}>
                {remove.isPending ? 'Removing…' : 'Remove tenant'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
