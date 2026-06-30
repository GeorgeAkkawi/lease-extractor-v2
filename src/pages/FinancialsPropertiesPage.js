import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getCorporation, listProperties, getPropertyTotals } from '../lib/api';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { usePrefetchers, propertyTotalsByCorpQuery } from '../lib/prefetch';
import { CardGridSkeleton } from '../components/Skeleton';
import { money, psf } from '../lib/format';

// Shared by Financials and History workspaces (mode = 'financials' | 'history').
export default function FinancialsPropertiesPage({ mode = 'financials' }) {
  const { corpId } = useParams();
  const { year } = useChrome();
  const qc = useQueryClient();
  const pf = usePrefetchers();
  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: properties = [], isPending } = useQuery({
    queryKey: ['properties', corpId],
    queryFn: () => listProperties(corpId),
  });
  // One request loads every card's totals and seeds each ['propertyTotals', id, year]
  // cache, so the cards render fully populated in one pass (no per-card waterfall).
  const { isPending: totalsPending } = useQuery({
    ...propertyTotalsByCorpQuery(qc, corpId, year, properties),
    enabled: properties.length > 0,
  });
  const base = mode === 'history' ? 'history' : 'financials';
  usePageChrome([{ label: mode === 'history' ? 'History' : 'Financials', to: `/${base}` }, { label: corp?.name || '…' }], true);

  const showSkeleton = isPending || (properties.length > 0 && totalsPending);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{corp?.name || '…'}</h1>
          <div className="muted">
            {mode === 'history' ? 'Year-over-year performance · ' : 'Property financials · '}FY {year}
          </div>
        </div>
      </div>

      {showSkeleton ? (
        <CardGridSkeleton className="prop-grid" count={3} height={140} />
      ) : properties.length === 0 ? (
        <p className="muted">No properties yet. Add them on the Leases page.</p>
      ) : (
        <div className="prop-grid">
          {properties.map((p) => (
            <FinPropCard key={p.id} property={p} year={year} mode={mode} to={`/${base}/${corpId}/${p.id}`} pf={pf} />
          ))}
        </div>
      )}
    </div>
  );
}

function FinPropCard({ property, year, mode, to, pf }) {
  const navigate = useNavigate();
  // Reads the cache seeded by the page's batched fetch — no own network round-trip.
  const { data: totals } = useQuery({
    queryKey: ['propertyTotals', property.id, year],
    queryFn: () => getPropertyTotals(property.id, year),
  });
  const expenses = totals ? Number(totals.taxes_total) + Number(totals.cam_total) + Number(totals.roof_total) : null;
  const warm = () => (mode === 'history' ? pf.propertyHistory(property.id) : pf.propertyFinancials(property.id, year));

  return (
    <button className="prop-card" onClick={() => navigate(to)} onMouseEnter={warm} onFocus={warm}>
      <div className="prop-card-head"><strong>{property.name}</strong></div>
      <div className="prop-addr muted">{property.address || 'No address'}</div>
      <div className="fin-mini">
        <div><span className="muted">Revenue</span><b className="pos">{money(totals?.total_revenue ?? 0)}</b></div>
        <div><span className="muted">Expenses</span><b className="neg">{expenses == null ? '—' : money(expenses)}</b></div>
        <div><span className="muted">Tax / SF</span><b>{psf(totals?.tax_psf)}</b></div>
        <div><span className="muted">CAM / SF</span><b>{psf(totals?.cam_psf)}</b></div>
      </div>
    </button>
  );
}
