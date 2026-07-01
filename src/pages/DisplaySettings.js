import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getHiddenWidgets, setHiddenWidgets } from '../lib/api';
import { DASHBOARD_WIDGETS } from '../lib/dashboardWidgets';
import { usePageChrome } from '../context/ChromeContext';

// Let the landlord choose which Overview (dashboard) widgets they want to see.
// Each toggle flips one widget on/off; the choice is saved to their account so it
// follows them across devices. The dashboard reads the same ['dashboardPrefs']
// query, so hiding here updates the dashboard the next time they open it.
export default function DisplaySettings() {
  usePageChrome([{ label: 'Display' }]);
  const qc = useQueryClient();
  const { data: hidden = [], isLoading } = useQuery({ queryKey: ['dashboardPrefs'], queryFn: getHiddenWidgets });

  const hiddenSet = new Set(hidden);

  async function toggle(key) {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    const arr = [...next];
    // Update the shared cache immediately so both this page and the dashboard
    // reflect the change without a round-trip, then persist.
    qc.setQueryData(['dashboardPrefs'], arr);
    try {
      await setHiddenWidgets(arr);
    } catch {
      // Revert on failure so the toggle never lies about what was saved.
      qc.setQueryData(['dashboardPrefs'], hidden);
    }
  }

  return (
    <div className="panel" style={{ maxWidth: 560 }}>
      <div className="panel-head"><strong>Display · Dashboard widgets</strong></div>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        Choose what shows on your Overview page. Turn off anything you don’t want to
        see — for example, hide <strong>Outstanding (receivables)</strong> if you don’t
        track tenant balances here. Your choices are saved to your account, so they
        apply everywhere you sign in.
      </p>

      {isLoading ? (
        <p className="muted" style={{ marginTop: 12 }}>Loading…</p>
      ) : (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {DASHBOARD_WIDGETS.map((w) => {
            const shown = !hiddenSet.has(w.key);
            return (
              <label
                key={w.key}
                className="row"
                style={{ gap: 12, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--line, #eee)', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={shown}
                  onChange={() => toggle(w.key)}
                  style={{ marginTop: 3, width: 16, height: 16, flex: '0 0 auto' }}
                />
                <span style={{ flex: 1 }}>
                  <span style={{ fontWeight: 600 }}>{w.label}</span>
                  <span className="muted" style={{ display: 'block', fontSize: 12.5 }}>{w.hint}</span>
                </span>
                <span className={`badge ${shown ? 'good' : 'info'}`} style={{ flex: '0 0 auto' }}>{shown ? 'Shown' : 'Hidden'}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
