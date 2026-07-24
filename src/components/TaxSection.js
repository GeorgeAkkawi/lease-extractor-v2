import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listTaxLineItems, addTaxLineItem, deleteTaxLineItem, getExpenseRecord, upsertExpenseRecord } from '../lib/api';
import { money } from '../lib/format';
import MutationError from './MutationError';
import UndoStrip from './UndoStrip';

// Property taxes, itemized the way CAM is (George: "when taxes are pulled from the
// statement they shouldnt upload to expenses rather to the property taxes box … a new
// line per time it sees it on the statement … give it its own line item"). A year's
// taxes are usually two or three instalments to a county, so each payment gets its own
// line — the sum is what bills, and it drives the tax PSF exactly as before. A single
// flat figure is still available while nothing is itemized.
export default function TaxSection({ propId, year, expense }) {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({
    queryKey: ['taxLineItems', propId, year],
    queryFn: () => listTaxLineItems(propId, year),
  });

  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [flat, setFlat] = useState('');
  const [saved, setSaved] = useState(null);
  useEffect(() => setSaved(null), [propId, year]); // never show a strip under another year's list

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['taxLineItems', propId, year] });
    qc.invalidateQueries({ queryKey: ['expenseRecord', propId, year] });
    qc.invalidateQueries({ queryKey: ['propertyTotals', propId, year] });
    qc.invalidateQueries({ queryKey: ['tenantShares', propId, year] });
    qc.invalidateQueries({ queryKey: ['corpRollups'] }); // taxes feed the corp roll-up
  };

  const add = useMutation({
    mutationFn: () => addTaxLineItem({ property_id: propId, year, label: label.trim() || 'Property tax', amount: Number(amount) || 0 }),
    onSuccess: (item) => {
      setLabel(''); setAmount(''); invalidate();
      setSaved({ label: `added ${item.label}`, undo: () => deleteTaxLineItem(item.id, propId, year) });
    },
  });
  const remove = useMutation({
    mutationFn: (it) => deleteTaxLineItem(it.id, propId, year),
    onSuccess: (_data, it) => {
      invalidate();
      setSaved({ label: `removed ${it.label}`, undo: () => addTaxLineItem({ property_id: propId, year, label: it.label, amount: it.amount }) });
    },
  });
  const saveFlat = useMutation({
    // `prevTaxes` (the pre-save figure, or null) rides along for the undo.
    mutationFn: (_prevTaxes) => upsertExpenseRecord({
      property_id: propId,
      year,
      taxes_total: Number(flat) || 0,
      cam_total: expense?.cam_total ?? 0,
      roof_total: expense?.roof_total ?? 0,
    }),
    onSuccess: (_data, prevTaxes) => {
      invalidate();
      setSaved({
        label: 'property taxes saved',
        // Re-read at undo time so a CAM/roof figure saved meanwhile survives.
        undo: async () => {
          const cur = await getExpenseRecord(propId, year);
          await upsertExpenseRecord({
            property_id: propId,
            year,
            taxes_total: Number(prevTaxes) || 0,
            cam_total: Number(cur?.cam_total) || 0,
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
        <div>Payment</div>
        <div className="num">Amount</div>
        <div className="num"></div>
        <div></div>
      </div>

      {items.length === 0 ? (
        <div className="empty-line muted">No tax payments itemized yet — add one below, or enter the year's total.</div>
      ) : (
        items.map((it, i) => (
          <div className={`cam-row${i === items.length - 1 ? ' last' : ''}`} key={it.id}>
            <div>
              {it.label}
              {it.import_id && <span className="badge info" style={{ marginLeft: 8 }} title="Recorded by a bank-statement import — ✕ removes just this line; ↩ Undo on the import reverses the whole statement">imported</span>}
            </div>
            <div className="num">{money(it.amount)}</div>
            <div className="num"></div>
            <button className="icon-btn danger-btn" onClick={() => remove.mutate(it)}>✕</button>
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
          <b>Property taxes</b>
          <b className="num">{money(total)}</b>
          <div></div>
          <div></div>
        </div>
      )}

      {/* add a payment */}
      <form className="cam-row" onSubmit={(e) => { e.preventDefault(); add.mutate(); }} style={{ borderBottom: 'none', marginTop: 8 }}>
        <input className="cam-input" placeholder="e.g. Cook County — 1st instalment" value={label} onChange={(e) => setLabel(e.target.value)} />
        <div className="cam-amt"><span className="cam-pre">$</span><input className="cam-input num" type="number" step="any" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div></div>
        <button type="submit" className="icon-btn" disabled={!(Number(amount) > 0) || add.isPending} title="Add tax payment">＋</button>
      </form>

      {items.length === 0 && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); saveFlat.mutate(Number(expense?.taxes_total) || 0); }} style={{ marginTop: 10 }}>
          <label className="form-field" style={{ marginBottom: 0, maxWidth: 200 }}>
            <span>Year's tax total ($)</span>
            <input className="text-input num" type="number" step="any" placeholder={expense?.taxes_total ?? '0'} value={flat} onChange={(e) => setFlat(e.target.value)} />
          </label>
          <button type="submit" className="secondary" disabled={saveFlat.isPending} style={{ alignSelf: 'flex-end' }}>Save property taxes</button>
          {expense?.taxes_total != null && <span className="muted" style={{ alignSelf: 'flex-end' }}>current: {money(expense.taxes_total)}</span>}
        </form>
      )}
    </div>
  );
}
