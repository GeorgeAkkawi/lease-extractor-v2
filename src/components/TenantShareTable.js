import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getTenantShares,
  getProperty,
  getExpenseRecord,
  getPropertyMonthlyRoll,
  listReconciliations,
  listInvoicesForProperty,
  updateLease,
  reconcileCamTax,
  markReconciliationRefunded,
  undoReconciliation,
  undoReconciliationRefund,
  draftCamReconciliationEmail,
  getLeaseStatedEstimate,
} from '../lib/api';
import { reconcileFigures, billedComponents, RECON_DUST } from '../lib/reconciliation';
import { allocatePayments, ledgerRowSummary } from '../lib/ledger';
import { useFeatures } from '../lib/features';
import { money, sf, pct } from '../lib/format';
import EmailComposeModal from './EmailComposeModal';
import MutationError from './MutationError';
import UndoStrip from './UndoStrip';

const psf2 = (n) => (n == null || isNaN(n) ? '—' : `$${Number(n).toFixed(2)}`);
const NBSP = ' ';

// One aligned figure in a ledger entry: a right-aligned main figure over an
// optional sub-line ($/SF etc. — blank renders as NBSP so mains line up across
// rows). The label is read by screen readers everywhere and becomes the visible
// eyebrow on narrow screens, where the shared header band is hidden.
function Stat({ label, main, sub, className = '' }) {
  return (
    <div className={`ledger-stat ${className}`.trim()}>
      <span className="stat-label">{label}</span>
      <div className="cell-main">{main}</div>
      <div className="cell-sub">{sub || NBSP}</div>
    </div>
  );
}

