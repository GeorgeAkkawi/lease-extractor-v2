import { NavLink } from 'react-router-dom';

// Property-level tab strip (Tenants | Contracts), reusing the segmented-control
// styling. Shown on the property's Leases view and its Contracts view.
export default function PropertyTabs({ corpId, propId }) {
  const cls = ({ isActive }) => `seg-btn${isActive ? ' on' : ''}`;
  return (
    <div className="seg" style={{ marginBottom: 18 }}>
      <NavLink end className={cls} to={`/leases/${corpId}/${propId}`}>Tenants</NavLink>
      <NavLink className={cls} to={`/leases/${corpId}/${propId}/contracts`}>Contracts</NavLink>
    </div>
  );
}
