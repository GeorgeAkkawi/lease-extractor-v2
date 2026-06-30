import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateProperty } from '../lib/api';

// Edit a property's building size after creation (drives vacancy & occupancy).
export default function BuildingSizeEditor({ propId, buildingSf }) {
  const qc = useQueryClient();
  const [val, setVal] = useState('');
  useEffect(() => { setVal(buildingSf ?? ''); }, [buildingSf]);

  const save = useMutation({
    mutationFn: () => updateProperty(propId, { building_sf: val === '' ? null : Number(val) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['property', propId] });
      qc.invalidateQueries({ queryKey: ['propertyTotals', propId] });
      qc.invalidateQueries({ queryKey: ['properties'] });
      qc.invalidateQueries({ queryKey: ['leases', propId] }); // vacancy on the leases page
    },
  });

  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} style={{ alignItems: 'flex-end', marginBottom: 16 }}>
      <label className="form-field" style={{ marginBottom: 0, maxWidth: 200 }}>
        <span>Building size (SF) — drives vacancy &amp; occupancy</span>
        <input className="text-input num" type="number" step="any" value={val} onChange={(e) => setVal(e.target.value)} />
      </label>
      <button type="submit" className="secondary" disabled={save.isPending}>Save building size</button>
      {save.isSuccess && <span className="badge good">Saved</span>}
    </form>
  );
}