// Per-tenant breakdown + the estimated-vs-actual reconciliation view (0060),
// laid out as a LEDGER — one entry per tenant — instead of a 13-column table,
// so the whole page fits the viewport with no sideways scrolling. The header
// band, every entry, and the totals band share one grid template, keeping the
// figures aligned down the page; each figure's $/SF rides its sub-line and the
// per-tenant actions live under the tenant's name.
//
// The content is unchanged: tenants pay the lease's typed ESTIMATE during the
// year (the true CAM is only known at year end); each entry shows the estimate
// being billed (click to edit — saved on the lease), the ACTUAL share as
// expenses fill in, and the live Difference between them. The Reconcile action
// settles a finished year: a shortfall becomes a reconciliation invoice in
// receivables; an overpayment becomes a refund you mark paid once you've paid
// the tenant back.
export default function TenantShareTable({ propertyId, year }) {
  const qc = useQueryClient();
  const { corpId } = useParams();
  const { isOn } = useFeatures();
  const ledgerOn = isOn('ledger');
  const { data: shares = [], isLoading } = useQuery({
    queryKey: ['tenantShares', propertyId, year],
    queryFn: () => getTenantShares(propertyId, year),
  });
  // The Rent Ledger's collections, per lease — same query key/data the Ledger tab
  // uses, so React Query dedupes and the two views can never disagree.
  const { data: roll = [] } = useQuery({
    queryKey: ['propertyRentRoll', propertyId, year],
    queryFn: () => getPropertyMonthlyRoll(propertyId, year),
    enabled: ledgerOn,
  });
  const { data: property } = useQuery({ queryKey: ['property', propertyId], queryFn: () => getProperty(propertyId) });
  // Same key as the Financials page's own expense query, so React Query dedupes it.
  // Feeds the Vacant-space line: the slice of taxes+CAM no tenant is billed for.
  const { data: expense } = useQuery({
    queryKey: ['expenseRecord', propertyId, year],
    queryFn: () => getExpenseRecord(propertyId, year),
  });
  const { data: recons = [] } = useQuery({
    queryKey: ['reconciliations', propertyId, year],
    queryFn: () => listReconciliations(propertyId, year),
  });
  // One property-wide read powers both the est-side snapshot for the live diff and
  // the paid/overdue state of each reconciliation's linked invoice.
  const { data: invoices = [] } = useQuery({
    queryKey: ['invoicesForProperty', propertyId],
    queryFn: () => listInvoicesForProperty(propertyId),
  });

  const [editingId, setEditingId] = useState(null); // lease being estimate-edited
  const [emailDraft, setEmailDraft] = useState(null); // reconciliation statement
  // The one transient post-save undo for the table: { leaseId, label, undo, after }.
  // undo is a closure over the previous values; after re-fetches what it touched.
  const [pendingUndo, setPendingUndo] = useState(null);
  useEffect(() => setPendingUndo(null), [year]); // never show a strip under another year's figures

  const invalidateBilling = () => {
    qc.invalidateQueries({ queryKey: ['tenantShares', propertyId] });
    qc.invalidateQueries({ queryKey: ['leases', propertyId] });
    qc.invalidateQueries({ queryKey: ['lease'] });
  };
  const invalidateRecon = () => {
    qc.invalidateQueries({ queryKey: ['reconciliations', propertyId, year] });
    qc.invalidateQueries({ queryKey: ['invoicesForProperty', propertyId] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
    qc.invalidateQueries({ queryKey: ['historyEvents', propertyId] });
  };

  const saveEst = useMutation({
    mutationFn: ({ leaseId, patch }) => updateLease(leaseId, patch),
    onSuccess: (_data, { leaseId, prev }) => {
      setEditingId(null);
      invalidateBilling();
      setPendingUndo({
        leaseId,
        label: 'estimate saved',
        undo: () => updateLease(leaseId, prev),
        after: invalidateBilling,
      });
    },
  });

  const reconcile = useMutation({
    mutationFn: (share) => reconcileCamTax(share.lease_id, propertyId, year),
    onSuccess: invalidateRecon,
  });

  // Un-reconcile: removes the record and voids its invoice (the persistent ↩ Undo).
  const unreconcile = useMutation({
    mutationFn: (recon) => undoReconciliation(recon),
    onSuccess: () => {
      setPendingUndo(null); // a live strip may reference the record that just went away
      invalidateRecon();
    },
  });

  const refund = useMutation({
    mutationFn: (recon) => markReconciliationRefunded(recon.id),
    onSuccess: (_data, recon) => {
      qc.invalidateQueries({ queryKey: ['reconciliations', propertyId, year] });
      setPendingUndo({
        leaseId: recon.lease_id,
        label: 'marked refunded',
        undo: () => undoReconciliationRefund(recon.id),
        after: () => qc.invalidateQueries({ queryKey: ['reconciliations', propertyId, year] }),
      });
    },
  });

  // Runs whatever undo closure the strip carries, then its own refresh.
  const undoMut = useMutation({
    mutationFn: (p) => p.undo(),
    onSuccess: (_data, p) => p.after?.(),
  });

  const buildingSf = Number(property?.building_sf) || 0;
  const noBuildingSf = property != null && !(buildingSf > 0);

  if (isLoading) return <p className="muted">Loading…</p>;
  if (shares.length === 0) return <p className="muted">No tenants/leases for this property yet.</p>;

  const reconByLease = Object.fromEntries(recons.map((r) => [r.lease_id, r]));
  const invById = Object.fromEntries(invoices.map((i) => [i.id, i]));
  // Collected/owes per lease from the SAME allocation the Ledger grid paints from.
  const collectedByLease = {};
  if (ledgerOn) {
    for (const r of roll) {
      const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments });
      collectedByLease[r.lease_id] = ledgerRowSummary({ year, owedByMonth: r.schedule, allocation: alloc });
    }
  }
  const ledgerTo = `/financials/${corpId}/${propertyId}/ledger`;

  // Per-row figures the cells below share. The estimate side is the tenant's current
  // typed estimate (billedComponents) — the same figure the Estimated column shows —
  // so Estimated − Actual on screen always equals the Difference. `anyEstimate` gates
  // the whole estimated/difference/reconcile view: with no estimate typed it stays
  // dormant (the tenant simply bills its actual share, exactly as before).
  const rowsData = shares.map((s) => {
    const fig = reconcileFigures({ share: s });
    const billed = billedComponents(s);
    return { share: s, fig, billed, recon: reconByLease[s.lease_id] || null };
  });

  // Estimated + Difference totals only count tenants who actually have an estimate
  // set — otherwise the fallback (a tenant's plain actual share) would masquerade as
  // an "estimate" and inflate the total. `anyEst` = at least one tenant has one.
  const tot = rowsData.reduce(
    (a, { share: s, fig, billed }) => ({
      sf: a.sf + (Number(s.square_footage) || 0),
      base: a.base + (Number(s.base_rent) || 0),
      est: a.est + (billed.anyEstimate ? fig.estTotal : 0),
      tax: a.tax + (Number(s.tax_amount) || 0),
      cam: a.cam + (Number(s.cam_amount) || 0),
      roof: a.roof + (Number(s.roof_amt) || 0),
      diff: a.diff + (billed.anyEstimate ? fig.diff : 0),
      anyEst: a.anyEst || billed.anyEstimate,
    }),
    { sf: 0, base: 0, est: 0, tax: 0, cam: 0, roof: 0, diff: 0, anyEst: false }
  );

  // The vacant space's slice of taxes + CAM. Shares are billed per SF of the WHOLE
  // building (0042), so the unleased SF's share is charged to no one — it stays with
  // the landlord. This makes that missing piece visible so the tenant shares + this
  // line reconcile back to the Expense entry total.
  const vacantSf = buildingSf > 0 ? Math.max(0, buildingSf - tot.sf) : 0;
  const camTaxEntered = Number(expense?.taxes_total || 0) + Number(expense?.cam_total || 0);
  const vacantCamTax = vacantSf > 0 && camTaxEntered > 0 ? (camTaxEntered * vacantSf) / buildingSf : 0;
  const showVacant = vacantCamTax > 0.005;
  // Only claim the three figures tie out when they actually do (a per-lease share
  // override can bill off pro-rata, in which case the sub-line stays additive only).
  const vacantReconciles = showVacant && Math.abs(tot.cam + tot.tax + vacantCamTax - camTaxEntered) <= 0.05;

  async function openStatement(recon) {
    const draft = await draftCamReconciliationEmail(recon);
    setEmailDraft({ ...draft, year: recon.year });
  }

  return (
    <div className={`table-wrap share-ledger${ledgerOn ? ' with-ledger' : ''}`}>
      {noBuildingSf && (
        <div className="note-msg warn" style={{ margin: '10px 12px' }}>
          Building size not set — CAM &amp; taxes are currently split over the leased space only.
          Enter the building’s total square footage (in <strong>Building size</strong>) to bill each tenant true
          per-SF of the whole building, leaving the vacant share with you.
        </div>
      )}
      <MutationError of={[saveEst, reconcile, refund, unreconcile, undoMut]} />
      {/* The band labels duplicate each figure's own (screen-reader) label, so this is
          presentation-only; on narrow screens it hides and the per-figure labels show. */}
      <div className="ledger-grid ledger-head" aria-hidden="true">
        <div>Tenant</div>
        <div className="lg-num">Base rent</div>
        <div className="lg-num">CAM &amp; tax<span className="sub-cap">estimated · billed to tenant</span></div>
        <div className="lg-num">CAM &amp; tax<span className="sub-cap">actual</span></div>
        <div className="lg-num">Roof<span className="sub-cap">actual</span></div>
        <div className="lg-num">Difference<span className="sub-cap">actual − estimated</span></div>
        {ledgerOn && <div className="lg-num">Collected<span className="sub-cap">this year · ledger</span></div>}
      </div>
      {rowsData.map((row) => {
        const s = row.share;
        const hasSf = Number(s.square_footage) > 0;
        const camTaxActual = Number(s.cam_amount || 0) + Number(s.tax_amount || 0);
        const camTaxPsf = hasSf ? camTaxActual / s.square_footage : null;
        const roofPsf = hasSf ? s.roof_amt / s.square_footage : null;
        const roofBilled = s.roof_responsible && s.roof_amt > 0;
        return (
          <div className="ledger-grid ledger-row" key={s.lease_id}>
            <div className="ledger-id">
              <div className="ledger-name">{s.tenant_name}</div>
              <div className="ledger-meta">{sf(s.square_footage)} · {pct(s.share_pct)} share</div>
              <div className="ledger-actions">
                <ReconcileAction
                  row={row}
                  invById={invById}
                  onReconcile={() => reconcile.mutate(s)}
                  onStatement={() => openStatement(row.recon)}
                  onRefunded={() => refund.mutate(row.recon)}
                  onUndo={() => unreconcile.mutate(row.recon)}
                  busy={reconcile.isPending || refund.isPending || unreconcile.isPending}
                />
                {pendingUndo?.leaseId === s.lease_id && (
                  <UndoStrip
                    label={pendingUndo.label}
                    busy={undoMut.isPending}
                    onUndo={() => {
                      const p = pendingUndo;
                      setPendingUndo(null); // optimistic dismiss, like the dashboard's undo banner
                      undoMut.mutate(p);
                    }}
                    onDismiss={() => setPendingUndo(null)}
                  />
                )}
              </div>
            </div>
            <Stat label="Base rent" main={money(s.base_rent)} sub={hasSf ? psf2(s.base_rent / s.square_footage) + '/SF' : ''} />
            <EstimateStat
              share={s}
              billed={row.billed}
              editing={editingId === s.lease_id}
              onToggle={() => setEditingId(editingId === s.lease_id ? null : s.lease_id)}
            />
            <Stat label="CAM & tax · actual" main={money(camTaxActual)} sub={hasSf ? psf2(camTaxPsf) + '/SF' : ''} />
            <Stat label="Roof · actual" main={roofBilled ? money(s.roof_amt) : <span className="muted">—</span>} sub={roofBilled && hasSf ? psf2(roofPsf) + '/SF' : ''} />
            <DiffStat fig={row.fig} show={row.billed.anyEstimate} />
            {ledgerOn && <CollectedStat summary={collectedByLease[s.lease_id]} to={ledgerTo} />}
            {editingId === s.lease_id && (
              <EstimateEditor
                share={s}
                saving={saveEst.isPending}
                onCancel={() => setEditingId(null)}
                onSave={(patch) =>
                  saveEst.mutate({
                    leaseId: s.lease_id,
                    patch,
                    // Captured for the post-save ↩ Undo: exactly what was stored before.
                    prev: {
                      est_cam_annual: s.est_cam_annual ?? null,
                      est_tax_annual: s.est_tax_annual ?? null,
                      est_roof_annual: s.est_roof_annual ?? null,
                    },
                  })
                }
              />
            )}
          </div>
        );
      })}
      {showVacant && (
        <div className="ledger-grid ledger-row ledger-vacant">
          <div className="ledger-id">
            <div className="ledger-name">Vacant space</div>
            <div className="ledger-meta">{sf(vacantSf)} · {pct(vacantSf / buildingSf)} of the building — billed to no one</div>
          </div>
          <Stat label="Base rent" main={<span className="muted">—</span>} />
          <Stat label="CAM & tax · estimated" main={<span className="muted">—</span>} />
          <Stat
            label="CAM & tax · vacant share, stays with you"
            main={money(vacantCamTax)}
            sub={psf2(camTaxEntered / buildingSf) + '/SF'}
          />
          <Stat label="Roof" main={<span className="muted">—</span>} />
          <Stat label="Difference" main={<span className="muted">—</span>} />
          {ledgerOn && <Stat label="Collected" main={<span className="muted">—</span>} />}
        </div>
      )}
      <div className="ledger-grid ledger-row ledger-totals">
        <div className="ledger-id">
          <div className="ledger-name">Totals</div>
          <div className="ledger-meta">{sf(tot.sf)} leased{buildingSf > 0 ? ` of ${sf(buildingSf)} building` : ''}</div>
        </div>
        <Stat label="Base rent" main={money(tot.base)} />
        <Stat label="CAM & tax · estimated" main={tot.anyEst ? money(tot.est) : <span className="muted">—</span>} />
        <Stat
          label="CAM & tax · actual"
          main={money(tot.cam + tot.tax)}
          sub={showVacant ? `+ ${money(vacantCamTax)} vacant${vacantReconciles ? ` = ${money(camTaxEntered)} entered` : ''}` : ''}
        />
        <Stat label="Roof · actual" main={money(tot.roof)} />
        <Stat
          label="Difference · actual − estimated"
          className="ledger-diff"
          main={tot.anyEst ? <DiffFigure diff={tot.diff} /> : <span className="muted">—</span>}
        />
        {ledgerOn && (
          <Stat
            label="Collected this year"
            main={(() => {
              const col = Object.values(collectedByLease).reduce((s, c) => s + (c?.collected || 0), 0);
              const proj = Object.values(collectedByLease).reduce((s, c) => s + (c?.projected || 0), 0);
              return <>{money(col)} <span className="muted">of {money(proj)}</span></>;
            })()}
            sub={(() => { const o = Object.values(collectedByLease).reduce((s, c) => s + (c?.owesToDate || 0), 0); return o > 0.05 ? `behind ${money(o)}` : 'all collected'; })()}
          />
        )}
      </div>
      <div className="table-note muted">
        {ledgerOn && (
          <><strong>Collected</strong> is money in — the payments received this year against the projected year total
          (open the Ledger for the month-by-month picture). It's separate from <strong>Difference</strong>, which
          compares the year's actual expenses to the estimate you billed. </>
        )}
        The <strong>estimated CAM &amp; tax</strong> is what the tenant actually pays during the year (click a figure
        to set it — the true CAM is only known once the year closes); it falls back to the actual share until you enter one.
        <strong> Difference</strong> updates live as expenses are entered: positive = the tenant will owe more at
        year end, negative = you'll owe the tenant back. <strong>Reconcile</strong> settles a finished year — a
        shortfall becomes an invoice in receivables, an overpayment a refund to the tenant — and <strong>↩ Undo</strong> reverses
        it any time (the record is removed and its invoice voided). <strong>CAM &amp; tax</strong>
        are billed and reconciled together as one combined charge, allocated per square foot of the
        {noBuildingSf ? ' leased space' : ' whole building'} (or a per-lease
        override){noBuildingSf ? '' : ', so the vacant share stays with the landlord'}; roof is billed by PSF only
        to roof-responsible tenants and stays its own separate line, estimate and reconciliation included.
        {buildingSf > 0 && tot.sf !== buildingSf && (
          <> The leased total ({sf(tot.sf)}) differs from the building size ({sf(buildingSf)}) by {sf(Math.abs(buildingSf - tot.sf))} of
          {buildingSf > tot.sf ? ' vacant' : ' over-allocated'} space{showVacant
            ? ' — its slice of the expenses is the Vacant space line above, which no tenant is billed for'
            : ' — yours to reconcile'}.</>
        )}
      </div>
      {emailDraft && (
        <EmailComposeModal
          title={`CAM & tax reconciliation statement (${emailDraft.year})`}
          to={emailDraft.to}
          subject={emailDraft.subject}
          body={emailDraft.body}
          onClose={() => setEmailDraft(null)}
        />
      )}
    </div>
  );
}

