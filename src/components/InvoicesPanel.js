import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listInvoices, listPayments, recordPayment, deletePayment, updateInvoice, deleteInvoice } from '../lib/api';
import { money, fmtDate } from '../lib/format';
import MutationError from './MutationError';

// Per-lease receivables: each saved invoice with its derived balance + status, a
// "record payment" form (partial payments supported), and the payment history.
// Invoices are created from the Financials → Invoice modal ("Save to receivables").
const STATUS_TONE = { paid: 'good', partial: 'warn', overdue: 'danger', sent: 'info', draft: 'info', void: 'info' };

export default function InvoicesPanel({ leaseId }) {
  const qc = useQueryClient();
  const { data: invoices = [], isLoading } = useQuery({ queryKey: ['invoices', leaseId], queryFn: () => listInvoices(leaseId) });
  const [openId, setOpenId] = useState(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['invoices', leaseId] });
    qc.invalidateQueries({ queryKey: ['portfolioAR'] });
    invoices.forEach((i) => qc.invalidateQueries({ queryKey: ['propertyAR', i.property_id] }));
    // Deleting/recording a payment here can change which MONTHS read as paid —
    // refresh the monthly tracker + property rent roll so they never show stale checks.
    qc.invalidateQueries({ queryKey: ['monthlyRent', leaseId] });
    qc.invalidateQueries({ queryKey: ['propertyRentRoll'] });
  };

  const voidInv = useMutation({ mutationFn: (id) => updateInvoice(id, { status: 'void' }), onSuccess: refresh });
  const removeInv = useMutation({ mutationFn: (id) => deleteInvoice(id), onSuccess: refresh });

  if (isLoading) return <p className="muted">Loading…</p>;

  if (invoices.length === 0) {
    return (
      <p className="empty-line muted">
        No invoices yet. Create one from <strong>Financials → Invoice → Save to receivables</strong>, then track payments here.
      </p>
    );
  }

  const owed = invoices
    .filter((i) => i.display_status !== 'void' && i.display_status !== 'draft')
    .reduce((s, i) => s + Math.max(0, Number(i.balance) || 0), 0);

  return (
    <div>
      <MutationError of={[voidInv, removeInv]} />
      {owed > 0 && (
        <p className="muted" style={{ marginTop: -6, marginBottom: 12, fontSize: 12.5 }}>
          Outstanding from this tenant: <strong style={{ color: 'var(--ink)' }}>{money(owed)}</strong>
        </p>
      )}
      <div className="table-wrap">
        <table style={{ minWidth: 0 }}>
          <thead><tr><th>Invoice</th><th>Issued</th><th>Due</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {invoices.map((inv) => (
              <Row
                key={inv.id}
                inv={inv}
                open={openId === inv.id}
                onToggle={() => setOpenId(openId === inv.id ? null : inv.id)}
                onRefresh={refresh}
                onVoid={() => { if (window.confirm('Void this invoice? It stops counting toward receivables.')) voidInv.mutate(inv.id); }}
                onDelete={() => { if (window.confirm('Delete this invoice and its payments permanently?')) removeInv.mutate(inv.id); }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ inv, open, onToggle, onRefresh, onVoid, onDelete }) {
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
            <PaymentBlock inv={inv} onRefresh={onRefresh} onVoid={onVoid} onDelete={onDelete} />
          </td>
        </tr>
      )}
    </>
  );
}

function PaymentBlock({ inv, onRefresh, onVoid, onDelete }) {
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

  const voidable = inv.status !== 'void';

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

      <div className="row" style={{ gap: 10, marginTop: 12 }}>
        {voidable && <button type="button" className="ghost" onClick={onVoid}>Void invoice</button>}
        <button type="button" className="ghost" onClick={onDelete}>Delete invoice</button>
      </div>
    </div>
  );
}
