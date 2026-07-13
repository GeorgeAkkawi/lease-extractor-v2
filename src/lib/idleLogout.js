// Pure helpers for the auto sign-out feature. No DOM, no timers — just the timing
// math, so it's fully unit-testable. The component (AutoLogout.js) supplies the
// clock and does the signing-out; this file only decides which phase we're in.

// App default when the user has never chosen (pref is null).
export const DEFAULT_MINUTES = 30;
// How long the "you're about to be signed out" warning shows before sign-out.
export const WARN_SECONDS = 60;

// The Settings picker options. `null` renders as the default (30). `0` = off.
export const AUTO_LOGOUT_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
];

// Resolve a stored preference to effective minutes: null/undefined → the default,
// otherwise the stored number (0 = off).
export function resolveMinutes(pref) {
  return pref == null ? DEFAULT_MINUTES : Number(pref);
}

// Which phase the session is in, given the last activity time, "now", and the
// effective idle-minutes setting:
//   • 'active'  — still within the idle window (or auto-logout is off).
//   • 'warn'    — within the final WARN_SECONDS before the cutoff; show the warning.
//   • 'expired' — past the cutoff; sign out.
// `minutes = 0` (off) is always 'active'. `minutes = null` is treated as the
// default so a caller that forgets to resolve first still behaves sanely.
export function idlePhase(lastActivityMs, nowMs, minutes) {
  const mins = resolveMinutes(minutes);
  if (!mins || mins <= 0) return 'active'; // off
  const idleMs = Math.max(0, nowMs - lastActivityMs);
  const cutoffMs = mins * 60 * 1000;
  if (idleMs >= cutoffMs) return 'expired';
  if (idleMs >= cutoffMs - WARN_SECONDS * 1000) return 'warn';
  return 'active';
}

// The activity timestamp to adopt when the auto sign-out watcher (re)starts — on sign-in
// or a page load, both of which ARE themselves user activity. localStorage survives a
// sign-out, so a returning user can carry a STALE stamp from a previous session; adopting
// it unchanged signs them out the instant they sign back in (the very first idle check
// reads the old time as long-expired). Rule: KEEP a recent stored stamp (so genuine
// cross-tab activity still counts), but fall back to `nowMs` when the stamp is missing,
// unparseable, in the future, or already past the idle window.
export function initialActivityStamp(storedMs, nowMs, minutes) {
  const mins = resolveMinutes(minutes);
  if (!Number.isFinite(storedMs) || storedMs <= 0) return nowMs; // missing / invalid
  if (storedMs > nowMs) return nowMs;                            // clock skew / future stamp
  if (mins > 0 && nowMs - storedMs >= mins * 60 * 1000) return nowMs; // stale leftover
  return storedMs;                                               // recent — keep it
}

// Seconds remaining before sign-out (for the live countdown in the warning modal).
// Clamped to [0, WARN_SECONDS].
export function secondsUntilLogout(lastActivityMs, nowMs, minutes) {
  const mins = resolveMinutes(minutes);
  if (!mins || mins <= 0) return WARN_SECONDS;
  const cutoffMs = lastActivityMs + mins * 60 * 1000;
  return Math.max(0, Math.min(WARN_SECONDS, Math.round((cutoffMs - nowMs) / 1000)));
}