// The Rent Ledger's per-tenant collections, compact: money collected this year OF the
// projected year total (with "behind $X" for unpaid due rent, or a credit / paid ✓).
// "Behind" is unpaid RENT — deliberately not "owes", which on the Difference column
// means the year-end CAM true-up. Clicks through to the month-by-month Ledger tab.
function CollectedStat({ summary, to }) {
  if (!summary) {
    return <Stat label="Collected this year" main={<span className="muted">—</span>} />;
  }
  const behind = summary.owesToDate;
  const sub =
    summary.credit > 0.05 ? `credit ${money(summary.credit)}` :
    behind > 0.05 ? `behind ${money(behind)}` : 'paid ✓';
  return (
    <div className="ledger-stat">
      <span className="stat-label">Collected this year</span>
      <Link to={to} className="collected-cell" title="Open the Rent Ledger — month-by-month collections">
        <div className="cell-main">{money(summary.collected)} <span className="muted">of {money(summary.projected)}</span></div>
        <div className={`cell-sub${behind > 0.05 ? ' owes' : ''}`}>{sub}</div>
      </Link>
    </div>
  );
}

// The signed live difference, colored by who ends up owing.
function DiffFigure({ diff }) {
  const d = Number(diff) || 0;
  if (Math.abs(d) <= RECON_DUST) return <span className="muted">even</span>;
  return d > 0
    ? <span className="pos-owed" title="Actuals are running above the estimate — the tenant will owe the difference at year end">+{money(d)}</span>
    : <span className="neg-owed" title="Actuals are running below the estimate — you'll owe the tenant the difference at year end">−{money(Math.abs(d))}</span>;
}

