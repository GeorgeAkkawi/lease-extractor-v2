import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCamLineItems, addCamLineItem, deleteCamLineItem, getExpenseRecord, upsertExpenseRecord, syncContractCamItems } from '../lib/api';
import { money } from '../lib/format';
import MutationError from './MutationError';
import UndoStrip from './UndoStrip';

// CAM is comprised of many sub-expenses. List them; the app sums them into the
// CAM total used everywhere. A flat entry is still available when there are none.
export default function CamSection({ propId, year, expense }) {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({
    queryKey: ['camLineItems', propId, year],
    // Carry this year's service contracts into CAM first (create/refresh at the escalated
    // amount), then list — so opening any fiscal year keeps its contract costs current.
    queryFn: async () => { await syncContractCamItems(propId, year); return listCamLineItems(propId, year); },
  });

  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [flat, setFlat] = useState('');
  // The post-action ↩ Undo: { label, undo } — one slot, latest action wins.
  const [saved, setSaved] = useState(null);
  useEffect(() => setSaved(null), [propId, year]); // never show a strip under another year's list

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['camLineItems', propId, year] });
    qc.invalidateQueries({ queryKey: ['expenseRecord', propId, year] });
    qc.invalidateQueries({ queryKey: ['propertyTotals', propId, year] });
    qc.invalidateQueries({ queryKey: ['tenantShares', propId, year] });
    qc.invalidateQueries({ queryKey: ['corpRollups'] }); // CAM feeds the corp roll-up
  };

  const add = useMutation({
    mutationFn: () => addCamLineItem({ property_id: propId, year, label: label.trim(), amount: Number(amount) || 0 }),
    onSuccess: (item) => {
      setLabel(''); setAmount(''); invalidate();
      setSaved({ label: `added ${item.label}`, undo: () => deleteCamLineItem(item.id, propId, year) });
    },
  });
  const remove = useMutation({
    mutationFn: (it) => deleteCamLineItem(it.id, propId, year),
    onSuccess: (_data, it) => {
      invalidate();
      // Undo re-adds the same label/amount (a fresh row — it lands at the list's end).
      setSaved({ label: `removed ${it.label}`, undo: () => addCamLineItem({ property_id: propId, year, label: it.label, amount: it.amount }) });
    },
  });
  const saveFlat = useMutation({
    // `prevCam` (the pre-save flat total, or null) rides along for the undo.
    mutationFn: (_prevCam) => upsertExpenseRecord({ property_id: propId, year, taxes_total: expense?.taxes_total ?? 0, cam_total: Number(flat) || 0, roof_total: expense?.roof_total ?? 0 }),
    onSuccess: (_data, prevCam) => {
      invalidate();
      setSaved({
        label: 'flat CAM saved',
        // Re-read the record at undo time so taxes/roof saved meanwhile survive.
        undo: async () => {
          const cur = await getExpenseRecord(propId, year);
          await upsertExpenseRecord({
            property_id: propId,
            year,
            taxes_total: Number(cur?.taxes_total) || 0,
            cam_total: Number(prevCam) || 0,
            roof_total: Number(cur?.roof_total) || 0,
          });
        },
      });
    },
  });
  const undoMut = useMutation({ mutationFn: (p) => p.undo(), onSuccess: invalidate });

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
            <div>{it.label}{it.contract_id && <span className="badge info" style={{ marginLeft: 8 }}>from contract</span>}</div>
            <div className="num">{money(it.amount)}</div>
            <div className="num"></div>
            {it.contract_id
              ? <span className="muted" title="Managed by the service contract — edit it in Contracts" style={{ fontSize: 11 }}>auto</span>
              : <button className="icon-btn danger-btn" onClick={() => remove.mutate(it)}>✕</button>}
          </div>
        ))
      )}

      <MutationError of={[add, remove, saveFlat, undoMut]} />
      {saved && (
        <div style={{ marginTop: 8 }}>
          <UndoStrip
            label={saved.label}
            busy={undoMut.isPending}
            onUndo={() => { const p = saved; setSaved(null); undoMut.mutate(p); }}
            onDismiss={() => setSaved(null)}
          />
        </div>
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
