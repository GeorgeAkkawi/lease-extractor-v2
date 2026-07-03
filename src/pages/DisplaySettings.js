import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getHiddenWidgets, setHiddenWidgets, getEnabledFeatures, setEnabledFeatures } from '../lib/api';
import { DASHBOARD_WIDGETS, PAGE_PANELS } from '../lib/dashboardWidgets';
import { FEATURES, isFeatureOn, toggleFeature } from '../lib/features';
import { usePageChrome } from '../context/ChromeContext';

// The "Display & features" section of Settings: the single place to hide or bring
// back anything. Two kinds of toggle share one row style:
//  • Widgets/panels — a "hidden" deny-list (user_preferences.hidden_widgets); the
//    dashboard/lease/property pages read the same ['dashboardPrefs'] query.
//  • Features — the opt-in module set (user_preferences.enabled_features); every
//    module guards its own UI with useFeatures().isOn(key).
// Turning anything off only hides it — the underlying data is never deleted.
export default function DisplaySettings() {
  usePageChrome([{ label: 'Settings', to: '/settings' }, { label: 'Display & features' }]);
  const qc = useQueryClient();
  const { data: hidden = [], isLoading } = useQuery({ queryKey: ['dashboardPrefs'], queryFn: getHiddenWidgets });
  const { data: enabled } = useQuery({ queryKey: ['enabledFeatures'], queryFn: getEnabledFeatures });

  const hiddenSet = new Set(hidden);

  async function toggleWidget(key) {
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

  async function toggleFeatureKey(key) {
    const next = toggleFeature(enabled, key); // materializes the full set on first change
    qc.setQueryData(['enabledFeatures'], next);
    try {
      await setEnabledFeatures(next);
    } catch {
      qc.setQueryData(['enabledFeatures'], enabled ?? null);
    }
  }

  // A widget/panel row (shown/hidden).
  const WidgetToggle = (w) => {
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
          onChange={() => toggleWidget(w.key)}
          style={{ marginTop: 3, width: 16, height: 16, flex: '0 0 auto' }}
        />
        <span style={{ flex: 1 }}>
          <span style={{ fontWeight: 600 }}>{w.label}</span>
          <span className="muted" style={{ display: 'block', fontSize: 12.5 }}>{w.hint}</span>
        </span>
        <span className={`badge ${shown ? 'good' : 'info'}`} style={{ flex: '0 0 auto' }}>{shown ? 'Shown' : 'Hidden'}</span>
      </label>
    );
  };

  // A feature-module row (on/off).
  const FeatureToggle = (f) => {
    const on = isFeatureOn(enabled, f.key);
    return (
      <label
        key={f.key}
        className="row"
        style={{ gap: 12, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--line, #eee)', cursor: 'pointer' }}
      >
        <input
          type="checkbox"
          checked={on}
          onChange={() => toggleFeatureKey(f.key)}
          style={{ marginTop: 3, width: 16, height: 16, flex: '0 0 auto' }}
        />
        <span style={{ flex: 1 }}>
          <span style={{ fontWeight: 600 }}>{f.label}</span>
          <span className="muted" style={{ display: 'block', fontSize: 12.5 }}>{f.hint}</span>
        </span>
        <span className={`badge ${on ? 'good' : 'info'}`} style={{ flex: '0 0 auto' }}>{on ? 'On' : 'Off'}</span>
      </label>
    );
  };

  return (
    <div className="panel" style={{ maxWidth: 560 }}>
      <div className="panel-head"><strong>Display &amp; features</strong></div>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        Turn on the tools you want and hide anything you don’t. Your choices are saved to
        your account, so they apply everywhere you sign in. Switching something off only
        hides it — nothing is deleted.
      </p>

      {isLoading ? (
        <p className="muted" style={{ marginTop: 12 }}>Loading…</p>
      ) : (
        <>
          <div className="fin-subhead" style={{ marginTop: 18 }}>Features</div>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {FEATURES.map(FeatureToggle)}
          </div>

          <div className="fin-subhead" style={{ marginTop: 22 }}>Overview (dashboard) widgets</div>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {DASHBOARD_WIDGETS.map(WidgetToggle)}
          </div>

          <div className="fin-subhead" style={{ marginTop: 22 }}>Lease &amp; property pages</div>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {PAGE_PANELS.map(WidgetToggle)}
          </div>
        </>
      )}
    </div>
  );
}
