import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listLeases } from '../lib/api';

// A hover/focus fly-out on a property card that jumps straight to any lease under it,
// skipping the property landing page. Reads the ['leases', propId] cache the property
// list already seeds, so it's a cache hit (no extra round-trip). The lease detail page
// lives only in the Portfolio workspace, so every link targets /leases/... regardless
// of which workspace the card sits in. A link click stops propagation so it opens the
// lease instead of the card's property-level click. Renders nothing until leases load.
export default function PropLeaseFlyout({ corpId, propertyId }) {
  const { data: leases = [] } = useQuery({
    queryKey: ['leases', propertyId],
    queryFn: () => listLeases(propertyId),
  });
  if (!leases.length) return null;
  return (
    <div className="corp-flyout" role="menu" aria-label="Leases at this property">
      <div className="corp-flyout-head">Go to a lease</div>
      {leases.map((l) => (
        <Link
          key={l.id}
          role="menuitem"
          className="corp-flyout-item"
          to={`/leases/${corpId}/${propertyId}/${l.id}`}
          onClick={(e) => e.stopPropagation()}
        >
          {l.tenant_name || 'Unnamed tenant'}
        </Link>
      ))}
    </div>
  );
}
