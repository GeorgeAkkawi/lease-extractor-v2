import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMonthlyRent, markMonthPaid, unmarkMonthPaid, localDateIso } from '../lib/api';
import { useChrome } from '../context/ChromeContext';
import { money } from '../lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const METHODS = ['check', 'ach', 'wire', 'card', 'cash', 'other'];

// A friendly MONTHLY view of one tenant's rent for the selected fiscal year: 12
// boxes, each = that month's share (the year's total / 12). Click an unpaid month
// to mark it paid; click a paid one to undo. Every check-off is a real payment
// against the year's invoice (created on demand), so the balance, AR, and dashboards
// update automatically. It follows the shared fiscal-year selector — switching the
// year shows a fresh grid, and prior years stay intact. "Payment details…" tweaks
// the amount / date / method applied to the next month you click.
export default function MonthlyRentTracker({ lease }) {
  const { year } = useChrome();
  const qc = useQueryClient();
  const leaseId = lease.id;
  const propertyId = lease.property_id;

  const { data, isLoading } = useQuery({
    queryKey: ['monthlyRent', leaseId, year],
    queryFn: () => getMonthlyRent(leaseId, year),
  });
  // Per-month expected owed (full charges minus any base abatement). Free months show
  // "Free" and aren't billed; reduced months carry the lower amount.
  const schedule = data?.schedule || {};

  const [method, setMethod] = useState('check');
  const [amt, setAmt] = useState('');
  const [date, setDate] = useState('');
  const [showOpts, setShowOpts] = useState(false);

  const rentKey = ['monthlyRent', leaseId, year];
  // Refresh only what a check-off can change (this lease's tracker + invoices, the
  // property roll/AR, the portfolio AR) — not a blanket ['payments'] sweep.
  const settle = () => {
    qc.invalidateQueries({ queryKey: ['monthlyRent', leaseId] });
    qc.invalidateQueries({ queryKey: ['invoices', leaseId] });
    qc.invalidateQueries({ queryKey: ['portfolioAR'] });
    qc.invalidateQueries({ queryKey: ['propertyAR', propertyId] });
    qc.invalidateQueries({ queryKey: ['propertyRentRoll', propertyId] });
  };

  // Optimistically flip a month in the cached tracker so the click paints instantly.
  const optimistic = (month, markPaid, amount) => async () => {
    await qc.cancelQueries({ queryKey: rentKey });
    const prev = qc.getQueryData(rentKey);
    qc.setQueryData(rentKey, (old) => {
      if (!old) return old;
      const byMonth = { ...old.byMonth };
      if (markPaid) byMonth[month] = { amount };
      else delete byMonth[month];
      return { ...old, byMonth };
    });
    return { prev };
  };
  const rollback = (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(rentKey, ctx.prev); };

  const mark = useMutation({
    // Default the amount to that month's expected owed (already net of any abatement),
    // unless the landlord typed an explicit override.
    mutationFn: (month) => markMonthPaid(leaseId, propertyId, year, month, {
      amount: amt !== '' ? amt : (schedule[month]?.owed ?? undefined),
      method, paid_date: date,
    }),
    onMutate: (month) => optimistic(month, true, amt !== '' ? Number(amt) : (schedule[month]?.owed ?? 0))(),
    onError: rollback,
    onSettled: settle,
  });
  const unmark = useMutation({
    mutationFn: (month) => unmarkMonthPaid(leaseId, year, month),
    onMutate: (month) => optimistic(month, false)(),
    onError: rollback,
    onSettled: settle,
  });
  const catchUp = useMutation({
    // One-click: record every month that has come due and is still unpaid, in order.
    mutationFn: async (months) => {
      for (const m of months) {
        await markMonthPaid(leaseId, propertyId, year, m, {
          amount: amt !== '' ? amt : (schedule[m]?.owed ?? undefined),
          method, paid_date: date || undefined,
        });
      }
    },
    onSettled: settle,
  });
  const busy = mark.isPending || unmark.isPending || catchUp.isPending;

  if (isLoading) return <p className="muted">Loading…</p>;

  const annual = Number(data?.annual || 0);
  const byMonth = data?.byMonth || {};

  if (annual <= 0) {
    return (
      <p className="empty-line muted">
        No rent on file for FY {year} for this tenant. Set the base rent (and this year's expenses) and the monthly boxes appear here.
      </p>
    );
  }

  // Calendar awareness: which months have actually come due as of the landlord's local
  // "today" (localDateIso), so a missed month reads differently from a not-yet-due one.
  const todayIso = localDateIso();
  const curY = Number(todayIso.slice(0, 4));
  const curM = Number(todayIso.slice(5, 7));
  const isCurrentFy = year === curY;
  const started = (m) => year < curY || (year === curY && m <= curM); // has this month begun?

  const cells = MONTHS.map((label, i) => {
    const m = i + 1;
    const s = schedule[m] || { owed: 0, outsideTerm: false, abated: false };
    const owed = Number(s.owed) || 0;
    const paid = !!byMonth[m];
    const outside = !!s.outsideTerm;                     // before the tenancy began → "—"
    const free = s.abated && owed <= 0 && !outside;      // fully abated → "Free"
    const due = !outside && !free && started(m);         // has come due
    const behind = due && !paid && owed > 0;             // owed, unpaid, month started → late
    const state = outside ? 'outside' : paid ? 'paid' : free ? 'free' : behind ? 'late' : 'upcoming';
    return { m, label, s, owed, paid, outside, free, due, behind, state, current: isCurrentFy && m === curM, cell: byMonth[m] };
  });

  const dueMonths = cells.filter((c) => c.due).length;
  const paidDue = cells.filter((c) => c.due && c.paid).length;
  const behindCells = cells.filter((c) => c.behind);
  const behindAmt = behindCells.reduce((s, c) => s + c.owed, 0);
  const collected = Object.values(byMonth).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const remaining = Math.max(0, annual - collected);
  const owedMonths = Number(data?.owedMonths) || cells.filter((c) => !c.outside && !c.free).length;
  const perMonth = owedMonths ? annual / owedMonths : 0;
  const throughM = year < curY ? 12 : (isCurrentFy ? curM : 0);
  const throughLabel = throughM ? MONTHS[throughM - 1] : null;

  const toggle = (m) => {
    if (busy) return;
    if (byMonth[m]) unmark.mutate(m);
    else mark.mutate(m);
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          <strong style={{ color: 'var(--ink)' }}>FY {year}</strong> · {money(perMonth)}/mo · {money(annual)}/yr{owedMonths < 12 ? ` · ${owedMonths} mo` : ''}
        </div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          <strong style={{ color: 'var(--ink)' }}>Paid {paidDue} of {dueMonths} due</strong>
          {behindCells.length > 0
            ? <> · <span style={{ color: 'var(--gold)', fontWeight: 700 }}>{behindCells.length} behind ({money(behindAmt)})</span></>
            : <> · {money(collected)} collected · {money(remaining)} left</>}
        </div>
      </div>

      {behindCells.length > 0 && throughLabel && (
        <div className="row" style={{ marginTop: -2, marginBottom: 10 }}>
          <button type="button" className="ghost" disabled={busy}
            onClick={() => catchUp.mutate(behindCells.map((c) => c.m))}
            title={`Records ${behindCells.length} unpaid month${behindCells.length === 1 ? '' : 's'} that have come due`}>
            {catchUp.isPending ? 'Recording…' : `✓ Mark paid through ${throughLabel}`}
          </button>
        </div>
      )}

      {data?.hasAbatement && (
        <p className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          Months in a rent-abatement window show <strong>Free</strong> (or the reduced amount) — base rent isn't billed then; CAM / taxes still apply.
        </p>
      )}
      <div className="month-grid">
        {cells.map(({ m, label, s, owed, paid, outside, free, state, current, cell }) => {
          // A pre-tenancy month ("—") and a fully-free month are shown but not clickable.
          if (outside) {
            return (
              <div key={m} className="month-cell outside" title={`${label}: before this lease began — nothing owed`}>
                <span className="month-label">{label}</span>
                <span className="month-amt">—</span>
              </div>
            );
          }
          if (free && !paid) {
            return (
              <div key={m} className="month-cell abated" title={`${label}: base rent abated — nothing due`}>
                <span className="month-label">{label}</span>
                <span className="month-amt">Free</span>
              </div>
            );
          }
          return (
            <button
              key={m}
              type="button"
              className={`month-cell ${state}${s.abated ? ' abated' : ''}${current ? ' current' : ''}`}
              onClick={() => toggle(m)}
              disabled={busy}
              title={paid ? `Paid ${money(cell.amount)} — click to undo` : `${state === 'late' ? 'Overdue — mark' : 'Mark'} ${label} paid (${money(owed)})${s.abated ? ' — base rent abated, CAM/taxes only' : ''}`}
            >
              <span className="month-label">{label}{s.abated && !paid ? ' ·' : ''}</span>
              <span className="month-amt">{paid ? `✓ ${money(cell.amount)}` : money(owed)}</span>
            </button>
          );
        })}
      </div>

      <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <button type="button" className="ghost" onClick={() => setShowOpts((v) => !v)}>
          {showOpts ? 'Hide options' : 'Payment details…'}
        </button>
        {showOpts && (
          <>
            <label className="form-field" style={{ marginBottom: 0, maxWidth: 150 }}>
              <span>Amount / month</span>
              <input className="text-input num" type="number" step="any" placeholder={String(Math.round(perMonth * 100) / 100)} value={amt} onChange={(e) => setAmt(e.target.value)} />
            </label>
            <label className="form-field" style={{ marginBottom: 0, maxWidth: 160 }}>
              <span>Paid on</span>
              <input className="text-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="form-field" style={{ marginBottom: 0, maxWidth: 130 }}>
              <span>Method</span>
              <select className="text-input" value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((mm) => <option key={mm} value={mm}>{mm}</option>)}
              </select>
            </label>
            <span className="muted" style={{ fontSize: 12, paddingBottom: 6 }}>Applied to the next month you click.</span>
          </>
        )}
      </div>
    </div>
  );
}
