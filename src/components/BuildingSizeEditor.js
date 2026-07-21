import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateProperty } from '../lib/api';
import MutationError from './MutationError';
import UndoStrip from './UndoStrip';

// Edit a property's building size after creation (drives vacancy & occupancy).
export default function BuildingSizeEditor({ propId, buildingSf }) {
  const qc = useQueryClient();
  const [val, setVal] = useState('');
  const [saved, setSaved] = useState(null); // post-save ↩ Undo (restores the prior size)
  useEffect(() => { setVal(buildingSf ?? ''); }, [buildingSf]);

  const invalidate = () => {
    // The building size is the tax/CAM/roof divisor, so re-divide every downstream
    // figure the moment it's saved: rate cards, per-tenant breakdown, invoices.
    qc.invalidateQueries({ queryKey: ['property', propId] });
    qc.invalidateQueries({ queryKey: ['propertyTotals', propId] });
    qc.invalidateQueries({ queryKey: ['properties'] });
    qc.invalidateQueries({ queryKey: ['leases', propId] }); // vacancy on the leases page
    qc.invalidateQueries({ queryKey: ['tenantShares', propId] }); // per-tenant breakdown + invoices
  };

  const save = useMutation({
    // `prev` (the pre-save size, or null) rides along for the undo.
    mutationFn: (_prev) => updateProperty(propId, { building_sf: val === '' ? null : Number(val) }),
    onSuccess: (_data, prev) => {
      invalidate();
      setSaved({ label: 'building size saved', undo: () => updateProperty(propId, { building_sf: prev }) });
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
