import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCorporation, listProperties, createProperty, listLeases } from '../lib/api';
import { usePageChrome } from '../context/ChromeContext';
import { usePrefetchers, leasesByPropertiesQuery } from '../lib/prefetch';
import { money } from '../lib/format';
import { useFeatures } from '../lib/features';
import { CardGridSkeleton } from '../components/Skeleton';
import { ShieldIcon } from '../components/icons';
import PropertyInsuranceModal from '../components/PropertyInsuranceModal';
import PropLeaseFlyout from '../components/PropLeaseFlyout';

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

      {showSkeleton ? (
        <CardGridSkeleton className="prop-grid" count={3} height={150} />
      ) : properties.length === 0 ? (
        <p className="muted">No properties yet.</p>
      ) : (
        <div className="prop-grid">
          {properties.map((p) => (
            <PropCard key={p.id} corpId={corpId} property={p} onInsurance={setInsuranceProp} pf={pf} />
          ))}
        </div>
      )}

      {insuranceProp && <PropertyInsuranceModal property={insuranceProp} onClose={() => setInsuranceProp(null)} />}
    </div>
  );
}

function PropCard({ corpId, property, onInsurance, pf }) {
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
  const occupancy = buildingSf > 0 ? totalSf / buildingSf : 1;
  const go = () => navigate(`/leases/${corpId}/${property.id}`);
  const keyGo = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  const warm = () => pf.propertyLeases(property.id);

  return (
    <div className="prop-card has-flyout" role="button" tabIndex={0} onClick={go} onKeyDown={keyGo} onMouseEnter={warm} onFocus={warm}>
      <div className="prop-card-head">
        <strong>{property.name}</strong>
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
      <div className="prop-addr muted">{property.address || 'No address'}</div>
      <div className="prop-card-stats">
        <div><span className="muted">Tenants</span><b>{leases.length}</b></div>
        <div><span className="muted">Sq ft</span><b>{Number(totalSf).toLocaleString()} / {Number(buildingSf).toLocaleString()}</b></div>
        <div><span className="muted">Leased</span><b>{Math.round(occupancy * 100)}%</b></div>
        <div><span className="muted">Revenue</span><b>{money(revenue)}</b></div>
      </div>
      <PropLeaseFlyout corpId={corpId} propertyId={property.id} />
    </div>
  );
}
