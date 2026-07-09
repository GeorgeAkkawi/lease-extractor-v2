import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getPropertyMonthlyRoll, markMonthPaid, unmarkMonthPaid, markMonthPaidAllTenants } from '../lib/api';
import { money, sf } from '../lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const todayIso = () => new Date().toISOString().slice(0, 10);

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
  const busy = cellMut.isPending || allMut.isPending;

  const vacant = Number(vacantSf) || 0;

  if (isLoading) return <p className="muted">Loading…</p>;
  if (!rows.length && vacant <= 0) return <p className="empty-line muted">No tenants with rent on file for FY {year}.</p>;

  const markAll = (m) => {
    // Count only tenants who actually owe this month — a fully-free abated month has nothing to collect.
    const unpaid = rows.filter((r) => !r.byMonth[m] && (r.schedule?.[m]?.owed ?? 1) > 0).length;
    if (unpaid === 0) { setNote(`Everyone has already paid ${MONTHS[m - 1]}.`); return; }
    if (window.confirm(`Mark ${MONTHS[m - 1]} ${year} paid for all ${unpaid} tenant${unpaid === 1 ? '' : 's'} who haven't yet?`)) {
      allMut.mutate(m);
    }
  };

  return (
    <div className="metric-group">
      <div className="fin-subhead">Monthly rent roll · FY {year}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
        Click any box to mark that tenant's month paid (or undo). Use <strong>✓ all</strong> under a month to mark it paid for every tenant at once. Feeds the same receivables above.
      </div>
      {note && <p className="badge good" style={{ marginBottom: 10 }}>{note}</p>}
      <div className="table-wrap">
        <table className="rent-roll">
          <thead>
            <tr>
              <th>Tenant</th>
              {MONTHS.map((ml, i) => (
                <th key={ml}>
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
              const paidCount = Object.keys(r.byMonth).length;
              // Holdover: the lease term has ended but the tenant hasn't been removed/extended,
              // so rent still collects. Flag it (matches the "Outdated" badge on the Leases page).
              const heldOver = (r.lease_termination_date && r.lease_termination_date < todayIso()) || r.is_active === false;
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
                    <div className="muted" style={{ fontSize: 11 }}>{money(r.monthly)}/mo</div>
                  </td>
                  {MONTHS.map((ml, i) => {
                    const m = i + 1;
                    const paid = !!r.byMonth[m];
                    const s = r.schedule?.[m];
                    const freeMonth = s?.abated && (Number(s.owed) || 0) <= 0;
                    // Fully-free abated month — nothing to collect; show "F", not a toggle.
                    if (freeMonth && !paid) {
                      return <td key={m}><span className="rr-cell abated" title={`${ml}: base rent abated — nothing due`}>F</span></td>;
                    }
                    return (
                      <td key={m}>
                        <button
                          type="button"
                          className={`rr-cell${paid ? ' paid' : ''}${s?.abated ? ' abated' : ''}`}
                          disabled={busy}
                          onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, paid })}
                          title={paid ? 'Paid — click to undo' : `Mark ${ml} paid (${money(s?.owed ?? r.monthly)})${s?.abated ? ' — base rent abated' : ''}`}
                        >
                          {paid ? '✓' : '—'}
                        </button>
                      </td>
                    );
                  })}
                  <td><strong>{paidCount}/12</strong></td>
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
