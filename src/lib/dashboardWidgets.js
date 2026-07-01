// The Overview (dashboard) widgets a landlord can show or hide, in display order.
// Keys are the stable identifiers stored in user_preferences.hidden_widgets; the
// labels/hints drive the toggles on the Display settings page. Keep this list in
// sync with the render blocks in src/pages/DashboardPage.js — the key on each
// block must match a key here.
export const DASHBOARD_WIDGETS = [
  { key: 'rent_roll',   label: 'Annual rent roll',          hint: 'Total yearly rent across all your active leases.' },
  { key: 'ar',          label: 'Outstanding (receivables)', hint: 'What tenants still owe you, and how much is overdue.' },
  { key: 'occupancy',   label: 'Occupancy',                 hint: 'How much of your space is leased versus vacant.' },
  { key: 'expiring',    label: 'Expiring ≤ 90 days',        hint: 'A count of leases ending within the next 90 days.' },
  { key: 'expirations', label: 'Lease expirations table',   hint: 'The list of leases ending in the next 90 days.' },
  { key: 'alerts',      label: 'Alerts & notifications',    hint: 'Reminders, renewal prompts, and key-date alerts.' },
];
