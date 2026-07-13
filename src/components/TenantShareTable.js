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

// A numeric cell with a main figure and an optional smaller sub-line. The sub
// element is always rendered (blank = NBSP) so every column shares the same
// height and the main figures line up across the row.
function NumCell({ main, sub, className = '', title }) {
  return (
    <td className={`num ${className}`.trim()} title={title}>
      <div className="cell-main">{main}</div>
      <div className="cell-sub">{sub || NBSP}</div>
    </td>
  );
}

// Per-tenant breakdown + the estimated-vs-actual reconciliation view (0060).
// Tenants pay the lease's typed ESTIMATE during the year (the true CAM is only
// known at year end); this table shows, per tenant: the estimate being billed
// (click to edit — saved on the lease), the ACTUAL share as expenses fill in,
// and the live Difference between them. The Reconcile action settles a finished
// year: a shortfall becomes a reconciliation invoice in receivables; an
// overpayment becomes a refund you mark paid once you've paid the tenant back.
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
      est: a.est + (billed.anyEstimate ? fig.estTotal : 0),
      tax: a.tax + (Number(s.tax_amount) || 0),
      cam: a.cam + (Number(s.cam_amount) || 0),
      roof: a.roof + (Number(s.roof_amt) || 0),
      diff: a.diff + (billed.anyEstimate ? fig.diff : 0),
      anyEst: a.anyEst || billed.anyEstimate,
    }),
    { sf: 0, est: 0, tax: 0, cam: 0, roof: 0, diff: 0, anyEst: false }
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
    <div className="table-wrap">
      {noBuildingSf && (
        <div className="note-msg warn" style={{ margin: '10px 12px' }}>
          Building size not set — CAM &amp; taxes are currently split over the leased space only.
          Enter the building’s total square footage (in <strong>Building size</strong>) to bill each tenant true
          per-SF of the whole building, leaving the vacant share with you.
        </div>
      )}
      <MutationError of={[saveEst, reconcile, refund]} />
      <table className="grouped">
        <thead>
          <tr>
            <th rowSpan={2}>Tenant</th>
            <th rowSpan={2} className="num">SF</th>
            <th rowSpan={2} className="num">Base rent</th>
            <th rowSpan={2} className="num">Share</th>
            <th rowSpan={2} className="num grp-start">Estimated<br /><span className="sub-cap">billed to tenant</span></th>
            <th colSpan={2} className="num grp">Property taxes · actual</th>
            <th colSpan={2} className="num grp">CAM · actual</th>
            <th rowSpan={2} className="num grp-start">Roof · actual</th>
            <th rowSpan={2} className="num grp-start">Difference<br /><span className="sub-cap">actual − estimated</span></th>
            <th rowSpan={2}></th>
          </tr>
          <tr>
            <th className="num grp-start sub">$</th>
            <th className="num sub">$/SF</th>
            <th className="num grp-start sub">$</th>
            <th className="num sub">$/SF</th>
          </tr>
        </thead>
        <tbody>
          {rowsData.map((row) => {
            const s = row.share;
            const taxPsf = s.square_footage > 0 ? s.tax_amount / s.square_footage : null;
            const camPsf = s.square_footage > 0 ? s.cam_amount / s.square_footage : null;
            const roofPsf = s.square_footage > 0 ? s.roof_amt / s.square_footage : null;
            const roofBilled = s.roof_responsible && s.roof_amt > 0;
            return (
              <tr key={s.lease_id}>
                <td>{s.tenant_name}</td>
                <NumCell main={sf(s.square_footage)} />
                <NumCell main={money(s.base_rent)} sub={s.square_footage > 0 ? psf2(s.base_rent / s.square_footage) + '/SF' : ''} />
                <NumCell main={pct(s.share_pct)} />
                <EstimateCell
                  key={`${s.lease_id}:${s.est_cam_annual}:${s.est_tax_annual}:${s.est_roof_annual}`}
                  share={s}
                  billed={row.billed}
                  editing={editingId === s.lease_id}
                  onEdit={() => setEditingId(s.lease_id)}
                  onCancel={() => setEditingId(null)}
                  onSave={(patch) => saveEst.mutate({ leaseId: s.lease_id, patch })}
                  saving={saveEst.isPending && editingId === s.lease_id}
                />
                <NumCell className="grp-start" main={money(s.tax_amount)} />
                <NumCell main={psf2(taxPsf)} />
                <NumCell className="grp-start" main={money(s.cam_amount)} />
                <NumCell main={psf2(camPsf)} />
                <NumCell className="grp-start" main={roofBilled ? money(s.roof_amt) : <span className="muted">—</span>} sub={roofBilled ? psf2(roofPsf) + '/SF' : ''} />
                <DifferenceCell fig={row.fig} show={row.billed.anyEstimate} />
                <td className="num">
                  <div className="cell-actions">
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
                </td>
              </tr>
            );
          })}
          <tr className="total-row">
            <td>Totals</td>
            <td className="num">
              <div className="cell-main">{sf(tot.sf)}</div>
              {buildingSf > 0 && (
                <div className="cell-sub">of {sf(buildingSf)} building</div>
              )}
            </td>
            <td className="num"></td>
            <td className="num"></td>
            <td className="num grp-start">{tot.anyEst ? money(tot.est) : <span className="muted">—</span>}</td>
            <td className="num grp-start">{money(tot.tax)}</td>
            <td className="num"></td>
            <td className="num grp-start">{money(tot.cam)}</td>
            <td className="num"></td>
            <td className="num grp-start">{money(tot.roof)}</td>
            <td className="num grp-start">
              {tot.anyEst ? <DiffFigure diff={tot.diff} /> : <span className="muted">—</span>}
            </td>
            <td></td>
          </tr>
        </tbody>
      </table>
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

