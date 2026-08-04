import { useQuery } from '@tanstack/react-query';
import { getEnabledFeatures } from './api';

// The optional feature modules a landlord can switch on or off. Same
// { key, label, hint } shape as src/lib/dashboardWidgets.js. Always-on core
// (leases, financials, history) is deliberately NOT listed here — it can't be
// turned off. As new modules ship (expenses, maintenance, deposits, paper-trail)
// each one appends a single entry to this list and the switchboard picks it up
// everywhere: the onboarding picker, the Settings "Features" toggles, and the
// useFeatures() guards on its own UI.
//
// ⚠ APPENDING AN ENTRY HERE IS NOT ENOUGH — IT SHIPS OFF FOR EXISTING ACCOUNTS.
// isFeatureOn (below) reads a stored null as "everything on" but a stored ARRAY as
// "exactly this set", and every account that has ever touched the Settings toggles has an
// array. A key appended here is therefore MISSING from that array, which reads as OFF —
// silently, with no way to discover the module except stumbling on its own toggle. That is
// exactly what happened to `announcements` on 2026-08-04: shipped, deployed, verified in
// the demo (which seeds no preferences row, so null ⇒ on) and invisible in production.
//
// Absence in the array means EITHER "turned off" OR "didn't exist yet" and the data cannot
// distinguish them, so this can't be solved once in code. **Every new entry must ship with
// a backfill migration** — copy `supabase/migrations/0084_backfill_announcements_feature.sql`
// and change the key. See CLAUDE.md §4.
export const FEATURES = [
  { key: 'insurance', label: 'Insurance vault',    hint: 'Store landlord and tenant policies, track expiry, and request certificates. Turning this off also silences its dashboard reminders and emails.' },
  { key: 'contracts', label: 'Service contracts',  hint: 'Landscaping, snow removal, security and other standing service agreements. Turning this off also silences its dashboard reminders and emails.' },
  { key: 'ledger',    label: 'Rent ledger',        hint: 'Per-tenant monthly collections: projected vs actually collected, month by month, with bank-statement import. Turning this off hides the Ledger tab and the collected/owes column on Financials.' },
  { key: 'announcements', label: 'Tenant announcements', hint: 'Write one notice — resurfacing, holiday hours, a new manager — and email it to every tenant of a property at once. Turning this off hides the Announcements button on the property cards.' },
  { key: 'esign', label: 'E-signature', hint: 'Send a lease, extension or amendment to a tenant to sign electronically, then countersign it yourself — Amlak builds the signed PDF with a certificate of completion. Turning this off hides the signature controls in Addendums & riders; documents already signed stay on file.' },
];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);

// The one source of truth for "is this module on?". A brand-new / skipped account
// stores null, which means "never chosen" — treat everything as on until the user
// decides. An array is the explicit chosen set. Undefined (still loading) also
// reads as on, so nothing flash-hides before preferences arrive (null == undefined).
export function isFeatureOn(enabled, key) {
  return enabled == null ? true : enabled.includes(key);
}

// Toggling a feature the first time on a never-chosen (null) account must
// materialize the full set first, so removing one leaves the rest explicitly on.
// Returns the next enabled array.
export function toggleFeature(enabled, key) {
  const base = enabled == null ? [...FEATURE_KEYS] : [...enabled];
  return base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
}

// Read the enabled set once (React Query dedupes across every caller) and expose
// a simple isOn(key) guard. `enabled` is null when never chosen, undefined while
// loading — both read as "everything on" via isFeatureOn.
export function useFeatures() {
  const { data: enabled, isLoading } = useQuery({
    queryKey: ['enabledFeatures'],
    queryFn: getEnabledFeatures,
  });
  return {
    enabled,
    loading: isLoading,
    isOn: (key) => isFeatureOn(enabled, key),
  };
}
