import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getCorporation, getProperty } from '../lib/api';
import { usePageChrome } from '../context/ChromeContext';
import PropertyTabs from '../components/PropertyTabs';
import ServiceContractsSection from '../components/ServiceContractsSection';

// Property "Contracts" tab — the standing service/maintenance agreements.
export default function ContractsPage() {
  const { corpId, propId } = useParams();
  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  usePageChrome([
    { label: 'Leases', to: '/leases' },
    { label: corp?.name || '…', to: `/leases/${corpId}` },
    { label: prop?.name || '…', to: `/leases/${corpId}/${propId}` },
    { label: 'Contracts' },
  ]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{prop?.name || '…'}</h1>
          <div className="muted">Service &amp; maintenance contracts</div>
        </div>
      </div>

      <PropertyTabs corpId={corpId} propId={propId} />

      <div className="panel">
        <div className="panel-head">
          <strong>Service contracts</strong>
          <span className="muted">Landscaping, snow removal, security…</span>
        </div>
        <ServiceContractsSection propId={propId} />
      </div>
    </div>
  );
}
