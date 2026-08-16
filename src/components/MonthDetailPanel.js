import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addAdjustment, deleteAdjustment, markMonthPaid, unmarkMonthPaid, updatePayment } from '../lib/api';
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
  //
  // source: 'manual' because this is the landlord saying money ARRIVED, not the app pricing
  // the month off the schedule. Without it the figure is re-pricable, and a later change to
  // a billed figure would delete this row and write an amount nobody received — after which
  // no bank statement can reconcile against the month again (0088).
  const recordGap = useMutation({
    mutationFn: () => markMonthPaid(row.lease_id, propertyId, year, m, {
      amount: shortfall, additional: monthPayments.length > 0, source: 'manual',
    }),
    onSuccess: settle,
  });
  const undoMonth = useMutation({
    mutationFn: () => unmarkMonthPaid(row.lease_id, year, m),
    onSuccess: settle,
  });

  // Re-file a payment (George, 2026-08-13: a tenant who pays the month before, and "if a
  // tenant is over paying where does that go"). Until now the only correction was Undo the
  // month and retype, which throws away the paid date, the note and the import provenance a
  // bank statement needs to reconcile against it later.
  const movePay = useMutation({
    mutationFn: ({ id, toMonth }) => updatePayment(id, { period_month: toMonth }),
    onSuccess: settle,
  });

  const busy = post.isPending || removeAdj.isPending || recordGap.isPending || undoMonth.isPending || movePay.isPending;

  // Moving money between months changes what the grid says about BOTH of them, so it asks
  // first — and the dialog states each side rather than saying "are you sure".
  async function askMove(p, raw) {
    const amt = money(Number(p.amount) || 0);
    if (raw === '') {
      const ok = await askConfirm({
        title: 'Let this payment spread forward?',
        message: `${amt} recorded on ${monthName(m)} ${year} stops belonging to ${monthName(m)} alone.`,
        implications: [
          `It fills each month's remaining need from January onward, ${monthName(m)} included.`,
          'Anything still left over after December shows as a credit owed back to the tenant.',
          'This is how an overpayment reaches the months after it — a payment tagged to one month settles that month and stops there.',
          'Nothing is deleted; put it back on a month whenever you like.',
        ],
        confirmLabel: 'Let it spread',
        // Money moves, nothing is destroyed — gold, not red.
        tone: 'warn',
      });
      if (ok) movePay.mutate({ id: p.id, toMonth: null });
      return;
    }
    const to = Number(raw);
    const ok = await askConfirm({
      title: `Move this payment to ${monthName(to)}?`,
      message: `${amt} received on ${p.paid_date || 'an unrecorded date'} is currently recorded against ${monthName(m)} ${year}.`,
      implications: [
        `${monthName(to)} counts it instead — its box shows the money and settles.`,
        `${monthName(m)} goes back to owing ${money(owed)}.`,
        'The payment itself is untouched — same amount, same date, same record.',
      ],
      confirmLabel: `Move it to ${monthName(to)}`,
      tone: 'warn',
    });
    if (ok) movePay.mutate({ id: p.id, toMonth: to });
  }

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
                      // ⚠ THE DIRECTION IS COMPUTED, and it was hardcoded to "lower" until
                      // 2026-08-16. Removing a CREDIT raises the invoice — so the dialog
                      // contradicted the line directly above it, which had the arithmetic
                      // right, on every credit there has ever been.
                      const isCredit = Number(a.amount) < 0;
                      const ok = await askConfirm({
                        title: 'Remove this adjustment?',
                        message: `${adjustmentKindInfo(a.kind).label} of ${isCredit ? '−' : '+'}${money(Math.abs(Number(a.amount)))} on ${monthName(m)} ${year}.`,
                        implications: [
                          `${monthName(m)} goes back to owing ${money(round2(owed - Number(a.amount)))}.`,
                          `This year's invoice is re-issued at the ${isCredit ? 'HIGHER' : 'lower'} total, so Outstanding moves.`,
                          // ⚠ HALF A SETTLEMENT IS WORSE THAN NONE. A carry-forward is two rows
                          // in two years; delete one here and the tenant is cleared in one year
                          // and charged in the other, and each screen reads as correct alone.
                          ...(a.kind === 'opening' || a.kind === 'writeoff' || a.kind === 'refund'
                            ? ['⚠ This entry is part of a year-end settlement, and a carried-forward balance has a matching entry in the OTHER year. Removing only this one leaves the two years disagreeing — use “Undo settlement” on the Ledger row to take back both.']
                            : []),
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
                <div key={p.id}>
                  <div className="mp-line">
                    <span>{p.paid_date || 'recorded'}{p.note ? <em className="muted"> — {p.note}</em> : null}</span>
                    <b>{money(p.amount)}</b>
                  </div>
                  {/* Re-file it, rather than delete-and-retype. The select resets to its
                      placeholder every render because the payment's CURRENT month is the
                      month this panel is showing — there is nothing for it to display. */}
                  <div className="mp-move">
                    <select
                      className="text-input"
                      value=""
                      disabled={busy}
                      onChange={(e) => { if (e.target.value !== '—') askMove(p, e.target.value); }}
                      title="Record this payment against a different month, or let it spread forward across the months still owing."
                    >
                      <option value="—">Move this payment…</option>
                      {MONTHS.map((nm, mi) => (
                        mi + 1 === m ? null : <option key={nm} value={mi + 1}>to {nm}</option>
                      ))}
                      <option value="">let it spread forward</option>
                    </select>
                  </div>
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
              {/* George, 2026-08-13: "if a tenant is over paying where does that go and how
                  does it show". It goes NOWHERE on its own, and that is worth saying: a
                  payment tagged to a month settles that month at whatever arrived and does
                  not roll forward (allocatePayments). So the extra sits here until the
                  landlord moves it. The two honest destinations are both above. */}
              {shortfall < -0.05 && (
                <p className="muted mp-note" style={{ marginTop: 6 }}>
                  This month is settled at what arrived, so the extra <strong>stays on {monthName(m)}</strong> —
                  it does not move to another month by itself. Use <em>Move this payment</em> above to put it on
                  the month it was for, or let it spread forward so it fills the months still owing and any true
                  remainder shows as a credit owed back.
                </p>
              )}
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
