import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMonthlyRent, localDateIso } from '../lib/api';
import { statementRows, adjustmentKindInfo } from '../lib/adjustments';
import { money } from '../lib/format';

// The tenant's running account — George's "debits and credits per tenant", read as a
// document rather than a grid: every charge, every credit and every payment in date
// order with a running balance, so "what does this tenant actually owe me, and why" is
// one screen instead of an inference across twelve boxes.
//
// It re-uses the ledger's OWN schedule + allocation inputs (getMonthlyRent, the same call
// the monthly tracker makes), so nothing here can disagree with the Ledger tab. The
// scheduled rent charge for each month is the pre-adjustment figure and each adjustment
// is its own line — which is the whole point: you can see WHY the balance is what it is.
//
// ⚠ Only charges that have COME DUE are listed. Rent is charged on the 1st, so listing
// December's rent in March would report a balance the tenant does not owe yet.
export default function TenantStatement({ leaseId, year, tenantName }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['monthlyRent', leaseId, year],
    queryFn: () => getMonthlyRent(leaseId, year),
    enabled: !!leaseId,
  });

  const today = new Date(`${localDateIso()}T12:00:00`);
  // The SCHEDULED owed per month = the adjusted owed less the month's adjustment, so the
  // rent line and the adjustment lines never double-count.
  const scheduled = {};
  for (let m = 1; m <= 12; m++) {
    const owed = Number(data?.schedule?.[m]?.owed) || 0;
    const adj = Number(data?.adjustments?.[m - 1]) || 0;
    scheduled[m] = { owed: Math.round((owed - adj) * 100) / 100 };
  }
  const { rows, balance } = statementRows({
    year,
    scheduled,
    payments: data?.payments || [],
    adjustments: data?.adjustmentRows || [],
    today,
  });
  const adjCount = (data?.adjustmentRows || []).length;

  return (
    <div className="panel">
      <button
        type="button"
        className="panel-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="panel-caret">{open ? '▾' : '▸'}</span>
        <div>
          <strong>Tenant statement · FY {year}</strong>
          <div className="muted" style={{ fontSize: 12.5 }}>
            {isLoading
              ? 'Loading…'
              : <>
                  {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}
                  {adjCount > 0 ? ` · ${adjCount} adjustment${adjCount === 1 ? '' : 's'}` : ''}
                  {' · '}
                  {balance > 0.05
                    ? <span className="stmt-owed">balance {money(balance)}</span>
                    : balance < -0.05
                      ? <span className="stmt-credit">credit {money(Math.abs(balance))}</span>
                      : 'settled'}
                </>}
          </div>
        </div>
      </button>

      {open && (
        <>
          {rows.length === 0 ? (
            <p className="muted">Nothing charged or received for {tenantName || 'this tenant'} in {year} yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="stmt-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Entry</th>
                    <th className="num">Charge</th>
                    <th className="num">Credit</th>
                    <th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={`stmt-${r.type}`}>
                      <td className="stmt-date">{r.date}</td>
                      <td>
                        {r.label}
                        {r.memo ? <div className="muted stmt-memo">{r.memo}</div> : null}
                      </td>
                      <td className="num">{r.amount > 0 ? money(r.amount) : ''}</td>
                      <td className="num">{r.amount < 0 ? money(Math.abs(r.amount)) : ''}</td>
                      <td className="num stmt-bal">{money(r.balance)}</td>
                    </tr>
                  ))}
                  <tr className="stmt-total">
                    <td colSpan={4}>{balance > 0.05 ? 'Balance owed' : balance < -0.05 ? 'Credit owed to the tenant' : 'Settled'}</td>
                    <td className="num">{money(Math.abs(balance))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <p className="table-note muted">
            Rent is charged on the 1st of each month, so months still ahead aren't listed. Corrections,
            fees and credits are posted per month from the <strong>Ledger</strong> tab — click any month
            box with money on it. A payment is listed on the day it was received, whatever month it settles.
            {adjCount > 0 && (
              <> This year's adjustments: {[...new Set((data?.adjustmentRows || []).map((a) => adjustmentKindInfo(a.kind).label))].join(' · ')}.</>
            )}
          </p>
        </>
      )}
    </div>
  );
}
