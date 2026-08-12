import { useState } from 'react';
import { useParams } from 'react-router-dom';
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
} from '../lib/api';
import { showRoof, roofOffered } from '../lib/roofDisplay';
import { useConfirm } from '../components/ConfirmDialog';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import FinancialsTabs from '../components/FinancialsTabs';
import TenantShareTable from '../components/TenantShareTable';
import CamSection from '../components/CamSection';
import TaxSection from '../components/TaxSection';
import RoofSection from '../components/RoofSection';
import RecoverabilityTable from '../components/RecoverabilityTable';
import OtherIncomeSection from '../components/OtherIncomeSection';
import WhatStayedStrip from '../components/WhatStayedStrip';
import BuildingSizeEditor from '../components/BuildingSizeEditor';
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

  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  const { data: totals } = useQuery({ queryKey: ['propertyTotals', propId, year], queryFn: () => getPropertyTotals(propId, year), placeholderData: keepPreviousData });
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

      <div className="metric-group">
        <div className="fin-subhead">Performance · FY {year}</div>
        <div className="metrics">
          <StatCard label="Revenue (annualized)" main={money(revenue)} footValue={totalSf ? psf(revenue / totalSf) : '—'} footCap="per leased sq ft" />
          <StatCard label="Total expenses" main={money(totalExp)} footValue={totalSf ? psf(totalExp / totalSf) : '—'} footCap="per leased sq ft" />
          <StatCard label="Net operating income" main={money(noi)} footValue={margin != null ? `${margin}%` : '—'} footCap="operating margin" />
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
          the panel it belongs to, not just onto the button. */}
      <StatementDropZone className="panel" onReady={setImportDoc}>
        <div className="panel-head">
          <strong>Expense entry · FY {year}</strong>
          <span className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span className="muted">Taxes, CAM and roof are each itemized.</span>
            <ImportStatementButton onReady={setImportDoc} />
          </span>
        </div>
        <ImportResultsStrip
          imported={imported}
          undoPending={undoImport.isPending}
          onUndo={() => undoImport.mutate(imported.import)}
          onDismiss={() => setImported(null)}
        />
        <MutationError of={[undoImport]} />
        <BuildingSizeEditor propId={propId} buildingSf={prop?.building_sf} year={year} />
        <div className="cam-block">
          <div className="cam-head">
            <div>
              <strong>Property taxes — itemized</strong>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                One line per tax payment — every instalment an imported statement finds lands here. The total drives the tax PSF tenants are billed.
              </div>
            </div>
          </div>
          <TaxSection propId={propId} year={year} expense={expense} />
        </div>
        <div className="cam-block">
          <div className="cam-head">
            <div>
              <strong>CAM / maintenance — itemized</strong>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Every component that rolls into CAM. The total drives the CAM PSF tenants are billed.
              </div>
            </div>
          </div>
          <CamSection propId={propId} year={year} expense={expense} />
        </div>
        {/* ⚠ THE HEAD ALWAYS RENDERS, the body is what's gated. The checkbox that turns roof
            back on cannot live inside the section it hides, or the switch is one-way. Off and
            empty, this whole block is a single row: the box, the words, and one line saying
            where roof costs go instead. */}
        <div className="cam-block">
          <div className="cam-head">
            <div>
              <strong>Roof — itemized</strong>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {roofVisible
                  ? 'One line per roof payment. The total is billed in full to the tenants whose leases make them responsible for the roof — everything else you absorb.'
                  : 'Roof repairs go in CAM on this building — add them as a CAM line above.'}
              </div>
            </div>
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={roofOn}
                disabled={setRoof.isPending}
                onChange={(e) => askRoof(e.target.checked)}
              />
              <span className="muted">Billed separately</span>
            </label>
          </div>
          {/* Still rendered while the box is unticked IF roof carries a figure here — a roof
              total or a roof-responsible lease. Hiding it then would leave the landlord billing
              tenants for something his own screen no longer mentions. */}
          {roofVisible && <RoofSection propId={propId} year={year} expense={expense} />}
          {roofVisible && !roofOn && (
            <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
              Still shown because this building has roof on the books{roof > 0 ? '' : ' — a lease here is charged for the roof'}. Clear it and this section goes away.
            </div>
          )}
        </div>
        <MutationError of={[setRoof]} />
      </StatementDropZone>

      <RecoverabilityTable propId={propId} corpId={corpId} year={year} />

      {/* Money IN that isn't rent, below the expense sections it mirrors: what went out
          that no expense total knows about, then what came in that no invoice does.
          (Owner money used to have a third panel of its own here. It was retired
          2026-08-12 — a distribution is now a not-billed expense line carrying the
          `distribution` category, so it appears in CAM / maintenance above and on its
          own line in "What it cost you", instead of in a panel of its own.) */}
      <OtherIncomeSection propId={propId} year={year} />

      <div className="page-head" style={{ marginTop: 8 }}>
        <h3 className="section-title" style={{ margin: 0 }}>Per-tenant breakdown</h3>
        <button className="secondary" onClick={() => setExporting(true)} title="Download a year-end reconciliation workbook — one tab per tenant, actual vs estimated CAM & tax">
          ⬇ Export reconciliation
        </button>
      </div>
      <TenantShareTable propertyId={propId} year={year} />
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

