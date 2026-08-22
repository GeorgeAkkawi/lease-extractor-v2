import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  getCorporation,
  getProperty,
  getPropertyTotals,
  getExpenseRecord,
  undoStatementImport,
  discardDocument,
  setRoofSeparate,
  getTenantShares,
  listSnapshots,
} from '../lib/api';
import { listBasisByProperty } from '../lib/portfolioBasis';
import { showRoof, roofOffered } from '../lib/roofDisplay';
import { useConfirm } from '../components/ConfirmDialog';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import FinancialsTabs from '../components/FinancialsTabs';
import Panel from '../components/Panel';
import TenantShareTable from '../components/TenantShareTable';
import CamSection from '../components/CamSection';
import TaxSection from '../components/TaxSection';
import RoofSection from '../components/RoofSection';
import RecoverabilityTable from '../components/RecoverabilityTable';
import OtherIncomeSection from '../components/OtherIncomeSection';
import WhatStayedStrip from '../components/WhatStayedStrip';
import BuildingSizeEditor from '../components/BuildingSizeEditor';
import useRecoverability from '../lib/useRecoverability';
import useCamSync from '../lib/useCamSync';
import StatementReview from '../components/StatementReview';
import ImportStatementButton, { ImportResultsStrip, StatementDropZone, settleStatementImport } from '../components/ImportStatementButton';
import ExportReconciliationModal from '../components/ExportReconciliationModal';
import MutationError from '../components/MutationError';
import { money, psf, sf } from '../lib/format';

// whole-dollar money (no cents) for the compact roof billed/absorbed line
const money0 = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

