import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCorporation, getProperty, listLeases, listEscalations, getTenantShares, getLeaseSort, setLeaseSort } from '../lib/api';
import { usePageChrome } from '../context/ChromeContext';
import { usePrefetchers, escalationsByLeasesQuery } from '../lib/prefetch';
import { sortLeases, LEASE_SORTS } from '../lib/leaseSort';
import { billedComponents } from '../lib/reconciliation';
import BuildingSizeEditor from '../components/BuildingSizeEditor';
import PropertyTabs from '../components/PropertyTabs';
import { RowListSkeleton } from '../components/Skeleton';
import { downloadRentRollXlsx } from '../lib/rentRollExcel';
import { money, psf, sf, fmtDate, approx } from '../lib/format';

const CURRENT_YEAR = new Date().getFullYear();

export default function LeasesPage() {
  const { corpId, propId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pf = usePrefetchers();
  const [showBldg, setShowBldg] = useState(false);
  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  const { data: leases = [], isLoading } = useQuery({ queryKey: ['leases', propId], queryFn: () => listLeases(propId) });
  // One request loads every row's escalations and seeds each ['escalations', leaseId]
  // cache, so rows show "next escalation" in one pass (no per-row waterfall).
  const { isPending: escPending } = useQuery({
    ...escalationsByLeasesQuery(qc, propId, leases),
    enabled: leases.length > 0,
  });
  // Per-tenant CAM/tax/roof shares for this calendar year — powers the CAM+tax and
  // Total columns (and the Total-rent sort). One query for the whole property.
  const { data: shares = [] } = useQuery({
    queryKey: ['tenantShares', propId, CURRENT_YEAR],
    queryFn: () => getTenantShares(propId, CURRENT_YEAR),
    enabled: leases.length > 0,
  });
  const { data: leaseSort = {} } = useQuery({ queryKey: ['leaseSort'], queryFn: getLeaseSort });
  usePageChrome([
    { label: 'Portfolio', to: '/leases' },
    { label: corp?.name || '…', to: `/leases/${corpId}` },
    { label: prop?.name || '…' },
  ]);

  const leasedSf = leases.reduce((s, l) => s + (Number(l.square_footage) || 0), 0);
  const buildingSf = Number(prop?.building_sf) || 0;
  const vacant = buildingSf > 0 ? Math.max(0, buildingSf - leasedSf) : 0;
  const newLease = () => navigate(`/leases/${corpId}/${propId}/new`);

  // lease_id -> { camTax, roof, total, totalPsf, isEstimate }. Total = base + CAM + tax
  // + roof, matching the real invoice — which since 0060 bills the lease's typed
  // ESTIMATE per component when one exists (the true CAM is only known at year end),
  // falling back to the actual share otherwise. The column shows the billed figure;
  // base uses the lease's own base_rent (what the Base rent column shows).
  const shareByLease = Object.fromEntries(shares.map((s) => [s.lease_id, s]));
  const totals = {};
  for (const l of leases) {
    // The share row carries actuals + estimates; before it loads (or in demo with no
    // expense record) the lease's own estimate fields still bill.
    const s = shareByLease[l.id] || {
      cam_amount: 0, tax_amount: 0, roof_amt: 0,
      roof_responsible: l.roof_responsible,
      est_cam_annual: l.est_cam_annual, est_tax_annual: l.est_tax_annual, est_roof_annual: l.est_roof_annual,
    };
    const billed = billedComponents(s);
    const camTax = billed.cam + billed.tax;
    const total = Number(l.base_rent || 0) + camTax + billed.roof;
    const sqft = Number(l.square_footage) || 0;
    totals[l.id] = { camTax, roof: billed.roof, total, totalPsf: sqft ? total / sqft : null, isEstimate: billed.anyEstimate };
  }

  const mode = leaseSort.mode || 'term_end';
  const dir = leaseSort.dir || 'asc';
  const manualOrder = leaseSort.manual?.[propId] || [];
  const ordered = sortLeases(leases, { mode, dir, manualOrder, totals });

  const saveSort = useMutation({
    mutationFn: setLeaseSort,
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ['leaseSort'] });
      const prev = qc.getQueryData(['leaseSort']);
      qc.setQueryData(['leaseSort'], (old = {}) => {
        const next = { ...(old || {}), ...patch };
        if (patch.manual) next.manual = { ...((old || {}).manual || {}), ...patch.manual };
        return next;
      });
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['leaseSort'], ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: ['leaseSort'] }),
  });

  // Drag-and-drop custom order. Dropping row A onto row B moves A to B's slot and
  // saves the new id order as the per-property manual order (switching to Custom).
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const onDrop = (targetId) => {
    if (dragId && dragId !== targetId) {
      const ids = ordered.map((l) => l.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from >= 0 && to >= 0) {
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        saveSort.mutate({ mode: 'custom', manual: { [propId]: ids } });
      }
    }
    setDragId(null);
    setOverId(null);
  };

  const subtitle = prop
    ? `${prop.address ? prop.address + ' · ' : ''}${sf(leasedSf)} leased${buildingSf ? ` of ${Number(buildingSf).toLocaleString()} SF` : ''}${vacant > 0 ? ` · ${Number(vacant).toLocaleString()} SF vacant` : buildingSf ? ' · fully leased' : ''}`
    : '…';

  const showSkeleton = isLoading || (leases.length > 0 && escPending);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{prop?.name || '…'}</h1>
          <div className="muted">{subtitle}</div>
        </div>
        <div className="head-actions">
          <button className="secondary" onClick={() => downloadRentRollXlsx({ leases, properties: [prop], fileLabel: prop?.name })} disabled={!leases.length || !prop}>⬇ Download rent roll</button>
          <button className="secondary" onClick={() => setShowBldg((s) => !s)}>⛶ Building size</button>
          <button onClick={newLease}>+ Add tenant</button>
        </div>
      </div>

      <PropertyTabs corpId={corpId} propId={propId} />

      {showBldg && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <strong>Building size</strong>
            <span className="muted">Update if the building's leasable area changes</span>
          </div>
          <BuildingSizeEditor propId={propId} buildingSf={prop?.building_sf} />
        </div>
      )}

      {leases.length > 1 && (
        <div className="lease-sortbar">
          <label>
            <span className="muted">Sort by</span>
            <select
              className="text-input"
              value={mode}
              onChange={(e) => saveSort.mutate({ mode: e.target.value })}
            >
              {LEASE_SORTS.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </label>
          {mode !== 'custom' && (
            <button
              type="button"
              className="secondary sort-dir"
              onClick={() => saveSort.mutate({ dir: dir === 'asc' ? 'desc' : 'asc' })}
              title={dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
            >
              {dir === 'asc' ? '↑ Asc' : '↓ Desc'}
            </button>
          )}
          {mode === 'custom'
            ? <span className="muted sortbar-hint">Drag rows to reorder</span>
            : <span className="muted sortbar-hint">Drag a row to set a custom order</span>}
        </div>
      )}

      {showSkeleton ? (
        <RowListSkeleton className="lease-list" count={3} />
      ) : leases.length === 0 && vacant === 0 ? (
        <p className="muted">No leases yet. Add one to get started.</p>
      ) : (
        <div className="lease-list">
          {ordered.map((l) => (
            <LeaseRow
              key={l.id}
              lease={l}
              totals={totals[l.id]}
              pf={pf}
              onOpen={() => navigate(`/leases/${corpId}/${propId}/${l.id}`)}
              draggable
              dragging={dragId === l.id}
              dragOver={overId === l.id && dragId !== l.id}
              onDragStart={() => setDragId(l.id)}
              onDragEnter={() => dragId && setOverId(l.id)}
              onDragOver={(e) => { if (dragId) e.preventDefault(); }}
              onDrop={() => onDrop(l.id)}
              onDragEnd={() => { setDragId(null); setOverId(null); }}
            />
          ))}
          {vacant > 0 && (
            <button className="lease-row empty-slot" onClick={newLease}>
              <span className="lease-name">
                <strong>Vacant space</strong>
                <span className="muted">Unleased suite</span>
              </span>
              <span className="lease-col">
                <span className="muted">Available</span>
                <b>{sf(vacant)}</b>
              </span>
              <span className="lease-col">
                <span className="muted">Of building</span>
                <b>{Math.round((vacant / buildingSf) * 100)}%</b>
              </span>
              <span className="slot-cta"><span className="slot-plus">＋</span> Fill in your building</span>
              <span className="chevron">›</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function LeaseRow({ lease, totals, onOpen, pf, draggable, dragging, dragOver, onDragStart, onDragEnter, onDragOver, onDrop, onDragEnd }) {
  // Reads the cache seeded by the page's batched fetch — no own network round-trip.
  const { data: escalations = [] } = useQuery({
    queryKey: ['escalations', lease.id],
    queryFn: () => listEscalations(lease.id),
  });
  const next = nextEscalation(escalations);
  const brPsf = lease.square_footage > 0 ? lease.base_rent / lease.square_footage : null;
  const camTax = totals?.camTax || 0;
  const hasCamTax = camTax > 0;
  const warm = () => pf.leaseDetail(lease.id);

  return (
    <button
      className={`lease-row${dragging ? ' dragging' : ''}${dragOver ? ' drag-over' : ''}`}
      onClick={onOpen}
      onMouseEnter={warm}
      onFocus={warm}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <span className="lease-name">
        <strong>{lease.tenant_name}</strong>
        <span className="muted">{sf(lease.square_footage)}</span>
        {lease.is_active === false && <span className="badge danger" style={{ marginTop: 4, alignSelf: 'flex-start' }}>Outdated — needs extension</span>}
      </span>
      <span className="lease-col">
        <span className="muted">Base rent</span>
        <b>{money(lease.base_rent)}</b>
        <span className="psf-sub">{brPsf == null ? '' : approx(lease.base_rent, lease.square_footage) + psf(brPsf)}</span>
      </span>
      <span className="lease-col">
        <span className="muted">CAM + tax</span>
        <b
          title={
            totals?.isEstimate
              ? 'Estimated CAM & tax — what the tenant pays during the year; reconciled against the actual figures at year end (Finances page)'
              : hasCamTax ? undefined : 'No expenses entered for this year yet — add them on the Finances page'
          }
        >
          {hasCamTax ? money(camTax) : '—'}
          {totals?.isEstimate && hasCamTax && <span className="est-tag"> est.</span>}
        </b>
      </span>
      <span className="lease-col">
        <span className="muted">Total rent</span>
        <b>{money(totals?.total ?? lease.base_rent)}</b>
        <span className="psf-sub">{totals?.totalPsf == null ? '' : approx(totals.total, lease.square_footage) + psf(totals.totalPsf)}</span>
      </span>
      <span className="lease-col">
        <span className="muted">Term ends</span>
        <b>{lease.lease_termination_date ? fmtDate(lease.lease_termination_date) : '—'}</b>
      </span>
      <span className="lease-col">
        <span className="muted">Next escalation</span>
        <b>{next || 'None'}</b>
      </span>
      <span className="chevron">›</span>
    </button>
  );
}

// The NEXT upcoming escalation: the soonest one that is still scheduled (not yet
// applied) and dated today or later. Already-applied / past steps are never the
// "next" — if none qualify we show "None".
export function nextEscalation(escalations) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const upcoming = (escalations || [])
    .filter((e) => e.status !== 'applied' && String(e.effective_date) >= todayIso)
    .sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)));
  const e = upcoming[0];
  if (!e) return null;
  const amt = e.escalation_type === 'percent' ? `+${e.escalation_value}%` : e.escalation_type === 'fixed' ? `+${money(e.escalation_value)}` : '';
  return `${amt}${amt ? ' · ' : ''}${fmtDate(e.effective_date)}`;
}
