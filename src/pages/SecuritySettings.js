import { useEffect, useState, useCallback } from 'react';
import { supabase, DEMO_MODE } from '../lib/supabaseClient';
import { usePageChrome } from '../context/ChromeContext';

// Authenticator-app (TOTP) two-factor. Uses Supabase's native MFA: enrolling
// creates a factor + QR the user scans with Google Authenticator / Authy / 1Password;
// entering a current code verifies it. Once verified, the account requires a code at
// sign-in (enforced server-side by the aal2 RLS policies — a password alone can't
// reach the data). Removing it unenrolls the factor.
export default function SecuritySettings() {
  usePageChrome([{ label: 'Settings', to: '/settings' }, { label: 'Security & 2FA' }]);
  const [loading, setLoading] = useState(true);
  const [factor, setFactor] = useState(null);     // the verified TOTP factor, or null
  const [stage, setStage] = useState('idle');     // idle | enrolling
  const [enroll, setEnroll] = useState(null);      // { factorId, qr, secret }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    if (DEMO_MODE) { setLoading(false); return; }
    try {
      const { data } = await supabase.auth.mfa.listFactors();
      setFactor(data?.totp?.[0] || null);
    } catch {
      setFactor(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function startEnroll() {
    setBusy(true); setMsg('');
    try {
      // Clear any half-finished (unverified) factors first so the QR is fresh and the
      // friendly name stays unique.
      const { data: list } = await supabase.auth.mfa.listFactors();
      const stale = (list?.all || []).filter((f) => f.status !== 'verified');
      for (const f of stale) { try { await supabase.auth.mfa.unenroll({ factorId: f.id }); } catch { /* ignore */ } }

      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Authenticator' });
      if (error) throw error;
      setEnroll({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
      setStage('enrolling'); setCode('');
    } catch (e) {
      setMsg(e?.message || 'Could not start setup. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll(e) {
    e.preventDefault(); setBusy(true); setMsg('');
    try {
      const { data: ch, error: cErr } = await supabase.auth.mfa.challenge({ factorId: enroll.factorId });
      if (cErr) throw cErr;
      const { error: vErr } = await supabase.auth.mfa.verify({ factorId: enroll.factorId, challengeId: ch.id, code: code.trim() });
      if (vErr) { setMsg("That code didn't match — enter the current 6-digit code from the app."); setCode(''); return; }
      setStage('idle'); setEnroll(null); setCode('');
      setMsg('Authenticator 2FA is now ON. You’ll enter a code from your app each time you sign in.');
      await load();
    } catch (e2) {
      setMsg(e2?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!factor) return;
    if (!window.confirm('Turn off authenticator 2FA? You’ll sign in with just your password until you set it up again.')) return;
    setBusy(true); setMsg('');
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (error) throw error;
      setMsg('Authenticator 2FA is now OFF.');
      await load();
    } catch (e) {
      setMsg(e?.message || 'Could not turn it off. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (DEMO_MODE) {
    return (
      <div className="panel" style={{ maxWidth: 560 }}>
        <div className="panel-head"><strong>Security · Two-factor authentication</strong></div>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Two-factor sign-in with an authenticator app is available on a real account — it isn’t part of the demo.
        </p>
      </div>
    );
  }

  const enabled = !!factor;

  return (
    <div className="panel" style={{ maxWidth: 560 }}>
      <div className="panel-head"><strong>Security · Two-factor authentication</strong></div>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        Add a second step at sign-in using an <strong>authenticator app</strong> (Google Authenticator, Authy,
        1Password, etc.). After your password, you’ll enter the current 6-digit code from the app.
      </p>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <p style={{ margin: '10px 0 14px' }}>
            Status: <span className={`badge ${enabled ? 'good' : 'info'}`}>{enabled ? 'On' : 'Off'}</span>
          </p>

          {stage === 'idle' ? (
            enabled ? (
              <button type="button" className="ghost" disabled={busy} onClick={remove}>
                Turn off authenticator 2FA
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={startEnroll}>
                {busy ? 'Starting…' : 'Set up authenticator app'}
              </button>
            )
          ) : (
            <div>
              <ol className="muted" style={{ fontSize: 13, paddingLeft: 18, marginTop: 0 }}>
                <li>Open your authenticator app and scan this QR code (or enter the key by hand).</li>
                <li>Type the 6-digit code it shows, below, to finish.</li>
              </ol>
              {enroll?.qr && (
                <div style={{ margin: '8px 0' }}>
                  <img src={enroll.qr} alt="Authenticator QR code" width={180} height={180} style={{ border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} />
                </div>
              )}
              {enroll?.secret && (
                <p className="muted" style={{ fontSize: 12 }}>
                  Can’t scan? Enter this key: <code style={{ userSelect: 'all' }}>{enroll.secret}</code>
                </p>
              )}
              <form onSubmit={confirmEnroll}>
                <label className="form-field"><span>6-digit code from the app</span>
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
                    {busy ? '…' : 'Confirm & turn on'}
                  </button>
                  <button type="button" className="ghost" onClick={() => { setStage('idle'); setEnroll(null); setCode(''); setMsg(''); }}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {enabled && stage === 'idle' && (
            <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
              Keep a backup of your authenticator (most apps sync across devices). If you ever lose access,
              the account owner can reset two-factor from the backend.
            </p>
          )}
        </>
      )}

      {msg && <p className="muted" style={{ marginTop: 12 }}>{msg}</p>}
    </div>
  );
}
