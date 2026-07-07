import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';

// Second step at login for users who have an authenticator-app (TOTP) factor.
// Shown by App.js when the session is only aal1 but a verified factor exists.
// It opens a challenge on mount; a correct 6-digit code from the authenticator app
// steps the session up to aal2 and calls passTwoFactor(), and the app renders.
export default function TwoFactorChallenge() {
  const { passTwoFactor } = useAuth();
  const [factorId, setFactorId] = useState(null);
  const [challengeId, setChallengeId] = useState(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(true);
  const startedRef = useRef(false); // StrictMode double-invoke guard

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      try {
        const { data, error } = await supabase.auth.mfa.listFactors();
        if (error) throw error;
        const totp = data?.totp?.[0]; // verified TOTP factors
        if (!totp) { passTwoFactor(); return; } // no factor to challenge → let them in
        setFactorId(totp.id);
        const { data: ch, error: cErr } = await supabase.auth.mfa.challenge({ factorId: totp.id });
        if (cErr) throw cErr;
        setChallengeId(ch.id);
      } catch {
        setMsg('Could not start verification. Sign out and try signing in again.');
      } finally {
        setPreparing(false);
      }
    })();
  }, [passTwoFactor]);

  async function verify(e) {
    e.preventDefault();
    if (!factorId || !challengeId) return;
    setBusy(true); setMsg('');
    try {
      const { error } = await supabase.auth.mfa.verify({ factorId, challengeId, code: code.trim() });
      if (error) { setMsg('Incorrect or expired code — check your authenticator app and try again.'); setCode(''); }
      else passTwoFactor();
    } catch {
      setMsg('Verification failed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <h1><span className="brand-mark" style={{ display: 'inline-grid', verticalAlign: 'middle', marginRight: 10 }}>A</span>Amlak</h1>
      <p className="muted">Two-factor verification</p>
      <p className="muted" style={{ fontSize: 13 }}>
        Open your authenticator app and enter the current 6-digit code for Amlak to continue.
      </p>
      <form onSubmit={verify}>
        <label className="form-field"><span>6-digit code</span>
          <input
            className="text-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            required
            autoFocus
            disabled={preparing || !challengeId}
          />
        </label>
        <button type="submit" disabled={busy || preparing || code.length !== 6 || !challengeId}>
          {busy ? '…' : preparing ? 'Preparing…' : 'Verify'}
        </button>
      </form>
      <p style={{ marginTop: 14 }}>
        <button type="button" className="ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </p>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
