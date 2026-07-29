// The Overview (dashboard) widgets a landlord can show or hide, in display order.
// Keys are the stable identifiers stored in user_preferences.hidden_widgets; the
// labels/hints drive the toggles on the Display settings page. Keep this list in
// sync with the render blocks in src/pages/DashboardPage.js — the key on each
// block must match a key here.
//
// The three metric cards that used to head this list (rent roll / occupancy / expiring)
// were retired when the chart band took over the top of the Overview — every figure they
// carried is now said better below them: the rent roll in the donut's centre, occupancy as
// the "Space leased" headline and the page-head subtitle, and the expiring count as the
// expirations table itself. A key still sitting in someone's saved hidden_widgets array is
// inert; show() simply stops asking about it.
export const DASHBOARD_WIDGETS = [
  { key: 'portfolio_charts', label: 'Portfolio charts',     hint: 'Where the rent comes from, how much space is leased, when leases come up for renewal, and what each property keeps.' },
  { key: 'expirations', label: 'Lease expirations table',   hint: 'The list of leases ending in the next 6 months.' },
  { key: 'alerts',      label: 'Alerts & notifications',    hint: 'Reminders, renewal prompts, and key-date alerts.' },
];

// Panels on the lease page and property Financials page a landlord can hide. Same
// per-account store as DASHBOARD_WIDGETS (user_preferences.hidden_widgets) — each key
// gates a panel via `!hidden.includes(key)`. Keep keys in sync with the render blocks
// in LeaseDetailPage.js and PropertyFinancialsPage.js.
export const PAGE_PANELS = [
  { key: 'lease_receivables',  label: 'Invoices & payments (lease page)',  hint: 'The invoices & payments panel on each tenant’s lease page.' },
  { key: 'lease_review',       label: 'Lease review (lease page)',         hint: 'The red-flag panel on each lease — missing protections and terms that could hurt you.' },
];
