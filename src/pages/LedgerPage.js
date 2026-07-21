import { useRef, useState } from 'react';
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
  listStatementImports,
  undoStatementImport,
  listSnapshots,
  uploadDoc,
  extractBankStatement,
  localDateIso,
} from '../lib/api';
import { DEMO_MODE } from '../lib/supabaseClient';
import { allocatePayments, componentizeSchedule, ledgerRowSummary, snapshotCollectionSummary } from '../lib/ledger';
import { parseBankStatementCsv, normalizeStatementRows, applyBalanceCheck } from '../lib/statementParse';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { useFeatures } from '../lib/features';
import FinancialsTabs from '../components/FinancialsTabs';
import StatementReview from '../components/StatementReview';
import MutationError from '../components/MutationError';
import { money, sf, fmtDate } from '../lib/format';

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
  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState('');
  // The post-save results strip: { summary, import, fileName }.
  const [imported, setImported] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const fileRef = useRef(null);
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
  // plus this property's expenses — refresh every surface that money moved.
  const settleImport = () => {
    qc.invalidateQueries({ queryKey: ['propertyRentRoll'] });
    qc.invalidateQueries({ queryKey: ['monthlyRent'] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
    qc.invalidateQueries({ queryKey: ['payments'] });
    qc.invalidateQueries({ queryKey: ['invoicesForProperty'] });
    qc.invalidateQueries({ queryKey: ['tenantShares'] });
    qc.invalidateQueries({ queryKey: ['propertyTotals'] });
    qc.invalidateQueries({ queryKey: ['expenseRecord'] });
    qc.invalidateQueries({ queryKey: ['camLineItems'] });
    qc.invalidateQueries({ queryKey: ['corpRollups'] });
    qc.invalidateQueries({ queryKey: ['historyEvents'] });
    qc.invalidateQueries({ queryKey: ['statementImports'] });
    qc.invalidateQueries({ queryKey: ['statementContext'] });
    qc.invalidateQueries({ queryKey: ['reconciliations'] });
  };

  async function openStatementFile(file) {
    setImportErr('');
    setImportBusy(true);
    try {
      if (/\.csv$/i.test(file.name)) {
        // CSV lane — parsed right here, $0, never uploaded.
        const parsed = parseBankStatementCsv(await file.text(), { fileName: file.name });
        setImportDoc({ fileName: file.name, accountHint: parsed.accountHint, parsed, pdfLane: false });
      } else {
        // PDF lane — one transcription read (~5–15¢); the transcript still passes
        // the same validation gate + balance check the CSV lane gets.
        const path = await uploadDoc(file);
        const res = await extractBankStatement({ path });
        const gate = normalizeStatementRows(res?.transactions || []);
        const checked = applyBalanceCheck(gate.transactions);
        setImportDoc({
          fileName: file.name,
          accountHint: null,
          parsed: { transactions: checked.transactions, skippedLines: gate.skippedLines, warnings: checked.warnings },
          pdfLane: true,
        });
      }
    } catch (e) {
      setImportErr(e?.message || 'Could not read that statement.');
    } finally {
      setImportBusy(false);
    }
  }

  async function openSampleStatement() {
    // Demo: the canned transcription runs the REAL gate + matcher — no AI, no files.
    setImportErr('');
    setImportBusy(true);
    try {
      const res = await extractBankStatement({ path: 'demo-sample' });
      const gate = normalizeStatementRows(res?.transactions || []);
      setImportDoc({
        fileName: 'sample-statement.pdf',
        accountHint: '••4821',
        parsed: { transactions: gate.transactions, skippedLines: gate.skippedLines, warnings: [] },
        pdfLane: true,
      });
    } finally {
      setImportBusy(false);
    }
  }

  const undoImport = useMutation({
    mutationFn: (imp) => undoStatementImport(imp),
    onSuccess: (res) => {
      setImported(null);
      setNote(res?.notes?.length ? res.notes.join(' ') : 'Import undone — its payments and expense additions were reversed.');
      settleImport();
    },
  });

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
    mutationFn: ({ leaseId, month, action, amount }) =>
      action === 'unmark'
        ? unmarkMonthPaid(leaseId, year, month)
        : markMonthPaid(leaseId, propId, year, month, action === 'gap' ? { amount } : {}),
    onMutate: async ({ leaseId, month, action, amount }) => {
      await qc.cancelQueries({ queryKey: rollKey });
      const prev = qc.getQueryData(rollKey);
      qc.setQueryData(rollKey, (old) => paint(old, leaseId, month, action, amount));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(rollKey, ctx.prev); setNote('Could not save that change — please try again.'); },
    onSettled: settle,
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
    mutationFn: async (months) => {
      let paid = 0;
      for (const m of months) { const res = await markMonthPaidAllTenants(propId, year, m); paid += res.paid; }
      return paid;
    },
    onSuccess: (paid) => setNote(paid ? `Recorded ${paid} tenant-month${paid === 1 ? '' : 's'} of rent.` : 'Everyone was already caught up.'),
    onError: () => setNote('Could not catch up the ledger — please try again.'),
    onSettled: settle,
  });
  const busy = cellMut.isPending || allMut.isPending || catchUpAll.isPending;

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
  const totalOwes = derived.reduce((s, { summary }) => s + summary.owesToDate, 0);

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
              <button type="button" className="ghost" disabled={busy} onClick={catchUp} title={`Record every unpaid month that has come due, for all tenants, through ${MONTHS[throughM - 1]}`}>
                {catchUpAll.isPending ? 'Recording…' : `✓ Mark everyone paid through ${MONTHS[throughM - 1]}`}
              </button>
            )}
            {DEMO_MODE && (
              <button type="button" className="secondary btn-sm" disabled={importBusy} onClick={openSampleStatement} title="Run the bundled sample statement through the real import flow — no files needed">
                Try a sample statement
              </button>
            )}
            <button type="button" className="secondary btn-sm" disabled={importBusy} onClick={() => fileRef.current?.click()} title="Import a bank statement — CSV reads instantly and free; a PDF uses one AI transcription read (~5–15¢)">
              {importBusy ? 'Reading…' : '⬆ Import statement'}
            </button>
            <input ref={fileRef} type="file" accept=".csv,.pdf" style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) openStatementFile(f); }} />
          </span>
        </div>
        {importErr && <p className="note-msg danger" style={{ marginBottom: 10 }}>{importErr}</p>}
        <div className="muted" style={{ fontSize: 12, marginTop: 4, marginBottom: 12 }}>
          <strong>✓</strong> collected · <strong>◐</strong> partly collected · amber months have come due and aren't covered · <strong>—</strong> before the tenant moved in · <strong>Free</strong> abated.
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
                      <button type="button" className="ghost rr-all" disabled={busy} onClick={() => markAll(i + 1)} title={`Mark ${ml} paid for all tenants`}>✓ all</button>
                    </div>
                  </th>
                ))}
                <th className="rr-owes">Collected</th>
                <th className="rr-owes">Owes</th>
              </tr>
            </thead>
            <tbody>
              {derived.map(({ r, alloc, comp, summary }) => {
                const heldOver = (r.lease_termination_date && r.lease_termination_date < todayIso) || r.is_active === false;
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
                      const tagged = !!r.byMonth[m];
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
                        if (tagged) {
                          return (
                            <td key={m}>
                              <button type="button" className={`rr-cell paid${s?.abated ? ' abated' : ''}`} disabled={busy}
                                onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'unmark' })}
                                title={`${monthLine} — collected · click to undo`}>✓</button>
                            </td>
                          );
                        }
                        return (
                          <td key={m}>
                            <span className="rr-cell paid pool" title={`${monthLine} — covered by an untagged payment · manage it on the lease's Invoices & payments`}>✓</span>
                          </td>
                        );
                      }
                      if (state === 'partial') {
                        const gap = round2(owedM - covered);
                        if (tagged) {
                          return (
                            <td key={m}>
                              <button type="button" className="rr-cell partial" disabled={busy}
                                onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'unmark' })}
                                title={`${monthLine} — ${money(covered)} collected, ${money(gap)} open · click to remove the recorded payment(s)`}>◐</button>
                            </td>
                          );
                        }
                        return (
                          <td key={m}>
                            <button type="button" className="rr-cell partial" disabled={busy}
                              onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'gap', amount: gap })}
                              title={`${monthLine} — ${money(covered)} covered by an untagged payment · click to record the remaining ${money(gap)}`}>◐</button>
                          </td>
                        );
                      }
                      const late = started;
                      return (
                        <td key={m}>
                          <button type="button" className={`rr-cell${late ? ' late' : ''}${s?.abated ? ' abated' : ''}`} disabled={busy}
                            onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'mark' })}
                            title={`${late ? 'Overdue — mark' : 'Mark'} ${monthLine.replace(`${ml}: `, `${ml} paid: `)}`}>—</button>
                        </td>
                      );
                    })}
                    <td className="rr-owes"><strong>{money(summary.collected)}</strong></td>
                    <td className="rr-owes">
                      {summary.credit > 0.05 ? (
                        <span className="badge warn" title="Collected more than the year bills — owed back to the tenant">credit {money(summary.credit)}</span>
                      ) : summary.owesToDate > 0.05 ? (
                        <strong className="rr-behind" title={`${summary.monthsBehind} month${summary.monthsBehind === 1 ? '' : 's'} behind`}>{money(summary.owesToDate)}</strong>
                      ) : (
                        <span className="pos">paid ✓</span>
                      )}
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
                  <td className="rr-owes muted">—</td>
                </tr>
              )}
              {derived.length > 1 && (
                <tr className="rr-totals">
                  <td className="muted">All tenants</td>
                  <td colSpan={12} />
                  <td className="rr-owes"><strong>{money(totalCollected)}</strong></td>
                  <td className="rr-owes">{totalOwes > 0.05 ? <strong className="rr-behind">{money(totalOwes)}</strong> : <span className="pos">paid ✓</span>}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}

        {imported && (
          <div className="undo-strip" style={{ marginTop: 12 }}>
            <span>
              saved · Imported {imported.fileName} — {imported.summary.paymentsCount} payment{imported.summary.paymentsCount === 1 ? '' : 's'} · {money(imported.summary.paymentsTotal)} in
              {' · '}{imported.summary.expensesCount} expense{imported.summary.expensesCount === 1 ? '' : 's'} · {money(imported.summary.expensesTotal)} out
              {Object.keys(imported.summary.crossProperty || {}).length > 0 && (
                <> · {Object.values(imported.summary.crossProperty).reduce((s, n) => s + n, 0)} payment(s) posted to other properties' tenants — they show on those ledgers</>
              )}
            </span>
            <button type="button" className="ghost btn-sm" disabled={undoImport.isPending} onClick={() => undoImport.mutate(imported.import)}>↩ Undo</button>
            <button type="button" className="icon-btn" title="Dismiss" onClick={() => setImported(null)}>✕</button>
          </div>
        )}
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
