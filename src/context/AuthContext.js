import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { getSecuritySettings } from '../lib/api';

const AuthContext = createContext({ session: null, user: null, loading: true });

// Per-browser-session marker that the second factor was cleared, so a refresh in
// the same tab doesn't re-challenge. Cleared when the tab closes (sessionStorage).
const twoFaKey = (uid) => `amlak.2fa_ok.${uid}`;

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [twoFaEnabled, setTwoFaEnabled] = useState(null); // null = not yet known
  const [twoFaPassed, setTwoFaPassed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // When the signed-in user changes, learn their 2FA preference and whether this
  // browser session already cleared the second factor.
  const uid = session?.user?.id ?? null;
  useEffect(() => {
    if (!uid) { setTwoFaEnabled(null); setTwoFaPassed(false); return; }
    let cancelled = false;
    setTwoFaEnabled(null);
    let passed = false;
    try { passed = sessionStorage.getItem(twoFaKey(uid)) === '1'; } catch { /* ignore */ }
    setTwoFaPassed(passed);
    getSecuritySettings().then((s) => { if (!cancelled) setTwoFaEnabled(!!s.email_2fa_enabled); });
    return () => { cancelled = true; };
  }, [uid]);

  const passTwoFactor = useCallback(() => {
    if (uid) { try { sessionStorage.setItem(twoFaKey(uid), '1'); } catch { /* ignore */ } }
    setTwoFaPassed(true);
  }, [uid]);

  // Hold the app while we have a session but haven't yet learned the 2FA setting.
  const securityLoading = !!session && twoFaEnabled === null;
  const needsTwoFactor = !!session && twoFaEnabled === true && !twoFaPassed;

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    securityLoading,
    needsTwoFactor,
    passTwoFactor,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
