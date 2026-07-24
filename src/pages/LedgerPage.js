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
  signDocUrl,
  localDateIso,
} from '../lib/api';
import { allocatePayments, componentizeSchedule, escalationStepMonths, ledgerRowSummary, representativeMonth, snapshotCollectionSummary } from '../lib/ledger';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { useFeatures } from '../lib/features';
import FinancialsTabs from '../components/FinancialsTabs';
import StatementReview from '../components/StatementReview';
import ImportStatementButton, { ImportResultsStrip, settleStatementImport } from '../components/ImportStatementButton';
import LearnedPayeesPanel from '../components/LearnedPayeesPanel';
import MutationError from '../components/MutationError';
import { money, money0, sf, fmtDate } from '../lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// The row's payment difference in one chip: across every month that has come due AND
// been paid, how far the deposits landed from the bill. Silent below 50¢ — that's
// rounding, not a difference worth a landlord's attention.
function VarianceChip({ variance }) {
  const v = round2(Number(variance) || 0);
  if (Math.abs(v) <= 0.5) return null;
  return v < 0
    ? <span className="rr-short" title="Across the months already paid, the deposits came in under what the lease billed. The estimate is what's billed all year; the year-end ⚖ Reconcile settles the difference.">short {money(Math.abs(v))}</span>
    : <span className="rr-over" title="Across the months already paid, the deposits came in over what the lease billed.">over {money(v)}</span>;
}

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
  // Scoped to the fiscal year the rest of the page follows, so the log resets with the
  // year instead of every statement ever imported piling into one list.
  const { data: register = [] } = useQuery({
    queryKey: ['statementImports', propId, year],
    queryFn: () => listStatementImports(propId, year),
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
    const steps = escalationStepMonths({ schedule: r.schedule, comp });
    return { r, alloc, comp, summary, steps };
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
  const totalBilled = derived.reduce((s, { summary }) => s + summary.billed, 0);
  const totalVariance = round2(derived.reduce((s, { summary }) => s + summary.variance, 0));
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
            storagePath={importDoc.storagePath}
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
        {/* The key is built from REAL .rr-cell elements wearing the live classes, so it
            can never drift from what the grid actually paints. */}
        <div className="rr-key">
          <span className="rr-key-label">Key</span>
          <span className="rr-key-item"><span className="rr-cell paid">✓<span className="rr-amt">5,324</span></span> paid in full</span>
          <span className="rr-key-item"><span className="rr-cell paid">✓<span className="rr-amt under">5,025</span></span> paid under the bill</span>
          <span className="rr-key-item"><span className="rr-cell paid pool">✓</span> covered by a lump</span>
          <span className="rr-key-item"><span className="rr-cell partial">◐</span> partly covered</span>
          <span className="rr-key-item"><span className="rr-cell late">—</span> due, unpaid</span>
          <span className="rr-key-item"><span className="rr-cell recv">↓</span> received, not billed</span>
          <span className="rr-key-item"><span className="rr-cell rr-step">▌</span> rent stepped up</span>
          <span className="rr-key-note">Click a box to record that month, or undo it. A payment with no month recorded fills the earliest months first.</span>
          {prevCollection?.rate != null && (
            <Link to={`/history/${corpId}/${propId}`} className="rr-key-note rr-tenant" title="From the closed year's snapshot — open History for the trend">FY {year - 1} collection rate: {Math.round(prevCollection.rate * 100)}%</Link>
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
              {derived.map(({ r, alloc, comp, summary, steps }) => {
                const heldOver = (r.lease_termination_date && r.lease_termination_date < todayIso) || r.is_active === false;
                const rate = pct(summary.collected, summary.projected);
                const stepSet = new Set(steps.map((s) => s.month));
                // Identity sub-line: show the tenant's CURRENT monthly, not a year-average.
                // On a stepped tenant the average (r.monthly = annual ÷ months) equals no box
                // and doesn't match its own base·CAM&tax breakdown — so read the representative
                // month's owed, which ties the headline, its breakdown, and that month's box.
                const repM = representativeMonth({ owedByMonth: alloc.owed, schedule: r.schedule, isCurrentFy, curMonth: curM });
                const rep = repM ? comp[repM] : null;
                const repMonthly = rep ? round2(alloc.owed[repM - 1]) : r.monthly;
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
                        {money(repMonthly)}/mo{rep ? ` = ${money(rep.base)} base · ${money(rep.camTax)} CAM&tax${rep.roof > 0 ? ` · ${money(rep.roof)} roof` : ''}` : ''}{r.owedMonths < 12 ? ` · ${r.owedMonths} mo` : ''}
                      </div>
                      {steps.length > 0 && (
                        <div className="rr-step-note" title="This tenant's base rent stepped up mid-year on a scheduled escalation — the two different monthly amounts are both correct.">
                          ↗ rent raised to {money(steps[0].owed)}/mo in {MONTHS[steps[0].month - 1]}
                        </div>
                      )}
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
                      // A scheduled rent escalation lands ON this month (base stepped up vs
                      // the prior month) — mark it so the higher amount from here reads as
                      // the intended raise. outsideTerm/owed<=0 months can't be steps.
                      const isStep = stepSet.has(m);
                      const stepCls = isStep ? ' rr-step' : '';
                      const stepTip = isStep ? '↗ Scheduled rent escalation — base rent stepped up this month; the higher amount from here on is the raise, not an error. ' : '';
                      // Money recorded FOR a month the lease bills nothing for (a tenant
                      // whose lease starts later in the year, an abated month). The tag
                      // holds — it renders before the out-of-term / abated cells, which
                      // would otherwise print "—" over a real deposit and leave the money
                      // to drift onto whatever month the lease does bill.
                      if (state === 'unbilled') {
                        return (
                          <td key={m}>
                            <button type="button" className="rr-cell recv" disabled={pending}
                              onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'unmark' })}
                              title={`${ml}: ${money(receivedM)} received — this lease bills nothing for ${ml}, so it settles no charge and isn't counted as collected rent. Click to undo.`}>
                              ↓<span className="rr-amt">{money0(receivedM)}</span>
                            </button>
                          </td>
                        );
                      }
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
                          const tagCount = (r.payments || []).filter((p) => Number(p.period_month) === m).length;
                          const diff = round2(receivedM - owedM);
                          // "paid = paid" stands: the box stays forest ✓ and stays clickable. Only
                          // the FIGURE carries the difference — gold when the deposit came in under
                          // the bill, a + when it came in over. That's the whole signal George
                          // asked to be able to read at a glance, and it costs the cell nothing.
                          const off = Math.abs(diff) > 0.5;
                          const amtCls = `rr-amt${off ? (diff < 0 ? ' under' : ' over') : ''}`;
                          const amtText = `${off && diff > 0 ? '+' : ''}${money0(receivedM)}`;
                          const diffTip = off
                            ? ` — ${diff < 0 ? `${money(Math.abs(diff))} under` : `${money(diff)} over`} the ${money(owedM)} billed`
                            : '';
                          // Recorded across MORE than one same-month payment: undoing would delete
                          // them all, so it's inert here and managed on the lease's Invoices & payments.
                          if (tagCount > 1) {
                            return (
                              <td key={m}>
                                <span className={`rr-cell paid${s?.abated ? ' abated' : ''}${stepCls}`}
                                  title={`${stepTip}${ml}: received ${money(receivedM)}${diffTip} — recorded across ${tagCount} payments · manage on the lease's Invoices & payments`}>
                                  ✓<span className={amtCls}>{amtText}</span>
                                </span>
                              </td>
                            );
                          }
                          // One tagged payment — paid = paid, click to undo whatever the amount.
                          return (
                            <td key={m}>
                              <button type="button" className={`rr-cell paid${s?.abated ? ' abated' : ''}${stepCls}`} disabled={pending}
                                onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'unmark' })}
                                title={`${stepTip}${ml} paid — received ${money(receivedM)}${diffTip} · click to undo`}>
                                ✓<span className={amtCls}>{amtText}</span>
                              </button>
                            </td>
                          );
                        }
                        // Covered by an untagged lump. Show the amount it drew and say a lump paid
                        // it — a faded, figureless, unclickable ✓ reads as a button that didn't press.
                        return (
                          <td key={m}>
                            <span className={`rr-cell paid pool${stepCls}`} title={`${stepTip}${monthLine} — ${money(receivedM)} drawn from a lump payment · manage it on the lease's Invoices & payments`}>
                              ✓<span className="rr-amt">{money0(receivedM)}</span>
                            </span>
                          </td>
                        );
                      }
                      if (state === 'partial') {
                        // Only a pooled lump produces a partial now (a tag always settles). One glyph,
                        // one action: click records the gap so the month reads paid.
                        const gap = round2(owedM - covered);
                        return (
                          <td key={m}>
                            <button type="button" className={`rr-cell partial${stepCls}`} disabled={pending}
                              onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'gap', amount: gap })}
                              title={`${stepTip}${monthLine} — ${money(covered)} covered by a lump payment · click to record the remaining ${money(gap)}`}>◐</button>
                          </td>
                        );
                      }
                      const late = started;
                      return (
                        <td key={m}>
                          <button type="button" className={`rr-cell${late ? ' late' : ''}${s?.abated ? ' abated' : ''}${stepCls}`} disabled={pending}
                            onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'mark', amount: round2(owedM) })}
                            title={`${stepTip}${late ? 'Overdue — mark' : 'Mark'} ${monthLine.replace(`${ml}: `, `${ml} paid: `)}`}>—</button>
                        </td>
                      );
                    })}
                    <td className="rr-owes">
                      <div className="rr-collected"><strong>{money(summary.collected)}</strong> <span className="muted">of {money(summary.billed)} billed</span></div>
                      <div className="rr-progress"><span style={{ width: `${Math.min(100, rate ?? 0)}%` }} /></div>
                      <div className="rr-collected-sub">
                        <span className="muted">{rate != null ? `${rate}%` : '—'}</span>
                        <VarianceChip variance={summary.variance} />
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
                    <div className="rr-collected"><strong>{money(totalCollected)}</strong> <span className="muted">of {money(totalBilled)} billed</span></div>
                    <div className="rr-progress"><span style={{ width: `${Math.min(100, pct(totalCollected, totalProjected) ?? 0)}%` }} /></div>
                    <div className="rr-collected-sub">
                      <span className="muted">{pct(totalCollected, totalProjected) != null ? `${pct(totalCollected, totalProjected)}%` : '—'}</span>
                      <VarianceChip variance={totalVariance} />
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
            <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>FY {year}</span>
            {showRegister && (
              <table style={{ minWidth: 0, marginTop: 8 }}>
                <thead><tr><th>File</th><th>Account</th><th>Imported</th><th className="num">Payments</th><th className="num">Expenses</th><th></th></tr></thead>
                <tbody>
                  {register.map((imp) => {
                    const applied = imp.applied || [];
                    const pays = applied.filter((a) => a.kind === 'payment');
                    // Explicit expense kinds only — 'rule' records (auto-learned payees) also
                    // ride in `applied` but aren't expenses, so they mustn't be counted here.
                    const exps = applied.filter((a) => a.kind === 'cam' || a.kind === 'tax' || a.kind === 'roof');
                    return (
                      <tr key={imp.id}>
                        <td>{imp.file_name || '—'}</td>
                        <td>{imp.account_hint || '—'}</td>
                        <td>{fmtDate(imp.created_at)}</td>
                        <td className="num">{pays.length} · {money(pays.reduce((s, a) => s + Number(a.amount || 0), 0))}</td>
                        <td className="num">{exps.length} · {money(exps.reduce((s, a) => s + Number(a.amount || 0), 0))}</td>
                        <td className="num">
                          {imp.storage_path && (
                            <button type="button" className="ghost btn-sm" title="Open the statement file this came from"
                              onClick={async () => {
                                const url = await signDocUrl(imp.storage_path).catch(() => null);
                                if (url) window.open(url, '_blank', 'noopener');
                                else setNote('That statement file is no longer available.');
                              }}>
                              Open
                            </button>
                          )}
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

        <LearnedPayeesPanel propId={propId} year={year} />
      </div>
    </div>
  );
}
