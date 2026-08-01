import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listEntityLedger, addEntityLedgerEntry, deleteEntityLedgerEntry, setEntityLedgerCategory } from '../lib/api';
import { ENTITY_KINDS, entityKindInfo, summarizeEntityLedger, entityCostCategories, entityCategoryLabel } from '../lib/entityLedger';
import { money, fmtShortDate } from '../lib/format';
import MutationError from './MutationError';
import { useConfirm } from './ConfirmDialog';

// Slice 4b — the money that crossed this property's account and is NOT the building's
// income or expense: what the owner took out, what they put in, and what the LLC
// itself cost.
//
// ⚠ Nothing on this panel can move a tenant's bill. Every row lives in entity_ledger,
// which no view, no invoice and no share calculation reads — that is why a draw
// recorded here is safe in a way a draw recorded as a "not billed" expense would not
// be. The panel says so on its face, because "where did my $20,000 go" and "why is my
// NOI wrong" are the same question asked twice.
export default function EntityLedgerSection({ propId, corporationId, year }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ kind: 'draw', amount: '', txn_date: '', label: '', category: '' });
  const [editCat, setEditCat] = useState(null);

  const { data: entries = [] } = useQuery({
    queryKey: ['entityLedger', propId, year],
    queryFn: () => listEntityLedger({ propertyId: propId, year }),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['entityLedger'] });
    qc.invalidateQueries({ queryKey: ['entityLedgerByCorps'] });
  };

  const add = useMutation({
    mutationFn: (f) => addEntityLedgerEntry({
      corporation_id: corporationId,
      property_id: propId,
      year,
      kind: f.kind,
      category: f.kind === 'cost' ? (f.category || null) : null,
      label: f.label || null,
      amount: f.amount,
      txn_date: f.txn_date || null,
    }),
    onSuccess: () => { setAdding(false); setForm({ kind: 'draw', amount: '', txn_date: '', label: '', category: '' }); invalidate(); },
  });
  const remove = useMutation({ mutationFn: (id) => deleteEntityLedgerEntry(id), onSuccess: invalidate });
  const setCat = useMutation({
    mutationFn: ({ id, category }) => setEntityLedgerCategory(id, category),
    onSuccess: () => { setEditCat(null); invalidate(); },
  });

  const sum = summarizeEntityLedger(entries);

  async function confirmRemove(row) {
    const info = entityKindInfo(row.kind);
    const ok = await askConfirm({
      title: `Remove this ${info.label.toLowerCase()}?`,
      message: `${row.label || info.label} — ${money(row.amount)}${row.txn_date ? ` on ${fmtShortDate(row.txn_date)}` : ''}.`,
      implications: [
        'The record of this money leaving your account is deleted for good.',
        'No tenant’s bill and no expense total changes — this row never fed either.',
        row.import_id ? 'It was recorded by a statement import; removing it here does NOT undo the rest of that import.' : null,
      ].filter(Boolean),
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (ok) remove.mutate(row.id);
  }

  // The category chip, in the same language as an expense bucket's — solid when
  // chosen, gold when nobody has decided. Only an entity COST has one: a draw files
  // on no line of any return, so offering it a category would invite a wrong answer.
  const catChip = (row) => {
    if (editCat === row.id) {
      return (
        <select
          className="text-input" style={{ maxWidth: 175, fontSize: 12, marginTop: 4 }}
          autoFocus
          value={row.category || ''}
          onChange={(e) => setCat.mutate({ id: row.id, category: e.target.value })}
          onBlur={() => setEditCat(null)}
        >
          <option value="">No category</option>
          {entityCostCategories().map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      );
    }
    return (
      <button
        type="button"
        className={`cat-chip${row.category ? '' : ' none'}`}
        onClick={() => setEditCat(row.id)}
        title="Which line of your return this entity cost rolls up to. Reporting only — it can never change what a tenant is billed."
      >
        {row.category ? entityCategoryLabel(row.category) : 'Set a tax category'}
      </button>
    );
  };

  const kindRows = (kind) => {
    const list = entries.filter((e) => e.kind === kind);
    if (!list.length) return null;
    const info = entityKindInfo(kind);
    const total = list.reduce((s, e) => s + Math.abs(Number(e.amount) || 0), 0);
    return (
      <div key={kind} style={{ marginTop: 14 }}>
        <div className="fin-subhead" title={info.hint}>{info.label}</div>
        {list.map((e, i) => (
          <div className={`cam-row${i === list.length - 1 ? ' last' : ''}${kind === 'cost' && !e.category ? ' cat-none' : ''}`} key={e.id}>
            <div>
              {e.label || info.label}
              {e.import_id && (
                <span className="badge info" style={{ marginLeft: 8 }} title="Recorded by a bank-statement import — ✕ removes just this row; ↩ Undo on the import reverses the whole statement">
                  imported
                </span>
              )}
              {kind === 'cost' && <div>{catChip(e)}</div>}
            </div>
            <div className="num">{money(e.amount)}</div>
            <div className="num muted" style={{ fontSize: 12 }}>{fmtShortDate(e.txn_date)}</div>
            <button className="icon-btn danger-btn" onClick={() => confirmRemove(e)}>✕</button>
          </div>
        ))}
        <div className="cam-row cam-total">
          <div className="muted">{info.label}{list.length > 1 ? ` · ${list.length} entries` : ''}</div>
          <div className="num"><b>{money(total)}</b></div>
          <div />
          <div />
        </div>
      </div>
    );
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>Owner &amp; entity money · FY {year}</strong>
        <button type="button" className="secondary btn-sm" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : '＋ Record one'}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        Money that crossed this property’s account but isn’t the building’s income or expense.
        A draw or contribution moves your <strong>equity</strong>, never income; an entity cost belongs to the
        LLC rather than to this building. None of it reaches a tenant’s bill, your CAM total, or NOI.
      </div>

      {adding && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <select className="text-input" style={{ maxWidth: 190 }} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            {ENTITY_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
          <input className="text-input" style={{ maxWidth: 190 }} placeholder="What it was (optional)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          <input className="text-input" style={{ maxWidth: 130 }} type="number" step="0.01" placeholder="Amount" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <input className="text-input" style={{ maxWidth: 150, minWidth: 0 }} type="date" value={form.txn_date} onChange={(e) => setForm({ ...form, txn_date: e.target.value })} />
          {form.kind === 'cost' && (
            <select className="text-input" style={{ maxWidth: 175 }} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="">Tax category…</option>
              {entityCostCategories().map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          )}
          <button type="button" className="btn-sm" disabled={!(Number(form.amount) > 0) || !corporationId || add.isPending} onClick={() => add.mutate(form)}>Add</button>
          <span className="muted" style={{ fontSize: 11 }}>{entityKindInfo(form.kind).hint}</span>
        </div>
      )}

      {!entries.length && !adding && (
        <p className="muted" style={{ fontSize: 12 }}>
          Nothing recorded for FY {year}. Import a statement and a line that looks like a draw or a transfer will
          offer these as destinations — or record one here by hand.
        </p>
      )}

      {ENTITY_KINDS.map((k) => kindRows(k.key))}

      {sum.count > 0 && (
        <div className="muted" style={{ fontSize: 11, marginTop: 12 }}>
          {money(sum.draws)} drawn · {money(sum.contributions)} contributed · {money(sum.costs)} of entity costs.
          None of it appears in this property’s expenses or NOI — see “What actually stayed” above.
        </div>
      )}
      <MutationError of={[add, remove, setCat]} />
    </div>
  );
}