// The entry's closing balance. No estimate set → nothing to compare against, so it
// stays dormant (—).
function DiffStat({ fig, show }) {
  if (!show) {
    return <Stat label="Difference · actual − estimated" className="ledger-diff" main={<span className="muted">—</span>} />;
  }
  const d = Number(fig.diff) || 0;
  const sub = Math.abs(d) <= RECON_DUST ? '' : d > 0 ? 'tenant owes' : 'you owe tenant';
  return <Stat label="Difference · actual − estimated" className="ledger-diff" main={<DiffFigure diff={d} />} sub={sub} />;
}

// The Estimated figure: the billed amount (typed estimate, else the actual it falls
// back to) with its $/SF sub-line, as a click target that opens/closes the editor.
function EstimateStat({ share, billed, editing, onToggle }) {
  const sfNum = Number(share.square_footage) || 0;
  const estCamTax = billed.camTax;
  const psfSub = sfNum > 0 ? `${psf2(estCamTax / sfNum)}/SF` : '';
  const roofSub = share.roof_responsible && billed.roof > 0 ? `+ roof ${money(billed.roof)}` : '';
  return (
    <div className="ledger-stat">
      <span className="stat-label">CAM & tax · estimated · billed to tenant</span>
      <button
        type="button"
        className={`est-cell-btn${editing ? ' editing' : ''}`}
        onClick={onToggle}
        title="Click to set what this tenant pays as one estimated CAM & tax figure (and roof, when responsible) during the year — entered in $ per square foot"
      >
        <div className="cell-main">
          {billed.anyEstimate
            ? <>{money(estCamTax)}<span className="est-tag"> est.</span></>
            : <span className="muted">＋ set estimate</span>}
        </div>
        {/* The roof rider gets its own sub-line so a long combo never bleeds into
            the neighboring column. */}
        <div className="cell-sub">{billed.anyEstimate ? (psfSub || NBSP) : 'billing actuals'}</div>
        {billed.anyEstimate && roofSub && <div className="cell-sub">{roofSub}</div>}
      </button>
    </div>
  );
}

