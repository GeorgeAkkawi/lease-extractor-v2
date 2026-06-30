import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCamLineItems, addCamLineItem, deleteCamLineItem, upsertExpenseRecord } from '../lib/api';
import { money } from '../lib/format';

// CAM is comprised of many sub-expenses. List them; the app sums them into the
// CAM total used everywhere. A flat entry is still available when there are none.
export default function CamSection({ propId, year, expense }) {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({
    queryKey: ['camLineItems', propId, year],
    queryFn: () => listCamLineItems(propId, year),
  });

  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [flat, setFlat] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['camLineItems', propId, year] });
    qc.invalidateQueries({ queryKey: ['expenseRecord', propId, year] });
    qc.invalidateQueries({ queryKey: ['propertyTotals', propId, year] });
    qc.invalidateQueries({ queryKey: ['tenantShares', propId, year] });
  };

  const add = useMutation({
    mutationFn: () => addCamLineItem({ property_id: propId, year, label: label.trim(), amount: Number(amount) || 0 }),
    onSuccess: () => { setLabel(''); setAmount(''); invalidate(); },
  });
  const remove = useMutation({ mutationFn: (id) => deleteCamLineItem(id, propId, year), onSuccess: invalidate });
  const saveFlat = useMutation({
    mutationFn: () => upsertExpenseRecord({ property_id: propId, year, taxes_total: expense?.taxes_total ?? 0, cam_total: Number(flat) || 0, roof_total: expense?.roof_total ?? 0 }),
    onSuccess: invalidate,
  });

  const total = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);

  return (
    <div className="cam-table">
      <div className="cam-row cam-th">
        <div>Component</div>
        <div className="num">Annual cost</div>
        <div className="num"></div>
        <div></div>
      </div>

      {items.length === 0 ? (
        <div className="empty-line muted">No CAM components yet — add the first one below, or set a flat total.</div>
      ) : (
        items.map((it, idx) => (
          <div className={`cam-row${idx === items.length - 1 ? ' last' : ''}`} key={it.id}>
            <div>{it.label}</div>
            <div className="num">{money(it.amount)}</div>
            <div className="num"></div>
            <button className="icon-btn danger-btn" onClick={() => remove.mutate(it.id)}>✕</button>
          </div>
        ))
      )}

      {items.length > 0 && (
        <div className="cam-row cam-total">
          <b>CAM total</b>
          <b className="num">{money(total)}</b>
          <div></div>
          <div></div>
        </div>
      )}

      {/* add a line item */}
      <form className="cam-row" onSubmit={(e) => { e.preventDefault(); if (label.trim()) add.mutate(); }} style={{ borderBottom: 'none', marginTop: 8 }}>
        <input className="cam-input" placeholder="e.g. Landscaping" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="cam-amt"><span className="cam-pre">$</span><input className="cam-input num" type="number" step="any" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div></div>
        <button type="submit" className="icon-btn" disabled={!label.trim() || add.isPending} title="Add CAM item">＋</button>
      </form>

      {items.length === 0 && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); saveFlat.mutate(); }} style={{ marginTop: 10 }}>
          <label className="form-field" style={{ marginBottom: 0, maxWidth: 200 }}>
            <span>Flat CAM total ($)</span>
            <input className="text-input num" type="number" step="any" placeholder={expense?.cam_total ?? '0'} value={flat} onChange={(e) => setFlat(e.target.value)} />
          </label>
          <button type="submit" className="secondary" disabled={saveFlat.isPending} style={{ alignSelf: 'flex-end' }}>Save flat CAM</button>
          {expense?.cam_total != null && <span className="muted" style={{ alignSelf: 'flex-end' }}>current: {money(expense.cam_total)}</span>}
        </form>
      )}
    </div>
  );
}
