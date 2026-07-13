import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPropertyMonthlyRoll, markMonthPaid, unmarkMonthPaid, markMonthPaidAllTenants, localDateIso } from '../lib/api';
import { money, sf } from '../lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Property-level monthly rent roll: tenants down the side, the 12 months across.
// Click any box to mark that tenant's month paid (or undo); "✓ all" under a month
// marks it paid for every tenant that hasn't yet — rent day for the whole building
// in one click. Every change writes a real payment, so the receivables above and the
// dashboard AR update automatically. Scoped to the selected fiscal year.
// `vacantSf` (from v_property_totals) adds a final "Vacant space" row so the roll
// mirrors the Leases/Overview view of the building. Holdover tenants (term expired
// but not removed) stay on the roll and keep billing, flagged with a badge.
export default function PropertyRentRoll({ propertyId, year, vacantSf = 0 }) {
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['propertyRentRoll', propertyId, year],
    queryFn: () => getPropertyMonthlyRoll(propertyId, year),
  });
  const [note, setNote] = useState('');
  const rollKey = ['propertyRentRoll', propertyId, year];

  // Scoped invalidation after a write settles — refresh only what this action can
  // change (this property's roll + receivables, the lease trackers, the portfolio
  // AR card). Deliberately NOT a blanket ['payments']/['invoices'] sweep, which
  // would restale every tenant's data across the whole app.
  const settle = () => {
    qc.invalidateQueries({ queryKey: rollKey });
    qc.invalidateQueries({ queryKey: ['monthlyRent'] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
    qc.invalidateQueries({ queryKey: ['propertyAR', propertyId] });
    qc.invalidateQueries({ queryKey: ['portfolioAR'] });
  };

  // Paint a set of cells paid/unpaid in the cached roll immediately, so the click
  // feels instant while the write settles in the background.
  const paintCell = (old, leaseId, month, markPaid) =>
    (old || []).map((r) => {
      if (r.lease_id !== leaseId) return r;
      const byMonth = { ...r.byMonth };
      if (markPaid) byMonth[month] = { amount: r.schedule?.[month]?.owed ?? r.monthly };
      else delete byMonth[month];
      return { ...r, byMonth };
    });

  const cellMut = useMutation({
    mutationFn: ({ leaseId, month, paid }) =>
      paid ? unmarkMonthPaid(leaseId, year, month) : markMonthPaid(leaseId, propertyId, year, month),
    onMutate: async ({ leaseId, month, paid }) => {
      await qc.cancelQueries({ queryKey: rollKey });
      const prev = qc.getQueryData(rollKey);
      qc.setQueryData(rollKey, (old) => paintCell(old, leaseId, month, !paid));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(rollKey, ctx.prev); setNote('Could not save that change — please try again.'); },
    onSettled: settle,
  });
  const allMut = useMutation({
    mutationFn: (month) => markMonthPaidAllTenants(propertyId, year, month),
    onMutate: async (month) => {
      await qc.cancelQueries({ queryKey: rollKey });
      const prev = qc.getQueryData(rollKey);
      qc.setQueryData(rollKey, (old) => (old || []).map((r) => {
        if (r.byMonth[month] || (Number(r.schedule?.[month]?.owed) || 0) <= 0) return r;
        return { ...r, byMonth: { ...r.byMonth, [month]: { amount: r.schedule?.[month]?.owed ?? r.monthly } } };
      }));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(rollKey, ctx.prev); setNote('Could not mark all paid — please try again.'); },
    onSuccess: (res, month) => {
      setNote(`Marked ${MONTHS[month - 1]} paid for ${res.paid} tenant${res.paid === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} already paid or free)` : ''}.`);
    },
    onSettled: settle,
  });
  const catchUpAll = useMutation({
    // Mark every DUE month (up through the current one) paid for every tenant that still
    // owes it — rent-day catch-up for the whole building at once.
    mutationFn: async (months) => {
      let paid = 0;
      for (const m of months) { const res = await markMonthPaidAllTenants(propertyId, year, m); paid += res.paid; }
      return paid;
    },
    onSuccess: (paid) => setNote(paid ? `Recorded ${paid} tenant-month${paid === 1 ? '' : 's'} of rent.` : 'Everyone was already caught up.'),
    onError: () => setNote('Could not catch up the roll — please try again.'),
    onSettled: settle,
  });
  const busy = cellMut.isPending || allMut.isPending || catchUpAll.isPending;

  const vacant = Number(vacantSf) || 0;

  if (isLoading) return <p className="muted">Loading…</p>;
  if (!rows.length && vacant <= 0) return <p className="empty-line muted">No tenants with rent on file for FY {year}.</p>;

  // Calendar awareness (localDateIso = the landlord's local "today", not UTC).
  const today = localDateIso();
  const curY = Number(today.slice(0, 4));
  const curM = Number(today.slice(5, 7));
  const isCurrentFy = year === curY;
  const started = (m) => year < curY || (year === curY && m <= curM);
  const throughM = year < curY ? 12 : (isCurrentFy ? curM : 0);

  const markAll = (m) => {
    // Count only tenants who actually owe this month — a fully-free abated month or a
    // pre-tenancy month has nothing to collect.
    const unpaid = rows.filter((r) => !r.byMonth[m] && (r.schedule?.[m]?.owed ?? 1) > 0 && !r.schedule?.[m]?.outsideTerm).length;
    if (unpaid === 0) { setNote(`Everyone has already paid ${MONTHS[m - 1]}.`); return; }
    if (window.confirm(`Mark ${MONTHS[m - 1]} ${year} paid for all ${unpaid} tenant${unpaid === 1 ? '' : 's'} who haven't yet?`)) {
      allMut.mutate(m);
    }
  };
  const catchUp = () => {
    if (!throughM) return;
    const months = Array.from({ length: throughM }, (_, i) => i + 1);
    if (window.confirm(`Mark rent paid for every tenant through ${MONTHS[throughM - 1]} ${year} (only the months they still owe)?`)) {
      catchUpAll.mutate(months);
    }
  };
  // How many tenant-months have come due but aren't yet marked — drives the catch-up button.
  const behindTotal = rows.reduce((acc, r) => acc + MONTHS.reduce((n, _l, i) => {
    const m = i + 1; const s = r.schedule?.[m];
    return n + ((started(m) && !r.byMonth[m] && (Number(s?.owed) || 0) > 0 && !s?.outsideTerm) ? 1 : 0);
  }, 0), 0);

  return (
    <div className="metric-group">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <div className="fin-subhead" style={{ marginBottom: 0 }}>Monthly rent roll · FY {year}</div>
        {throughM > 0 && behindTotal > 0 && (
          <button type="button" className="ghost" disabled={busy} onClick={catchUp} title={`Record every unpaid month that has come due, for all tenants, through ${MONTHS[throughM - 1]}`}>
            {catchUpAll.isPending ? 'Recording…' : `✓ Mark everyone paid through ${MONTHS[throughM - 1]}`}
          </button>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 12 }}>
        Click any box to mark that tenant's month paid (or undo). Use <strong>✓ all</strong> under a month to mark it for every tenant. Amber months have come due and aren't paid; <strong>—</strong> months are before the tenant moved in. Feeds the same receivables above.
      </div>
      {note && <p className="badge good" style={{ marginBottom: 10 }}>{note}</p>}
      <div className="table-wrap">
        <table className="rent-roll">
          <thead>
            <tr>
              <th>Tenant</th>
              {MONTHS.map((ml, i) => (
                <th key={ml} className={isCurrentFy && i + 1 === curM ? 'rr-current' : undefined}>
                  <div className="rr-mhead">
                    <span>{ml}</span>
                    <button type="button" className="ghost rr-all" disabled={busy} onClick={() => markAll(i + 1)} title={`Mark ${ml} paid for all tenants`}>✓ all</button>
                  </div>
                </th>
              ))}
              <th>Paid</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              // "Due" months = in-term, owed, and already started; the Paid column reads
              // paid-of-due, not paid-of-12, so a mid-year or partial-year tenant reads honestly.
              const dueMonths = MONTHS.reduce((n, _l, i) => {
                const m = i + 1; const s = r.schedule?.[m];
                return n + ((started(m) && (Number(s?.owed) || 0) > 0 && !s?.outsideTerm) ? 1 : 0);
              }, 0);
              const paidDue = MONTHS.reduce((n, _l, i) => {
                const m = i + 1; const s = r.schedule?.[m];
                return n + ((started(m) && r.byMonth[m] && !s?.outsideTerm) ? 1 : 0);
              }, 0);
              // Holdover: the lease term has ended but the tenant hasn't been removed/extended,
              // so rent still collects. Flag it (matches the "Outdated" badge on the Leases page).
              const heldOver = (r.lease_termination_date && r.lease_termination_date < today) || r.is_active === false;
              return (
                <tr key={r.lease_id}>
                  <td>
                    {r.tenant_name}
                    {heldOver && (
                      <div>
                        <span
                          className="badge warn"
                          style={{ marginTop: 3 }}
                          title="This lease has expired but the tenant is being held over — rent still collects until you remove or extend the lease."
                        >
                          Expired — held over{r.is_active === false ? ' · needs extension' : ''}
                        </span>
                      </div>
                    )}
                    <div className="muted" style={{ fontSize: 11 }}>{money(r.monthly)}/mo{r.owedMonths < 12 ? ` · ${r.owedMonths} mo` : ''}</div>
                  </td>
                  {MONTHS.map((ml, i) => {
                    const m = i + 1;
                    const paid = !!r.byMonth[m];
                    const s = r.schedule?.[m];
                    const outside = !!s?.outsideTerm;
                    const freeMonth = s?.abated && (Number(s.owed) || 0) <= 0 && !outside;
                    // A pre-tenancy month ("—" muted) — nothing owed, not clickable.
                    if (outside) {
                      return <td key={m}><span className="rr-cell outside" title={`${ml}: before this lease began`}>—</span></td>;
                    }
                    // Fully-free abated month — nothing to collect; show "F", not a toggle.
                    if (freeMonth && !paid) {
                      return <td key={m}><span className="rr-cell abated" title={`${ml}: base rent abated — nothing due`}>F</span></td>;
                    }
                    const late = !paid && started(m) && (Number(s?.owed) || 0) > 0; // came due, unpaid
                    return (
                      <td key={m}>
                        <button
                          type="button"
                          className={`rr-cell${paid ? ' paid' : ''}${late ? ' late' : ''}${s?.abated ? ' abated' : ''}`}
                          disabled={busy}
                          onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, paid })}
                          title={paid ? 'Paid — click to undo' : `${late ? 'Overdue — mark' : 'Mark'} ${ml} paid (${money(s?.owed ?? r.monthly)})${s?.abated ? ' — base rent abated' : ''}`}
                        >
                          {paid ? '✓' : '—'}
                        </button>
                      </td>
                    );
                  })}
                  <td><strong>{paidDue}/{dueMonths}</strong></td>
                </tr>
              );
            })}
            {vacant > 0 && (
              <tr className="rr-vacant">
                <td>
                  <span className="muted">Vacant space</span>
                  <div className="muted" style={{ fontSize: 11 }}>{sf(vacant)} · nothing to collect</div>
                </td>
                {MONTHS.map((ml) => (
                  <td key={ml}><span className="rr-cell vacant" title={`${ml}: unleased space — no rent`}>—</span></td>
                ))}
                <td className="muted">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
