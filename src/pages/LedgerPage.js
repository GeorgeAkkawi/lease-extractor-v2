import { useState } from 'react';
import { useParams, Navigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  getCorporation,
  getProperty,
  getPropertyTotals,
  getPropertyMonthlyRoll,
  markMonthPaid,
  unmarkMonthPaid,
  markMonthPaidAllTenants,
  markMonthsPaidAllTenants,
  listStatementImports,
  undoStatementImport,
  listSnapshots,
  localDateIso,
} from '../lib/api';
import { allocatePayments, componentizeSchedule, ledgerRowSummary, snapshotCollectionSummary } from '../lib/ledger';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { useFeatures } from '../lib/features';
import FinancialsTabs from '../components/FinancialsTabs';
import StatementReview from '../components/StatementReview';
import ImportStatementButton, { ImportResultsStrip, settleStatementImport } from '../components/ImportStatementButton';
import MutationError from '../components/MutationError';
import { money, money0, sf, fmtDate } from '../lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// The Rent Ledger: tenants down the side, the 12 months across, PROJECTED (what the
// lease bills) vs ACTUAL (what's been collected) — the per-tenant "owes $X / owed $X"
// view George's partners asked for. Cell states derive from ONE allocation of the
// year's payments (ledger.js): tagged payments cover their own month, untagged
// (lump/partial) money pools and fills months first-to-last, so a lump payer reads
// ✓ ✓ ✓ ✓ ✓ ◐ with the rest open. Click a cell to record/undo that month; the
// trailing Collected / Owes columns come from the SAME allocation, so the figures
// and the cells can never disagree. Scoped to the shared fiscal-year selector.
export default function LedgerPage() {
  const { corpId, propId } = useParams();
  const { year } = useChrome();
  const { isOn, loading: featuresLoading } = useFeatures();
  const qc = useQueryClient();

  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  const { data: totals } = useQuery({ queryKey: ['propertyTotals', propId, year], queryFn: () => getPropertyTotals(propId, year), placeholderData: keepPreviousData });
  const rollKey = ['propertyRentRoll', propId, year];
  const { data: rows = [], isLoading } = useQuery({ queryKey: rollKey, queryFn: () => getPropertyMonthlyRoll(propId, year) });
  usePageChrome([
    { label: 'Financials', to: '/financials' },
    { label: corp?.name || '…', to: `/financials/${corpId}` },
    { label: prop?.name || '…', to: `/financials/${corpId}/${propId}` },
    { label: 'Ledger' },
  ], true);

  const [note, setNote] = useState('');
  // Statement import: null | { fileName, accountHint, parsed, pdfLane } while reviewing.
  const [importDoc, setImportDoc] = useState(null);
  // The post-save results strip: { summary, import, fileName }.
  const [imported, setImported] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const { data: register = [] } = useQuery({
    queryKey: ['statementImports', propId],
    queryFn: () => listStatementImports(propId),
    enabled: isOn('ledger'),
  });
  // Prior-year collection rate (from the year-close snapshot) — the quiet trend chip.
  const { data: snaps = [] } = useQuery({
    queryKey: ['snapshots', propId],
    queryFn: () => listSnapshots(propId),
    enabled: isOn('ledger'),
  });
  const prevSnap = (snaps || []).find((s) => Number(s.year) === year - 1);
  const prevCollection = prevSnap ? snapshotCollectionSummary(prevSnap) : null;

  // Scoped invalidation after a write settles — this property's roll + the lease-page
  // invoices/payments panels; deliberately not a blanket sweep.
  const settle = () => {
    qc.invalidateQueries({ queryKey: rollKey });
    qc.invalidateQueries({ queryKey: ['monthlyRent'] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
    qc.invalidateQueries({ queryKey: ['payments'] });
  };

  // A statement import can touch OTHER properties' tenants (cross-property deposits)
  // plus this property's expenses — refresh every surface that money moved (shared
  // helper, so the Financials-page host invalidates the identical set).
  const settleImport = () => settleStatementImport(qc);

  const undoImport = useMutation({
    mutationFn: (imp) => undoStatementImport(imp),
    onSuccess: (res) => {
      setImported(null);
      setNote(res?.notes?.length ? res.notes.join(' ') : 'Import undone — its payments and expense additions were reversed.');
      settleImport();
    },
  });

  // Per-cell pending set (`${leaseId}:${m}`) so ONE click disables only its own box —
  // the whole grid stays clickable (parallel marks work), which is the speed fix.
  const [pendingCells, setPendingCells] = useState(() => new Set());
  const cellKey = (leaseId, m) => `${leaseId}:${m}`;

  // Optimistic paint: adjust the row's raw payments (what the allocation derives from)
  // so the click repaints instantly while the write settles.
  const paint = (old, leaseId, month, action, amount) =>
    (old || []).map((r) => {
      if (r.lease_id !== leaseId) return r;
      const payments = [...(r.payments || [])];
      const byMonth = { ...r.byMonth };
      if (action === 'unmark') {
        delete byMonth[month];
        return { ...r, byMonth, payments: payments.filter((p) => Number(p.period_month) !== month) };
      }
      payments.push({ amount, period_month: month, paid_date: localDateIso() });
      byMonth[month] = { amount: (byMonth[month]?.amount || 0) + amount };
      return { ...r, byMonth, payments };
    });

  const cellMut = useMutation({
    // Every write carries a real amount (open→full owed, gap→the residual) so markMonthPaid
    // skips the schedule rebuild AND the optimistic paint moves a real figure, not undefined.
    mutationFn: ({ leaseId, month, action, amount }) =>
      action === 'unmark'
        ? unmarkMonthPaid(leaseId, year, month)
        : markMonthPaid(leaseId, propId, year, month, { amount }),
    onMutate: async ({ leaseId, month, action, amount }) => {
      setPendingCells((s) => new Set(s).add(cellKey(leaseId, month)));
      await qc.cancelQueries({ queryKey: rollKey });
      const prev = qc.getQueryData(rollKey);
      qc.setQueryData(rollKey, (old) => paint(old, leaseId, month, action, amount));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(rollKey, ctx.prev); setNote('Could not save that change — please try again.'); },
    onSettled: (_d, _e, vars) => {
      setPendingCells((s) => { const n = new Set(s); n.delete(cellKey(vars.leaseId, vars.month)); return n; });
      settle();
    },
  });
  const allMut = useMutation({
    mutationFn: (month) => markMonthPaidAllTenants(propId, year, month),
    onError: () => setNote('Could not mark all paid — please try again.'),
    onSuccess: (res, month) => {
      setNote(`Marked ${MONTHS[month - 1]} paid for ${res.paid} tenant${res.paid === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} already covered or free)` : ''}.`);
    },
    onSettled: settle,
  });
  const catchUpAll = useMutation({
    // One round-trip for every due month × every tenant (the plural bulk), not a serial loop.
    mutationFn: (months) => markMonthsPaidAllTenants(propId, year, months),
    onSuccess: (res) => setNote(res.paid ? `Recorded ${res.paid} tenant-month${res.paid === 1 ? '' : 's'} of rent.` : 'Everyone was already caught up.'),
    onError: () => setNote('Could not catch up the ledger — please try again.'),
    onSettled: settle,
  });
  const bulkBusy = allMut.isPending || catchUpAll.isPending;

  // Module switched off → back to the property's Financials page.
  if (!featuresLoading && !isOn('ledger')) {
    return <Navigate to={`/financials/${corpId}/${propId}`} replace />;
  }

  const vacant = Number(totals?.vacant_sf) || 0;

  // Calendar awareness (localDateIso = the landlord's local "today", not UTC).
  const todayIso = localDateIso();
  const today = new Date(`${todayIso}T12:00:00`);
  const curY = Number(todayIso.slice(0, 4));
  const curM = Number(todayIso.slice(5, 7));
  const isCurrentFy = year === curY;
  const throughM = year < curY ? 12 : (isCurrentFy ? curM : 0);

  // Derive each row's allocation / components / summary ONCE per render.
  const derived = rows.map((r) => {
    const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments });
    const comp = componentizeSchedule({ schedule: r.schedule, factor: r.factor, camTaxAnnual: r.camTaxAnnual, roofAnnual: r.roofAnnual });
    const summary = ledgerRowSummary({ year, owedByMonth: r.schedule, allocation: alloc, today });
    return { r, alloc, comp, summary };
  });

  const markAll = (m) => {
    const unpaid = derived.filter(({ alloc }) => round2(alloc.owed[m - 1] - alloc.coverage[m - 1]) > 0.05).length;
    if (unpaid === 0) { setNote(`Everyone is already covered for ${MONTHS[m - 1]}.`); return; }
    if (window.confirm(`Mark ${MONTHS[m - 1]} ${year} paid for all ${unpaid} tenant${unpaid === 1 ? '' : 's'} who haven't yet?`)) {
      allMut.mutate(m);
    }
  };
  const catchUp = () => {
    if (!throughM) return;
    const months = Array.from({ length: throughM }, (_, i) => i + 1);
    if (window.confirm(`Mark rent paid for every tenant through ${MONTHS[throughM - 1]} ${year} (only what they still owe)?`)) {
      catchUpAll.mutate(months);
    }
  };
  const behindTotal = derived.reduce((acc, { summary }) => acc + summary.monthsBehind, 0);
  const totalCollected = derived.reduce((s, { summary }) => s + summary.collected, 0);
  const totalProjected = derived.reduce((s, { summary }) => s + summary.projected, 0);
  const totalCredit = derived.reduce((s, { summary }) => s + (summary.credit > 0.05 ? summary.credit : 0), 0);
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);

  if (importDoc) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1>{prop?.name || '…'}</h1>
            <div className="muted">Rent ledger · FY {year} — reviewing {importDoc.fileName}</div>
          </div>
        </div>
        <FinancialsTabs corpId={corpId} propId={propId} />
        <div className="panel">
          <StatementReview
            propertyId={propId}
            year={year}
            fileName={importDoc.fileName}
            accountHint={importDoc.accountHint}
            parsed={importDoc.parsed}
            pdfLane={importDoc.pdfLane}
            onCancel={() => setImportDoc(null)}
            onSaved={(res) => {
              setImportDoc(null);
              setImported({ ...res, fileName: importDoc.fileName });
              settleImport();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{prop?.name || '…'}</h1>
          <div className="muted">Rent ledger · FY {year} — projected vs collected, month by month</div>
        </div>
      </div>

      <FinancialsTabs corpId={corpId} propId={propId} />

      <div className="panel">
        <div className="panel-head">
          <strong>Ledger · FY {year}</strong>
          <span className="row" style={{ gap: 8 }}>
            {throughM > 0 && behindTotal > 0 && (
              <button type="button" className="ghost" disabled={bulkBusy} onClick={catchUp} title={`Record every unpaid month that has come due, for all tenants, through ${MONTHS[throughM - 1]}`}>
                {catchUpAll.isPending ? 'Recording…' : `✓ Mark everyone paid through ${MONTHS[throughM - 1]}`}
              </button>
            )}
            <ImportStatementButton onReady={setImportDoc} />
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 12 }}>
          <strong>✓</strong> paid — recording a payment marks the month paid whatever the amount; any gap vs the projection shows up in <em>Collected</em> and the year-end reconcile · dashed <strong>✓</strong> covered by a lump payment · <strong>◐</strong> partly covered by a lump · amber months have come due and aren't paid · <strong>—</strong> before the tenant moved in · <strong>Free</strong> abated.
          Click a box to record that month (or undo). A lump payment with no month recorded fills the earliest months first.
          {prevCollection?.rate != null && (
            <> · <Link to={`/history/${corpId}/${propId}`} className="rr-tenant" title="From the closed year's snapshot — open History for the trend">FY {year - 1} collection rate: {Math.round(prevCollection.rate * 100)}%</Link></>
          )}
        </div>
        {note && <p className="badge good" style={{ marginBottom: 10 }}>{note}</p>}
        {isLoading ? <p className="muted">Loading…</p> : (!rows.length && vacant <= 0) ? (
          <p className="empty-line muted">No tenants with rent on file for FY {year}.</p>
        ) : (
        <div className="table-wrap">
          <table className="rent-roll">
            <thead>
              <tr>
                <th>Tenant</th>
                {MONTHS.map((ml, i) => (
                  <th key={ml} className={isCurrentFy && i + 1 === curM ? 'rr-current' : undefined}>
                    <div className="rr-mhead">
                      <span>{ml}</span>
                      {i + 1 <= throughM && (
                        <button type="button" className="ghost rr-all" disabled={bulkBusy} onClick={() => markAll(i + 1)} title={`Mark ${ml} paid for all tenants`}>✓ all</button>
                      )}
                    </div>
                  </th>
                ))}
                <th className="rr-owes">Collected</th>
              </tr>
            </thead>
            <tbody>
              {derived.map(({ r, alloc, comp, summary }) => {
                const heldOver = (r.lease_termination_date && r.lease_termination_date < todayIso) || r.is_active === false;
                const rate = pct(summary.collected, summary.projected);
                // Representative month for the identity sub-line: the current month when
                // it's a normal billed month, else the first owed non-free month.
                let repM = isCurrentFy && (alloc.owed[curM - 1] || 0) > 0 && !r.schedule?.[curM]?.abated ? curM : 0;
                if (!repM) for (let m = 1; m <= 12; m++) if ((alloc.owed[m - 1] || 0) > 0 && !r.schedule?.[m]?.abated) { repM = m; break; }
                const rep = repM ? comp[repM] : null;
                return (
                  <tr key={r.lease_id}>
                    <td>
                      <Link to={`/leases/${corpId}/${propId}/${r.lease_id}`} className="rr-tenant">{r.tenant_name}</Link>
                      {heldOver && (
                        <div>
                          <span className="badge warn" style={{ marginTop: 3 }} title="This lease has expired but the tenant is being held over — rent still collects until you remove or extend the lease.">
                            Expired — held over{r.is_active === false ? ' · needs extension' : ''}
                          </span>
                        </div>
                      )}
                      <div className="rr-split">
                        {money(r.monthly)}/mo{rep ? ` = ${money(rep.base)} base · ${money(rep.camTax)} CAM&tax${rep.roof > 0 ? ` · ${money(rep.roof)} roof` : ''}` : ''}{r.owedMonths < 12 ? ` · ${r.owedMonths} mo` : ''}
                      </div>
                    </td>
                    {MONTHS.map((ml, i) => {
                      const m = i + 1;
                      const s = r.schedule?.[m];
                      const c = comp[m];
                      const owedM = alloc.owed[i];
                      const state = alloc.states[i];
                      const covered = alloc.coverage[i];
                      const settledM = alloc.settled[i];
                      const receivedM = alloc.received[i];
                      const pending = pendingCells.has(cellKey(r.lease_id, m));
                      if (s?.outsideTerm) {
                        return <td key={m}><span className="rr-cell outside" title={`${ml}: before this lease began`}>—</span></td>;
                      }
                      if (owedM <= 0) {
                        return <td key={m}><span className="rr-cell abated" title={`${ml}: base rent abated — nothing due`}>F</span></td>;
                      }
                      const parts = c ? `${money(c.base)} base · ${money(c.camTax)} CAM&tax${c.roof > 0 ? ` · ${money(c.roof)} roof` : ''}` : '';
                      const monthLine = `${ml}: ${money(owedM)} owed (${parts})${s?.abated ? ' — base rent abated' : ''}`;
                      const started = year < curY || (isCurrentFy && m <= curM);
                      if (state === 'covered') {
                        // A TAGGED month is settled — "paid = paid". It reads ✓ whatever the amount;
                        // when what came in differs from the projection, show that received figure.
                        if (settledM) {
                          const off = Math.abs(receivedM - owedM) > 0.05;
                          return (
                            <td key={m}>
                              <button type="button" className={`rr-cell paid${s?.abated ? ' abated' : ''}`} disabled={pending}
                                onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'unmark' })}
                                title={`${ml} paid — received ${money(receivedM)}${off ? ` (projected ${money(owedM)})` : ''} · click to undo`}>
                                ✓<span className="rr-amt">{money0(receivedM)}</span>
                              </button>
                            </td>
                          );
                        }
                        // Covered by an untagged lump — inert (managed on the lease's payments panel).
                        return (
                          <td key={m}>
                            <span className="rr-cell paid pool" title={`${monthLine} — covered by a lump payment · manage it on the lease's Invoices & payments`}>✓</span>
                          </td>
                        );
                      }
                      if (state === 'partial') {
                        // Only a pooled lump produces a partial now (a tag always settles). One glyph,
                        // one action: click records the gap so the month reads paid.
                        const gap = round2(owedM - covered);
                        return (
                          <td key={m}>
                            <button type="button" className="rr-cell partial" disabled={pending}
                              onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'gap', amount: gap })}
                              title={`${monthLine} — ${money(covered)} covered by a lump payment · click to record the remaining ${money(gap)}`}>◐</button>
                          </td>
                        );
                      }
                      const late = started;
                      return (
                        <td key={m}>
                          <button type="button" className={`rr-cell${late ? ' late' : ''}${s?.abated ? ' abated' : ''}`} disabled={pending}
                            onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'mark', amount: round2(owedM) })}
                            title={`${late ? 'Overdue — mark' : 'Mark'} ${monthLine.replace(`${ml}: `, `${ml} paid: `)}`}>—</button>
                        </td>
                      );
                    })}
                    <td className="rr-owes">
                      <div className="rr-collected"><strong>{money(summary.collected)}</strong> <span className="muted">of {money(summary.projected)}</span></div>
                      <div className="rr-progress"><span style={{ width: `${Math.min(100, rate ?? 0)}%` }} /></div>
                      <div className="rr-collected-sub">
                        <span className="muted">{rate != null ? `${rate}%` : '—'}</span>
                        {summary.credit > 0.05 && <span className="rr-credit" title="Collected more than projected — owed back to the tenant">credit {money(summary.credit)}</span>}
                        {summary.monthsBehind > 0 && <span className="rr-behind" title="Due months with nothing collected yet">{summary.monthsBehind} mo behind</span>}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {vacant > 0 && (
                <tr className="rr-vacant">
                  <td>
                    <span className="muted">Vacant space</span>
                    <div className="rr-split">{sf(vacant)} · nothing to collect</div>
                  </td>
                  {MONTHS.map((ml) => (
                    <td key={ml}><span className="rr-cell vacant" title={`${ml}: unleased space — no rent`}>—</span></td>
                  ))}
                  <td className="rr-owes muted">—</td>
                </tr>
              )}
              {derived.length > 1 && (
                <tr className="rr-totals">
                  <td className="muted">All tenants</td>
                  <td colSpan={12} />
                  <td className="rr-owes">
                    <div className="rr-collected"><strong>{money(totalCollected)}</strong> <span className="muted">of {money(totalProjected)}</span></div>
                    <div className="rr-progress"><span style={{ width: `${Math.min(100, pct(totalCollected, totalProjected) ?? 0)}%` }} /></div>
                    <div className="rr-collected-sub">
                      <span className="muted">{pct(totalCollected, totalProjected) != null ? `${pct(totalCollected, totalProjected)}%` : '—'}</span>
                      {totalCredit > 0.05 && <span className="rr-credit">credit {money(totalCredit)}</span>}
                      {behindTotal > 0 && <span className="rr-behind">{behindTotal} mo behind</span>}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}

        <ImportResultsStrip
          imported={imported}
          undoPending={undoImport.isPending}
          onUndo={() => undoImport.mutate(imported.import)}
          onDismiss={() => setImported(null)}
        />
        <MutationError of={[undoImport]} />

        {register.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <button type="button" className="ghost" onClick={() => setShowRegister((v) => !v)}>
              {showRegister ? '▾' : '▸'} Imported statements ({register.length}) — {showRegister ? 'hide' : 'show'}
            </button>
            {showRegister && (
              <table style={{ minWidth: 0, marginTop: 8 }}>
                <thead><tr><th>File</th><th>Account</th><th>Imported</th><th className="num">Payments</th><th className="num">Expenses</th><th></th></tr></thead>
                <tbody>
                  {register.map((imp) => {
                    const applied = imp.applied || [];
                    const pays = applied.filter((a) => a.kind === 'payment');
                    const exps = applied.filter((a) => a.kind !== 'payment');
                    return (
                      <tr key={imp.id}>
                        <td>{imp.file_name || '—'}</td>
                        <td>{imp.account_hint || '—'}</td>
                        <td>{fmtDate(imp.created_at)}</td>
                        <td className="num">{pays.length} · {money(pays.reduce((s, a) => s + Number(a.amount || 0), 0))}</td>
                        <td className="num">{exps.length} · {money(exps.reduce((s, a) => s + Number(a.amount || 0), 0))}</td>
                        <td className="num">
                          <button type="button" className="ghost btn-sm" disabled={undoImport.isPending}
                            onClick={() => { if (window.confirm(`Undo the import of ${imp.file_name || 'this statement'}? Its payments and expense additions are reversed.`)) undoImport.mutate(imp); }}>
                            ↩ Undo
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
