import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listRoofLineItems, addRoofLineItem, deleteRoofLineItem, getExpenseRecord, upsertExpenseRecord, resyncPropertyBilling } from '../lib/api';
import { settleBillingChange } from '../lib/invalidate';
import { money, fmtShortDate } from '../lib/format';
import MutationError from './MutationError';
import UndoStrip from './UndoStrip';
import CapitalizeLineButton, { CAPITALIZE_FLOOR } from './CapitalizeLineButton';

// Roof costs, itemized the way property taxes are (0074). A roof is replaced once and
// repaired several times, and one accumulating figure hid which payment was which — the
// same complaint that made taxes itemized in 0067. The sum is what bills, and it drives
// the roof PSF and the recovered/absorbed split exactly as before. A single flat figure
// is still available while nothing is itemized, so a property that never itemizes reads
// and behaves precisely as it did.
//
// ⚠ Roof costs bill back at 100% to roof-responsible tenants, not pro-rata — so every
// write here goes through resyncPropertyBilling, and the first itemized line carries the
// flat figure in first (carryFlatIntoItems, api.js) rather than re-summing the year down.
export default function RoofSection({ propId, year, expense }) {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({
    queryKey: ['roofLineItems', propId, year],
    queryFn: () => listRoofLineItems(propId, year),
  });

  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [paidDate, setPaidDate] = useState('');
  const [flat, setFlat] = useState('');
  const [saved, setSaved] = useState(null);
  useEffect(() => setSaved(null), [propId, year]); // never show a strip under another year's list

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['roofLineItems', propId, year] });
    qc.invalidateQueries({ queryKey: ['expenseRecord', propId, year] });
    settleBillingChange(qc, { propertyId: propId, year });
  };

  // The roof total is billed to the roof-responsible tenants, so the year's stored
  // invoices follow a line being added, removed or re-entered.
  const carryThrough = () => resyncPropertyBilling(propId, year);

  const add = useMutation({
    mutationFn: async () => {
      const item = await addRoofLineItem({ property_id: propId, year, label: label.trim() || 'Roof', amount: Number(amount) || 0, paid_date: paidDate || null });
      await carryThrough();
      return item;
    },
    onSuccess: (item) => {
      setLabel(''); setAmount(''); setPaidDate(''); invalidate();
      setSaved({
        label: `added ${item.label}`,
        undo: async () => { await deleteRoofLineItem(item.id, propId, year); await carryThrough(); },
      });
    },
  });
  const remove = useMutation({
    mutationFn: async (it) => { const out = await deleteRoofLineItem(it.id, propId, year); await carryThrough(); return out; },
    onSuccess: (_data, it) => {
      invalidate();
      setSaved({
        label: `removed ${it.label}`,
        undo: async () => { await addRoofLineItem({ property_id: propId, year, label: it.label, amount: it.amount, paid_date: it.paid_date || null }); await carryThrough(); },
      });
    },
  });
  const saveFlat = useMutation({
    // `prevRoof` (the pre-save figure, or null) rides along for the undo.
    mutationFn: async (_prevRoof) => {
      const out = await upsertExpenseRecord({
        property_id: propId,
        year,
        taxes_total: expense?.taxes_total ?? 0,
        cam_total: expense?.cam_total ?? 0,
        roof_total: Number(flat) || 0,
      });
      await carryThrough();
      return out;
    },
    onSuccess: (_data, prevRoof) => {
      invalidate();
      setSaved({
        label: 'roof saved',
        // Re-read at undo time so a CAM/tax figure saved meanwhile survives.
        undo: async () => {
          const cur = await getExpenseRecord(propId, year);
          await upsertExpenseRecord({
            property_id: propId,
            year,
            taxes_total: Number(cur?.taxes_total) || 0,
            cam_total: Number(cur?.cam_total) || 0,
            roof_total: Number(prevRoof) || 0,
          });
          await carryThrough();
        },
      });
    },
  });
  const undoMut = useMutation({ mutationFn: (p) => p.undo(), onSuccess: invalidate });

  const total = items.reduce((s, it) => s + (Number(it.amount) || 0), 0);

  return (
    <div className="cam-table">
      <div className="cam-row cam-th">
        <div>Roof work</div>
        <div className="num">Amount</div>
        <div className="num">Date paid</div>
        <div></div>
      </div>

      {items.length === 0 ? (
        <div className="empty-line muted">No roof work itemized yet — add a payment below, or enter the year's total.</div>
      ) : (
        items.map((it, i) => (
          <div className={`cam-row${i === items.length - 1 ? ' last' : ''}`} key={it.id}>
            <div>
              {it.label}
              {it.import_id && <span className="badge info" style={{ marginLeft: 8 }} title="Recorded by a bank-statement import — ✕ removes just this line; ↩ Undo on the import reverses the whole statement">imported</span>}
              {it.asset_id && (
                <span className="badge info" style={{ marginLeft: 8 }} title="Derived from an asset in “What you own” — this year's share of a cost spread over its life. Switch it off there, not here.">amortized</span>
              )}
              {/* Slice 5b — a roof REPLACEMENT is the textbook capital cost, and this is
                  where a landlord is standing when they realize it. Capitalizing lowers
                  roof_total, which lowers what roof-responsible tenants are billed; the
                  confirm names that before anything moves. */}
              {!it.asset_id && Math.abs(Number(it.amount) || 0) >= CAPITALIZE_FLOOR && (
                <div style={{ marginTop: 4 }}>
                  <CapitalizeLineButton item={it} propId={propId} year={year} />
                </div>
              )}
            </div>
            <div className="num">{money(it.amount)}</div>
            <div className="num muted" style={{ fontSize: 12 }} title={it.paid_date ? undefined : 'No date on file — entered by hand rather than read from a statement'}>{fmtShortDate(it.paid_date)}</div>
            {it.asset_id
              ? <span className="muted" title="Derived from an asset — managed in “What you own”" style={{ fontSize: 11 }}>auto</span>
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
          <b>Roof</b>
          <b className="num">{money(total)}</b>
          <div></div>
          <div></div>
        </div>
      )}

      {/* add a payment */}
      <form className="cam-row" onSubmit={(e) => { e.preventDefault(); add.mutate(); }} style={{ borderBottom: 'none', marginTop: 8 }}>
        <input className="cam-input" placeholder="e.g. Apex Roofing — patch repair" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="cam-amt"><span className="cam-pre">$</span><input className="cam-input num" type="number" step="any" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <input className="cam-input" type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} title="The day it was paid — optional" style={{ fontSize: 12 }} />
        <button type="submit" className="icon-btn" disabled={!(Number(amount) > 0) || add.isPending} title="Add roof payment">＋</button>
      </form>

      {items.length === 0 && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); saveFlat.mutate(Number(expense?.roof_total) || 0); }} style={{ marginTop: 10 }}>
          <label className="form-field" style={{ marginBottom: 0, maxWidth: 200 }}>
            <span>Year's roof total ($)</span>
            <input className="text-input num" type="number" step="any" placeholder={expense?.roof_total ?? '0'} value={flat} onChange={(e) => setFlat(e.target.value)} />
          </label>
          <button type="submit" className="secondary" disabled={saveFlat.isPending} style={{ alignSelf: 'flex-end' }}>Save roof</button>
          {expense?.roof_total != null && <span className="muted" style={{ alignSelf: 'flex-end' }}>current: {money(expense.roof_total)}</span>}
        </form>
      )}
    </div>
  );
}
