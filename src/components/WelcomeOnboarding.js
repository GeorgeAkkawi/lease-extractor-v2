import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FEATURES, FEATURE_KEYS } from '../lib/features';
import { setEnabledFeatures } from '../lib/api';

// One-time picker shown after the very first sign-in (when enabled_features is
// still null). The landlord chooses which optional modules Amlak should handle
// for them; everything is pre-checked, so keeping the default is the same as the
// app has always behaved. Saving writes a non-null set, so this never appears
// again — later changes happen in Settings → Display & features.
export default function WelcomeOnboarding() {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState(() => new Set(FEATURE_KEYS));
  const [busy, setBusy] = useState(false);

  function toggle(key) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function commit(keys) {
    setBusy(true);
    // Seed the cache first so the gate in Layout drops us straight into the app,
    // then persist. If the write fails the choice is still applied for this session.
    qc.setQueryData(['enabledFeatures'], keys);
    try {
      await setEnabledFeatures(keys);
    } catch {
      /* non-fatal — the cached choice still stands */
    } finally {
      setBusy(false);
    }
  }

  const save = () => commit(FEATURE_KEYS.filter((k) => chosen.has(k)));
  const keepAll = () => commit([...FEATURE_KEYS]);

  return (
    <div className="panel" style={{ maxWidth: 620, margin: '8px auto' }}>
      <div className="panel-head"><strong>Welcome to Amlak</strong></div>
      <p className="muted" style={{ fontSize: 13.5, marginTop: 4 }}>
        What should Amlak handle for you? Pick the tools you want — you can turn any of
        these on or off later under <strong>Settings → Display &amp; features</strong>.
        Your core leases, financials and history are always on.
      </p>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {FEATURES.map((f) => {
          const on = chosen.has(f.key);
          return (
            <label
              key={f.key}
              className="row"
              style={{ gap: 12, alignItems: 'flex-start', padding: '12px 0', borderBottom: '1px solid var(--line, #eee)', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(f.key)}
                style={{ marginTop: 3, width: 16, height: 16, flex: '0 0 auto' }}
              />
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: 600 }}>{f.label}</span>
                <span className="muted" style={{ display: 'block', fontSize: 12.5 }}>{f.hint}</span>
              </span>
              <span className={`badge ${on ? 'good' : 'info'}`} style={{ flex: '0 0 auto' }}>{on ? 'On' : 'Off'}</span>
            </label>
          );
        })}
      </div>

      <div className="row" style={{ gap: 10, marginTop: 18 }}>
        <button type="button" disabled={busy} onClick={save}>
          {busy ? '…' : 'Save & continue'}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={keepAll}>
          Skip — keep everything on
        </button>
      </div>
    </div>
  );
}
