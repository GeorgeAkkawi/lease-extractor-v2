import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTenantShares } from '../lib/api';
import { downloadReconciliationXlsx } from '../lib/reconciliationExcel';
import { useModalA11y } from './modalA11y';
import StaleBuildNotice from './StaleBuildNotice';

// Pick which tenants to export, then download a year-end reconciliation workbook
// (one tab per tenant, itemized actual vs estimated CAM & tax). No AI, no charge —
// pure formatting over the live figures the Financials breakdown already shows.
export default function ExportReconciliationModal({ propertyId, year, propertyName, onClose }) {
  const modalRef = useModalA11y(onClose);
  const { data: shares = [], isLoading } = useQuery({
    queryKey: ['tenantShares', propertyId, year],
    queryFn: () => getTenantShares(propertyId, year),
  });
  // Default: every tenant selected.
  const [picked, setPicked] = useState(null); // null = "all", else a Set of lease ids
  const [busy, setBusy] = useState(false);
  // The ERROR OBJECT, not its message — StaleBuildNotice needs to know which kind it is.
  const [err, setErr] = useState(null);

  const isOn = (id) => (picked ? picked.has(id) : true);
  const toggle = (id) => {
    setPicked((prev) => {
      const next = new Set(prev ?? shares.map((s) => s.lease_id));
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectedIds = shares.filter((s) => isOn(s.lease_id)).map((s) => s.lease_id);

  async function download() {
    setErr(null); setBusy(true);
    try {
      await downloadReconciliationXlsx({ propertyId, year, leaseIds: selectedIds });
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Export reconciliation · {propertyName || 'property'} · FY {year}</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
            One Excel tab per tenant — itemized actual vs estimated CAM &amp; tax, a summary, and a lease-terms
            reference. Ready to send to tenants or keep for your records.
          </p>
          {isLoading ? (
            <p className="muted">Loading tenants…</p>
          ) : shares.length === 0 ? (
            <p className="muted">No tenants on this property for FY {year}.</p>
          ) : (
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--hair)', borderRadius: 8, padding: 8 }}>
              {shares.map((s) => (
                <label key={s.lease_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px' }}>
                  <input type="checkbox" checked={isOn(s.lease_id)} onChange={() => toggle(s.lease_id)} />
                  <span>{s.tenant_name}</span>
                </label>
              ))}
            </div>
          )}
          <StaleBuildNotice error={err} />
        </div>
        <div className="modal-foot">
          <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 10 }}>
            <button className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button onClick={download} disabled={busy || selectedIds.length === 0}>
              {busy ? 'Building…' : `⬇ Download Excel (${selectedIds.length})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