function DifferenceCell({ fig, show }) {
  // No estimate set → nothing to compare against, so the column stays dormant.
  if (!show) {
    return (
      <td className="num grp-start">
        <div className="cell-main muted">—</div>
        <div className="cell-sub">{NBSP}</div>
      </td>
    );
  }
  const d = Number(fig.diff) || 0;
  const sub = Math.abs(d) <= RECON_DUST ? '' : d > 0 ? 'tenant owes' : 'you owe tenant';
  return (
    <td className="num grp-start">
      <div className="cell-main"><DiffFigure diff={d} /></div>
      <div className="cell-sub">{sub || NBSP}</div>
    </td>
  );
}

// The Estimated column: shows the billed figure (typed estimate, else the actual it
// falls back to) with its $/SF — like the actual columns — and opens a tiny inline
// form where the landlord types the estimates in $/SF of the tenant's space (per
// George: prices are quoted per square foot). Stored annualized on the lease, so
// every billing surface (invoice, monthly tracker, Leases page) follows. A lease
// with no square footage on file falls back to plain $/yr entry.
function EstimateCell({ share, billed, editing, onEdit, onCancel, onSave, saving }) {
  const sfNum = Number(share.square_footage) || 0;
  const perSf = sfNum > 0;
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const toInput = (annual) => (annual == null ? '' : String(perSf ? round2(annual / sfNum) : annual));
  const [cam, setCam] = useState(toInput(share.est_cam_annual));
  const [tax, setTax] = useState(toInput(share.est_tax_annual));
  const [roof, setRoof] = useState(toInput(share.est_roof_annual));

  if (editing) {
    // What the landlord types (a $/SF rate when the SF is known) → the annual $ saved.
    const annualOf = (v) => (v === '' || v == null ? null : perSf ? round2(Number(v) * sfNum) : Number(v));
    const unit = perSf ? '$/SF/yr' : '$/yr';
    const ph = (actualAnnual) => (perSf ? (Number(actualAnnual || 0) / sfNum).toFixed(2) : String(Math.round(actualAnnual || 0)));
    const preview =
      (annualOf(cam) ?? Number(share.cam_amount || 0)) +
      (annualOf(tax) ?? Number(share.tax_amount || 0)) +
      (share.roof_responsible ? (annualOf(roof) ?? Number(share.roof_amt || 0)) : 0);
    return (
      <td className="num grp-start est-edit">
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
      </td>
    );
  }

  const estCamTax = billed.cam + billed.tax;
  const psfSub = perSf ? `${psf2(estCamTax / sfNum)}/SF` : '';
  const roofSub = share.roof_responsible && billed.roof > 0 ? `+ roof ${money(billed.roof)}` : '';
  const sub = [psfSub, roofSub].filter(Boolean).join(' · ');
  return (
    <td className="num grp-start">
      <button
        type="button"
        className="est-cell-btn"
        onClick={onEdit}
        title="Click to set what this tenant pays as estimated CAM / tax (and roof, when responsible) during the year — entered in $ per square foot"
      >
        <div className="cell-main">
          {billed.anyEstimate
            ? <>{money(estCamTax)}<span className="est-tag"> est.</span></>
            : <span className="muted">＋ set estimate</span>}
        </div>
        <div className="cell-sub">{billed.anyEstimate ? (sub || NBSP) : 'billing actuals'}</div>
      </button>
    </td>
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
