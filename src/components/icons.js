// Thin-line SVG icons drawn with currentColor (no icon library), per the design.
const base = { className: 'si-ico', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };

export const DocIcon = () => (
  <svg {...base}><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v4h4" /><path d="M9 12h6M9 16h6" /></svg>
);
export const ChartIcon = () => (
  <svg {...base}><path d="M4 20V4" /><path d="M4 20h16" /><rect x="7" y="11" width="3" height="6" /><rect x="12" y="7" width="3" height="10" /><rect x="17" y="13" width="3" height="4" /></svg>
);
export const ClockIcon = () => (
  <svg {...base}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
// Grid — the portfolio overview / dashboard.
export const GridIcon = () => (
  <svg {...base}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
);
// Building/identity mark for a corporation's business profile.
export const BuildingIcon = () => (
  <svg {...base}><path d="M4 21V5l8-3 8 3v16" /><path d="M4 21h16" /><path d="M9 9h0M15 9h0M9 13h0M15 13h0M9 17h0M15 17h0" /></svg>
);
// Notification bell.
export const BellIcon = () => (
  <svg {...base}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
);
// Sparkle — marks AI-powered affordances (assistant, search).
export const SparkIcon = () => (
  <svg {...base}><path d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7z" /><path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></svg>
);
// Shield — insurance.
export const ShieldIcon = () => (
  <svg {...base}><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /><path d="M9 12l2 2 4-4" /></svg>
);
// Chevron — collapse/expand the sidebar (rotated 180° when collapsed).
export const ChevronLeftIcon = () => (
  <svg {...base}><path d="M15 6l-6 6 6 6" /></svg>
);
// Sign out — box with an arrow leaving to the right.
export const SignOutIcon = () => (
  <svg {...base}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>
);
