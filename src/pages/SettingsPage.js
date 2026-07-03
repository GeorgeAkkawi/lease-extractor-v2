import { NavLink, Outlet } from 'react-router-dom';
import { SlidersIcon, ShieldIcon } from '../components/icons';

// Settings hub: a slim list of sections down the left, the chosen section's
// content on the right (via <Outlet/>). "Display & features" is first and is the
// default (the index route redirects here). New settings sections are added by
// dropping another NavLink below and a nested route in App.js — the layout
// scales without changing shape. The breadcrumb is set by each child section so
// it reads "Settings › …".
const sectionClass = ({ isActive }) => 'side-item' + (isActive ? ' active' : '');

export default function SettingsPage() {
  return (
    <div className="settings-layout" style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <nav className="settings-rail" style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 210 }}>
        <NavLink className={sectionClass} to="/settings/display">
          <SlidersIcon /> <span>Display &amp; features</span>
        </NavLink>
        <NavLink className={sectionClass} to="/settings/security">
          <ShieldIcon /> <span>Security &amp; 2FA</span>
        </NavLink>
      </nav>
      <div className="settings-content" style={{ flex: 1, minWidth: 0 }}>
        <Outlet />
      </div>
    </div>
  );
}
