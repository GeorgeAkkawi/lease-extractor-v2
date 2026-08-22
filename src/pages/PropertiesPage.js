import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCorporation, listProperties, createProperty, listLeases } from '../lib/api';
import { usePageChrome } from '../context/ChromeContext';
import { usePrefetchers, leasesByPropertiesQuery } from '../lib/prefetch';
import { money } from '../lib/format';
import { useFeatures } from '../lib/features';
import { CardGridSkeleton } from '../components/Skeleton';
import { MegaphoneIcon, ShieldIcon } from '../components/icons';
import PropertyInsuranceModal from '../components/PropertyInsuranceModal';
import PropertyAnnouncementsModal from '../components/PropertyAnnouncementsModal';
import PropLeaseFlyout from '../components/PropLeaseFlyout';
import PropertyMixDonut from '../components/PropertyMixDonut';
import MutationError from '../components/MutationError';

// Leases-mode property list. Financials/History have their own (FinancialsPropertiesPage).
export default function PropertiesPage() {
  const { corpId } = useParams();
  const qc = useQueryClient();
  const pf = usePrefetchers();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [buildingSf, setBuildingSf] = useState('');

  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const [insuranceProp, setInsuranceProp] = useState(null);
  const [announceProp, setAnnounceProp] = useState(null);
  const { data: properties = [], isPending } = useQuery({
    queryKey: ['properties', corpId],
    queryFn: () => listProperties(corpId),
  });
  // One request loads every card's leases and seeds each ['leases', propId] cache,
  // so the cards render fully populated in one pass (no per-card waterfall).
  const { isPending: leasesPending } = useQuery({
    ...leasesByPropertiesQuery(qc, corpId, properties),
    enabled: properties.length > 0,
  });
  usePageChrome([{ label: 'Portfolio', to: '/leases' }, { label: corp?.name || '…' }]);

  const add = useMutation({
    mutationFn: () => createProperty({ corporation_id: corpId, name: name.trim(), address: address.trim(), building_sf: buildingSf === '' ? null : Number(buildingSf) }),
    onSuccess: () => {
      setName('');
      setAddress('');
      setBuildingSf('');
      qc.invalidateQueries({ queryKey: ['properties', corpId] });
      qc.invalidateQueries({ queryKey: ['corpCounts'] });
      // The Overview is built out of this one index — its "N properties · N active tenants"
      // subtitle, its occupancy figures, its basis rows and every chart. Nothing invalidated
      // it, so a client who set up their portfolio and then clicked Overview read zeros.
      qc.invalidateQueries({ queryKey: ['searchIndex'] });
      // The Sidebar's own property list. It never unmounts, and with staleTime 5min /
      // refetchOnWindowFocus false a query whose observer never unmounts NEVER refetches —
      // so without this the new property was missing from the fly-out until a hard reload.
      // Exactly the `sidebarLeases` shape from 2026-08-04.
      qc.invalidateQueries({ queryKey: ['corpProperties'] });
    },
  });

  const showSkeleton = isPending || (properties.length > 0 && leasesPending);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{corp?.name || '…'}</h1>
          <div className="muted">{properties.length} {properties.length === 1 ? 'property' : 'properties'}</div>
        </div>
        <div className="head-actions">
          <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add.mutate(); }}>
            <input className="text-input" placeholder="Property name" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="text-input" placeholder="Address (optional)" value={address} onChange={(e) => setAddress(e.target.value)} />
            <input className="text-input num" type="number" placeholder="Building SF" value={buildingSf} onChange={(e) => setBuildingSf(e.target.value)} style={{ width: 120 }} />
            <button type="submit" disabled={!name.trim() || add.isPending}>+ Add property</button>
          </form>
        </div>
      </div>

      {/* ⚠ A NEW CLIENT'S SECOND CLICK, and until now a failed one said nothing at all: the
          button un-disabled, the typed text stayed in the boxes, no card appeared, and the
          screen was indistinguishable from a click that hadn't registered. */}
      <MutationError of={[add]} />

      {showSkeleton ? (
        <CardGridSkeleton className="prop-grid" count={3} height={150} />
      ) : properties.length === 0 ? (
        <p className="muted">No properties yet.</p>
      ) : (
        <div className="prop-grid">
          {properties.map((p) => (
            <PropCard key={p.id} corpId={corpId} property={p} onInsurance={setInsuranceProp} onAnnounce={setAnnounceProp} pf={pf} />
          ))}
        </div>
      )}

      {insuranceProp && <PropertyInsuranceModal property={insuranceProp} onClose={() => setInsuranceProp(null)} />}
      {announceProp && <PropertyAnnouncementsModal property={announceProp} corp={corp} onClose={() => setAnnounceProp(null)} />}
    </div>
  );
}

