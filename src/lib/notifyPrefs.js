// How far ahead the landlord is notified for each kind of event — pure, leaf module
// (no react-query), so alerts.js and the Settings page share ONE source of truth.
//
// Every notification the app raises has an entry in NOTIFY_TYPES with a DEFAULT lead
// that exactly matches today's hard-coded behavior, so an account that never opens
// Settings sees identical alerts. The landlord can override any lead with a freeform
// value ("3 months" / "90 days" / "1 year") that parseLeadTime turns into days; a
// per-lease override (lease-ending only) is handled at the call site.
//
//   kind 'before' — days BEFORE the event (a lease ends, an insurance policy expires).
//   kind 'after'  — days AFTER the trigger (a certificate was requested, or rent came
//                   due) before the app nudges. Same freeform input; different meaning.

export const NOTIFY_TYPES = [
  { key: 'lease_end',       label: 'Lease ending',          defaultDays: 183, kind: 'before',
    hint: 'A lease term approaching its end date. Also has a per-lease override in the lease’s Term panel.' },
  { key: 'renewal',         label: 'Upcoming renewal option', defaultDays: 183, kind: 'before',
    hint: 'A renewal option’s notice deadline is approaching.' },
  { key: 'escalation',      label: 'Rent escalation',       defaultDays: 183, kind: 'before',
    hint: 'A scheduled rent step-up is coming due.' },
  { key: 'insurance',       label: 'Insurance expiring',    defaultDays: 183, kind: 'before',
    hint: 'A landlord or tenant insurance policy nearing its expiry date.' },
  { key: 'contract',        label: 'Service contract ending', defaultDays: 183, kind: 'before',
    hint: 'A service contract approaching its end date.' },
  { key: 'annual_report',   label: 'Annual report filing',  defaultDays: 31,  kind: 'before',
    hint: 'A corporation’s annual report filing deadline.' },
  { key: 'abatement',       label: 'Free rent ending',      defaultDays: 31,  kind: 'before',
    hint: 'A free / reduced-rent period about to end and full billing resume.' },
  { key: 'insurance_chase', label: 'Insurance not received', defaultDays: 21,  kind: 'after',
    hint: 'A certificate was requested this many days ago and still hasn’t arrived.' },
  { key: 'unpaid_rent',     label: 'Tenant behind on rent', defaultDays: 7,   kind: 'after',
    hint: 'Grace period after a rent month comes due before flagging it unpaid.' },
];

// { key: defaultDays } — the neutral fallback used when the owner hasn't set a lead.
export const DEFAULT_LEAD_DAYS = Object.fromEntries(NOTIFY_TYPES.map((t) => [t.key, t.defaultDays]));

const NOTIFY_BY_KEY = Object.fromEntries(NOTIFY_TYPES.map((t) => [t.key, t]));

// A rough calendar-month length so "3 months" reads as ~91 days, not 90. Months and
// years are approximated (the app's leads are heads-up windows, not exact dates).
const DAYS_PER_MONTH = 30.44;
const DAYS_PER_YEAR = 365;

// Parse a freeform lead into whole days, or null when it can't be understood.
//   "90" / "90 days" / "90d" → 90 · "3 months" / "3mo" → 91 · "2 weeks" / "2w" → 14
//   "1 year" / "1yr" → 365 · "" / "soon" / "-5" → null
export function parseLeadTime(input) {
  if (input == null) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!(n > 0)) return null;
  const unit = m[2];
  let days;
  if (unit === '' || unit === 'd' || unit.startsWith('day')) days = n;
  else if (unit === 'w' || unit.startsWith('wk') || unit.startsWith('week')) days = n * 7;
  else if (unit === 'mo' || unit === 'm' || unit.startsWith('month') || unit.startsWith('mon')) days = n * DAYS_PER_MONTH;
  else if (unit === 'y' || unit === 'yr' || unit.startsWith('year')) days = n * DAYS_PER_YEAR;
  else return null;
  return Math.max(1, Math.round(days));
}

// Days → a friendly label for the Settings row and computed alert bucket. Prefers the
// largest whole unit that divides cleanly, else rounds to the nearest sensible unit.
export function formatLeadDays(days) {
  const d = Math.round(Number(days) || 0);
  if (d <= 0) return '0 days';
  if (d % DAYS_PER_YEAR === 0 || d === 365) return plural(d / 365, 'year');
  if (d >= 60 && Math.abs(d - Math.round(d / DAYS_PER_MONTH) * DAYS_PER_MONTH) < 2) {
    return plural(Math.round(d / DAYS_PER_MONTH), 'month');
  }
  if (d % 7 === 0 && d <= 56) return plural(d / 7, 'week');
  if (d >= 350 && d <= 380) return '1 year';
  if (d >= 27 && d <= 32) return '1 month';
  return plural(d, 'day');
}

function plural(n, unit) {
  const r = Math.round(n);
  return `${r} ${unit}${r === 1 ? '' : 's'}`;
}

// The resolved lead (in days) for a type: the owner's saved value when set, else the
// default. `prefs` is the notify_lead_times map ({ key: days } or {}/null).
export function leadDaysFor(prefs, key) {
  const v = prefs?.[key];
  if (typeof v === 'number' && v > 0) return v;
  return NOTIFY_BY_KEY[key]?.defaultDays ?? null;
}

// The full resolved map (every type → days), for handing to buildAlerts.
export function resolveLeadDays(prefs) {
  return Object.fromEntries(NOTIFY_TYPES.map((t) => [t.key, leadDaysFor(prefs, t.key)]));
}
