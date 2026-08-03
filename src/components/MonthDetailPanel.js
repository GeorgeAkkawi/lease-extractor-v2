import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addAdjustment, deleteAdjustment, markMonthPaid, unmarkMonthPaid } from '../lib/api';
import { settleBillingChange } from '../lib/invalidate';
import { useModalA11y } from './modalA11y';
import { useConfirm } from './ConfirmDialog';
import MutationError from './MutationError';
import { money } from '../lib/format';
import {
  adjustmentKindsFor, adjustmentKindInfo, adjustmentsForMonth, signedAmount, monthName,
} from '../lib/adjustments';

// One month of one tenant, opened from the Rent Ledger grid — George's "go into months
// that are under or overpaid and edit … to show the differences".
//
// It answers three questions in the order a landlord asks them:
//   1. What did we bill?    scheduled base · CAM & tax · roof, then every correction
//   2. What came in?        each payment on the month, with its date
//   3. What's the gap?      and the two ways to close it — record the money, or post an
//                           adjustment saying the bill itself was different.
//
// ⚠ The distinction the panel exists to make, stated on it: recording a payment says
// MONEY ARRIVED; posting an adjustment says THE BILL WAS DIFFERENT. Blur the two and the
// Collected figure starts claiming cash that never landed.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export default function MonthDetailPanel({
  propertyId, year, month, row, comp, alloc, onClose, onMonth,
}) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const modalRef = useModalA11y(onClose);
  const [kind, setKind] = useState('camtax');
  const [dir, setDir] = useState('charge');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [refused, setRefused] = useState(null);

  const m = Number(month);
  const i = m - 1;
  const c = comp?.[m] || { base: 0, camTax: 0, roof: 0, adj: 0 };
  const owed = round2(Number(alloc?.owed?.[i]) || 0);
  const received = round2(Number(alloc?.received?.[i]) || 0);
  // The plain money difference — what the month bills less what actually arrived. NOT
  // owed − coverage: a settled month's coverage is the scheduled bill whatever the
  // amount ("paid = paid"), so that figure reads $0 on exactly the month this panel
  // exists to explain. This is the number the box's gold figure shows.
  const shortfall = round2(owed - received);
  const scheduled = round2(c.base + c.camTax + c.roof);
  const monthPayments = (row?.payments || []).filter((p) => Number(p.period_month) === m);
  const rowsForMonth = useMemo(
    () => adjustmentsForMonth(row?.adjustmentRows || [], m),
    [row?.adjustmentRows, m],
  );
  const kinds = adjustmentKindsFor({ gross: !!row?.gross });
  const info = adjustmentKindInfo(kind);
  const locked = info.dir === 'charge' || info.dir === 'credit';
  const effDir = locked ? info.dir : dir;
  const preview = signedAmount({ kind, amount, direction: effDir });

  const settle = () => settleBillingChange(qc, { propertyId, leaseId: row?.lease_id, year });

  const post = useMutation({
    mutationFn: async () => {
      const res = await addAdjustment({
        leaseId: row.lease_id, propertyId, year, month: m, kind, amount: preview, memo: memo.trim() || null,
      });
      if (res?.refused) throw new Error(res.message);
      return res;
    },
    onSuccess: () => { setAmount(''); setMemo(''); setRefused(null); settle(); },
    onError: (e) => setRefused(e?.message || 'Could not post that adjustment.'),
  });

  const removeAdj = useMutation({
    mutationFn: (id) => deleteAdjustment(id),
    onSuccess: settle,
  });

  // Record the money the tenant still owes on this month. `additional: true` is the
  // deliberate top-up path (api.js) — a second same-month payment the allocation sums
  // with the first, which is how a month that settled short gets completed.
  const recordGap = useMutation({
    mutationFn: () => markMonthPaid(row.lease_id, propertyId, year, m, { amount: shortfall, additional: monthPayments.length > 0 }),
    onSuccess: settle,
  });
  const undoMonth = useMutation({
    mutationFn: () => unmarkMonthPaid(row.lease_id, year, m),
    onSuccess: settle,
  });

  const busy = post.isPending || removeAdj.isPending || recordGap.isPending || undoMonth.isPending;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div
        className="modal month-panel"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${monthName(m)} ${year} — ${row?.tenant_name || 'tenant'}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <strong>{row?.tenant_name}</strong>
            <div className="muted" style={{ fontSize: 12 }}>{monthName(m)} {year}</div>
          </div>
          <div className="mp-nav">
            <button className="icon-btn" disabled={m <= 1} onClick={() => onMonth?.(m - 1)} aria-label="Previous month">◀</button>
            <span className="mp-nav-label">{MONTHS[i]}</span>
            <button className="icon-btn" disabled={m >= 12} onClick={() => onMonth?.(m + 1)} aria-label="Next month">▶</button>
            <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <div className="modal-body">
          <div className="mp-grid">
            <div className="mp-col">
              <p className="mp-cap">What you billed</p>
              <div className="mp-line"><span>Base rent</span><b>{money(c.base)}</b></div>
              <div className="mp-line"><span>CAM &amp; tax</span><b>{money(c.camTax)}</b></div>
              {c.roof > 0 && <div className="mp-line"><span>Roof</span><b>{money(c.roof)}</b></div>}
              <div className="mp-line mp-sub"><span>Scheduled</span><b>{money(scheduled)}</b></div>
              {rowsForMonth.map((a) => (
                <div className="mp-line mp-adj" key={a.id}>
                  <span>
                    {adjustmentKindInfo(a.kind).label}
                    {a.memo ? <em className="muted"> — {a.memo}</em> : null}
                  </span>
                  <b className={Number(a.amount) < 0 ? 'mp-credit' : 'mp-charge'}>
                    {Number(a.amount) < 0 ? '−' : '+'}{money(Math.abs(Number(a.amount)))}
                  </b>
                  <button
                    className="icon-btn"
                    disabled={busy}
                    aria-label="Remove this adjustment"
                    onClick={async () => {
                      const ok = await askConfirm({
                        title: 'Remove this adjustment?',
                        message: `${adjustmentKindInfo(a.kind).label} of ${Number(a.amount) < 0 ? '−' : '+'}${money(Math.abs(Number(a.amount)))} on ${monthName(m)} ${year}.`,
                        implications: [
                          `${monthName(m)} goes back to owing ${money(round2(owed - Number(a.amount)))}.`,
                          "This year's invoice is re-issued at the lower total, so Outstanding moves.",
                          'No payment is touched — only what was billed.',
                        ],
                        confirmLabel: 'Remove',
                        tone: 'warn',
                      });
                      if (ok) removeAdj.mutate(a.id);
                    }}
                  >✕</button>
                </div>
              ))}
              <div className="mp-line mp-total"><span>Owed</span><b>{money(owed)}</b></div>
            </div>

            <div className="mp-col">
              <p className="mp-cap">What came in</p>
              {monthPayments.length === 0 && received <= 0.005 && (
                <p className="muted" style={{ margin: '4px 0' }}>Nothing recorded for {monthName(m)} yet.</p>
              )}
              {monthPayments.map((p) => (
                <div className="mp-line" key={p.id}>
                  <span>{p.paid_date || 'recorded'}{p.note ? <em className="muted"> — {p.note}</em> : null}</span>
                  <b>{money(p.amount)}</b>
                </div>
              ))}
              {round2(received - monthPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0)) > 0.005 && (
                <div className="mp-line"><span className="muted">Drawn from a lump payment</span><b>{money(round2(received - monthPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0)))}</b></div>
              )}
              <div className="mp-line mp-total"><span>Received</span><b>{money(received)}</b></div>
              <div className={`mp-line mp-total ${shortfall > 0.05 ? 'mp-short' : ''}`}>
                <span>{shortfall > 0.05 ? 'Still owed' : shortfall < -0.05 ? 'Paid over' : 'Settled'}</span>
                <b>{money(Math.abs(shortfall))}</b>
              </div>
              {shortfall > 0.05 && (
                <button className="secondary" style={{ marginTop: 8 }} disabled={busy} onClick={() => recordGap.mutate()}>
                  Record {money(shortfall)} received
                </button>
              )}
              {monthPayments.length > 0 && (
                <button className="ghost" style={{ marginTop: 6 }} disabled={busy} onClick={async () => {
                  const ok = await askConfirm({
                    title: `Undo ${monthName(m)}?`,
                    message: `Deletes ${monthPayments.length} payment${monthPayments.length === 1 ? '' : 's'} recorded for ${monthName(m)} ${year}.`,
                    implications: [
                      `${money(monthPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0))} comes off what has been collected.`,
                      'Any adjustments on this month stay — they are what was billed, not what was paid.',
                    ],
                    confirmLabel: 'Undo the month',
                    tone: 'warn',
                  });
                  if (ok) undoMonth.mutate();
                }}>
                  Undo this month
                </button>
              )}
            </div>
          </div>

          <div className="mp-post">
            <p className="mp-cap">The bill itself was different</p>
            <p className="muted mp-note">
              Post a charge or a credit on {monthName(m)} — the CAM really was different, a late fee, a
              concession. It changes what the tenant <strong>owes</strong>; it never claims money arrived.
              {' '}Money that came in and was never billed is <strong>Other income</strong> on the Financials
              page instead — one event is never both.
            </p>
            <div className="mp-form">
              <label>
                <span>Kind</span>
                <select value={kind} onChange={(e) => { setKind(e.target.value); setRefused(null); }} disabled={busy}>
                  {kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                </select>
              </label>
              <label>
                <span>Charge or credit</span>
                <select value={effDir} onChange={(e) => setDir(e.target.value)} disabled={busy || locked}>
                  <option value="charge">Charge — the tenant owes more</option>
                  <option value="credit">Credit — the tenant owes less</option>
                </select>
              </label>
              <label>
                <span>Amount</span>
                <input
                  className="text-input" type="number" step="0.01" min="0" inputMode="decimal"
                  value={amount} placeholder="0.00" disabled={busy}
                  onChange={(e) => { setAmount(e.target.value); setRefused(null); }}
                />
              </label>
              <label className="mp-memo">
                <span>Note (optional)</span>
                <input
                  className="text-input" type="text" value={memo} disabled={busy}
                  placeholder="e.g. snow removal invoice came in higher"
                  onChange={(e) => setMemo(e.target.value)}
                />
              </label>
            </div>
            <p className="mp-hint muted">{info.hint}</p>
            <div className="modal-actions" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              {Math.abs(preview) > 0 && (
                <span className="muted mp-preview">
                  {monthName(m)} will owe <b>{money(round2(owed + preview))}</b>
                </span>
              )}
              <button disabled={busy || !(Math.abs(preview) > 0)} onClick={() => post.mutate()}>
                {post.isPending ? 'Posting…' : preview < 0 ? 'Post credit' : 'Post charge'}
              </button>
            </div>
            {refused && <p className="note-msg danger">{refused}</p>}
            <MutationError of={[removeAdj, recordGap, undoMonth]} />
          </div>
        </div>
      </div>
    </div>
  );
}
