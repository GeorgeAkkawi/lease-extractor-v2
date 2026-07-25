import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { passwordProblem } from './Login';
import BrandMark from '../components/BrandMark';

const MIN_PASSWORD = 10;

// Shown when the user arrives from a password-reset link (the app catches the
// PASSWORD_RECOVERY auth event and renders this in place of the whole app). Branded
// like the sign-in screen. Sets the new password, then signs out EVERY session
// (per George's spec — a reset should invalidate anything already signed in) and
// returns to the login screen.
export default function ResetPasswordPage() {
  const { finishPasswordRecovery } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setMsg('');
    const problem = passwordProblem(password);
    if (problem) { setMsg(problem); return; }
    if (password !== confirm) { setMsg('The two passwords don’t match.'); return; }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setDone(true);
    } catch (err) {
      setMsg(err?.message || 'Could not update the password — the reset link may have expired. Request a new one from the sign-in screen.');
    } finally {
      setBusy(false);
    }
  }

  // Sign every session out and return to login. Global scope so any device already
  // signed in with the old password is logged out too.
  async function backToSignIn() {
    setBusy(true);
    try { await supabase.auth.signOut({ scope: 'global' }); } catch { /* ignore */ }
    finishPasswordRecovery();
  }

  return (
    <div className="login-wrap">
      <h1><span className="brand-mark" style={{ display: 'inline-grid', verticalAlign: 'middle', marginRight: 10 }}><BrandMark /></span>Amlak</h1>
      {done ? (
        <>
          <p className="muted">Your password has been changed. For your security, you’ve been signed out everywhere — sign in with the new password.</p>
          <button type="button" onClick={backToSignIn} disabled={busy}>{busy ? '…' : 'Continue to sign in'}</button>
        </>
      ) : (
        <>
          <p className="muted">Set a new password for your account.</p>
          <form onSubmit={submit}>
            <label className="form-field"><span>New password</span>
              <input
                className="text-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={MIN_PASSWORD}
                autoComplete="new-password"
                autoFocus
              />
            </label>
            <label className="form-field"><span>Confirm new password</span>
              <input
                className="text-input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={MIN_PASSWORD}
                autoComplete="new-password"
              />
            </label>
            <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              At least {MIN_PASSWORD} characters, with upper- and lower-case letters and a number.
            </p>
            <button type="submit" disabled={busy}>{busy ? '…' : 'Change password'}</button>
          </form>
        </>
      )}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
