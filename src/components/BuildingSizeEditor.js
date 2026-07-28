import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateProperty, resyncPropertyBilling } from '../lib/api';
import { settleBillingChange } from '../lib/invalidate';
import MutationError from './MutationError';
import UndoStrip from './UndoStrip';

// Edit a property's building size after creation (drives vacancy & occupancy).
export default function BuildingSizeEditor({ propId, buildingSf, year }) {
  const qc = useQueryClient();
  const [val, setVal] = useState('');
  const [saved, setSaved] = useState(null); // post-save ↩ Undo (restores the prior size)
  useEffect(() => { setVal(buildingSf ?? ''); }, [buildingSf]);
  const fy = year || new Date().getFullYear();

  const invalidate = () => {
    // The building size is the tax/CAM/roof divisor, so re-divide every downstream
    // figure the moment it's saved: rate cards, per-tenant breakdown, invoices.
    qc.invalidateQueries({ queryKey: ['property', propId] });
    qc.invalidateQueries({ queryKey: ['properties'] });
    settleBillingChange(qc, { propertyId: propId, year: fy });
  };

  // Changing the divisor re-splits EVERY tenant's share, so every live annual invoice
  // on the property follows — not just the breakdown and the Ledger, which rebuild
  // themselves from the live figures.
  const carryThrough = () => resyncPropertyBilling(propId, fy);

  const save = useMutation({
    // `prev` (the pre-save size, or null) rides along for the undo.
    mutationFn: async (_prev) => {
      const out = await updateProperty(propId, { building_sf: val === '' ? null : Number(val) });
      await carryThrough();
      return out;
    },
    onSuccess: (_data, prev) => {
      invalidate();
      setSaved({
        label: 'building size saved',
        undo: async () => { await updateProperty(propId, { building_sf: prev }); await carryThrough(); },
      });
    },
  });

  const undoMut = useMutation({ mutationFn: (p) => p.undo(), onSuccess: invalidate });

  return (
    <>
      <form className="row" onSubmit={(e) => {
        e.preventDefault();
        save.mutate(buildingSf == null || buildingSf === '' ? null : Number(buildingSf));
      }} style={{ alignItems: 'flex-end', marginBottom: 16 }}>
        <label className="form-field" style={{ marginBottom: 0, maxWidth: 200 }}>
          <span>Building size (SF) — drives vacancy &amp; occupancy</span>
          <input className="text-input num" type="number" step="any" value={val} onChange={(e) => setVal(e.target.value)} />
        </label>
        <button type="submit" className="secondary" disabled={save.isPending}>Save building size</button>
        {saved && (
          <UndoStrip
            label={saved.label}
            busy={undoMut.isPending}
            onUndo={() => { const p = saved; setSaved(null); undoMut.mutate(p); }}
            onDismiss={() => setSaved(null)}
          />
        )}
      </form>
      <MutationError of={[save, undoMut]} />
    </>
  );
}
