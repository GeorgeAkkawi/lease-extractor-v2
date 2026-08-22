import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listInvoices, listPayments, recordPayment, deletePayment, updateInvoice } from '../lib/api';
import { settlePaymentChange } from '../lib/invalidate';
import { money, fmtDate } from '../lib/format';
import MutationError from './MutationError';
import { useConfirm } from './ConfirmDialog';
import { useOptimisticRemove } from './useOptimisticRemove';
import SelectMenu from './SelectMenu';

// Per-lease invoices & payments: each invoice with its derived balance + status, a
// "record payment" form (partial payments supported), and the payment history. Invoices
// land here when a year is reconciled on the property's Financials page — ⚖ Reconcile
// turns a shortfall into its own reconciliation invoice (an undone reconcile shows
// under "removed").
const STATUS_TONE = { paid: 'good', partial: 'warn', overdue: 'danger', sent: 'info', void: 'info' };
// ⚠ "SENT" IS A BUSINESS FACT THIS APP NEVER PERFORMS. `ensureInvoice` stamps status 'sent'
// the first time a month is ticked on the Ledger, and there is no send path anywhere in the
// product — so the column asserted, on a brand-new client's first invoice, that a document had
// gone to a tenant who has never heard from it. The stored value stays (the views, the
// receivables math and 0055's index all read it); only the word the landlord sees changes.
const STATUS_LABEL = { sent: 'issued', void: 'removed' };
const STATUS_TITLE = {
  sent: 'Raised by Amlak and counting toward receivables. Amlak does not email invoices — send it yourself if the tenant needs a copy.',
  void: 'Removed — it counts toward nothing. Restore it to put its payments back on the Rent Ledger.',
};

