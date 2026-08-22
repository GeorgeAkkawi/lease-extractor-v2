import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCamLineItems, addCamLineItem, deleteCamLineItem, getExpenseRecord, upsertExpenseRecord, getPropertyTotals, resyncPropertyBilling, listExpenseBuckets, saveExpenseBucket } from '../lib/api';
import { settleBillingChange } from '../lib/invalidate';
import { CAM_KEYWORD_LABELS } from '../lib/statementMatch';
import { categoryFor, categoryLabel, bucketKey } from '../lib/expenseCategories';
import LabelPicker from './LabelPicker';
import TaxCategorySelect from './TaxCategorySelect';
import { money, fmtShortDate } from '../lib/format';
import MutationError from './MutationError';
import UndoStrip from './UndoStrip';
import InlineEdit from './InlineEdit';
import { useOptimisticRemove } from './useOptimisticRemove';
import { useExpenseLineEdit } from './useExpenseLineEdit';

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
  // ⚠ A PLAIN READ, DELIBERATELY. Carrying this year's service contracts and rent-percentage
  // fees into CAM used to happen inside this queryFn; it never ran on the Financials page,
  // because `useRecoverability` observes the same key and last writer wins. It lives in
  // `useCamSync` now, called by the PAGE — this section sits inside a foldable panel, and a
  // year must still self-heal when the landlord has folded it. See that file for the story.
  const { data: items = [] } = useQuery({
    queryKey: ['camLineItems', propId, year],
    queryFn: () => listCamLineItems(propId, year),
  });
  // The property's annual base rent — what a management fee is struck against. Same
  // query key the Financials page already warms, so this is a cache hit.
  const { data: totals } = useQuery({ queryKey: ['propertyTotals', propId, year], queryFn: () => getPropertyTotals(propId, year) });
  const rentBasis = Number(totals?.total_revenue) || 0;

  // The saved bucket records (0075) — owner-wide, so this key carries no property or
  // year: a category answered on one property is answered everywhere.
  const { data: buckets = [] } = useQuery({ queryKey: ['expenseBuckets'], queryFn: listExpenseBuckets });
  const [editCat, setEditCat] = useState(null); // the bucket label whose category is open
  const saveCat = useMutation({
    mutationFn: ({ label, category }) => saveExpenseBucket({ label, category: category || null }),
    onSuccess: () => {
      setEditCat(null);
      // Owner-wide, and the import review reads the same records — refresh both.
      qc.invalidateQueries({ queryKey: ['expenseBuckets'] });
      qc.invalidateQueries({ queryKey: ['statementContext'] });
    },
  });

  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [pct, setPct] = useState('');
  const [pctMode, setPctMode] = useState(false);
  const [notBilled, setNotBilled] = useState(false);
  const [paidDate, setPaidDate] = useState('');
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
    settleBillingChange(qc, { propertyId: propId, year });
  };

  // A billable CAM line changes what EVERY tenant on the property is charged, so the
  // year's stored invoices follow it — the breakdown and the Ledger rebuild themselves
  // from live expenses, the invoice is a frozen copy that would otherwise go stale.
  const carryThrough = () => resyncPropertyBilling(propId, year);

  const add = useMutation({
    mutationFn: async () => {
      const item = await addCamLineItem({
        property_id: propId,
        year,
        label: label.trim(),
        // A percentage line stores BOTH: the dollars that bill, and the rate they came
        // from — so the row can say what it is and follow the rent when it changes.
        amount: pctMode ? feeAmount : Number(amount) || 0,
        rent_pct: pctMode ? Number(pct) || 0 : null,
        billable: !notBilled,
        paid_date: paidDate || null,
      });
      if (item.billable !== false) await carryThrough();
      return item;
    },
    onSuccess: (item) => {
      setLabel(''); setAmount(''); setPct(''); setPctMode(false); setNotBilled(false); setPaidDate(''); invalidate();
      setSaved({
        label: `added ${item.label}`,
        undo: async () => { await deleteCamLineItem(item.id, propId, year); if (item.billable !== false) await carryThrough(); },
      });
    },
  });
  // The row goes the instant it is clicked; the property-wide invoice rebuild below
  // carries on behind it and repaints the money screens when it lands.
  const remove = useOptimisticRemove({
    queryKey: ['camLineItems', propId, year],
    mutationFn: async (it) => {
      const out = await deleteCamLineItem(it.id, propId, year);
      if (it.billable !== false) await carryThrough();
      return out;
    },
    onSuccess: (_data, it) => {
      invalidate();
      // Undo re-adds the same label/amount/kind (a fresh row — it lands at the list's end).
      setSaved({
        label: `removed ${it.label}`,
        undo: async () => {
          await addCamLineItem({ property_id: propId, year, label: it.label, amount: it.amount, rent_pct: it.rent_pct ?? null, billable: it.billable !== false, paid_date: it.paid_date || null });
          if (it.billable !== false) await carryThrough();
        },
      });
    },
  });
  const saveFlat = useMutation({
    // `prevCam` (the pre-save flat total, or null) rides along for the undo.
    mutationFn: async (_prevCam) => {
      const out = await upsertExpenseRecord({ property_id: propId, year, taxes_total: expense?.taxes_total ?? 0, cam_total: Number(flat) || 0, roof_total: expense?.roof_total ?? 0 });
      await carryThrough();
      return out;
    },
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
          await carryThrough();
        },
      });
    },
  });
  const undoMut = useMutation({ mutationFn: (p) => p.undo(), onSuccess: invalidate });

  // Correcting a name or a date paid. Neither is billed — see updateExpenseLineItem for
  // the walk — so there is deliberately no carryThrough() here, unlike every other write
  // in this file. What a rename DOES move is which bucket the line sits in and therefore
  // which tax line it files under, so the strip says that outright rather than leaving it
  // to be found on the workbook three weeks later.
  const editLine = useExpenseLineEdit({
    invalidate,
    setSaved,
    describe: ({ item, field, value }) => {
      if (field === 'paid_date') {
        return value ? `${item.label} dated ${fmtShortDate(value)}` : `date cleared on ${item.label}`;
      }
      const before = categoryFor(String(item.label || '').trim(), buckets).category || null;
      const after = categoryFor(String(value || '').trim(), buckets).category || null;
      const moved = after !== before
        ? ` — now files under ${after ? categoryLabel(after) : 'no tax category yet'}`
        : '';
      return `renamed ${item.label} → ${value}${moved}`;
    },
  });

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
  // ⚠ The category is RESOLVED HERE, through the same `categoryFor` the chip beside each
  // bucket uses — not a second guess at what a name means. The picker showing one category
  // while the chip below showed another is the §3 drift in miniature, on one screen.
  const bucketOptions = bucketLabels.map((l) => ({ label: l, category: categoryLabel(categoryFor(l, buckets).category) }));

  // The bucket's tax category, shown once per bucket (on its first line) and editable
  // in place. Three states, and the third is the whole point of this slice: a bucket
  // nobody has categorized reads "Set a tax category" rather than being absorbed into
  // "Other", so the money that needs an answer stays visible.
  const catChip = (label) => {
    const { category, source } = categoryFor(label, buckets);
    if (editCat === bucketKey(label)) {
      return (
        // The padding lives in .cat-select, not inline: an inline padding shorthand beats
        // every stylesheet rule, including the one that reserves room for the chevron.
        <TaxCategorySelect
          className="cam-input cat-select" autoFocus value={category || ''}
          onChange={(next) => saveCat.mutate({ label, category: next })}
          onBlur={() => setEditCat(null)}
        />
      );
    }
    const title = source === 'saved'
      ? `Tax category — you chose this. It applies to every "${label}" line, on every property.`
      : source === 'default'
        ? `Tax category — Amlak's default for "${label}". Click to confirm or change it; your CPA may file it differently.`
        : `No tax category yet. "${label}" won't roll up to a tax line until you pick one — click to choose.`;
    return (
      <button type="button" className={`cat-chip${category ? (source === 'default' ? ' derived' : '') : ' none'}`}
        onClick={() => setEditCat(bucketKey(label))} title={title}>
        {category ? categoryLabel(category) : 'Set a tax category'}
      </button>
    );
  };

  const itemRow = (it, last, showCat) => (
    <div className={`cam-row${last ? ' last' : ''}`} key={it.id}>
      <div>
        <div className="cam-name">
          {/* A contract-derived line is NOT renamable: syncContractCamItems rewrites its
              label from the contract every time this fiscal year is opened, so a rename
              would look accepted and be gone on the next page load. */}
          <InlineEdit
            value={it.label} maxLength={80}
            readOnly={!!it.contract_id}
            readOnlyTitle="This line's name comes from the service contract and is rewritten from it — rename it in Contracts."
            title="Rename this component. It changes which bucket the line sits in, and so which tax line it files under — nothing about what tenants are billed."
            onCommit={(v) => editLine.mutate({ item: it, field: 'label', value: v })}
          />
          {it.contract_id && <span className="badge info">from contract</span>}
          {it.import_id && <span className="badge info" title="Recorded by a bank-statement import — ✕ removes just this line; ↩ Undo on the import reverses the whole statement">imported</span>}
        </div>
        {it.rent_pct != null && (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }} title="Priced as a percentage of this property's annual base rent — it follows the rent when a lease escalates or a tenant changes.">
            {Number(it.rent_pct)}% of {money(rentBasis)} base rent
          </div>
        )}
        {showCat && <div>{catChip(String(it.label || '').trim())}</div>}
      </div>
      <div className="num">{money(it.amount)}</div>
      <div className="num">
        <InlineEdit
          type="date" className="cam-date" placeholder="＋ date"
          value={it.paid_date || ''}
          display={it.paid_date ? fmtShortDate(it.paid_date) : null}
          title="The day it was paid. It decides which month this cost falls in on the income-and-expenses sheet — it never changes what a tenant is billed."
          onCommit={(v) => editLine.mutate({ item: it, field: 'paid_date', value: v })}
        />
      </div>
      {/* `asset_id` no longer marks a row as managed elsewhere: capitalizing was removed
          2026-08-12 and the rows it once derived became ordinary, editable lines. The
          column and its rows stay in the database untouched — cam_line_items.asset_id is
          ON DELETE CASCADE from fixed_assets, so clearing either would delete a real,
          billed expense line and move a tenant's bill. */}
      {it.contract_id
        ? <span className="muted" title="Managed by the service contract — edit it in Contracts" style={{ fontSize: 11 }}>auto</span>
        : <button className="icon-btn danger-btn" onClick={() => remove.mutate(it)}>✕</button>}
    </div>
  );
  const groupRows = (list) =>
    groupsOf(list).flatMap((group, gi, groups) => {
      const rows = group.map((it, i) => itemRow(it, gi === groups.length - 1 && i === group.length - 1 && group.length === 1, i === 0));
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
        <div className="num">Date paid</div>
        <div></div>
      </div>

      {items.length === 0 ? (
        <div className="empty-line muted">No CAM components yet — add the first one below, or set a flat total.</div>
      ) : (
        groupRows(billableItems)
      )}

      <MutationError of={[add, remove, saveFlat, undoMut, editLine, saveCat]} />
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
          {/* The column captions sit thirty pixels above this, on the first head, and
              nothing between the two changes what they mean. */}
          <div className="cam-row cam-th" style={{ marginTop: 18 }}>
            <div>Other expenses — not billed to tenants</div>
            <div></div>
            <div></div>
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

      {/* Slice 2's CAM-only roll-up lived here and is DELIBERATELY GONE. It covered one of
          the three itemized sections and said so in its own footnote; Slice 3's
          "What it cost you" table below the expense entry covers all three AND adds the
          recovered column, so keeping both would put two roll-ups on one page disagreeing
          about scope. Setting a category still happens here, on the chip beside each
          bucket — that is this section's job and it stays. */}

      {/* Add a line item. The four columns line up with the table above; the two switches
          that used to be stacked inside the 132px date column — raw browser checkboxes,
          under a date field, in a column meant for one date — sit on their own line
          underneath, where they have room to say what they do (George, 2026-08-17: "way
          too cluttered … reduce the noise there"). */}
      <form className="cam-add" onSubmit={(e) => { e.preventDefault(); if (label.trim()) add.mutate(); }}>
        <div className="cam-add-line">
          <LabelPicker
            id="cam-bucket"
            value={label}
            onChange={setLabel}
            options={bucketOptions}
            placeholder="e.g. Landscaping"
            ariaLabel="Expense name"
          />
          {pctMode ? (
            <div className="cam-amt"><span className="cam-pre">%</span><input className="cam-input num" type="number" step="any" placeholder="5" value={pct} onChange={(e) => setPct(e.target.value)} /></div>
          ) : (
            <div className="cam-amt"><span className="cam-pre">$</span><input className="cam-input num" type="number" step="any" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          )}
          <input className="cam-input" type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} aria-label="Date paid — optional" />
          <button type="submit" className="icon-btn" disabled={!label.trim() || add.isPending || (pctMode && !(Number(pct) > 0))} title="Add expense item">＋</button>
        </div>
        <div className="cam-add-opts">
          <label className={`opt-toggle${pctMode ? ' on' : ''}`} title="Price this line as a percentage of the property's annual base rent — the usual way a management fee is set. The dollar figure is worked out for you and follows the rent.">
            <input type="checkbox" checked={pctMode} onChange={(e) => setPctMode(e.target.checked)} />
            <span className="opt-dot" aria-hidden="true" />% of rent
          </label>
          <label className={`opt-toggle${notBilled ? ' on' : ''}`} title="Tick for spending tenants shouldn't reimburse — it stays itemized here but never bills through CAM">
            <input type="checkbox" checked={notBilled} onChange={(e) => setNotBilled(e.target.checked)} />
            <span className="opt-dot" aria-hidden="true" />not billed
          </label>
          {pctMode && (
            <span className="cam-add-calc">
              {rentBasis > 0
                ? <>{Number(pct) || 0}% of {money(rentBasis)} base rent = <strong>{money(feeAmount)}</strong> for FY {year}{notBilled ? '' : ' — billed back through CAM'}</>
                : <>No base rent on file for FY {year} yet, so there's nothing to take a percentage of — enter the fee as a dollar figure instead.</>}
            </span>
          )}
        </div>
      </form>

      {items.length === 0 && (
        // The pre-save total rides along as the mutation's variable so ↩ Undo can put it
        // back. Omit it and undo writes 0 — and rebuilds every tenant's bill at no CAM.
        <form className="row" onSubmit={(e) => { e.preventDefault(); saveFlat.mutate(Number(expense?.cam_total) || 0); }} style={{ marginTop: 10 }}>
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
