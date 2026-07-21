import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  getStatementMatchContext,
  listReconciliations,
  listSnapshots,
  applyStatementImport,
  saveImportRule,
} from '../lib/api';
import { matchStatement, suggestRulePattern } from '../lib/statementMatch';
import { money, fmtDate } from '../lib/format';
import MutationError from './MutationError';

// The full-page statement review — a 40–100-line table doesn't belong in a modal.
// Every line the parser produced is here in one of three groups (Money in ·
// Money out · Duplicates & skipped), each with the matcher's SUGGESTION as an
// editable pick. Nothing writes until Save; the footer summarizes exactly what
// will be recorded first. The property the EXPENSES land on is stated plainly up
// top (deposits self-route to their tenant's own property regardless), with a
// switch banner when the deposits vote for a different property.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KIND_LABEL = { tenant: 'Tenant payment', expense_tax: 'Property taxes', expense_cam: 'CAM expense', expense_roof: 'Roof expense', ignore: 'Ignore', unmatched: '— pick —' };
const CONF_TONE = { rule: 'good', high: 'good', medium: 'warn', low: 'warn', none: 'info' };
const CONF_LABEL = { rule: 'rule', high: 'confident', medium: 'likely', low: 'weak', none: '?' };

export default function StatementReview({ propertyId, year, fileName, accountHint, parsed, pdfLane = false, onCancel, onSaved }) {
  const { data: ctx } = useQuery({
    queryKey: ['statementContext', propertyId, year],
    queryFn: () => getStatementMatchContext(propertyId, year),
  });

  // Which property the statement's EXPENSES record on. Defaults to the account's
  // last-used property (the ••4821 memory) when known, else the page's.
  const [expensePropPick, setExpensePropPick] = useState(null);
  const remembered = accountHint && ctx?.accountMemory?.[accountHint]?.property_id;
  const expenseProp = expensePropPick || remembered || propertyId;
  const { data: recons = [] } = useQuery({
    queryKey: ['reconciliations', expenseProp, year],
    queryFn: () => listReconciliations(expenseProp, year),
  });
  const { data: snapshots = [] } = useQuery({
    queryKey: ['snapshots', expenseProp],
    queryFn: () => listSnapshots(expenseProp),
  });
  const closedYears = useMemo(() => new Set((snapshots || []).map((s) => Number(s.year))), [snapshots]);

  // Per-row user overrides, keyed by row index: { checked, pick, month, always }.
  // `pick` = 'lease:{id}' | 'expense_tax' | 'expense_cam' | 'expense_roof' | 'ignore'.
  const [overrides, setOverrides] = useState({});
  const setOv = (i, patch) => setOverrides((o) => ({ ...o, [i]: { ...o[i], ...patch } }));

  // Draft rules from this session's "always" ticks re-apply to the OTHER lines of
  // this same import immediately (a garbled payee fixed once fixes the whole file).
  const draftRules = useMemo(() => {
    const out = [];
    for (const [i, ov] of Object.entries(overrides)) {
      if (!ov?.always) continue;
      const txn = parsed.transactions[Number(i)];
      if (!txn) continue;
      const pattern = suggestRulePattern(txn.description);
      const resolved = resolvePick(ov.pick);
      if (pattern && resolved) out.push({ pattern, target_kind: resolved.kind, lease_id: resolved.lease_id || null, cam_label: null, property_id: expenseProp });
    }
    return out;
  }, [overrides, parsed.transactions, expenseProp]);

  const matched = useMemo(() => {
    if (!ctx) return null;
    return matchStatement({
      transactions: parsed.transactions,
      propertyId: expenseProp,
      tenants: ctx.tenants,
      rules: [...draftRules, ...ctx.rules],
      existingHashes: ctx.existingHashes,
    });
  }, [ctx, parsed.transactions, expenseProp, draftRules]);

  // One resolved decision per row: what Save would actually write.
  const resolved = useMemo(() => {
    if (!matched) return [];
    return matched.rows.map((row, i) => {
      const ov = overrides[i] || {};
      const pick = ov.pick != null ? resolvePick(ov.pick) : null;
      const kind = pick ? pick.kind : row.kind === 'unmatched' ? 'ignore' : row.kind;
      const leaseId = pick ? pick.lease_id : row.candidate?.lease_id || null;
      const tenant = leaseId ? ctx.tenants.find((t) => t.lease_id === leaseId) : null;
      // Recompute recon routing when the user re-picked the tenant by hand.
      const toRecon = !pick ? !!row.candidate?.toRecon : !!(tenant?.reconBalance > 0 && Math.abs(tenant.reconBalance - row.txn.amount) <= Math.max(1, 0.01 * tenant.reconBalance));
      const month = ov.month !== undefined ? (ov.month === '' ? null : Number(ov.month)) : row.month;
      const defaultChecked = row.checked && !row.txn.needsReview;
      const checked = ov.checked !== undefined ? ov.checked : defaultChecked;
      // An ignored/unresolved line writes nothing, whatever the checkbox says.
      const writable = kind === 'tenant' ? !!(leaseId && tenant) : kind.startsWith('expense_');
      return { row, i, kind, leaseId, tenant, toRecon, month: toRecon ? null : month, checked: writable && checked, always: !!ov.always };
    });
  }, [matched, overrides, ctx]);

  const save = useMutation({
    mutationFn: async () => {
      const entries = [];
      for (const r of resolved) {
        if (!r.checked) continue;
        if (r.kind === 'tenant' && r.tenant) {
          entries.push({
            type: 'payment', lease_id: r.tenant.lease_id, property_id: r.tenant.property_id, year: r.row.year,
            amount: r.row.txn.amount, date: r.row.txn.date, description: r.row.txn.description,
            period_month: r.month || null, reconInvoiceId: r.toRecon ? r.tenant.reconInvoiceId : null, hash: r.row.hash,
          });
        } else if (r.kind === 'expense_cam') {
          entries.push({ type: 'cam', property_id: expenseProp, year: r.row.year, amount: r.row.txn.amount, label: r.row.label || 'Imported expense', hash: r.row.hash });
        } else if (r.kind === 'expense_tax') {
          entries.push({ type: 'tax', property_id: expenseProp, year: r.row.year, amount: r.row.txn.amount, hash: r.row.hash });
        } else if (r.kind === 'expense_roof') {
          entries.push({ type: 'roof', property_id: expenseProp, year: r.row.year, amount: r.row.txn.amount, hash: r.row.hash });
        }
      }
      // Persist this session's "always match" rules (best-effort — a rule failure
      // must not lose the import itself).
      for (const dr of draftRules) {
        try { await saveImportRule(dr); } catch { /* reviewed next time */ }
      }
      return applyStatementImport({ propertyId: expenseProp, year, fileName, accountHint, entries });
    },
    onSuccess: (res) => onSaved(res),
  });

  if (!ctx || !matched) return <p className="muted">Reading the statement…</p>;

  const rows = resolved;
  const moneyIn = rows.filter((r) => !r.row.duplicate && r.row.txn.direction === 'in');
  const moneyOut = rows.filter((r) => !r.row.duplicate && r.row.txn.direction === 'out');
  const dupes = rows.filter((r) => r.row.duplicate);

  // Footer summary of exactly what Save writes.
  const willPay = rows.filter((r) => r.checked && r.kind === 'tenant' && r.tenant);
  const willExpense = rows.filter((r) => r.checked && r.kind.startsWith('expense_'));
  const payTotal = willPay.reduce((s, r) => s + r.row.txn.amount, 0);
  const expTotal = willExpense.reduce((s, r) => s + r.row.txn.amount, 0);
  const payTenants = new Set(willPay.map((r) => r.tenant.lease_id)).size;
  const ignored = rows.filter((r) => !r.checked).length;
  const reconciledCount = (recons || []).length;
  const closedYearLines = rows.filter((r) => r.checked && closedYears.has(r.row.year));
  const propName = (id) => ctx.properties.find((p) => p.id === id)?.name || '…';

  const acceptAllConfident = () => {
    const patch = {};
    rows.forEach((r) => {
      if (!r.row.duplicate && (r.row.confidence === 'high' || r.row.confidence === 'rule') && !r.row.txn.needsReview) patch[r.i] = { ...overrides[r.i], checked: true };
    });
    setOverrides((o) => ({ ...o, ...patch }));
  };

  return (
    <div className="stmt-review">
      <div className="panel-head" style={{ alignItems: 'flex-start' }}>
        <div>
          <strong>Review statement — {fileName || 'statement'}</strong>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {parsed.transactions.length} line{parsed.transactions.length === 1 ? '' : 's'} parsed · {parsed.skippedLines.length} skipped
            {pdfLane ? ' · transcribed from a PDF — check the count against your statement' : ''}
            {accountHint ? ` · account ${accountHint}` : ''}
          </div>
          {(parsed.warnings || []).map((w, i) => <div key={i} className="note-msg warn" style={{ marginTop: 6 }}>{w}</div>)}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="ghost" onClick={acceptAllConfident}>✓ Accept all confident</button>
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>

      <div className="stmt-propline">
        <label>
          Expenses will be recorded on:{' '}
          <select className="text-input" value={expenseProp} onChange={(e) => setExpensePropPick(e.target.value)} style={{ maxWidth: 240, display: 'inline-block' }}>
            {ctx.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {remembered && !expensePropPick && (
          <span className="muted" style={{ fontSize: 12 }}>Account {accountHint} — last imported into {propName(remembered)}</span>
        )}
        <span className="muted" style={{ fontSize: 12 }}>Tenant deposits post to each tenant's own property automatically.</span>
      </div>
      {matched.propertyVote && matched.propertyVote.propertyId !== expenseProp && (
        <div className="note-msg warn" style={{ margin: '8px 0' }}>
          {matched.propertyVote.count} of {matched.propertyVote.total} matched deposits belong to <strong>{matched.propertyVote.propertyName}</strong> tenants — record this statement's expenses there instead?{' '}
          <button type="button" className="btn-sm secondary" onClick={() => setExpensePropPick(matched.propertyVote.propertyId)}>Switch</button>
        </div>
      )}

      <Group title={`Money in · ${moneyIn.length}`} rows={moneyIn} ctx={ctx} year={year} closedYears={closedYears} expenseProp={expenseProp} setOv={setOv} />
      <Group title={`Money out · ${moneyOut.length}`} rows={moneyOut} ctx={ctx} year={year} closedYears={closedYears} expenseProp={expenseProp} setOv={setOv} />
      {dupes.length > 0 && <DupeGroup rows={dupes} ctx={ctx} year={year} closedYears={closedYears} setOv={setOv} />}
      {parsed.skippedLines.length > 0 && <SkippedGroup skipped={parsed.skippedLines} />}

      <div className="stmt-footer">
        {reconciledCount > 0 && willExpense.length > 0 && (
          <div className="note-msg warn">
            FY{year} has {reconciledCount} reconciled tenant{reconciledCount === 1 ? '' : 's'} on {propName(expenseProp)} — new expenses change their actuals. Consider ↩ Undo on those reconciliations and re-running them after the import.
          </div>
        )}
        {closedYearLines.length > 0 && (
          <div className="note-msg warn">
            {closedYearLines.length} line{closedYearLines.length === 1 ? '' : 's'} fall in a closed fiscal year — they import normally, but that year's History snapshot is stale until you close it again.
          </div>
        )}
        <MutationError of={[save]} />
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div className="muted">
            <strong>{willPay.length}</strong> payment{willPay.length === 1 ? '' : 's'} to <strong>{payTenants}</strong> tenant{payTenants === 1 ? '' : 's'} · {money(payTotal)} in
            {' — '}<strong>{willExpense.length}</strong> expense{willExpense.length === 1 ? '' : 's'} · {money(expTotal)} out
            {' — '}<strong>{ignored}</strong> ignored
          </div>
          <button type="button" disabled={save.isPending || (willPay.length === 0 && willExpense.length === 0)} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save to ledger'}
          </button>
        </div>
      </div>
    </div>
  );
}

function resolvePick(pick) {
  if (!pick) return null;
  if (pick.startsWith('lease:')) return { kind: 'tenant', lease_id: pick.slice(6) };
  if (pick === 'expense_tax' || pick === 'expense_cam' || pick === 'expense_roof' || pick === 'ignore') return { kind: pick };
  return null;
}

function Group({ title, rows, ctx, year, closedYears, expenseProp, setOv }) {
  if (!rows.length) return null;
  return (
    <div className="stmt-group">
      <div className="fin-subhead">{title}</div>
      <div className="table-wrap">
        <table className="stmt-table">
          <thead>
            <tr><th></th><th>Date</th><th>Description</th><th className="num">Amount</th><th>Record as</th><th>For month</th><th></th><th>Always</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => <ReviewRow key={r.i} r={r} ctx={ctx} year={year} closedYears={closedYears} expenseProp={expenseProp} setOv={setOv} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewRow({ r, ctx, year, closedYears, expenseProp, setOv, dupe = false }) {
  const { row } = r;
  const txn = row.txn;
  const isIn = txn.direction === 'in';
  const pickValue = r.kind === 'tenant' && r.leaseId ? `lease:${r.leaseId}` : r.kind === 'unmatched' ? '' : r.kind;
  const candidateIds = new Set((row.candidates || []).map((c) => c.lease_id));
  return (
    <tr className={r.checked ? undefined : 'stmt-off'}>
      <td>
        <input type="checkbox" checked={r.checked} onChange={(e) => setOv(r.i, { checked: e.target.checked })} title={dupe ? 'Import anyway' : 'Include this line'} />
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {fmtDate(txn.date)}
        {row.year !== year && <span className="badge info" style={{ marginLeft: 5 }} title="This line's own date decides its fiscal year">FY {row.year}</span>}
        {closedYears.has(row.year) && <span className="badge warn" style={{ marginLeft: 5 }} title="This fiscal year was closed — it still imports; re-close the year to refresh its snapshot">FY {row.year} closed</span>}
      </td>
      <td className="stmt-desc" title={txn.description}>
        {txn.description}
        {txn.needsReview && <span className="badge warn" style={{ marginLeft: 5 }} title="This line's amount doesn't match the statement's running balance — double-check it">check</span>}
        {dupe && <span className="badge info" style={{ marginLeft: 5 }}>already imported</span>}
      </td>
      <td className="num">{money(txn.amount)}</td>
      <td>
        <select className="text-input" value={pickValue} onChange={(e) => setOv(r.i, { pick: e.target.value || 'ignore' })}>
          {isIn ? (
            <>
              <option value="">{KIND_LABEL.unmatched}</option>
              {(row.candidates || []).length > 0 && (
                <optgroup label="Suggested">
                  {row.candidates.map((c) => (
                    <option key={c.lease_id} value={`lease:${c.lease_id}`}>
                      {c.tenant_name}{c.property_id !== expenseProp ? ` — ${c.property_name}` : ''} ({Math.round(c.score * 100)}%)
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="All tenants">
                {ctx.tenants.filter((t) => !candidateIds.has(t.lease_id)).map((t) => (
                  <option key={t.lease_id} value={`lease:${t.lease_id}`}>{t.tenant_name} — {t.property_name}</option>
                ))}
              </optgroup>
              <option value="ignore">Ignore</option>
            </>
          ) : (
            <>
              <option value="expense_tax">Property taxes</option>
              <option value="expense_cam">CAM expense{row.label ? ` — ${row.label}` : ''}</option>
              <option value="expense_roof">Roof expense</option>
              <option value="ignore">Ignore</option>
            </>
          )}
        </select>
        {row.reason && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{row.reason}</div>}
        {r.row.collision && (
          <div className="note-msg warn" style={{ marginTop: 4 }}>possibly already recorded by hand — left unchecked</div>
        )}
      </td>
      <td>
        {isIn && r.kind === 'tenant' && (
          r.toRecon ? (
            <span className="badge info" title="Matches this tenant's open reconciliation true-up — records against that invoice, no month">true-up</span>
          ) : (
            <select className="text-input" value={r.month ?? ''} onChange={(e) => setOv(r.i, { month: e.target.value })}>
              <option value="">— (lump)</option>
              {MONTH_NAMES.map((nm, mi) => <option key={nm} value={mi + 1}>{nm.slice(0, 3)}</option>)}
            </select>
          )
        )}
      </td>
      <td>
        <span className={`badge ${CONF_TONE[row.confidence] || 'info'}`} title={`Match confidence: ${row.confidence}`}>{CONF_LABEL[row.confidence] || row.confidence}</span>
      </td>
      <td>
        {(r.kind === 'tenant' || r.kind.startsWith('expense_')) && (
          <input
            type="checkbox"
            checked={r.always}
            onChange={(e) => setOv(r.i, { always: e.target.checked })}
            title={`Always match "${suggestRulePattern(txn.description) || txn.description}" this way on future imports`}
          />
        )}
      </td>
    </tr>
  );
}

function DupeGroup({ rows, ctx, year, closedYears, setOv }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stmt-group">
      <button type="button" className="ghost" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Duplicates · {rows.length} — already imported, skipped by default
      </button>
      {open && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="stmt-table">
            <thead><tr><th></th><th>Date</th><th>Description</th><th className="num">Amount</th><th>Record as</th><th>For month</th><th></th><th>Always</th></tr></thead>
            <tbody>
              {rows.map((r) => <ReviewRow key={r.i} r={r} ctx={ctx} year={year} closedYears={closedYears} expenseProp={null} setOv={setOv} dupe />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SkippedGroup({ skipped }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stmt-group">
      <button type="button" className="ghost" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Skipped lines · {skipped.length} — couldn't be read as transactions
      </button>
      {open && (
        <ul className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {skipped.map((s, i) => <li key={i}>line {s.line}: {s.reason} — <code>{String(s.raw).slice(0, 90)}</code></li>)}
        </ul>
      )}
    </div>
  );
}
