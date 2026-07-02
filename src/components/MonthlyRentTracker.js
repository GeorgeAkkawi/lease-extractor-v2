import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getMonthlyRent, markMonthPaid, unmarkMonthPaid } from '../lib/api';
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

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['monthlyRent', leaseId] });
    qc.invalidateQueries({ queryKey: ['invoices', leaseId] });
    qc.invalidateQueries({ queryKey: ['payments'] });
    qc.invalidateQueries({ queryKey: ['portfolioAR'] });
    qc.invalidateQueries({ queryKey: ['propertyAR', propertyId] });
    qc.invalidateQueries({ queryKey: ['propertyRentRoll', propertyId] });
  };

  const mark = useMutation({
    // Default the amount to that month's expected owed (already net of any abatement),
    // unless the landlord typed an explicit override.
    mutationFn: (month) => markMonthPaid(leaseId, propertyId, year, month, {
      amount: amt !== '' ? amt : (schedule[month]?.owed ?? undefined),
      method, paid_date: date,
    }),
    onSuccess: refresh,
  });
  const unmark = useMutation({
    mutationFn: (month) => unmarkMonthPaid(leaseId, year, month),
    onSuccess: refresh,
  });
  const busy = mark.isPending || unmark.isPending;

  if (isLoading) return <p className="muted">Loading…</p>;

  const monthly = Number(data?.monthly || 0);
  const annual = Number(data?.annual || 0);
  const byMonth = data?.byMonth || {};

  if (annual <= 0) {
    return (
      <p className="empty-line muted">
        No rent on file for FY {year} for this tenant. Set the base rent (and this year's expenses) and the monthly boxes appear here.
      </p>
    );
  }

  const paidCount = Object.keys(byMonth).length;
  const collected = Object.values(byMonth).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const remaining = Math.max(0, annual - collected);

  const toggle = (m) => {
    if (busy) return;
    if (byMonth[m]) unmark.mutate(m);
    else mark.mutate(m);
  };

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <div className="muted" style={{ fontSize: 12.5 }}>
          <strong style={{ color: 'var(--ink)' }}>FY {year}</strong> · {money(monthly)}/mo · {money(annual)}/yr
        </div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          <strong style={{ color: 'var(--ink)' }}>{paidCount}/12</strong> months · {money(collected)} collected · {money(remaining)} left
        </div>
      </div>

      {data?.hasAbatement && (
        <p className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 10 }}>
          Months in a rent-abatement window show <strong>Free</strong> (or the reduced amount) — base rent isn't billed then; CAM / taxes still apply.
        </p>
      )}
      <div className="month-grid">
        {MONTHS.map((label, i) => {
          const m = i + 1;
          const cell = byMonth[m];
          const paid = !!cell;
          const s = schedule[m] || { owed: monthly, abated: false };
          const owed = Number(s.owed) || 0;
          const freeMonth = s.abated && owed <= 0;
          // A fully-free month has nothing to collect — show it, don't make it clickable.
          if (freeMonth && !paid) {
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
              className={`month-cell${paid ? ' paid' : ''}${s.abated ? ' abated' : ''}`}
              onClick={() => toggle(m)}
              disabled={busy}
              title={paid ? `Paid ${money(cell.amount)} — click to undo` : `Mark ${label} paid (${money(owed)})${s.abated ? ' — base rent abated, CAM/taxes only' : ''}`}
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
              <input className="text-input num" type="number" step="any" placeholder={String(Math.round(monthly * 100) / 100)} value={amt} onChange={(e) => setAmt(e.target.value)} />
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
