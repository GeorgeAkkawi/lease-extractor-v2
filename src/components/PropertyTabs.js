import { NavLink } from 'react-router-dom';
import { useFeatures } from '../lib/features';

// Property-level tab strip (Tenants | Contracts), reusing the segmented-control
// styling. Shown on the property's Leases view and its Contracts view. When the
// Contracts module is switched off there's nothing to switch to, so the whole
// strip hides.
export default function PropertyTabs({ corpId, propId }) {
  const { isOn } = useFeatures();
  if (!isOn('contracts')) return null;
  const cls = ({ isActive }) => `seg-btn${isActive ? ' on' : ''}`;
  return (
    <div className="seg" style={{ marginBottom: 18 }}>
      <NavLink end className={cls} to={`/leases/${corpId}/${propId}`}>Tenants</NavLink>
      <NavLink className={cls} to={`/leases/${corpId}/${propId}/contracts`}>Contracts</NavLink>
    </div>
  );
}
