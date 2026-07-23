import { useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, DEMO_MODE } from '../lib/supabaseClient';
import { listCorporations, listPropertiesByCorps } from '../lib/api';
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
  // Corporations + their properties, for the hover fly-out that jumps straight into
  // one. Shares the exact ['corporations'] / ['corpProperties', ids] keys the
  // Corporations grid warms, so this is usually a cache hit — no extra round-trip.
  const { data: corps = [] } = useQuery({ queryKey: ['corporations'], queryFn: listCorporations, enabled: !!user });
  const corpIds = corps.map((c) => c.id);
  const { data: corpProps = {} } = useQuery({
    queryKey: ['corpProperties', corpIds.join(',')],
    queryFn: () => listPropertiesByCorps(corpIds),
    enabled: corps.length > 0,
  });
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

  // A workspace nav item (Portfolio / Financials / History) that reveals a fly-out on
  // hover/focus: each corporation, its properties nested underneath, every one a direct
  // link into that page for the corp/property — so a whole account is one hover away
  // (works from the collapsed icon rail too, where it doubles as a menu).
  const NavFlyout = ({ to, mode, label, icon, extra }) => (
    <span className="side-item-wrap">
      <NavLink className={navClass} to={to} {...tip(label)} {...(extra || {})}>
        {icon} <span className="side-label">{label}</span>
      </NavLink>
      {corps.length > 0 && (
        <div className="side-flyout" role="menu" aria-label={`Jump to a ${label.toLowerCase()} page`}>
          {corps.map((c) => (
            <div className="side-flyout-corp" key={c.id}>
              <Link className="side-flyout-head" role="menuitem" to={`/${mode}/${c.id}`}>{c.name}</Link>
              {(corpProps[c.id] || []).map((p) => (
                <Link className="side-flyout-item" role="menuitem" key={p.id} to={`/${mode}/${c.id}/${p.id}`}>{p.name}</Link>
              ))}
            </div>
          ))}
        </div>
      )}
    </span>
  );

  return (
    <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
      <div className="brand">
        <span className="brand-mark">A</span> <span className="side-label brand-text">Amlak</span>
      </div>

      <nav className="side-nav">
        <NavLink end className={navClass} to="/" {...tip('Overview')} {...warm(pf.dashboard)}><GridIcon /> <span className="side-label">Overview</span></NavLink>
        <NavLink className={navClass} to="/ask" {...tip('Ask Amlak')}><SparkIcon /> <span className="side-label">Ask Amlak</span></NavLink>
        <NavFlyout to="/leases" mode="leases" label="Portfolio" icon={<DocIcon />} extra={warm(pf.corporations)} />
        <NavFlyout to="/financials" mode="financials" label="Financials" icon={<ChartIcon />} extra={warm(() => pf.corporationsFinancials(year))} />
        <NavFlyout to="/history" mode="history" label="History" icon={<ClockIcon />} extra={warm(() => pf.corporationsFinancials(year))} />
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
