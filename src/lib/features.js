import { useQuery } from '@tanstack/react-query';
import { getEnabledFeatures } from './api';

// The optional feature modules a landlord can switch on or off. Same
// { key, label, hint } shape as src/lib/dashboardWidgets.js. Always-on core
// (leases, financials, history) is deliberately NOT listed here — it can't be
// turned off. As new modules ship (expenses, maintenance, deposits, paper-trail)
// each one appends a single entry to this list and the switchboard picks it up
// everywhere: the onboarding picker, the Settings "Features" toggles, and the
// useFeatures() guards on its own UI.
export const FEATURES = [
  { key: 'insurance', label: 'Insurance vault',    hint: 'Store landlord and tenant policies, track expiry, and request certificates.' },
  { key: 'contracts', label: 'Service contracts',  hint: 'Landscaping, snow removal, security and other standing service agreements.' },
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
