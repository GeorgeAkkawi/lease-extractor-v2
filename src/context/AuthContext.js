import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { getSecuritySettings } from '../lib/api';

const AuthContext = createContext({ session: null, user: null, loading: true });

// Per-browser-session marker that the second factor was cleared, so a refresh in
// the same tab doesn't re-challenge. Cleared when the tab closes (sessionStorage).
const twoFaKey = (uid) => `amlak.2fa_ok.${uid}`;

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [twoFaEnabled, setTwoFaEnabled] = useState(null); // null = not yet known
  const [twoFaPassed, setTwoFaPassed] = useState(false);
  // Last signed-in user id we've seen. `undefined` = first sync not done yet.
  const lastUidRef = useRef(undefined);

  useEffect(() => {
    // Whenever the signed-in user actually changes (login, logout, or switching
    // accounts), wipe the in-memory query cache. Without this the previous
    // account's data — which is kept warm with gcTime: Infinity — stays cached
    // and shows up under the next account until a hard refresh. Same-user token
    // refreshes keep the same id, so they don't clear the cache (no reload flash).
    const syncUser = (s) => {
      const uid = s?.user?.id ?? null;
      if (lastUidRef.current !== undefined && lastUidRef.current !== uid) {
        queryClient.clear();
      }
      lastUidRef.current = uid;
      setSession(s);
    };

    supabase.auth.getSession().then(({ data }) => {
      syncUser(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      syncUser(s);
    });
    return () => sub.subscription.unsubscribe();
  }, [queryClient]);

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
