import InsuranceVault from './InsuranceVault';
import { useModalA11y } from './modalA11y';

// The landlord's building policy for one property, opened from the property card.
export default function PropertyInsuranceModal({ property, onClose }) {
  // Escape closes; focus is trapped in the dialog and returned on close.
  const modalRef = useModalA11y(onClose);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{property.name} — landlord insurance</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }}>
            The building's insurance policy for this property. Add it once, then ask anything about
            coverage, additional insured, or expiry.
          </p>
          <InsuranceVault party="landlord" propertyId={property.id} />
        </div>
      </div>
    </div>
  );
}