// The inline estimate editor, opened by clicking the Estimated figure — a roomy
// band spanning the whole entry. The landlord types ONE combined CAM & tax $/SF
// rate of the tenant's space (per George: prices are quoted per square foot), plus
// a separate roof rate when the tenant is roof-responsible. It's stored annualized
// on the lease (the whole figure in est_cam_annual, est_tax_annual = 0) so every
// billing surface — invoice, monthly tracker, Leases page, reconciliation — follows.
// A lease with no square footage on file falls back to plain $/yr entry. An older
// lease with CAM and tax typed separately is prefilled from their sum.
function EstimateEditor({ share, onSave, onCancel, saving }) {
  const sfNum = Number(share.square_footage) || 0;
  const perSf = sfNum > 0;
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const toInput = (annual) => (annual == null ? '' : String(perSf ? round2(annual / sfNum) : annual));
  const camTaxAnnual =
    share.est_cam_annual != null || share.est_tax_annual != null
      ? Number(share.est_cam_annual || 0) + Number(share.est_tax_annual || 0)
      : null;
  const [camTax, setCamTax] = useState(toInput(camTaxAnnual));
  const [roof, setRoof] = useState(toInput(share.est_roof_annual));
  const [touched, setTouched] = useState(false);

  // When NO estimate is saved yet, pull the figure the LEASE itself states (the
  // cached AI read's expense_estimates, shipped 7/13) and pre-fill the input with
  // it — one Save adopts it as the billed estimate. Editable as always; the lease's
  // figure never starts billing on its own, only when saved here.
  const { data: stated } = useQuery({
    queryKey: ['leaseStatedEstimate', share.lease_id],
    queryFn: () => getLeaseStatedEstimate(share.lease_id),
    enabled: camTaxAnnual == null,
    staleTime: 5 * 60 * 1000,
  });
  const statedPrefilled = camTaxAnnual == null && !touched && stated?.camTaxAnnual != null;
  useEffect(() => {
    if (statedPrefilled) setCamTax(toInput(stated.camTaxAnnual));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statedPrefilled, stated]);

  // What the landlord types (a $/SF rate when the SF is known) → the annual $ saved.
  // A blank OR a zero/negative entry means "no estimate — bill actuals", so it saves
  // as NULL, never a stored 0 (a stored 0 billed base-only rent and produced the
  // phantom-✓ ledger George caught).
  const annualOf = (v) => {
    if (v === '' || v == null) return null;
    const out = perSf ? round2(Number(v) * sfNum) : Number(v);
    return out > 0 ? out : null;
  };
  const unit = perSf ? '$/SF/yr' : '$/yr';
  const ph = (actualAnnual) => (perSf ? (Number(actualAnnual || 0) / sfNum).toFixed(2) : String(Math.round(actualAnnual || 0)));
  const actualCamTax = Number(share.cam_amount || 0) + Number(share.tax_amount || 0);
  const preview =
    (annualOf(camTax) ?? actualCamTax) +
    (share.roof_responsible ? (annualOf(roof) ?? Number(share.roof_amt || 0)) : 0);
  const camTaxAnnualOut = annualOf(camTax);

  return (
    <div className="ledger-edit">
      <label>
        <span>CAM &amp; tax {unit}</span>
        <input className="text-input num" type="number" step="any" min="0" value={camTax} onChange={(e) => { setTouched(true); setCamTax(e.target.value); }} placeholder={ph(actualCamTax)} />
        {statedPrefilled && (
          <span className="muted" style={{ fontSize: 11, display: 'block', marginTop: 3 }} title={stated.quote ? `The lease says: “${stated.quote}”` : 'Read from the lease document by the AI extractor'}>
            from the lease{stated.quote ? `: “${String(stated.quote).slice(0, 70)}${String(stated.quote).length > 70 ? '…' : ''}”` : ''} — Save to start billing it
          </span>
        )}
      </label>
      {share.roof_responsible && (
        <label>
          <span>Roof {unit}</span>
          <input className="text-input num" type="number" step="any" min="0" value={roof} onChange={(e) => setRoof(e.target.value)} placeholder={ph(share.roof_amt)} />
        </label>
      )}
      {perSf && (
        <div className="est-preview">× {sf(sfNum)} = {money(round2(preview))}/yr</div>
      )}
      <div className="est-edit-actions">
        <button
          className="btn-sm"
          disabled={saving}
          onClick={() =>
            onSave({
              // The combined CAM & tax estimate lives in est_cam_annual; est_tax_annual
              // is zeroed so `cam + tax` reads back as the single figure entered.
              est_cam_annual: camTaxAnnualOut,
              est_tax_annual: camTaxAnnualOut == null ? null : 0,
              est_roof_annual: share.roof_responsible ? annualOf(roof) : null,
            })
          }
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="secondary btn-sm" onClick={onCancel} disabled={saving}>Cancel</button>
      </div>
    </div>
  );
}

