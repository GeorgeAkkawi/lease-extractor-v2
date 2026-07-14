import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listInvoices, listPayments, recordPayment, deletePayment, updateInvoice } from '../lib/api';
import { money, fmtDate } from '../lib/format';
import MutationError from './MutationError';

// Per-lease invoices & payments: each invoice with its derived balance + status, a
// "record payment" form (partial payments supported), and the payment history. Invoices
// are created automatically the first time a month is marked paid on the tracker above,
// or saved from the Financials → Invoice modal.
const STATUS_TONE = { paid: 'good', partial: 'warn', overdue: 'danger', sent: 'info', void: 'info' };

export default function InvoicesPanel({ leaseId }) {
  const qc = useQueryClient();
  const { data: invoices = [], isLoading } = useQuery({ queryKey: ['invoices', leaseId], queryFn: () => listInvoices(leaseId) });
  const [openId, setOpenId] = useState(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['invoices', leaseId] });
  };

  // "Remove invoice" = void (kept, not destroyed) so a mistaken invoice stops counting
  // toward receivables while its history stays recoverable under "removed".
  const removeInv = useMutation({ mutationFn: (id) => updateInvoice(id, { status: 'void' }), onSuccess: refresh });

  if (isLoading) return <p className="muted">Loading…</p>;

  if (invoices.length === 0) {
    return (
      <p className="empty-line muted">
        Invoices appear here automatically when you mark months paid above — or save one from <strong>Financials → Invoice</strong>.
      </p>
    );
  }

  const live = invoices.filter((i) => i.display_status !== 'void');
  const removed = invoices.filter((i) => i.display_status === 'void');
  const owed = live.reduce((s, i) => s + Math.max(0, Number(i.balance) || 0), 0);
  const shown = showRemoved ? invoices : live;

  return (
    <div>
      <MutationError of={[removeInv]} />
      {owed > 0 && (
        <p className="muted" style={{ marginTop: -6, marginBottom: 12, fontSize: 12.5 }}>
          Outstanding from this tenant: <strong style={{ color: 'var(--ink)' }}>{money(owed)}</strong>
        </p>
      )}
      <div className="table-wrap">
        <table style={{ minWidth: 0 }}>
          <thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {shown.map((inv) => (
              <Row
                key={inv.id}
                inv={inv}
                open={openId === inv.id}
                onToggle={() => setOpenId(openId === inv.id ? null : inv.id)}
                onRefresh={refresh}
                onRemove={() => { if (window.confirm('Remove this invoice? It stops counting toward receivables (you can still see it under “removed”).')) removeInv.mutate(inv.id); }}
              />
            ))}
          </tbody>
        </table>
      </div>
      {removed.length > 0 && (
        <button type="button" className="ghost" style={{ marginTop: 8 }} onClick={() => setShowRemoved((v) => !v)}>
          {showRemoved ? 'Hide removed' : `${removed.length} removed — show`}
        </button>
      )}
    </div>
  );
}

function Row({ inv, open, onToggle, onRefresh, onRemove }) {
  const tone = STATUS_TONE[inv.display_status] || 'info';
  return (
    <>
      <tr>
        <td>
          FY {inv.year}
          {inv.kind === 'reconciliation' && (
            <span className="badge info" style={{ marginLeft: 6 }} title="Year-end true-up of estimated vs actual CAM & tax">Reconciliation</span>
          )}
        </td>
        <td>{fmtDate(inv.issue_date)}</td>
        <td>{fmtDate(inv.due_date)}</td>
        <td className="num">{money(inv.total_amount)}</td>
        <td className="num">{money(inv.amount_paid)}</td>
        <td className="num">{money(inv.balance)}</td>
        <td><span className={`badge ${tone}`}>{inv.display_status}</span></td>
        <td className="num">
          <button type="button" className="ghost" onClick={onToggle}>{open ? 'Close' : 'Payments'}</button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8}>
            <PaymentBlock inv={inv} onRefresh={onRefresh} onRemove={onRemove} />
          </td>
        </tr>
      )}
    </>
  );
}

function PaymentBlock({ inv, onRefresh, onRemove }) {
  const qc = useQueryClient();
  const { data: payments = [] } = useQuery({ queryKey: ['payments', inv.id], queryFn: () => listPayments(inv.id) });
  const [form, setForm] = useState({ amount: Number(inv.balance) > 0 ? String(inv.balance) : '', paid_date: '', method: 'check', note: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const refreshAll = () => { qc.invalidateQueries({ queryKey: ['payments', inv.id] }); onRefresh(); };

  const add = useMutation({
    mutationFn: () => recordPayment({
      invoice_id: inv.id, lease_id: inv.lease_id,
      amount: Number(form.amount), paid_date: form.paid_date || undefined,
      method: form.method || null, note: form.note || null,
    }),
    onSuccess: () => { setForm({ amount: '', paid_date: '', method: 'check', note: '' }); refreshAll(); },
  });
  const remove = useMutation({ mutationFn: (id) => deletePayment(id), onSuccess: refreshAll });

  return (
    <div style={{ padding: '12px 4px' }}>
      <MutationError of={[add, remove]} />
      {payments.length > 0 ? (
        <table style={{ minWidth: 0, marginBottom: 12 }}>
          <thead><tr><th>Paid</th><th className="num">Amount</th><th>Method</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.paid_date)}</td>
                <td className="num">{money(p.amount)}</td>
                <td>{p.method || '—'}</td>
                <td>{p.note || '—'}</td>
                <td className="num">
                  <button type="button" className="icon-btn danger-btn" title="Delete this payment"
                    onClick={() => { if (window.confirm('Delete this payment?')) remove.mutate(p.id); }}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty-line muted" style={{ marginBottom: 12 }}>No payments recorded yet.</p>
      )}

      {Number(inv.balance) > 0 && inv.status !== 'void' && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (form.amount !== '') add.mutate(); }} style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <label className="form-field" style={{ marginBottom: 0, maxWidth: 140 }}><span>Amount</span><input className="text-input num" type="number" step="any" value={form.amount} onChange={set('amount')} /></label>
          <label className="form-field" style={{ marginBottom: 0, maxWidth: 160 }}><span>Paid on</span><input className="text-input" type="date" value={form.paid_date} onChange={set('paid_date')} /></label>
          <label className="form-field" style={{ marginBottom: 0, maxWidth: 130 }}><span>Method</span>
            <select className="text-input" value={form.method} onChange={set('method')}>
              <option value="check">Check</option><option value="ach">ACH</option><option value="wire">Wire</option>
              <option value="card">Card</option><option value="cash">Cash</option><option value="other">Other</option>
            </select>
          </label>
          <label className="form-field" style={{ marginBottom: 0, maxWidth: 200 }}><span>Note</span><input className="text-input" value={form.note} onChange={set('note')} /></label>
          <button type="submit" disabled={form.amount === '' || add.isPending}>+ Record payment</button>
        </form>
      )}

      {inv.status !== 'void' && (
        <div className="row" style={{ gap: 10, marginTop: 12 }}>
          <button type="button" className="ghost" onClick={onRemove}>Remove invoice</button>
        </div>
      )}
    </div>
  );
}
