import { NavLink } from 'react-router-dom';
import { supabase, DEMO_MODE } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useChrome } from '../context/ChromeContext';
import { usePrefetchers } from '../lib/prefetch';
import { DocIcon, ChartIcon, ClockIcon, GridIcon, ShieldIcon } from './icons';

export default function Sidebar() {
  const { user } = useAuth();
  const { year } = useChrome();
  const pf = usePrefetchers();
  const navClass = ({ isActive }) => 'side-item' + (isActive ? ' active' : '');
  // Warm a destination's data on hover/focus so the page is already cached on click.
  const warm = (fn) => ({ onMouseEnter: fn, onFocus: fn });

  function resetDemo() {
    if (window.confirm('Reset all demo data?')) {
      try { localStorage.removeItem('amlak.dismissedAlerts'); localStorage.removeItem('amlak.snoozedAlerts'); } catch { /* ignore */ }
      window.location.reload();
    }
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">A</span> Amlak
      </div>

      <nav className="side-nav">
        <NavLink end className={navClass} to="/" {...warm(pf.dashboard)}><GridIcon /> Overview</NavLink>
        <NavLink className={navClass} to="/leases" {...warm(pf.corporations)}><DocIcon /> Leases</NavLink>
        <NavLink className={navClass} to="/financials" {...warm(() => pf.corporationsFinancials(year))}><ChartIcon /> Financials</NavLink>
        <NavLink className={navClass} to="/history" {...warm(() => pf.corporationsFinancials(year))}><ClockIcon /> History</NavLink>
      </nav>

      <div className="side-foot">
        {/* Alerts + notifications live in one place: the bell in the top bar. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <NavLink to="/security" className="reset-btn" style={{ textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
            <ShieldIcon /> Security &amp; 2FA
          </NavLink>
          {DEMO_MODE && (
            <button className="reset-btn" onClick={resetDemo}>↺ Reset demo data</button>
          )}
          <button className="reset-btn" onClick={() => supabase.auth.signOut()}>
            Sign out{user?.email ? ` · ${user.email}` : ''}
          </button>
        </div>
      </div>
    </aside>
  );
}
