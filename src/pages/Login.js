import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD = 10;

// Private beta: public self-service sign-up is closed — only accounts created in
// Supabase can sign in. This hides the "Sign up" option; the real enforcement is
// server-side (Supabase enable_signup=false + the user-cap trigger in
// migration 0031). Flip to true (and re-enable both server controls) to reopen
// public registration when going public.
const SIGNUP_OPEN = false;

// Mirror the server-side policy (config.toml: minimum_password_length = 10,
// password_requirements = lower_upper_letters_digits) so users get instant,
// specific feedback instead of a generic server rejection. The server remains
// the source of truth — this is a UX nicety, not the enforcement.
function passwordProblem(pw) {
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
      <h1><span className="brand-mark" style={{ display: 'inline-grid', verticalAlign: 'middle', marginRight: 10 }}>L</span>Lease Extractor V2</h1>
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
