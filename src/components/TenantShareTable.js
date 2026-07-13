import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getTenantShares,
  getProperty,
  listReconciliations,
  listInvoicesForProperty,
  updateLease,
  reconcileCamTax,
  markReconciliationRefunded,
  draftCamReconciliationEmail,
} from '../lib/api';
import { reconcileFigures, billedComponents, RECON_DUST } from '../lib/reconciliation';
import { money, sf, pct } from '../lib/format';
import InvoiceButton from './InvoiceButton';
import EmailComposeModal from './EmailComposeModal';
import MutationError from './MutationError';

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
  const { data: shares = [], isLoading } = useQuery({
    queryKey: ['tenantShares', propertyId, year],
    queryFn: () => getTenantShares(propertyId, year),
  });
  const { data: property } = useQuery({ queryKey: ['property', propertyId], queryFn: () => getProperty(propertyId) });
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

  const invalidateBilling = () => {
    qc.invalidateQueries({ queryKey: ['tenantShares', propertyId] });
    qc.invalidateQueries({ queryKey: ['leases', propertyId] });
    qc.invalidateQueries({ queryKey: ['lease'] });
    qc.invalidateQueries({ queryKey: ['propertyRentRoll', propertyId] });
    qc.invalidateQueries({ queryKey: ['monthlyRent'] });
  };

  const saveEst = useMutation({
    mutationFn: ({ leaseId, patch }) => updateLease(leaseId, patch),
    onSuccess: () => {
      setEditingId(null);
      invalidateBilling();
    },
  });

  const reconcile = useMutation({
    mutationFn: (share) => reconcileCamTax(share.lease_id, propertyId, year),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reconciliations', propertyId, year] });
      qc.invalidateQueries({ queryKey: ['invoicesForProperty', propertyId] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['propertyAR', propertyId] });
      qc.invalidateQueries({ queryKey: ['portfolioAR'] });
      qc.invalidateQueries({ queryKey: ['historyEvents', propertyId] });
    },
  });

  const refund = useMutation({
    mutationFn: (id) => markReconciliationRefunded(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reconciliations', propertyId, year] }),
  });

  const buildingSf = Number(property?.building_sf) || 0;
  const noBuildingSf = property != null && !(buildingSf > 0);

  if (isLoading) return <p className="muted">Loading…</p>;
  if (shares.length === 0) return <p className="muted">No tenants/leases for this property yet.</p>;

  const reconByLease = Object.fromEntries(recons.map((r) => [r.lease_id, r]));
  const invById = Object.fromEntries(invoices.map((i) => [i.id, i]));

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

  async function openStatement(recon) {
    const draft = await draftCamReconciliationEmail(recon);
    setEmailDraft({ ...draft, year: recon.year });
  }

  function confirmReconcile(row) {
    const { share, fig } = row;
    const head = `Reconcile ${share.tenant_name}'s CAM & tax for ${year}?\n\nBilled (estimated): ${money(fig.estTotal)}\nActual share: ${money(fig.actualTotal)}\n\n`;
    const tail =
      fig.direction === 'tenant_owes'
        ? `The tenant owes ${money(fig.diff)} more. A reconciliation invoice for the balance will be added to receivables — you can email the statement after.`
        : fig.direction === 'landlord_owes'
          ? `You owe the tenant ${money(Math.abs(fig.diff))} back. This records the refund as owed — mark it refunded once you've paid the tenant.`
          : 'Estimate and actual came out even — this simply records the year as reconciled.';
    if (window.confirm(head + tail)) reconcile.mutate(share);
  }

  return (
    <div className="table-wrap share-ledger">
      {noBuildingSf && (
        <div className="note-msg warn" style={{ margin: '10px 12px' }}>
          Building size not set — CAM &amp; taxes are currently split over the leased space only.
          Enter the building’s total square footage (in <strong>Building size</strong>) to bill each tenant true
          per-SF of the whole building, leaving the vacant share with you.
        </div>
      )}
      <MutationError of={[saveEst, reconcile, refund]} />
      {/* The band labels duplicate each figure's own (screen-reader) label, so this is
          presentation-only; on narrow screens it hides and the per-figure labels show. */}
      <div className="ledger-grid ledger-head" aria-hidden="true">
        <div>Tenant</div>
        <div className="lg-num">Base rent</div>
        <div className="lg-num">Estimated<span className="sub-cap">billed to tenant</span></div>
        <div className="lg-num">Property taxes<span className="sub-cap">actual</span></div>
        <div className="lg-num">CAM<span className="sub-cap">actual</span></div>
        <div className="lg-num">Roof<span className="sub-cap">actual</span></div>
        <div className="lg-num">Difference<span className="sub-cap">actual − estimated</span></div>
      </div>
      {rowsData.map((row) => {
        const s = row.share;
        const hasSf = Number(s.square_footage) > 0;
        const taxPsf = hasSf ? s.tax_amount / s.square_footage : null;
        const camPsf = hasSf ? s.cam_amount / s.square_footage : null;
        const roofPsf = hasSf ? s.roof_amt / s.square_footage : null;
        const roofBilled = s.roof_responsible && s.roof_amt > 0;
        return (
          <div className="ledger-grid ledger-row" key={s.lease_id}>
            <div className="ledger-id">
              <div className="ledger-name">{s.tenant_name}</div>
              <div className="ledger-meta">{sf(s.square_footage)} · {pct(s.share_pct)} share</div>
              <div className="ledger-actions">
                <InvoiceButton share={s} />
                <ReconcileAction
                  row={row}
                  invById={invById}
                  onReconcile={() => confirmReconcile(row)}
                  onStatement={() => openStatement(row.recon)}
                  onRefunded={() => refund.mutate(row.recon.id)}
                  busy={reconcile.isPending || refund.isPending}
                />
              </div>
            </div>
            <Stat label="Base rent" main={money(s.base_rent)} sub={hasSf ? psf2(s.base_rent / s.square_footage) + '/SF' : ''} />
            <EstimateStat
              share={s}
              billed={row.billed}
              editing={editingId === s.lease_id}
              onToggle={() => setEditingId(editingId === s.lease_id ? null : s.lease_id)}
            />
            <Stat label="Property taxes · actual" main={money(s.tax_amount)} sub={hasSf ? psf2(taxPsf) + '/SF' : ''} />
            <Stat label="CAM · actual" main={money(s.cam_amount)} sub={hasSf ? psf2(camPsf) + '/SF' : ''} />
            <Stat label="Roof · actual" main={roofBilled ? money(s.roof_amt) : <span className="muted">—</span>} sub={roofBilled && hasSf ? psf2(roofPsf) + '/SF' : ''} />
            <DiffStat fig={row.fig} show={row.billed.anyEstimate} />
            {editingId === s.lease_id && (
              <EstimateEditor
                share={s}
                saving={saveEst.isPending}
                onCancel={() => setEditingId(null)}
                onSave={(patch) => saveEst.mutate({ leaseId: s.lease_id, patch })}
              />
            )}
          </div>
        );
      })}
      <div className="ledger-grid ledger-row ledger-totals">
        <div className="ledger-id">
          <div className="ledger-name">Totals</div>
          <div className="ledger-meta">{sf(tot.sf)} leased{buildingSf > 0 ? ` of ${sf(buildingSf)} building` : ''}</div>
        </div>
        <Stat label="Base rent" main={money(tot.base)} />
        <Stat label="Estimated · billed" main={tot.anyEst ? money(tot.est) : <span className="muted">—</span>} />
        <Stat label="Property taxes · actual" main={money(tot.tax)} />
        <Stat label="CAM · actual" main={money(tot.cam)} />
        <Stat label="Roof · actual" main={money(tot.roof)} />
        <Stat
          label="Difference · actual − estimated"
          className="ledger-diff"
          main={tot.anyEst ? <DiffFigure diff={tot.diff} /> : <span className="muted">—</span>}
        />
      </div>
      <div className="table-note muted">
        <strong>Estimated</strong> is what the tenant actually pays during the year (click a figure to set it — the
        true CAM is only known once the year closes); it falls back to the actual share until you enter one.
        <strong> Difference</strong> updates live as expenses are entered: positive = the tenant will owe more at
        year end, negative = you'll owe the tenant back. <strong>Reconcile</strong> settles a finished year — a
        shortfall becomes an invoice in receivables, an overpayment a refund to the tenant. Tax &amp; CAM are
        allocated per square foot of the {noBuildingSf ? 'leased space' : 'whole building'} (or a per-lease
        override){noBuildingSf ? '' : ', so the vacant share stays with the landlord'}; roof is billed by PSF only
        to roof-responsible tenants and stays its own separate line, estimate and reconciliation included.
        {buildingSf > 0 && tot.sf !== buildingSf && (
          <> The leased total ({sf(tot.sf)}) differs from the building size ({sf(buildingSf)}) by {sf(Math.abs(buildingSf - tot.sf))} of
          {buildingSf > tot.sf ? ' vacant' : ' over-allocated'} space — yours to reconcile.</>
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
  const estCamTax = billed.cam + billed.tax;
  const psfSub = sfNum > 0 ? `${psf2(estCamTax / sfNum)}/SF` : '';
  const roofSub = share.roof_responsible && billed.roof > 0 ? `+ roof ${money(billed.roof)}` : '';
  return (
    <div className="ledger-stat">
      <span className="stat-label">Estimated · billed to tenant</span>
      <button
        type="button"
        className={`est-cell-btn${editing ? ' editing' : ''}`}
        onClick={onToggle}
        title="Click to set what this tenant pays as estimated CAM / tax (and roof, when responsible) during the year — entered in $ per square foot"
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
// band spanning the whole entry. The landlord types $/SF rates of the tenant's
// space (per George: prices are quoted per square foot), stored annualized on the
// lease so every billing surface (invoice, monthly tracker, Leases page) follows.
// A lease with no square footage on file falls back to plain $/yr entry.
function EstimateEditor({ share, onSave, onCancel, saving }) {
  const sfNum = Number(share.square_footage) || 0;
  const perSf = sfNum > 0;
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const toInput = (annual) => (annual == null ? '' : String(perSf ? round2(annual / sfNum) : annual));
  const [cam, setCam] = useState(toInput(share.est_cam_annual));
  const [tax, setTax] = useState(toInput(share.est_tax_annual));
  const [roof, setRoof] = useState(toInput(share.est_roof_annual));

  // What the landlord types (a $/SF rate when the SF is known) → the annual $ saved.
  const annualOf = (v) => (v === '' || v == null ? null : perSf ? round2(Number(v) * sfNum) : Number(v));
  const unit = perSf ? '$/SF/yr' : '$/yr';
  const ph = (actualAnnual) => (perSf ? (Number(actualAnnual || 0) / sfNum).toFixed(2) : String(Math.round(actualAnnual || 0)));
  const preview =
    (annualOf(cam) ?? Number(share.cam_amount || 0)) +
    (annualOf(tax) ?? Number(share.tax_amount || 0)) +
    (share.roof_responsible ? (annualOf(roof) ?? Number(share.roof_amt || 0)) : 0);

  return (
    <div className="ledger-edit">
      <label>
        <span>CAM {unit}</span>
        <input className="text-input num" type="number" step="any" min="0" value={cam} onChange={(e) => setCam(e.target.value)} placeholder={ph(share.cam_amount)} />
      </label>
      <label>
        <span>Tax {unit}</span>
        <input className="text-input num" type="number" step="any" min="0" value={tax} onChange={(e) => setTax(e.target.value)} placeholder={ph(share.tax_amount)} />
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
              est_cam_annual: annualOf(cam),
              est_tax_annual: annualOf(tax),
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

// The per-row reconcile state: the button before a year is reconciled, then the
// outcome — the linked invoice's live status (tenant owed), the refund open/settled
// state (you owed), or a quiet "even". Statement letter available either way.
function ReconcileAction({ row, invById, onReconcile, onStatement, onRefunded, busy }) {
  const { recon } = row;
  if (!recon) {
    // Reconciliation only applies once an estimate is set — with none, the tenant is
    // simply billed its actual share and there's nothing to true up.
    if (!row.billed.anyEstimate) return null;
    return (
      <button className="secondary btn-sm" onClick={onReconcile} disabled={busy} title={`Settle ${row.share.tenant_name}'s estimated-vs-actual CAM & tax for the year`}>
        ⚖ Reconcile
      </button>
    );
  }
  if (recon.direction === 'even') {
    return <span className="badge good" title="Estimate and actual came out even">Reconciled ✓</span>;
  }
  if (recon.direction === 'tenant_owes') {
    const inv = recon.invoice_id ? invById[recon.invoice_id] : null;
    const status = inv?.display_status;
    const label =
      status === 'paid' ? 'collected ✓' : status === 'overdue' ? 'overdue' : status === 'partial' ? 'partly paid' : 'invoiced';
    return (
      <span className="recon-state">
        <span className={`badge ${status === 'paid' ? 'good' : status === 'overdue' ? 'danger' : 'info'}`}>
          Owed {money(recon.diff)} — {label}
        </span>
        <button className="secondary btn-sm" onClick={onStatement}>✉ Statement</button>
      </span>
    );
  }
  // landlord_owes
  const owed = money(Math.abs(Number(recon.diff)));
  if (recon.status === 'settled') {
    return (
      <span className="recon-state">
        <span className="badge good">Refunded {owed} ✓</span>
        <button className="secondary btn-sm" onClick={onStatement}>✉ Statement</button>
      </span>
    );
  }
  return (
    <span className="recon-state">
      <span className="badge warn">You owe {owed}</span>
      <button className="secondary btn-sm" onClick={onRefunded} disabled={busy} title="Mark once you've paid the tenant back (outside the app)">✓ Mark refunded</button>
      <button className="secondary btn-sm" onClick={onStatement}>✉ Statement</button>
    </span>
  );
}
