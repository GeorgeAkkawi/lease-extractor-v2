import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import WelcomeOnboarding from './WelcomeOnboarding';
import { DEMO_MODE } from '../lib/supabaseClient';
import { promptDueRenewalDecisions, applyDueEscalations, getEnabledFeatures } from '../lib/api';

export default function Layout({ children }) {
  const qc = useQueryClient();
  const ran = useRef(false);

  // First-run onboarding gate: a fresh account stores enabled_features = null.
  // Until the landlord makes their first pick we show the one-time Welcome picker
  // in place of the app. Saving writes a non-null set, so this shows exactly once.
  // Demo mode never has a persisted row, so it's skipped there entirely.
  const { data: enabledFeatures, isLoading: featuresLoading } = useQuery({
    queryKey: ['enabledFeatures'],
    queryFn: getEnabledFeatures,
    enabled: !DEMO_MODE,
  });
  const needsOnboarding = !DEMO_MODE && !featuresLoading && enabledFeatures === null;

  // On load: rent escalations whose effective date has arrived apply automatically
  // (they update the lease's base rent). Renewal options never apply on their own —
  // instead, when a decision is due we drop a "Is the tenant renewing?" prompt for
  // the owner to confirm. Neither happens early; nothing extends the term silently.
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    Promise.allSettled([applyDueEscalations(), promptDueRenewalDecisions()])
      .then((results) => {
        qc.invalidateQueries({ queryKey: ['notifications'] });
        const changed = results.some((r) => r.status === 'fulfilled' && r.value && r.value.length);
        if (changed) {
          ['alerts', 'leases', 'lease', 'escalations', 'propertyTotals', 'tenantShares', 'expiredLeases', 'snapshots', 'renewals', 'propertyEscalations', 'searchIndex']
            .forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
        }
      })
      .catch(() => { /* non-fatal */ });
  }, [qc]);

  return (
    <div className="app">
      <Sidebar />
      <div className="main-col">
        <TopBar />
        {DEMO_MODE && (
          <div className="demo-banner">
            🧪 Demo mode — seeded sample data, no backend. AI buttons return canned responses. Add
            Supabase keys in <code>.env.local</code> to go live.
          </div>
        )}
        <div className="content">{needsOnboarding ? <WelcomeOnboarding /> : children}</div>
      </div>
    </div>
  );
}
