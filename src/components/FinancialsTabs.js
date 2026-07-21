import { NavLink } from 'react-router-dom';
import { useFeatures } from '../lib/features';

// Financials-side tab strip (Financials | Ledger) — the same segmented control
// PropertyTabs uses on the Leases side. When the Rent-ledger module is switched
// off there's nothing to switch to, so the whole strip hides.
export default function FinancialsTabs({ corpId, propId }) {
  const { isOn } = useFeatures();
  if (!isOn('ledger')) return null;
  const cls = ({ isActive }) => `seg-btn${isActive ? ' on' : ''}`;
  return (
    <div className="seg" style={{ marginBottom: 18 }}>
      <NavLink end className={cls} to={`/financials/${corpId}/${propId}`}>Financials</NavLink>
      <NavLink className={cls} to={`/financials/${corpId}/${propId}/ledger`}>Ledger</NavLink>
    </div>
  );
}