export default function InvoicesPanel({ leaseId }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const { data: invoices = [], isLoading } = useQuery({ queryKey: ['invoices', leaseId], queryFn: () => listInvoices(leaseId) });
  const [openId, setOpenId] = useState(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['invoices', leaseId] });
  };
  // ⚠ VOIDING AN INVOICE IS A PAYMENT CHANGE, because every ledger read filters void
  // invoices out — `getYearInvoice`, `getMonthlyRent` and `getPropertyMonthlyRoll` all do.
  // So the moment this lands, every payment recorded against it leaves the Rent Ledger grid,
  // the lease's monthly tracker, the Tenant statement and the Overview's collected figure.
  // Invalidating only ['invoices', leaseId] repainted the row and left all four quoting a
  // tenant who had paid in full — until the next hard reload.
  const settleInv = (inv) => { refresh(); settlePaymentChange(qc, { propertyId: inv?.property_id }); };

  // "Remove invoice" = void (kept, not destroyed) so a mistaken invoice stops counting
  // toward receivables while its history stays recoverable under "removed".
  const removeInv = useMutation({ mutationFn: (inv) => updateInvoice(inv.id, { status: 'void' }), onSuccess: (_d, inv) => settleInv(inv) });
  // …and back again. Without this the dialog's "reversible" was simply false: nothing in the
  // app could un-void an invoice, and re-ticking a month raised a NEW one while the real
  // cheques stayed orphaned on the dead one forever. 0055's index allows exactly one live
  // invoice per lease + year, so a restore is refused while another one holds that slot.
  const restoreInv = useMutation({ mutationFn: (inv) => updateInvoice(inv.id, { status: 'sent' }), onSuccess: (_d, inv) => settleInv(inv) });

  if (isLoading) return <p className="muted">Loading…</p>;

  if (invoices.length === 0) {
    return (
      <p className="empty-line muted">
        Invoices appear here when you reconcile a year on the property's <strong>Financials</strong> page —
        a shortfall becomes a reconciliation invoice in receivables.
      </p>
    );
  }

  const live = invoices.filter((i) => i.display_status !== 'void');
  const removed = invoices.filter((i) => i.display_status === 'void');
  // Which fiscal years already hold a live invoice — the slot 0055's unique index protects.
  const liveYears = new Set(live.map((i) => Number(i.year)));
  const owed = live.reduce((s, i) => s + Math.max(0, Number(i.balance) || 0), 0);
  const shown = showRemoved ? invoices : live;

  return (
    <div>
      <MutationError of={[removeInv, restoreInv]} />
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
                canRestore={!liveYears.has(Number(inv.year))}
                onRestore={() => restoreInv.mutate(inv)}
                restorePending={restoreInv.isPending}
                // ⚠ THE PAYMENTS ARE THE POINT, so the dialog is built from the rows the
                // expanded block already has in hand. "Recorded payments stay attached" was
                // true and useless: they stay attached to an invoice nothing on any money
                // screen will read again, which is not what a landlord hears.
                onRemove={async (payments = []) => {
                  const n = payments.length;
                  const paid = payments.reduce((t, p) => t + (Number(p.amount) || 0), 0);
                  if (await askConfirm({
                    title: 'Remove invoice?',
                    message: `Remove the FY ${inv.year} invoice for this tenant?`,
                    implications: [
                      'It stops counting toward receivables.',
                      n > 0
                        ? `The ${n} payment${n === 1 ? '' : 's'} recorded against it (${money(paid)}) ${n === 1 ? 'stops' : 'stop'} showing on the Rent Ledger, the monthly tracker and the tenant statement — the tenant reads as having paid nothing for ${inv.year}.`
                        : 'No payments are recorded against it yet.',
                      'You can put it back from “removed” below, as long as no other invoice has been issued for that year since.',
                    ],
                    confirmLabel: 'Remove',
                    tone: 'warn',
                  })) removeInv.mutate(inv);
                }}
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

function Row({ inv, open, onToggle, onRefresh, onRemove, canRestore, onRestore, restorePending }) {
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
        <td><span className={`badge ${tone}`} title={STATUS_TITLE[inv.display_status] || undefined}>{STATUS_LABEL[inv.display_status] || inv.display_status}</span></td>
        <td className="num" style={{ whiteSpace: 'nowrap' }}>
          <button type="button" className="ghost" onClick={onToggle}>{open ? 'Close' : 'Payments'}</button>
          {/* The other half of "you can put it back". Refused rather than hidden when the year
              already holds a live invoice, so the reason is on screen instead of arriving as a
              constraint error from the database. */}
          {inv.display_status === 'void' && (canRestore ? (
            <button type="button" className="ghost" disabled={restorePending} onClick={onRestore} style={{ marginLeft: 6 }}
              title={`Put the FY ${inv.year} invoice back — its payments return to the Rent Ledger and the tenant statement`}>
              Restore
            </button>
          ) : (
            <span className="muted" style={{ fontSize: 12, marginLeft: 6 }} title={`FY ${inv.year} already has a live invoice — remove that one first`}>
              can’t restore
            </span>
          ))}
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

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function PaymentBlock({ inv, onRefresh, onRemove }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const { data: payments = [] } = useQuery({ queryKey: ['payments', inv.id], queryFn: () => listPayments(inv.id) });
  const [form, setForm] = useState({ amount: Number(inv.balance) > 0 ? String(inv.balance) : '', paid_date: '', method: 'check', note: '', period_month: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Month tags only make sense on the year's ANNUAL invoice — a reconciliation
  // true-up is a one-off bill, not part of the monthly stream.
  const monthTaggable = (inv.kind ?? 'annual') === 'annual';

  // ⚠ THE NAMED SET, not a third hand-rolled list. The one this replaced omitted
  // ['portfolioBasis'], so recording a cheque moved the Ledger and left the Overview's
  // collected figure on the pre-payment number — the exact omission `settlePaymentChange`
  // was created to end, sitting on the one surface that still hand-rolled it (CLAUDE.md §6).
  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['payments', inv.id] });
    settlePaymentChange(qc, { propertyId: inv.property_id });
    onRefresh();
  };

  const add = useMutation({
    mutationFn: () => recordPayment({
      invoice_id: inv.id, lease_id: inv.lease_id,
      amount: Number(form.amount), paid_date: form.paid_date || undefined,
      method: form.method || null, note: form.note || null,
      period_month: monthTaggable && form.period_month !== '' ? Number(form.period_month) : null,
      // A figure the landlord typed. It is never re-priced when a billed figure moves — that
      // used to depend on whether he happened to fill the Note box too (0088).
      source: 'manual',
    }),
    onSuccess: () => { setForm({ amount: '', paid_date: '', method: 'check', note: '', period_month: '' }); refreshAll(); },
  });
  const remove = useOptimisticRemove({
    queryKey: ['payments', inv.id], idOf: (id) => id,
    mutationFn: (id) => deletePayment(id), onSuccess: refreshAll,
  });

  return (
    <div style={{ padding: '12px 4px' }}>
      <MutationError of={[add, remove]} />
      {/* What this invoice IS. `notes` carries the est-vs-actual breakdown and the
          "prorated — N of 12 months in term" note that a part-year settlement needs in order
          not to look like an arithmetic mistake — written at creation and, until now, read by
          no screen in the app. A landlord asked "what is this $985 for?" had nothing here. */}
      {inv.notes && <p className="muted" style={{ marginTop: 0, marginBottom: 12, fontSize: 12.5 }}>{inv.notes}</p>}
      {payments.length > 0 ? (
        <table style={{ minWidth: 0, marginBottom: 12 }}>
          <thead><tr><th>Paid</th><th className="num">Amount</th><th>For month</th><th>Method</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id}>
                <td>{fmtDate(p.paid_date)}</td>
                <td className="num">{money(p.amount)}</td>
                <td>{p.period_month ? MONTH_NAMES[Number(p.period_month) - 1]?.slice(0, 3) : '—'}</td>
                <td>{p.method || '—'}</td>
                <td>{p.note || '—'}</td>
                <td className="num">
                  <button type="button" className="icon-btn danger-btn" title="Delete this payment"
                    onClick={async () => {
                      // The same action has two truths, and the Ledger's door already told
                      // both. A payment the bank-statement import created is released back to
                      // "Money not yet placed" with its real date and description — so
                      // "this can't be undone" was wrong, and where the money went was unsaid.
                      const imported = p.source === 'import';
                      if (await askConfirm({
                        title: 'Delete payment?',
                        message: 'Delete this recorded payment?',
                        implications: [
                          'The invoice balance and receivables update.',
                          'The ledger box for its month reopens.',
                          imported
                            ? 'This deposit came from an imported bank statement — it goes back to “Money not yet placed” on the Rent Ledger, keeping its real date and description. File it from there rather than re-recording it here.'
                            : 'This can’t be undone.',
                        ],
                        confirmLabel: 'Delete',
                      })) remove.mutate(p.id);
                    }}>✕</button>
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
          {monthTaggable && (
            <label className="form-field" style={{ marginBottom: 0, maxWidth: 150 }} title="Optional — which month's rent this payment is for. Leave blank for a lump/partial payment; the Ledger fills the earliest months first.">
              <span>For month</span>
              <SelectMenu className="text-input" value={form.period_month} onChange={set('period_month')}>
                <option value="">— (lump)</option>
                {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
              </SelectMenu>
            </label>
          )}
          <label className="form-field" style={{ marginBottom: 0, maxWidth: 130 }}><span>Method</span>
            <SelectMenu className="text-input" value={form.method} onChange={set('method')}>
              <option value="check">Check</option><option value="ach">ACH</option><option value="wire">Wire</option>
              <option value="card">Card</option><option value="cash">Cash</option><option value="other">Other</option>
            </SelectMenu>
          </label>
          <label className="form-field" style={{ marginBottom: 0, maxWidth: 200 }}><span>Note</span><input className="text-input" value={form.note} onChange={set('note')} /></label>
          <button type="submit" disabled={form.amount === '' || add.isPending}>+ Record payment</button>
        </form>
      )}

      {inv.status !== 'void' && (
        <div className="row" style={{ gap: 10, marginTop: 12 }}>
          <button type="button" className="ghost" onClick={() => onRemove(payments)}>Remove invoice</button>
        </div>
      )}
    </div>
  );
}
