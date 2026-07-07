import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateCorporation } from '../lib/api';
import { useModalA11y } from './modalA11y';

// Edits one corporation's identity — its name plus the address/email/phone used
// as the letterhead + signature on the tenant emails & invoices it sends. Each
// corporation can therefore correspond to a different sending email.
export default function CorporationProfileModal({ corp, onClose }) {
  // Escape closes; focus is trapped in the dialog and returned on close.
  const modalRef = useModalA11y(onClose);
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: corp.name || '',
    address: corp.address || '',
    contact_email: corp.contact_email || '',
    contact_phone: corp.contact_phone || '',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => updateCorporation(corp.id, form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['corporations'] });
      qc.invalidateQueries({ queryKey: ['corporation', corp.id] });
      onClose();
    },
  });

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{corp.name} — business profile</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            This corporation's letterhead and signature on the emails and invoices it sends.
            Use a different contact email per corporation to send under different identities.
          </p>
          <label className="form-field" style={{ maxWidth: '100%' }}>
            <span>Corporation / company name</span>
            <input className="text-input" value={form.name} onChange={set('name')} placeholder="Acme Holdings" required />
          </label>
          <label className="form-field" style={{ maxWidth: '100%' }}>
            <span>Address</span>
            <input className="text-input" value={form.address} onChange={set('address')} placeholder="100 Maple St, Suite 500, Springfield, IL" />
          </label>
          <label className="form-field" style={{ maxWidth: '100%' }}>
            <span>Contact / sending email</span>
            <input className="text-input" type="email" value={form.contact_email} onChange={set('contact_email')} placeholder="leasing@acme.com" />
          </label>
          <label className="form-field" style={{ maxWidth: '100%', marginBottom: 0 }}>
            <span>Contact phone</span>
            <input className="text-input" value={form.contact_phone} onChange={set('contact_phone')} placeholder="(555) 240-1180" />
          </label>
        </div>
        <div className="modal-foot">
          <div className="modal-actions">
            <span className="muted">{save.isError ? 'Could not save' : 'Used on this corporation’s tenant emails'}</span>
            <div className="row">
              <button className="secondary" onClick={onClose}>Cancel</button>
              <button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim()}>{save.isPending ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
