import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { getSecuritySettings, sendTwoFactorCode, verifyTwoFactorCode } from '../lib/api';
import { usePageChrome } from '../context/ChromeContext';

// Turn email 2FA on or off. Either way the user must enter a code we email them
// first, so the toggle can only be flipped by someone who controls the inbox
// (the server enforces this — the flag is never written directly by the client).
export default function SecuritySettings() {
  usePageChrome([{ label: 'Settings', to: '/settings' }, { label: 'Security & 2FA' }]);
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(null); // null = loading
  const [stage, setStage] = useState('idle');   // idle | code
  const [intent, setIntent] = useState('enable');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => { getSecuritySettings().then((s) => setEnabled(!!s.email_2fa_enabled)); }, []);

  async function start(which) {
    setIntent(which); setBusy(true); setMsg('');
    try {
      await sendTwoFactorCode();
      setStage('code');
      setMsg(`Code sent to ${user?.email || 'your email'}.`);
    } catch {
      setMsg('Could not send a code. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e) {
    e.preventDefault(); setBusy(true); setMsg('');
    try {
      const r = await verifyTwoFactorCode(code.trim(), intent);
      if (r?.verified) {
        setEnabled(intent === 'enable');
        setStage('idle'); setCode('');
        setMsg(intent === 'enable' ? 'Email 2FA is now ON.' : 'Email 2FA is now OFF.');
      } else {
        setMsg(r?.error || 'Incorrect code.');
      }
    } catch (err) {
      setMsg(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ maxWidth: 540 }}>
      <div className="panel-head"><strong>Security · Two-factor authentication</strong></div>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        When on, signing in requires a 6-digit code emailed to {user?.email ? <strong>{user.email}</strong> : 'your address'},
        in addition to your password.
      </p>

      {enabled === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p style={{ margin: '10px 0 14px' }}>
            Status: <span className={`badge ${enabled ? 'good' : 'info'}`}>{enabled ? 'On' : 'Off'}</span>
          </p>

          {stage === 'idle' ? (
            enabled ? (
              <button type="button" className="ghost" disabled={busy} onClick={() => start('disable')}>
                Turn off email 2FA
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => start('enable')}>
                Turn on email 2FA
              </button>
            )
          ) : (
            <form onSubmit={confirm}>
              <label className="form-field"><span>Enter the code we emailed you</span>
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
              <div className="row" style={{ gap: 10 }}>
                <button type="submit" disabled={busy || code.length !== 6}>
                  {busy ? '…' : intent === 'enable' ? 'Confirm & turn on' : 'Confirm & turn off'}
                </button>
                <button type="button" className="ghost" onClick={() => { setStage('idle'); setCode(''); setMsg(''); }}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}

      {msg && <p className="muted" style={{ marginTop: 12 }}>{msg}</p>}
    </div>
  );
}