// The per-row reconcile state: the button before a year is reconciled (instant —
// no confirm popup; the persistent ↩ Undo is the safety net), then the outcome as
// one quiet muted line: the linked invoice's live status (tenant owed), the refund
// open/settled state (you owed), or "even". ✉ Statement rides along, and ↩ Undo
// always fully un-reconciles — removes the record, voids its invoice — so the year
// can be reopened and reconciled again any time.
function ReconcileAction({ row, invById, onReconcile, onStatement, onRefunded, onUndo, busy }) {
  const { recon } = row;
  if (!recon) {
    // Reconciliation only applies once an estimate is set — with none, the tenant is
    // simply billed its actual share and there's nothing to true up.
    if (!row.billed.anyEstimate) return null;
    return (
      <button className="secondary btn-sm" onClick={onReconcile} disabled={busy} title={`Settle ${row.share.tenant_name}'s estimated-vs-actual CAM & tax for the year — ↩ Undo can reverse it any time`}>
        ⚖ Reconcile
      </button>
    );
  }
  const owed = money(Math.abs(Number(recon.diff)));
  const inv = recon.invoice_id ? invById[recon.invoice_id] : null;
  let note;
  if (recon.direction === 'even') {
    note = 'reconciled — even';
  } else if (recon.direction === 'tenant_owes') {
    const status = inv?.display_status;
    const label =
      status === 'paid' ? 'collected ✓' : status === 'overdue' ? 'overdue' : status === 'partial' ? 'partly paid' : 'invoiced';
    note = `reconciled — owed ${money(recon.diff)} · ${label}`;
  } else {
    note = recon.status === 'settled' ? `reconciled — refunded ${owed} ✓` : `reconciled — you owe ${owed}`;
  }
  const collected = Number(inv?.amount_paid) > 0;
  return (
    <span className="recon-state">
      <span className="recon-note">{note}</span>
      {recon.direction !== 'even' && <button className="secondary btn-sm" onClick={onStatement}>✉ Statement</button>}
      {recon.direction === 'landlord_owes' && recon.status !== 'settled' && (
        <button className="secondary btn-sm" onClick={onRefunded} disabled={busy} title="Mark once you've paid the tenant back (outside the app)">✓ Mark refunded</button>
      )}
      <button
        className="ghost btn-sm"
        onClick={onUndo}
        disabled={busy}
        title={
          'Un-reconcile this year — removes the reconciliation and voids its invoice; you can reconcile again any time.' +
          (collected ? ` The ${money(inv.amount_paid)} already collected stays on the removed invoice.` : '')
        }
      >
        ↩ Undo
      </button>
    </span>
  );
}
