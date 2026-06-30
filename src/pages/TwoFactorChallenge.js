import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { sendTwoFactorCode, verifyTwoFactorCode } from '../lib/api';

// Second step at login for users who have email 2FA on. Shown by App.js when a
// session exists but the second factor hasn't been cleared this browser session.
// Sends a code on mount; on a correct code it calls passTwoFactor() and the app
// renders.
export default function TwoFactorChallenge() {
  const { user, passTwoFactor } = useAuth();
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(true);
  const sentOnce = useRef(false);

  useEffect(() => {
    if (sentOnce.current) return; // StrictMode double-invoke guard
    sentOnce.current = true;
    sendTwoFactorCode()
      .then(() => setSending(false))
      .catch(() => { setSending(false); setMsg('Could not send a code. Use Resend below.'); });
  }, []);

  async function verify(e) {
    e.preventDefault();
    setBusy(true); setMsg('');
    try {
      const r = await verifyTwoFactorCode(code.trim(), 'login');
      if (r?.verified) { passTwoFactor(); return; }
      setMsg(r?.error || 'Incorrect code.');
    } catch (err) {
      setMsg(err.message || 'Verification failed.');
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setMsg(''); setSending(true);
    try { await sendTwoFactorCode(); setMsg('A new code is on its way.'); }
    catch { setMsg('Could not send a code. Try again in a moment.'); }
    finally { setSending(false); }
  }

  return (
    <div className="login-wrap">
      <h1><span className="brand-mark" style={{ display: 'inline-grid', verticalAlign: 'middle', marginRight: 10 }}>A</span>Amlak</h1>
      <p className="muted">Two-factor verification</p>
      <p className="muted" style={{ fontSize: 13 }}>
        We emailed a 6-digit code to {user?.email ? <strong>{user.email}</strong> : 'your address'}. Enter it to continue.
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
          />
        </label>
        <button type="submit" disabled={busy || code.length !== 6}>{busy ? '…' : 'Verify'}</button>
      </form>
      <p style={{ marginTop: 14, display: 'flex', gap: 14 }}>
        <button type="button" className="ghost" onClick={resend} disabled={sending}>Resend code</button>
        <button type="button" className="ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </p>
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
