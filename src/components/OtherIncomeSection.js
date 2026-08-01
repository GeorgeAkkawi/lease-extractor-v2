import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listOtherIncome, addOtherIncomeEntry, deleteOtherIncomeEntry, setOtherIncomeCategory, listLeases } from '../lib/api';
import { INCOME_CATEGORIES, incomeCategoryInfo, incomeCategoryLabel, summarizeOtherIncome } from '../lib/otherIncome';
import { money, fmtShortDate } from '../lib/format';
import MutationError from './MutationError';
import { useConfirm } from './ConfirmDialog';

// Slice 4c — income the property really received that is not tenant rent.
//
// This is the mirror of the "Owner & entity money" panel above it, and it reads the
// same way on purpose: itemized rows grouped with subtotals, an "imported" badge, a ✕
// per row. What differs is the sign and the axis — income has no billable/not-billed
// question, because nobody bills a late fee back to the tenants.
//
// ⚠ THE REASON THIS PANEL EXISTS. Before it, a late fee had exactly two destinations:
// the tenant who paid it, or Ignore. Booked against the tenant it credits their ANNUAL
// INVOICE, so allocatePayments reads the month over-paid and the Ledger's Collected
// column reports rent that never arrived. Recording WHO it came from is still real
// information, so `lease_id` keeps it — in a table no billing code reads.
export default function OtherIncomeSection({ propId, year }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ category: 'late_fee', amount: '', txn_date: '', label: '', lease_id: '' });
  const [editCat, setEditCat] = useState(null);

  const { data: entries = [] } = useQuery({
    queryKey: ['otherIncome', propId, year],
    queryFn: () => listOtherIncome(propId, year),
  });
  // Already in cache on this page — the per-tenant breakdown reads the same key.
  const { data: leases = [] } = useQuery({ queryKey: ['leases', propId], queryFn: () => listLeases(propId) });
  const tenantName = (id) => leases.find((l) => l.id === id)?.tenant_name || null;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['otherIncome'] });

  const add = useMutation({
    mutationFn: (f) => addOtherIncomeEntry({
      property_id: propId,
      lease_id: f.lease_id || null,
      year,
      category: f.category || 'other',
      label: f.label || null,
      amount: f.amount,
      txn_date: f.txn_date || null,
    }),
    onSuccess: () => { setAdding(false); setForm({ category: 'late_fee', amount: '', txn_date: '', label: '', lease_id: '' }); invalidate(); },
  });
  const remove = useMutation({ mutationFn: (id) => deleteOtherIncomeEntry(id), onSuccess: invalidate });
  const setCat = useMutation({
    mutationFn: ({ id, category }) => setOtherIncomeCategory(id, category),
    onSuccess: () => { setEditCat(null); invalidate(); },
  });

  const sum = summarizeOtherIncome(entries);

  async function confirmRemove(row) {
    const ok = await askConfirm({
      title: 'Remove this income?',
      message: `${row.label || incomeCategoryLabel(row.category)} — ${money(row.amount)}${row.txn_date ? ` on ${fmtShortDate(row.txn_date)}` : ''}.`,
      implications: [
        'The record of this money arriving is deleted for good.',
        'No tenant’s invoice and no rent figure changes — this row never fed either.',
        row.import_id ? 'It was recorded by a statement import; removing it here does NOT undo the rest of that import.' : null,
      ].filter(Boolean),
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (ok) remove.mutate(row.id);
  }

  // Every income row carries a category, so unlike an expense bucket there is no
  // "nobody has decided" state to nag about — the pick is made at the moment the money
  // is placed. The chip is here to CHANGE it, not to fill a hole.
  const catChip = (row) => {
    if (editCat === row.id) {
      return (
        <select
          className="text-input" style={{ maxWidth: 175, fontSize: 12, marginTop: 4 }}
          autoFocus
          value={row.category || 'other'}
          onChange={(e) => setCat.mutate({ id: row.id, category: e.target.value })}
          onBlur={() => setEditCat(null)}
        >
          {INCOME_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      );
    }
    return (
      <button
        type="button"
        className="cat-chip"
        onClick={() => setEditCat(row.id)}
        title="What kind of income this is. Reporting only — it can never change what a tenant is billed."
      >
        {incomeCategoryLabel(row.category)}
      </button>
    );
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>Other income · FY {year}</strong>
        <button type="button" className="secondary btn-sm" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : '＋ Record one'}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Income this property really received that isn’t rent — late fees, parking, laundry, a utility
        a tenant paid back, an insurance payout. Recorded here rather than against a lease, because a
        payment booked against a tenant settles their <strong>rent</strong>, and these don’t.
      </div>

      {adding && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <select className="text-input" style={{ maxWidth: 190 }} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {INCOME_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <input className="text-input" style={{ maxWidth: 190 }} placeholder="What it was (optional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <input className="text-input" style={{ maxWidth: 130 }} type="number" step="0.01" placeholder="Amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <input className="text-input" style={{ maxWidth: 150, minWidth: 0 }} type="date" value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} />
          <select className="text-input" style={{ maxWidth: 190 }} value={form.lease_id} onChange={(e) => setForm({ ...form, lease_id: e.target.value })}>
            <option value="">From no particular tenant</option>
            {leases.map((l) => <option key={l.id} value={l.id}>{l.tenant_name}</option>)}
          </select>
          <button type="button" className="btn-sm" disabled={!(Number(form.amount) > 0) || add.isPending} onClick={() => add.mutate(form)}>Add</button>
          <span className="muted" style={{ fontSize: 11 }}>{incomeCategoryInfo(form.category).hint}</span>
        </div>
      )}

      {!entries.length && !adding && (
        <p className="muted" style={{ fontSize: 12 }}>
          Nothing recorded for FY {year}. Import a statement and any deposit that isn’t rent can be
          placed here — or record one by hand.
        </p>
      )}

      {sum.groups.map((g) => (
        <div key={g.key} style={{ marginTop: 14 }}>
          <div className="fin-subhead" title={incomeCategoryInfo(g.key).hint}>{g.label}</div>
          {g.rows.map((e, i) => (
            <div className={`cam-row${i === g.rows.length - 1 ? ' last' : ''}`} key={e.id}>
              <div>
                {e.label || g.label}
                {e.import_id && (
                  <span className="badge info" style={{ marginLeft: 8 }} title="Recorded by a bank-statement import — ✕ removes just this row; ↩ Undo on the import reverses the whole statement">
                    imported
                  </span>
                )}
                {/* Who it came from, when we know — attribution WITHOUT billing. The
                    tenant is named here and nowhere near their invoice. */}
                {e.lease_id && tenantName(e.lease_id) && (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>from {tenantName(e.lease_id)}</span>
                )}
                <div>{catChip(e)}</div>
              </div>
              <div className="num">{money(e.amount)}</div>
              <div className="num muted" style={{ fontSize: 12 }}>{fmtShortDate(e.txn_date)}</div>
              <button className="icon-btn danger-btn" onClick={() => confirmRemove(e)}>✕</button>
            </div>
          ))}
          <div className="cam-row cam-total">
            <div className="muted">{g.label}{g.count > 1 ? ` · ${g.count} entries` : ''}</div>
            <div className="num"><b>{money(g.total)}</b></div>
            <div />
            <div />
          </div>
        </div>
      ))}

      {sum.count > 0 && (
        <div className="muted" style={{ fontSize: 11, marginTop: 12 }}>
          {money(sum.total)} of income NOI has never counted — it isn’t rent, so no invoice and no
          tenant’s Collected figure includes it. It is added back in “What actually stayed” above.
        </div>
      )}
      <MutationError of={[add, remove, setCat]} />
    </div>
  );
}