function PropCard({ corpId, property, onInsurance, onAnnounce, pf }) {
  const navigate = useNavigate();
  const { isOn } = useFeatures();
  // Reads the cache seeded by the page's batched fetch — no own network round-trip.
  const { data: leases = [] } = useQuery({
    queryKey: ['leases', property.id],
    queryFn: () => listLeases(property.id),
  });
  // Count EVERY tenant, including an "outdated / needs-extension" lease — the tenant
  // still occupies the space (and still owes rent) until the landlord removes them, so
  // the card's tenant count / SF / occupancy / revenue match the Leases page instead of
  // reading their space as vacant.
  const totalSf = leases.reduce((s, l) => s + (Number(l.square_footage) || 0), 0);
  const revenue = leases.reduce((s, l) => s + (Number(l.base_rent) || 0), 0);
  const buildingSf = Number(property.building_sf) || totalSf;
  // ⚠ NULL IS NOT 100%. A brand-new property has no building size and no tenants, so both
  // sides of this are 0 — and the fallback reported the client's first empty building as
  // "Leased 100%" before they had entered a single thing. Unknown is its own answer.
  const occupancy = buildingSf > 0 ? totalSf / buildingSf : null;
  const go = () => navigate(`/leases/${corpId}/${property.id}`);
  const keyGo = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  const warm = () => pf.propertyLeases(property.id);

  return (
    <div className="prop-card has-flyout" role="button" tabIndex={0} onClick={go} onKeyDown={keyGo} onMouseEnter={warm} onFocus={warm}>
      <div className="prop-card-main">
        <div className="prop-card-head">
          <strong>{property.name}</strong>
          {/* Both pills stop propagation — the card itself is the navigate-to-leases button. */}
          <div className="prop-card-actions">
            {isOn('announcements') && (
              <button
                className="corp-edit"
                title="Email an announcement to every tenant of this property"
                onClick={(e) => { e.stopPropagation(); onAnnounce(property); }}
              >
                <MegaphoneIcon /> Announcements
              </button>
            )}
            {isOn('insurance') && (
              <button
                className="corp-edit"
                title="Landlord insurance for this property"
                onClick={(e) => { e.stopPropagation(); onInsurance(property); }}
              >
                <ShieldIcon /> Insurance
              </button>
            )}
          </div>
        </div>
        <div className="prop-addr muted">{property.address || 'No address'}</div>
        <div className="prop-card-stats">
          <div><span className="muted">Tenants</span><b>{leases.length}</b></div>
          <div><span className="muted">Sq ft</span><b>{Number(totalSf).toLocaleString()} / {Number(buildingSf).toLocaleString()}</b></div>
          <div>
            <span className="muted">Leased</span>
            <b title={occupancy == null ? 'Enter the building size to see occupancy' : undefined}>
              {occupancy == null ? '—' : `${Math.round(occupancy * 100)}%`}
            </b>
          </div>
          <div><span className="muted">Revenue</span><b>{money(revenue)}</b></div>
        </div>
      </div>
      <PropertyMixDonut property={property} leases={leases} />
      <PropLeaseFlyout corpId={corpId} propertyId={property.id} />
    </div>
  );
}
