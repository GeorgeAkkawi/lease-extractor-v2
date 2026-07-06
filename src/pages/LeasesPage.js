import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCorporation, getProperty, listLeases, listEscalations } from '../lib/api';
import { usePageChrome } from '../context/ChromeContext';
import { usePrefetchers, escalationsByLeasesQuery } from '../lib/prefetch';
import BuildingSizeEditor from '../components/BuildingSizeEditor';
import LeaseSearch from '../components/LeaseSearch';
import PropertyTabs from '../components/PropertyTabs';
import { RowListSkeleton } from '../components/Skeleton';
import { downloadRentRollXlsx } from '../lib/rentRollExcel';
import { money, psf, sf, fmtDate } from '../lib/format';

export default function LeasesPage() {
  const { corpId, propId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const pf = usePrefetchers();
  const [showBldg, setShowBldg] = useState(false);
  const [search, setSearch] = useState('');
  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  const { data: leases = [], isLoading } = useQuery({ queryKey: ['leases', propId], queryFn: () => listLeases(propId) });
  // One request loads every row's escalations and seeds each ['escalations', leaseId]
  // cache, so rows show "next escalation" in one pass (no per-row waterfall).
  const { isPending: escPending } = useQuery({
    ...escalationsByLeasesQuery(qc, propId, leases),
    enabled: leases.length > 0,
  });
  usePageChrome([
    { label: 'Leases', to: '/leases' },
    { label: corp?.name || '…', to: `/leases/${corpId}` },
    { label: prop?.name || '…' },
  ]);

  const leasedSf = leases.reduce((s, l) => s + (Number(l.square_footage) || 0), 0);
  const buildingSf = Number(prop?.building_sf) || 0;
  const vacant = buildingSf > 0 ? Math.max(0, buildingSf - leasedSf) : 0;
  const newLease = () => navigate(`/leases/${corpId}/${propId}/new`);

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

      {showSkeleton ? (
        <RowListSkeleton className="lease-list" count={3} />
      ) : leases.length === 0 && vacant === 0 ? (
        <p className="muted">No leases yet. Add one to get started.</p>
      ) : (
        <>
        {leases.length > 0 && (
          <LeaseSearch
            propId={propId}
            query={search}
            onChange={setSearch}
            leases={leases}
            onOpen={(id) => navigate(`/leases/${corpId}/${propId}/${id}`)}
            onWarm={(id) => pf.leaseDetail(id)}
          />
        )}
        {search.trim() ? null : (
        <div className="lease-list">
          {leases.map((l) => (
            <LeaseRow key={l.id} lease={l} pf={pf} onOpen={() => navigate(`/leases/${corpId}/${propId}/${l.id}`)} />
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
        </>
      )}
    </div>
  );
}

function LeaseRow({ lease, onOpen, pf }) {
  // Reads the cache seeded by the page's batched fetch — no own network round-trip.
  const { data: escalations = [] } = useQuery({
    queryKey: ['escalations', lease.id],
    queryFn: () => listEscalations(lease.id),
  });
  const next = nextEscalation(escalations);
  const brPsf = lease.square_footage > 0 ? lease.base_rent / lease.square_footage : null;
  const warm = () => pf.leaseDetail(lease.id);

  return (
    <button className="lease-row" onClick={onOpen} onMouseEnter={warm} onFocus={warm}>
      <span className="lease-name">
        <strong>{lease.tenant_name}</strong>
        <span className="muted">{sf(lease.square_footage)}</span>
        {lease.is_active === false && <span className="badge danger" style={{ marginTop: 4, alignSelf: 'flex-start' }}>Outdated — needs extension</span>}
      </span>
      <span className="lease-col">
        <span className="muted">Base rent</span>
        <b>{money(lease.base_rent)}</b>
        <span className="psf-sub">{brPsf == null ? '' : psf(brPsf)}</span>
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
