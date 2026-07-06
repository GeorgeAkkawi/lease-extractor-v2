import { createContext, useContext, useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase, DEMO_MODE } from '../lib/supabaseClient';

const AuthContext = createContext({ session: null, user: null, loading: true });

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  // Native (authenticator-app / TOTP) two-factor gate, driven by the session's real
  // Authenticator Assurance Level — NOT a client flag anyone could set. `needs` is
  // true when the user HAS a verified factor but the current session is still aal1,
  // so they must complete a TOTP challenge to reach aal2. Server-side RLS enforces
  // the same thing on the data itself (a bare aal1 JWT can't read the tables); this
  // state is only the UI gate that shows the challenge screen.
  const [mfa, setMfa] = useState({ loading: true, needs: false });
  // Last signed-in user id we've seen. `undefined` = first sync not done yet.
  const lastUidRef = useRef(undefined);

  const refreshAal = useCallback(async () => {
    if (DEMO_MODE) { setMfa({ loading: false, needs: false }); return; }
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      // Step-up needed only when the user could reach aal2 (has a verified factor)
      // but the current session hasn't (still aal1).
      const needs = !!data && data.nextLevel === 'aal2' && data.currentLevel !== data.nextLevel;
      setMfa({ loading: false, needs });
    } catch {
      // Fail OPEN on the UI gate — the RLS policy is the real guard, so a hiccup
      // here can't expose data, and we don't want to lock the app on a transient error.
      setMfa({ loading: false, needs: false });
    }
  }, []);

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

  // When the signed-in user changes, re-evaluate their assurance level (do they
  // have a factor, and is this session already stepped-up?).
  const uid = session?.user?.id ?? null;
  useEffect(() => {
    if (!uid) { setMfa({ loading: false, needs: false }); return; }
    setMfa((m) => ({ ...m, loading: true }));
    refreshAal();
  }, [uid, refreshAal]);

  // Called by the challenge screen after a successful TOTP verify: the session is
  // now aal2, so re-read the level and the gate drops.
  const passTwoFactor = useCallback(() => { refreshAal(); }, [refreshAal]);

  // Hold the app while we have a session but haven't yet learned the assurance level.
  const securityLoading = !!session && mfa.loading;
  const needsTwoFactor = !!session && mfa.needs;

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
