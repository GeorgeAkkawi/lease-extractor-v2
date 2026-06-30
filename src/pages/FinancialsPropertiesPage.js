import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getCorporation, listProperties, getPropertyTotals } from '../lib/api';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { money, psf } from '../lib/format';

// Shared by Financials and History workspaces (mode = 'financials' | 'history').
export default function FinancialsPropertiesPage({ mode = 'financials' }) {
  const { corpId } = useParams();
  const { year } = useChrome();
  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: properties = [], isLoading } = useQuery({
    queryKey: ['properties', corpId],
    queryFn: () => listProperties(corpId),
  });
  const base = mode === 'history' ? 'history' : 'financials';
  usePageChrome([{ label: mode === 'history' ? 'History' : 'Financials', to: `/${base}` }, { label: corp?.name || '…' }], true);

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

      {isLoading ? (
        <p className="muted">Loading…</p>
      ) : properties.length === 0 ? (
        <p className="muted">No properties yet. Add them on the Leases page.</p>
      ) : (
        <div className="prop-grid">
          {properties.map((p) => (
            <FinPropCard key={p.id} property={p} year={year} to={`/${base}/${corpId}/${p.id}`} />
          ))}
        </div>
      )}
    </div>
  );
}

function FinPropCard({ property, year, to }) {
  const navigate = useNavigate();
  const { data: totals } = useQuery({
    queryKey: ['propertyTotals', property.id, year],
    queryFn: () => getPropertyTotals(property.id, year),
  });
  const expenses = totals ? Number(totals.taxes_total) + Number(totals.cam_total) + Number(totals.roof_total) : null;

  return (
    <button className="prop-card" onClick={() => navigate(to)}>
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