export default function PropertyFinancialsPage() {
  const { corpId, propId } = useParams();
  const { year } = useChrome();
  const qc = useQueryClient();

  const askConfirm = useConfirm();

  // Contracts and the management fee become this year's CAM lines — from the page, not from
  // a queryFn a co-observer can pre-empt, and not from CamSection, which the landlord can fold.
  useCamSync(propId, year);

  // ⚠ WHETHER THIS YEAR IS CLOSED IS A FACT THIS PAGE HAS TO STATE. Every editor below moves
  // figures that build UP from live data — the shares, the Difference column, the totals band,
  // the expense cards — while `resyncPropertyBilling` returns `{ skipped: 'closed' }` and the
  // invoices already sent deliberately stay as they were. That refusal is right (CLAUDE.md §1)
  // and it used to print nothing at all, which left the landlord's own screen disagreeing with
  // his bills and no way to tell from here. Same `['snapshots', propId]` key the Ledger and the
  // import review already warm, so this is a cache hit.
  const { data: snapshots = [] } = useQuery({ queryKey: ['snapshots', propId], queryFn: () => listSnapshots(propId) });
  const yearClosed = (snapshots || []).some((s) => Number(s.year) === Number(year));

  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  const { data: totals } = useQuery({ queryKey: ['propertyTotals', propId, year], queryFn: () => getPropertyTotals(propId, year), placeholderData: keepPreviousData });
  // The Overview's projected Revenue for THIS property — the leases' own months, each raise
  // dated, via the ONE loader that derives it (portfolioBasis; a second derivation here is the
  // §3 drift that had two screens quoting different projections all along). Keyed under the
  // `portfolioBasis` family so `settleBillingChange` repaints it with everything else. Used
  // only for the reconciling note under the revenue card — the card's own figure stays the
  // view's, because NOI and the margin beside it are the view's arithmetic.
  const { data: basisForNote } = useQuery({
    queryKey: ['portfolioBasis', 'one', propId, year],
    queryFn: () => listBasisByProperty([propId], year),
    placeholderData: keepPreviousData,
  });
  const scheduleRent = basisForNote?.[propId]?.rentProjected;
  const { data: expense } = useQuery({ queryKey: ['expenseRecord', propId, year], queryFn: () => getExpenseRecord(propId, year), placeholderData: keepPreviousData });
  usePageChrome([
    { label: 'Financials', to: '/financials' },
    { label: corp?.name || '…', to: `/financials/${corpId}` },
    { label: prop?.name || '…' },
  ], true);

  // Statement import from the Expense entry — the same pipeline as the Ledger tab
  // (two doors, one flow): the review swaps in full-page, Save books everything,
  // then the results strip with ↩ Undo shows here beside the expenses it created.
  const [importDoc, setImportDoc] = useState(null);
  const [imported, setImported] = useState(null);
  const [exporting, setExporting] = useState(false);
  const undoImport = useMutation({
    mutationFn: (imp) => undoStatementImport(imp),
    onSuccess: () => { setImported(null); settleStatementImport(qc); },
  });

  const totalSf = totals?.total_sf ?? 0;
  const buildingSf = (totals?.building_sf ?? Number(prop?.building_sf)) || 0;
  const occupancy = totals?.occupancy != null ? Math.round(totals.occupancy * 100) : null;
  const revenue = totals?.total_revenue ?? 0;
  const taxes = Number(totals?.taxes_total ?? expense?.taxes_total ?? 0);
  const cam = Number(totals?.cam_total ?? expense?.cam_total ?? 0);
  const roof = Number(totals?.roof_total ?? expense?.roof_total ?? 0);
  const totalExp = taxes + cam + roof;
  const noi = totals?.noi ?? revenue - totalExp;
  const margin = revenue > 0 ? Math.round((noi / revenue) * 100) : null;
  // ⚠ WHAT NOI DOES NOT KNOW. `v_property_totals.noi` is `Σ effective_rent − (taxes + cam +
  // roof)` (migration 0049) — base rent on one side, GROSS expenses on the other — so on a
  // triple-net property it is struck BEFORE the reimbursement that is meant to cancel those
  // expenses. The card said none of that, which is how a landlord reads a NNN building's NOI
  // as lower than the rent it charges and has no way to tell why (George, 2026-08-21).
  // Same loader the two panels below use, so this is a cache hit and the figure quoted here
  // is the one they print.
  const { totals: recovTotals } = useRecoverability(propId, year);
  const reimbursed = Number(recovTotals?.recovered || 0);
  const roofRecovered = totals?.roof_recovered ?? 0;
  const roofUnrecovered = totals?.roof_unrecovered ?? roof;

  // ── Does this building bill roof separately (0097)? ────────────────────────────────────
  // The checkbox says what the landlord WANTS; `roofInUse` says what is actually happening,
  // and the second one wins whenever they disagree.
  //
  // ⚠ THE SECOND HALF IS NOT OPTIONAL, and not available where you'd first look for it. A roof
  // total alone leaves a dead end: switch a property off while empty, let an addendum mark a
  // lease roof-responsible, and the landlord has a tenant on the hook for roof and no box to
  // enter the cost in. v_property_totals looks like it answers this — 0049 computes resp_sf —
  // but that lives in a CTE and is never selected out (checked live: PostgREST says 42703), so
  // reading totals.resp_sf would be `undefined > 0`, i.e. permanently false. v_tenant_shares
  // does carry roof_responsible per lease, and TenantShareTable on this very page already
  // fetches it under this exact key — so React Query serves both from one request.
  const { data: shares = [] } = useQuery({
    queryKey: ['tenantShares', propId, year],
    queryFn: () => getTenantShares(propId, year),
  });
  const roofInUse = roof > 0 || shares.some((s) => s.roof_responsible);
  // What the per-tenant table adds up to, for the line it shows while folded.
  const allocated = shares.reduce(
    (t, s) => t + (Number(s.tax_amount) || 0) + (Number(s.cam_amount) || 0) + (Number(s.roof_amount) || 0),
    0,
  );
  const roofVisible = showRoof(prop, roofInUse);
  const roofOn = roofOffered(prop);
  const setRoof = useMutation({
    mutationFn: (on) => setRoofSeparate(propId, on),
    // ⚠ NO settleBillingChange, and no resync. Unlike building_sf — a denominator inside
    // v_tenant_shares — nothing downstream of this column reaches a share or an invoice.
    // Only the property row itself moved, so only the property row is refetched.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['property', propId] }),
  });
  // George asked for the description in a popup, and it is the right place for it: this is the
  // one control on the page whose effect is mostly about what STOPS being shown.
  async function askRoof(on) {
    const where = prop?.name ? ` at ${prop.name}` : '';
    const ok = await askConfirm(on
      ? {
        title: `Bill roof separately${where}?`,
        message: 'Roof work gets its own expense box, and its own line on a tenant’s bill — charged only to the leases whose terms make them responsible for the roof.',
        implications: [
          'Nothing moves now. This adds the box; what a tenant pays changes only when you enter a roof cost or mark a lease roof-responsible.',
          'Roof is split by floor area and ignores a tenant’s custom share % — unlike CAM. That is the real difference between the two.',
        ],
        confirmLabel: 'Turn on', tone: 'default',
      }
      : {
        title: `Stop billing roof separately${where}?`,
        message: 'Roof repairs become an ordinary CAM expense here — you record them as a CAM line and they are shared like any other CAM cost.',
        implications: [
          'Nothing moves. No bill changes, no invoice is rebuilt, and no figure already recorded is altered.',
          'It only stops offering roof on this property. Wherever roof already carries a figure — a year with a roof total, or a lease charged for the roof — it keeps showing, so nothing is ever billed out of sight.',
          'You can turn it back on here at any time.',
        ],
        confirmLabel: 'Turn off', tone: 'default',
      });
    if (ok) setRoof.mutate(on);
  }

  if (importDoc) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1>{prop?.name || '…'}</h1>
            <div className="muted">Expense entry · FY {year} — reviewing {importDoc.fileName}</div>
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
            onCancel={() => { const p = importDoc.storagePath; setImportDoc(null); if (p) discardDocument(p).catch(() => {}); }}
            onSaved={(res) => {
              setImportDoc(null);
              setImported({ ...res, fileName: importDoc.fileName });
              settleStatementImport(qc);
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
          <div className="muted">
            {prop?.address ? `${prop.address} · ` : ''}FY {year} · {sf(totalSf)} leased
            {buildingSf ? ` of ${Number(buildingSf).toLocaleString()}` : ''}
            {occupancy != null ? ` · ${occupancy}% occupied` : ''}
          </div>
        </div>
      </div>

      <FinancialsTabs corpId={corpId} propId={propId} />

      {yearClosed && (
        <div className="callout warn" role="status">
          <strong>FY {year} is closed.</strong>{' '}
          Edits here still move your records and your reconciliation — but the invoices already
          sent for {year} stay exactly as they were sent, so this page and those bills will differ.
          Reopen the year in <Link to={`/history/${corpId}/${propId}`}>History</Link> if the bills
          should follow.
        </div>
      )}

      <div className="metric-group">
        <div className="fin-subhead">Performance · FY {year}</div>
        <div className="metrics">
          {/* ⚠ "Projected" is the OVERVIEW's word now, and it means the dated schedule. This
              card is the annual RATE — every lease at today's rent for all twelve months
              (`v_property_totals.total_revenue`, which NOI and the margin beside it are built
              from, so the figure stays). The label says which question it answers, and the
              note reconciles it to the Overview whenever a mid-year raise makes them differ —
              the reconciliation George asked after three times, on the screen instead of in
              an explanation (2026-08-18 (12)). */}
          <StatCard
            label="Revenue at today's rates (annualized)"
            main={money(revenue)}
            footValue={totalSf ? psf(revenue / totalSf) : '—'}
            footCap="per leased sq ft"
            note={scheduleRent != null && Math.abs(scheduleRent - revenue) > 1 ? (
              <span>
                The Overview projects <strong>{money(scheduleRent)}</strong> — same leases, with
                each raise counted from the month it lands rather than all year.
              </span>
            ) : null}
          />
          <StatCard label="Total expenses" main={money(totalExp)} footValue={totalSf ? psf(totalExp / totalSf) : '—'} footCap="per leased sq ft" />
          <StatCard
            label="Net operating income"
            main={money(noi)}
            footValue={margin != null ? `${margin}%` : '—'}
            footCap="operating margin"
            note={reimbursed > 0.005 ? (
              <span>
                Struck <strong>before</strong> reimbursement — tenants pay back{' '}
                <strong>{money(reimbursed)}</strong> of the expenses above. What actually stayed adds it back.
              </span>
            ) : null}
          />
        </div>
      </div>

      {/* Sits directly under NOI, because it is the sentence NOI leaves unfinished. */}
      <WhatStayedStrip propId={propId} year={year} noi={noi} />

      <div className="metric-group">
        <div className="fin-subhead">Recoverable expenses · billed back to tenants</div>
        <div className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
          Big number = the year's total. Smaller number beneath = the rate per leased square foot each tenant is charged.
        </div>
        <div className="metrics">
          <StatCard label="Property taxes" main={money(taxes)} footValue={psf(totals?.tax_psf)} footCap="charged per sq ft" />
          <StatCard label="CAM / maintenance" main={money(cam)} footValue={psf(totals?.cam_psf)} footCap="charged per sq ft" />
          {/* Gone entirely when this building doesn't bill roof and has none — a card reading
              $0 billed / $0 absorbed is the noise the checkbox exists to remove. It comes back
              on its own the moment roof carries a figure again. */}
          {roofVisible && (
            <StatCard
              label="Roof (billed separately)"
              main={money(roof)}
              footValue={totalSf ? psf(roof / totalSf) : '—'}
              footCap="rate per sq ft"
              note={
                <>
                  <span><strong className="pos">{money0(roofRecovered)}</strong> billed</span>
                  <span><strong>{money0(roofUnrecovered)}</strong> absorbed</span>
                </>
              }
            />
          )}
        </div>
      </div>

      {/* Same drop target as the Ledger's — a statement can be dragged anywhere onto
          the panel it belongs to, not just onto the button. The drop zone stays OUTSIDE the
          fold: a statement dragged onto a folded section still lands. */}
      <StatementDropZone className="panel" onReady={setImportDoc}>
        {/* ⚠ OUTSIDE THE FOLD, for the same reason the drop zone is. What an import wrote —
            and the ↩ Undo for the whole of it — must not be a child of a panel the landlord
            may have folded, or a statement saved against the wrong year reports nothing and
            offers no way back. */}
        <ImportResultsStrip
          imported={imported}
          undoPending={undoImport.isPending}
          onUndo={() => undoImport.mutate(imported.import)}
          onDismiss={() => setImported(null)}
        />
        <MutationError of={[undoImport]} />
        <Panel
          bare
          id="fin.expenses"
          title={`Expense entry · FY ${year}`}
          hint="Taxes, CAM and roof are each itemized."
          summary={`Taxes ${money(taxes)} · CAM ${money(cam)}${roofVisible ? ` · Roof ${money(roof)}` : ''}`}
          actions={<ImportStatementButton onReady={setImportDoc} />}
        >
          <BuildingSizeEditor propId={propId} buildingSf={prop?.building_sf} year={year} />
          <Panel
            bare
            stack
            className="cam-block"
            headClass="cam-head"
            id="fin.taxes"
            title="Property taxes — itemized"
            hint="One line per tax payment — every instalment an imported statement finds lands here. The total drives the tax PSF tenants are billed."
            summary={`${money(taxes)} for the year`}
          >
            <TaxSection propId={propId} year={year} expense={expense} />
          </Panel>
          <Panel
            bare
            stack
            className="cam-block"
            headClass="cam-head"
            id="fin.cam"
            title="CAM / maintenance — itemized"
            hint="Every component that rolls into CAM. The total drives the CAM PSF tenants are billed."
            summary={`${money(cam)} for the year`}
          >
            <CamSection propId={propId} year={year} expense={expense} />
          </Panel>
          {/* ⚠ THE HEAD ALWAYS RENDERS, the body is what's gated. The checkbox that turns roof
              back on cannot live inside the section it hides, or the switch is one-way. Off and
              empty, this whole block is a single row: the box, the words, and one line saying
              where roof costs go instead. That is also why the checkbox is an `action` rather
              than part of the toggle — roof can still be switched off with the section folded. */}
          <Panel
            bare
            stack
            className="cam-block"
            headClass="cam-head"
            id="fin.roof"
            title="Roof — itemized"
            hint={roofVisible
              ? 'One line per roof payment. The total is billed in full to the tenants whose leases make them responsible for the roof — everything else you absorb.'
              : 'Roof repairs go in CAM on this building — add them as a CAM line above.'}
            summary={roofVisible
              ? `${money(roof)} for the year`
              : 'Not billed separately here — roof costs go in CAM'}
            actions={(
              <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap' }}>
                <input
                  type="checkbox"
                  checked={roofOn}
                  disabled={setRoof.isPending}
                  onChange={(e) => askRoof(e.target.checked)}
                />
                <span className="muted">Billed separately</span>
              </label>
            )}
          >
            {/* Still rendered while the box is unticked IF roof carries a figure here — a roof
                total or a roof-responsible lease. Hiding it then would leave the landlord billing
                tenants for something his own screen no longer mentions. */}
            {roofVisible && <RoofSection propId={propId} year={year} expense={expense} />}
            {roofVisible && !roofOn && (
              <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
                Still shown because this building has roof on the books{roof > 0 ? '' : ' — a lease here is charged for the roof'}. Clear it and this section goes away.
              </div>
            )}
          </Panel>
          <MutationError of={[setRoof]} />
        </Panel>
      </StatementDropZone>

      <RecoverabilityTable propId={propId} year={year} />

      {/* Money IN that isn't rent, below the expense sections it mirrors: what went out
          that no expense total knows about, then what came in that no invoice does.
          (Owner money used to have a third panel of its own here. It was retired
          2026-08-12 — a distribution is now a not-billed expense line carrying the
          `distribution` category, so it appears in CAM / maintenance above and on its
          own line in "What it cost you", instead of in a panel of its own.) */}
      <OtherIncomeSection propId={propId} year={year} />

      {/* Folded, this states the two things the table is for: who is on it, and how much of
          the year's CAM & taxes their shares account for. `shares` is already on this page
          for the roof check above — no second query. */}
      <Panel
        className="breakdown-block"
        id="fin.breakdown"
        title="Per-tenant breakdown"
        summary={shares.length
          ? `${shares.length} tenant${shares.length === 1 ? '' : 's'} · ${money(allocated)} of CAM & taxes allocated`
          : 'No tenants on this property yet'}
        actions={(
          <button className="secondary" onClick={() => setExporting(true)} title="Download a year-end reconciliation workbook — one tab per tenant, actual vs estimated CAM & tax">
            ⬇ Export reconciliation
          </button>
        )}
      >
        <TenantShareTable propertyId={propId} year={year} />
      </Panel>
      {exporting && (
        <ExportReconciliationModal propertyId={propId} year={year} propertyName={prop?.name} onClose={() => setExporting(false)} />
      )}
    </div>
  );
}

function StatCard({ label, main, footValue, footCap, note }) {
  return (
    <div className="metric stat">
      <div className="label">{label}</div>
      <div className="value">{main}</div>
      {footValue != null && (
        <div className="stat-foot">
          <span className="stat-psf">{footValue}</span>
          <span className="stat-cap">{footCap}</span>
        </div>
      )}
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

