import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addAdjustment, deleteAdjustment, markMonthPaid, updatePayment } from '../lib/api';
import { settleBillingChange, settlePaymentChange } from '../lib/invalidate';
import { paintAdjustment } from '../lib/rollPaint';
import { useModalA11y } from './modalA11y';
import { useConfirm } from './ConfirmDialog';
import MutationError from './MutationError';
import { money } from '../lib/format';
import {
  adjustmentKindsFor, adjustmentKindInfo, adjustmentsForMonth, signedAmount, monthName,
  pnlDestination,
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
const signedMoney = (n) => `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`;

export default function MonthDetailPanel({
  propertyId, year, month, row, comp, alloc, onClose, onMonth,
}) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const modalRef = useModalA11y(onClose);
  const amountRef = useRef(null);
  const [kind, setKind] = useState('camtax');
  const [dir, setDir] = useState('charge');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [refused, setRefused] = useState(null);
  // What the last post actually did, kept on screen until the next one is typed. See the
  // receipt block below for why this exists at all.
  const [posted, setPosted] = useState(null);
  // Which payment is being re-filed. The month picker is a second control on a row that
  // already carries a date, a note and an amount, so it stays behind a link until asked for.
  const [movingId, setMovingId] = useState(null);

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
  const dest = pnlDestination(kind);
  const drawnFromLump = round2(received - monthPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0));

  const settle = () => settleBillingChange(qc, { propertyId, leaseId: row?.lease_id, year });
  // ⚠ A PAYMENT MOVES NO BILLED FIGURE, so it does not go through the billed-figure set —
  // that refetched sixteen key families (and a whole property roll) for a write that changed
  // who had SETTLED, which is most of why this panel felt slow.
  const settlePay = () => settlePaymentChange(qc, { propertyId });

  const rollKey = ['propertyRentRoll', propertyId, year];
  // Paint the cached roll, hand back the rollback. The grid, this panel and the box's hover
  // card all read that one cache, so they move together or not at all.
  const paint = async (adjRow) => {
    await qc.cancelQueries({ queryKey: rollKey });
    const prev = qc.getQueryData(rollKey);
    qc.setQueryData(rollKey, (old) => paintAdjustment(old, row.lease_id, m, adjRow));
    return { prev };
  };
  const unpaint = (ctx) => { if (ctx?.prev !== undefined) qc.setQueryData(rollKey, ctx.prev); };

  // Typing anything means the last post has been read and acted on. The receipt goes.
  const editing = () => { setRefused(null); setPosted(null); };

  const post = useMutation({
    mutationFn: async () => {
      const res = await addAdjustment({
        leaseId: row.lease_id, propertyId, year, month: m, kind, amount: preview, memo: memo.trim() || null,
      });
      if (res?.refused) throw new Error(res.message);
      return res;
    },
    // The row appears the moment it is clicked — with its note, which is the thing George
    // could not find afterwards. `id` is a placeholder until the real row lands; nothing
    // reads it before the refetch except React's key.
    //
    // ⚠ THE FORM IS NOT CLEARED HERE, and it was until 2026-08-17. Clearing on mutate dropped
    // `preview` to 0, which greyed the button, emptied the "will owe" line and emptied the
    // "where it lands" line all in the same frame — so a form that had just worked read as
    // spent (George: *"i should be able to post more than one charge … the post charge button
    // goes grey after the first"*). Worse, a REFUSAL — a closed year, a gross lease, a credit
    // larger than the bill — threw away the amount AND the note he had typed, because nothing
    // put them back. The optimistic row below is the instant feedback; clearing belongs in
    // onSuccess, where it means "that one is filed", not "that one is gone".
    onMutate: async () => {
      const optimistic = { id: `pending-${m}-${kind}`, kind, amount: preview, memo: memo.trim() || null, month: m, pending: true };
      const ctx = await paint(optimistic);
      // Snapshot BEFORE the paint lands, so the receipt can quote the month's new figure
      // without re-deriving it from a cache that is about to be refetched.
      return { ...ctx, snap: { kind, amount: preview, owedAfter: round2(owed + preview) } };
    },
    onSuccess: (res, _v, ctx) => {
      setRefused(null);
      setPosted({ ...ctx.snap, id: res?.row?.id || null });
      setAmount('');
      setMemo('');
      settle();
      amountRef.current?.focus();
    },
    onError: (e, _v, ctx) => { unpaint(ctx); setRefused(e?.message || 'Could not post that adjustment.'); },
  });

  const removeAdj = useMutation({
    mutationFn: (id) => deleteAdjustment(id),
    onMutate: async (id) => {
      const gone = rowsForMonth.find((a) => a.id === id);
      return paint({ remove: id, amount: -(Number(gone?.amount) || 0) });
    },
    onError: (_e, _id, ctx) => unpaint(ctx),
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
    onSuccess: settlePay,
  });
  // Re-file a payment (George, 2026-08-13: a tenant who pays the month before, and "if a
  // tenant is over paying where does that go"). Until now the only correction was Undo the
  // month and retype, which throws away the paid date, the note and the import provenance a
  // bank statement needs to reconcile against it later.
  const movePay = useMutation({
    mutationFn: ({ id, toMonth }) => updatePayment(id, { period_month: toMonth }),
    onSuccess: () => { setMovingId(null); settlePay(); },
  });

  const busy = post.isPending || removeAdj.isPending || recordGap.isPending || movePay.isPending;

  // Moving money between months changes what the grid says about BOTH of them, so it asks
  // first — and the dialog states each side rather than saying "are you sure".
  //
  // ⚠ "SPREAD FORWARD" IS GONE from every string here (George, 2026-08-17: *"i dont get what
  // let it spread forward means in the pop up"*). It was wrong twice over: an untagged payment
  // does not move FORWARD from this month, it fills each month's remaining need from JANUARY
  // (allocatePayments) — and "spread" is not a word anybody uses about a cheque. What the
  // action does is untie the payment from a month; the implications still state the rest.
  async function askMove(p, raw) {
    const amt = money(Number(p.amount) || 0);
    if (raw === '') {
      const ok = await askConfirm({
        title: `Untie this payment from ${monthName(m)}?`,
        message: `${amt} recorded on ${monthName(m)} ${year} stops belonging to ${monthName(m)} alone.`,
        implications: [
          `It fills each month's remaining need from January onward, ${monthName(m)} included.`,
          'Anything still left over after December shows as a credit owed back to the tenant.',
          'This is how an overpayment reaches the months after it — a payment tied to one month settles that month and stops there.',
          'Nothing is deleted; put it back on a month whenever you like.',
        ],
        confirmLabel: 'Untie it',
        // Money moves, nothing is destroyed — gold, not red.
        tone: 'warn',
      });
      if (ok) movePay.mutate({ id: p.id, toMonth: null });
      else setMovingId(null);
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
    else setMovingId(null);
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
          <div className="mp-title">
            <strong>{row?.tenant_name}</strong>
            <span className="mp-when">{monthName(m)} {year}</span>
          </div>
          <div className="mp-head-right">
            {/* One bordered group rather than three loose glyphs — ◀ Jan ▶ reads as a
                control, and the close sits apart from it so it can't be hit by accident. */}
            <div className="mp-nav">
              <button className="mp-nav-btn" disabled={m <= 1} onClick={() => onMonth?.(m - 1)} aria-label="Previous month">◀</button>
              <span className="mp-nav-label">{MONTHS[i]}</span>
              <button className="mp-nav-btn" disabled={m >= 12} onClick={() => onMonth?.(m + 1)} aria-label="Next month">▶</button>
            </div>
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
                <div className={`mp-adj ${Number(a.amount) < 0 ? 'is-credit' : 'is-charge'}`} key={a.id}>
                  <div className="mp-adj-head">
                    <span>{adjustmentKindInfo(a.kind).label}</span>
                    <b>{signedMoney(Number(a.amount) || 0)}</b>
                    <button
                      className="icon-btn mp-adj-x"
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
                  {a.memo ? <p className="mp-adj-memo">{a.memo}</p> : null}
                </div>
              ))}
              <div className="mp-foot"><span>Owed</span><b>{money(owed)}</b></div>
            </div>

            <div className="mp-col">
              <p className="mp-cap">What came in</p>
              {monthPayments.length === 0 && received <= 0.005 && (
                <p className="muted mp-empty">Nothing recorded for {monthName(m)} yet.</p>
              )}
              {monthPayments.map((p) => (
                <div className="mp-pay" key={p.id}>
                  <div className="mp-line">
                    <span>
                      {p.paid_date || 'recorded'}
                      {p.note ? <em className="mp-pay-note">{p.note}</em> : null}
                    </span>
                    <b>{money(p.amount)}</b>
                  </div>
                  {/* Re-file it, rather than delete-and-retype. The select resets to its
                      placeholder every render because the payment's CURRENT month is the
                      month this panel is showing — there is nothing for it to display. */}
                  {movingId === p.id ? (
                    <div className="mp-move">
                      <select
                        className="text-input"
                        value=""
                        disabled={busy}
                        autoFocus
                        onChange={(e) => { if (e.target.value !== '—') askMove(p, e.target.value); }}
                      >
                        <option value="—">Where does it belong?</option>
                        {MONTHS.map((nm, mi) => (
                          mi + 1 === m ? null : <option key={nm} value={mi + 1}>to {nm}</option>
                        ))}
                        <option value="">don’t tie it to a month</option>
                      </select>
                      <button className="ghost btn-sm" disabled={busy} onClick={() => setMovingId(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button
                      className="ghost btn-sm mp-move-open"
                      disabled={busy}
                      onClick={() => setMovingId(p.id)}
                    >Move this payment…</button>
                  )}
                </div>
              ))}
              {drawnFromLump > 0.005 && (
                <div className="mp-line"><span className="muted">Drawn from a lump payment</span><b>{money(drawnFromLump)}</b></div>
              )}
              <div className="mp-foot"><span>Received</span><b>{money(received)}</b></div>
              <div className={`mp-foot ${shortfall > 0.05 ? 'mp-short' : ''}`}>
                <span>{shortfall > 0.05 ? 'Still owed' : shortfall < -0.05 ? 'Paid over' : 'Settled'}</span>
                <b>{money(Math.abs(shortfall))}</b>
              </div>
              {/* George, 2026-08-13: "if a tenant is over paying where does that go and how
                  does it show". It goes NOWHERE on its own, and that is worth saying: a
                  payment tied to a month settles that month at whatever arrived and does
                  not roll forward (allocatePayments). So the extra sits here until the
                  landlord moves it. The two honest destinations are both above. */}
              {shortfall < -0.05 && (
                <p className="muted mp-note mp-note-tight">
                  This month is settled at what arrived, so the extra <strong>stays on {monthName(m)}</strong> —
                  it does not move to another month by itself. Use <em>Move this payment</em> above to put it on
                  the month it was for, or untie it, and it pays off the oldest months still owing — any true
                  remainder then shows as a credit owed back.
                </p>
              )}
              {shortfall > 0.05 && (
                <button className="secondary mp-record" disabled={busy} onClick={() => recordGap.mutate()}>
                  Record {money(shortfall)} received
                </button>
              )}
              {/* ⚠ "Undo this month" USED TO LIVE HERE and has moved to the grid, where a
                  single click on the box takes the month back and a double-click opens this
                  panel (George, 2026-08-17: *"one click to mark it paid one to mark it
                  unpaid and a double click to enter the pop up not an undo this month in the
                  popup to remove it"*). Two ways to do one thing is how they drift; the
                  grid's version also asks first when the money came off a bank statement,
                  which this one never did. */}
              {monthPayments.length > 0 && (
                <p className="muted mp-note mp-note-tight">
                  To take {monthName(m)} back, click its box on the Ledger — one click records a month,
                  one click undoes it.
                </p>
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
                <select className="text-input" value={kind} onChange={(e) => { setKind(e.target.value); editing(); }} disabled={busy}>
                  {kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                </select>
              </label>
              <label>
                <span>Charge or credit</span>
                <select className="text-input" value={effDir} onChange={(e) => { setDir(e.target.value); editing(); }} disabled={busy || locked}>
                  <option value="charge">Charge — the tenant owes more</option>
                  <option value="credit">Credit — the tenant owes less</option>
                </select>
              </label>
              <label>
                <span>Amount</span>
                <input
                  ref={amountRef}
                  className="text-input" type="number" step="0.01" min="0" inputMode="decimal"
                  value={amount} placeholder="0.00" disabled={busy}
                  onChange={(e) => { setAmount(e.target.value); editing(); }}
                />
              </label>
              <label className="mp-memo">
                <span>Note (optional)</span>
                <input
                  className="text-input" type="text" value={memo} disabled={busy}
                  placeholder="e.g. snow removal invoice came in higher"
                  onChange={(e) => { setMemo(e.target.value); editing(); }}
                />
              </label>
            </div>
            <p className="mp-hint muted">{info.hint}</p>
            {/* ⚠ WHERE IT LANDS ON THE SHEET, before it is posted (George, 2026-08-17: the app
                should say "this money is now going to revenue"). And the honest moment to say
                it is HERE, not at Settle up: the workbook counts rent when it FALLS DUE, so a
                charge is revenue the instant it is posted, whether or not anyone pays it. */}
            {Math.abs(preview) > 0 && (
              <p className="mp-lands">
                {dest.earned
                  ? <>Posting this {preview < 0 ? <>takes <b>{money(Math.abs(preview))}</b> off</> : <>adds <b>{money(preview)}</b> to</>} FY {year} income, under <b>{dest.section} › {dest.row} › {dest.label}</b>.</>
                  : <>This moves what the tenant owes. FY {year} income does not change — it is stated under <b>{dest.row}</b> and taken back out before <b>Total earned</b>.</>}
              </p>
            )}
          </div>
        </div>

        {/* ── The foot: what will happen, or what just did ─────────────────────────────
            ⚠ THIS SLOT IS WHY THE FORM READ AS SPENT. It held only the "will owe" preview,
            which vanished the instant a post cleared the amount — so the last thing a
            landlord saw after a successful post was an empty strip and a grey button, and
            the app never once said what it had done. It now carries a receipt instead:
            which adjustment, how much, on which month, and what the month owes now — with
            Undo, because the next thing you want after posting the wrong figure is to take
            it back. It clears the moment the next one is typed. */}
        <div className="modal-foot">
          {refused && <p className="note-msg danger mp-foot-msg">{refused}</p>}
          <MutationError of={[removeAdj, recordGap, movePay]} />
          <div className="modal-actions">
            {Math.abs(preview) > 0 ? (
              <span className="muted mp-preview">
                {monthName(m)} will owe <b>{money(round2(owed + preview))}</b>
              </span>
            ) : posted ? (
              <span className="mp-posted">
                ✓ {adjustmentKindInfo(posted.kind).label} <b>{signedMoney(posted.amount)}</b> posted
                to {monthName(m)} · {monthName(m)} now owes <b>{money(posted.owedAfter)}</b>
                {posted.id && (
                  <button
                    className="ghost btn-sm"
                    disabled={busy}
                    onClick={() => { removeAdj.mutate(posted.id); setPosted(null); }}
                  >Undo</button>
                )}
              </span>
            ) : (
              <span className="muted mp-preview">Post as many as the month needs.</span>
            )}
            {/* ⚠ DISABLED ONLY WHILE A WRITE IS IN FLIGHT. Greying it for an empty amount is
                what made "you have had your one charge" the obvious reading; a live button
                that says what is missing when you press it says the true thing instead. */}
            <button disabled={busy} onClick={() => {
              if (!(Math.abs(preview) > 0)) {
                setRefused('Enter an amount to post.');
                amountRef.current?.focus();
                return;
              }
              post.mutate();
            }}>
              {post.isPending ? 'Posting…' : effDir === 'credit' ? 'Post credit' : 'Post charge'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
