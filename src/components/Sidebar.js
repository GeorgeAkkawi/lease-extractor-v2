import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, DEMO_MODE } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useChrome } from '../context/ChromeContext';
import { usePrefetchers } from '../lib/prefetch';
import { DocIcon, ChartIcon, ClockIcon, GridIcon, SlidersIcon, ChevronLeftIcon, SignOutIcon, SparkIcon } from './icons';

const COLLAPSE_KEY = 'amlak.sidebarCollapsed';

export default function Sidebar() {
  const { user } = useAuth();
  const { year } = useChrome();
  const pf = usePrefetchers();
  const queryClient = useQueryClient();
  // Collapsed = icon-only rail. Persisted so the preference survives reloads.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }

  // Drop the cached data immediately so no rows linger on screen while signing
  // out; the auth-change handler also clears, this just makes it instant.
  async function signOut() {
    queryClient.clear();
    await supabase.auth.signOut();
  }
  const navClass = ({ isActive }) => 'side-item' + (isActive ? ' active' : '');
  // Warm a destination's data on hover/focus so the page is already cached on click.
  const warm = (fn) => ({ onMouseEnter: fn, onFocus: fn });
  // When collapsed, labels are hidden — surface them as hover tooltips instead.
  const tip = (label) => (collapsed ? { title: label } : {});

  function resetDemo() {
    if (window.confirm('Reset all demo data?')) {
      try { localStorage.removeItem('amlak.dismissedAlerts'); localStorage.removeItem('amlak.snoozedAlerts'); } catch { /* ignore */ }
      window.location.reload();
    }
  }

  return (
    <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
      <div className="brand">
        <span className="brand-mark">A</span> <span className="side-label brand-text">Amlak</span>
      </div>

      <nav className="side-nav">
        <NavLink end className={navClass} to="/" {...tip('Overview')} {...warm(pf.dashboard)}><GridIcon /> <span className="side-label">Overview</span></NavLink>
        <NavLink className={navClass} to="/ask" {...tip('Ask Amlak')}><SparkIcon /> <span className="side-label">Ask Amlak</span></NavLink>
        <NavLink className={navClass} to="/leases" {...tip('Leases')} {...warm(pf.corporations)}><DocIcon /> <span className="side-label">Leases</span></NavLink>
        <NavLink className={navClass} to="/financials" {...tip('Financials')} {...warm(() => pf.corporationsFinancials(year))}><ChartIcon /> <span className="side-label">Financials</span></NavLink>
        <NavLink className={navClass} to="/history" {...tip('History')} {...warm(() => pf.corporationsFinancials(year))}><ClockIcon /> <span className="side-label">History</span></NavLink>
      </nav>

      <div className="side-foot">
        {/* Alerts + notifications live in one place: the bell in the top bar. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <NavLink to="/settings" className="reset-btn" {...tip('Settings')}>
            <SlidersIcon /> <span className="side-label">Settings</span>
          </NavLink>
          {DEMO_MODE && (
            <button className="reset-btn" onClick={resetDemo} {...tip('Reset demo data')}>
              <span className="si-ico" aria-hidden style={{ display: 'grid', placeItems: 'center' }}>↺</span> <span className="side-label">Reset demo data</span>
            </button>
          )}
          <button className="reset-btn" onClick={signOut} {...tip('Sign out')}>
            <SignOutIcon /> <span className="side-label">Sign out{user?.email ? ` · ${user.email}` : ''}</span>
          </button>
        </div>
        <button
          className="reset-btn collapse-toggle"
          onClick={toggleCollapsed}
          {...tip('Expand')}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronLeftIcon /> <span className="side-label">Collapse</span>
        </button>
      </div>
    </aside>
  );
}
