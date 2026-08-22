import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import BrandMark from '../components/BrandMark';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD = 10;

// Private beta: public self-service sign-up is closed — only accounts created in
// Supabase can sign in. This hides the "Sign up" option; the real enforcement is
// server-side (Supabase enable_signup=false + the user-cap trigger in
// migration 0031). Flip to true (and re-enable both server controls) to reopen
// public registration when going public.
const SIGNUP_OPEN = false;

// Mirror the server-side policy so users get instant, specific feedback instead of a
// generic server rejection. Exported so the reset-password page enforces the same rule.
//
// ⚠ THE MIRROR WAS BROKEN ON BOTH HALVES UNTIL 2026-08-21, and config.toml is not the
// thing to check. config.toml drives LOCAL DEV ONLY (SECURITY.md says so); the live
// project is configured in the dashboard and had drifted from it in two directions at
// once: `password_min_length` was **6** while this file said 10, and
// `password_required_characters` was the symbols preset while this file checks only
// lower/upper/digit. Both are now aligned — the server minimum was raised to 10, and the
// character requirement set to the three-group preset this function actually mirrors:
//     abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789
//
// ⚠ THERE IS NO SAFE SYMBOL OPTION TO MIRROR, which is why symbols are not required.
// Supabase accepts only four preset values and the sole one with symbols is
//     ...:0123456789:!@#$%^&*()_+-=[]{};'\:"|<>?,./`~
// whose symbol set CONTAINS A COLON — the very delimiter of the field — so it parses
// into FIVE groups, not four, and appears to demand a character from `!@#$…;'\` AND
// another from `"|<>?,./`~` separately. `Abcdefgh1!` would satisfy the first and fail the
// second. Custom values are rejected (400: "Invalid option"). So the choice was an
// unmirrorable requirement or none; none, with a 10-character minimum, is the honest one.
// If Supabase ever ships a clean symbols preset, add the class HERE in the same change.
export function passwordProblem(pw) {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (!/[a-z]/.test(pw)) return 'Include a lowercase letter.';
  if (!/[A-Z]/.test(pw)) return 'Include an uppercase letter.';
  if (!/[0-9]/.test(pw)) return 'Include a number.';
  return null;
}

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState('signin');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  // "Forgot your password?" — send the account a recovery link. The link brings the
  // user back into the app with a recovery session, which the app catches (the
  // PASSWORD_RECOVERY auth event) and shows the reset page. Works signed-out — a
  // locked-out user can't reach Settings. Always reports "sent" (never reveals whether
  // an address has an account).
  async function sendReset() {
    const cleanEmail = email.trim();
    if (!EMAIL_RE.test(cleanEmail)) { setMsg('Enter your email above first, then tap “Forgot your password?”.'); return; }
    setBusy(true); setMsg('');
    try {
      // ⚠ DESTRUCTURE THE ERROR. The catch below is unreachable for every realistic failure:
      // supabase-js wraps the POST and RETURNS `{ data: null, error }` for anything carrying
      // the auth-error marker, which includes the 60-second per-email throttle, the project's
      // hourly email cap, a 5xx and an offline browser. Discarding it meant a locked-out
      // client read a confident "on its way" for a mail that was never sent, waited, checked
      // spam, and concluded Amlak's email was broken. The two sign-in calls below have always
      // checked it; this one didn't.
      const { error } = await supabase.auth.resetPasswordForEmail(cleanEmail, { redirectTo: `${window.location.origin}/` });
      if (error) throw error;
      setResetSent(true);
      setMsg(`If an account exists for ${cleanEmail}, a password-reset link is on its way. Open it on this device to set a new password.`);
    } catch (err) {
      // Deliberately NOT anti-enumeration wording: this is a send that failed, which says
      // nothing about whether the address has an account. `resetSent` stays false so the
      // button is still there to try again.
      setMsg(err?.message || 'Could not send the reset email — try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const cleanEmail = email.trim();
      if (!EMAIL_RE.test(cleanEmail)) throw new Error('Enter a valid email address.');
      if (mode === 'signup') {
        const pwProblem = passwordProblem(password);
        if (pwProblem) throw new Error(pwProblem);
        const { error } = await supabase.auth.signUp({ email: cleanEmail, password });
        if (error) throw error;
        setMsg('Account created. Check your inbox to verify your email address, then sign in.');
        setMode('signin');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
        if (error) throw error;
      }
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <h1 className="brand-lockup"><span className="brand-mark"><BrandMark /></span>Amlak</h1>
      <p className="muted">{mode === 'signin' ? 'Sign in to continue.' : 'Create an account.'}</p>
      <form onSubmit={submit}>
        <label className="form-field"><span>Email</span>
          <input className="text-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label className="form-field"><span>Password</span>
          <input
            className="text-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={MIN_PASSWORD}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          />
        </label>
        {mode === 'signup' && (
          <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            At least {MIN_PASSWORD} characters, with upper- and lower-case letters and a number.
          </p>
        )}
        <button type="submit" disabled={busy}>{busy ? '…' : mode === 'signin' ? 'Sign in' : 'Sign up'}</button>
      </form>
      {/* ⚠ THE BUTTON STAYS. Hiding it after one attempt made a typo'd address a dead end: the
          confirmation names the address back ("…for jane@acmee.com"), so the client can SEE
          the mistake — and then has no control left to correct it without reloading the page.
          It reads "Send it again" once one has gone out, which is also the honest label when
          the first mail is slow. */}
      {mode === 'signin' && (
        <p style={{ marginTop: 12 }}>
          <button type="button" className="ghost" style={{ fontSize: 13 }} disabled={busy} onClick={sendReset}>
            {resetSent ? 'Send the reset link again' : 'Forgot your password?'}
          </button>
        </p>
      )}
      {SIGNUP_OPEN && (
        <p style={{ marginTop: 14 }}>
          <button type="button" className="ghost" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
            {mode === 'signin' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
          </button>
        </p>
      )}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
