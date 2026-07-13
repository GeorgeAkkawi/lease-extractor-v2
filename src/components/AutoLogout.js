import { useEffect, useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase, DEMO_MODE } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { getAutoLogoutMinutes } from '../lib/api';
import { idlePhase, secondsUntilLogout, resolveMinutes, WARN_SECONDS } from '../lib/idleLogout';
import { useModalA11y } from './modalA11y';

// Auto sign-out after a period of inactivity (configurable in Settings → Security).
// Signs the user out of THIS browser once idle past their chosen window, after a
// 60-second warning that lets them stay. Activity is tracked in localStorage so it
// counts across all open tabs (multi-tab safe). Inert in demo, when signed out, or
// when the setting is Off.
const ACTIVITY_KEY = 'amlak:lastActivity';
const WRITE_THROTTLE_MS = 10000; // stamp at most ~once / 10s
const TICK_MS = 15000;           // check the phase every 15s

function readLastActivity() {
  try {
    const v = Number(localStorage.getItem(ACTIVITY_KEY));
    return Number.isFinite(v) && v > 0 ? v : Date.now();
  } catch {
    return Date.now();
  }
}
function writeLastActivity(ts) {
  try { localStorage.setItem(ACTIVITY_KEY, String(ts)); } catch { /* storage blocked — ignore */ }
}

export default function AutoLogout() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const [warnUntil, setWarnUntil] = useState(null); // sign-out timestamp while warning; null when not warning
  const [remaining, setRemaining] = useState(WARN_SECONDS);
  const signingOut = useRef(false);

  // The user's chosen idle window. Only read when actually signed in (live mode).
  const { data: pref } = useQuery({
    queryKey: ['autoLogout'],
    queryFn: getAutoLogoutMinutes,
    enabled: !DEMO_MODE && !!session,
    staleTime: 5 * 60 * 1000,
  });

  const minutes = resolveMinutes(pref);
  const active = !DEMO_MODE && !!session && minutes > 0;

  const doSignOut = useCallback(async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    try { qc.clear(); } catch { /* ignore */ }
    try { await supabase.auth.signOut(); } catch { /* onAuthStateChange will still route to login */ }
  }, [qc]);

  // Record activity (throttled) and, if a warning is showing, dismiss it. Runs in
  // every tab; the localStorage write is what makes cross-tab activity count.
  useEffect(() => {
    if (!active) return undefined;
    // Seed an initial stamp so a freshly-loaded tab doesn't inherit a stale one.
    if (!localStorage.getItem(ACTIVITY_KEY)) writeLastActivity(Date.now());
    let lastWrite = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastWrite >= WRITE_THROTTLE_MS) { writeLastActivity(now); lastWrite = now; }
      // Any real interaction while warning = "stay signed in".
      setWarnUntil((w) => (w ? null : w));
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, onActivity));
  }, [active]);

  // Poll the idle phase on an interval; also re-evaluate when the warning opens so
  // the countdown starts immediately.
  useEffect(() => {
    if (!active) { setWarnUntil(null); return undefined; }
    const check = () => {
      const last = readLastActivity();
      const now = Date.now();
      const phase = idlePhase(last, now, minutes);
      if (phase === 'expired') { setWarnUntil(null); doSignOut(); return; }
      if (phase === 'warn') {
        setWarnUntil(last + minutes * 60 * 1000);
        setRemaining(secondsUntilLogout(last, now, minutes));
      } else {
        setWarnUntil(null);
      }
    };
    check();
    const id = setInterval(check, TICK_MS);
    return () => clearInterval(id);
  }, [active, minutes, doSignOut]);

  // While the warning is up, tick the countdown every second (and sign out at 0
  // without waiting for the slower poll).
  useEffect(() => {
    if (!warnUntil) return undefined;
    const id = setInterval(() => {
      const secs = Math.max(0, Math.round((warnUntil - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0) { setWarnUntil(null); doSignOut(); }
    }, 1000);
    return () => clearInterval(id);
  }, [warnUntil, doSignOut]);

  const stay = useCallback(() => {
    writeLastActivity(Date.now());
    setWarnUntil(null);
  }, []);

  const modalRef = useModalA11y(stay, !!warnUntil);
  if (!warnUntil) return null;

  return (
    <div className="modal-scrim" onClick={stay}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" aria-label="Session about to expire" tabIndex={-1} style={{ width: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><strong>Still there?</strong></div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>
            You’ll be signed out in <strong>{remaining}s</strong> for your security, since there’s been no activity.
          </p>
        </div>
        <div className="modal-foot">
          <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="ghost" onClick={doSignOut}>Sign out now</button>
            <button type="button" onClick={stay} autoFocus>Stay signed in</button>
          </div>
        </div>
      </div>
    </div>
  );
}
