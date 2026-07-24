import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCamLineItems, addCamLineItem, deleteCamLineItem, getExpenseRecord, upsertExpenseRecord, syncContractCamItems, syncRentPctCamItems, getPropertyTotals } from '../lib/api';
import { CAM_KEYWORD_LABELS } from '../lib/statementMatch';
import { money } from '../lib/format';
import MutationError from './MutationError';
import UndoStrip from './UndoStrip';

// A management fee isn't a figure you look up — it's a percentage of the rent. Typing
// a label that reads like one offers the percentage entry automatically; the toggle
// beside the amount turns it on for anything else priced the same way.
const FEE_LABEL = 'Management fee';
const looksLikeFee = (label) => /manage/i.test(label);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// CAM is comprised of many sub-expenses, itemized into named BUCKETS (the label —
// Garbage, Snow removal, HVAC…). Billable items sum into the CAM total billed back
// to tenants; "not billed to tenants" items (billable=false) are tracked in their
// own group for the landlord's records only. A flat entry is still available when
// there are no items.
export default function CamSection({ propId, year, expense }) {
  const qc = useQueryClient();
  const { data: items = [] } = useQuery({
    queryKey: ['camLineItems', propId, year],
    // Carry this year's service contracts into CAM first (create/refresh at the escalated
    // amount) and true up any rent-percentage line, then list — so opening any fiscal
    // year keeps its contract costs and management fee current.
    queryFn: async () => {
      await syncContractCamItems(propId, year);
      await syncRentPctCamItems(propId, year);
      return listCamLineItems(propId, year);
    },
  });
  // The property's annual base rent — what a management fee is struck against. Same
  // query key the Financials page already warms, so this is a cache hit.
  const { data: totals } = useQuery({ queryKey: ['propertyTotals', propId, year], queryFn: () => getPropertyTotals(propId, year) });
  const rentBasis = Number(totals?.total_revenue) || 0;

  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [pct, setPct] = useState('');
  const [pctMode, setPctMode] = useState(false);
  const [notBilled, setNotBilled] = useState(false);
  const [flat, setFlat] = useState('');
  // Offer the percentage the moment the label starts reading like a management fee —
  // once, so turning it back off sticks while the label still says "management".
  const wasFee = useRef(false);
  useEffect(() => {
    const isFee = looksLikeFee(label);
    if (isFee && !wasFee.current) setPctMode(true);
    wasFee.current = isFee;
  }, [label]);
  const feeAmount = round2(rentBasis * ((Number(pct) || 0) / 100));
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
    mutationFn: () => addCamLineItem({
      property_id: propId,
      year,
      label: label.trim(),
      // A percentage line stores BOTH: the dollars that bill, and the rate they came
      // from — so the row can say what it is and follow the rent when it changes.
      amount: pctMode ? feeAmount : Number(amount) || 0,
      rent_pct: pctMode ? Number(pct) || 0 : null,
      billable: !notBilled,
    }),
    onSuccess: (item) => {
      setLabel(''); setAmount(''); setPct(''); setPctMode(false); setNotBilled(false); invalidate();
      setSaved({ label: `added ${item.label}`, undo: () => deleteCamLineItem(item.id, propId, year) });
    },
  });
  const remove = useMutation({
    mutationFn: (it) => deleteCamLineItem(it.id, propId, year),
    onSuccess: (_data, it) => {
      invalidate();
      // Undo re-adds the same label/amount/kind (a fresh row — it lands at the list's end).
      setSaved({ label: `removed ${it.label}`, undo: () => addCamLineItem({ property_id: propId, year, label: it.label, amount: it.amount, rent_pct: it.rent_pct ?? null, billable: it.billable !== false }) });
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

  const billableItems = items.filter((it) => it.billable !== false);
  const otherItems = items.filter((it) => it.billable === false);
  const total = billableItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  const otherTotal = otherItems.reduce((s, it) => s + (Number(it.amount) || 0), 0);

  // Group a list by bucket (label) in first-appearance order; multi-item buckets
  // get a quiet subtotal line so "Garbage — 3 items · $1,140" reads at a glance.
  const groupsOf = (list) => {
    const m = new Map();
    for (const it of list) {
      const k = String(it.label || '').trim().toLowerCase() || '—';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return [...m.values()];
  };
  const bucketLabels = [...new Set([...items.map((it) => String(it.label || '').trim()).filter(Boolean), ...CAM_KEYWORD_LABELS, FEE_LABEL])].sort();

  const itemRow = (it, last) => (
    <div className={`cam-row${last ? ' last' : ''}`} key={it.id}>
      <div>
        {it.label}
        {it.contract_id && <span className="badge info" style={{ marginLeft: 8 }}>from contract</span>}
        {it.import_id && <span className="badge info" style={{ marginLeft: 8 }} title="Recorded by a bank-statement import — ✕ removes just this line; ↩ Undo on the import reverses the whole statement">imported</span>}
        {it.rent_pct != null && (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }} title="Priced as a percentage of this property's annual base rent — it follows the rent when a lease escalates or a tenant changes.">
            {Number(it.rent_pct)}% of {money(rentBasis)} base rent
          </div>
        )}
      </div>
      <div className="num">{money(it.amount)}</div>
      <div className="num"></div>
      {it.contract_id
        ? <span className="muted" title="Managed by the service contract — edit it in Contracts" style={{ fontSize: 11 }}>auto</span>
        : <button className="icon-btn danger-btn" onClick={() => remove.mutate(it)}>✕</button>}
    </div>
  );
  const groupRows = (list) =>
    groupsOf(list).flatMap((group, gi, groups) => {
      const rows = group.map((it, i) => itemRow(it, gi === groups.length - 1 && i === group.length - 1 && group.length === 1));
      if (group.length > 1) {
        const sub = group.reduce((s, it) => s + (Number(it.amount) || 0), 0);
        rows.push(
          <div className="cam-row cam-sub" key={`${group[0].id}-sub`}>
            <div className="muted" style={{ fontSize: 12 }}>{group[0].label} · {group.length} items</div>
            <div className="num muted" style={{ fontSize: 12 }}>{money(sub)}</div>
            <div className="num"></div>
            <div></div>
          </div>
        );
      }
      return rows;
    });

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
        groupRows(billableItems)
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

      {billableItems.length > 0 && (
        <div className="cam-row cam-total">
          <b>CAM total</b>
          <b className="num">{money(total)}</b>
          <div></div>
          <div></div>
        </div>
      )}

      {otherItems.length > 0 && (
        <>
          <div className="cam-row cam-th" style={{ marginTop: 14 }}>
            <div>Other expenses — not billed to tenants</div>
            <div className="num">Annual cost</div>
            <div className="num"></div>
            <div></div>
          </div>
          {groupRows(otherItems)}
          <div className="cam-row cam-total">
            <b>Other total</b>
            <b className="num">{money(otherTotal)}</b>
            <div></div>
            <div></div>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            Tracked for your records — never included in the CAM billed back through tenant shares.
          </div>
        </>
      )}

      {/* add a line item */}
      <form className="cam-row" onSubmit={(e) => { e.preventDefault(); if (label.trim()) add.mutate(); }} style={{ borderBottom: 'none', marginTop: 8 }}>
        <input className="cam-input" placeholder="e.g. Landscaping" value={label} onChange={(e) => setLabel(e.target.value)} list="cam-bucket-list" />
        <datalist id="cam-bucket-list">
          {bucketLabels.map((l) => <option key={l} value={l} />)}
        </datalist>
        {pctMode ? (
          <div className="cam-amt"><span className="cam-pre">%</span><input className="cam-input num" type="number" step="any" placeholder="5" value={pct} onChange={(e) => setPct(e.target.value)} /></div>
        ) : (
          <div className="cam-amt"><span className="cam-pre">$</span><input className="cam-input num" type="number" step="any" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <label className="muted" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }} title="Price this line as a percentage of the property's annual base rent — the usual way a management fee is set. The dollar figure is worked out for you and follows the rent.">
            <input type="checkbox" checked={pctMode} onChange={(e) => setPctMode(e.target.checked)} />
            % of rent
          </label>
          <label className="muted" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }} title="Tick for spending tenants shouldn't reimburse — it stays itemized here but never bills through CAM">
            <input type="checkbox" checked={notBilled} onChange={(e) => setNotBilled(e.target.checked)} />
            not billed
          </label>
        </div>
        <button type="submit" className="icon-btn" disabled={!label.trim() || add.isPending || (pctMode && !(Number(pct) > 0))} title="Add expense item">＋</button>
      </form>
      {pctMode && (
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          {rentBasis > 0
            ? <>{Number(pct) || 0}% of {money(rentBasis)} base rent = <strong>{money(feeAmount)}</strong> for FY {year}{notBilled ? '' : ' — billed back through CAM'}</>
            : <>No base rent on file for FY {year} yet, so there's nothing to take a percentage of — enter the fee as a dollar figure instead.</>}
        </div>
      )}

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
