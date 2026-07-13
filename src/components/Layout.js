import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import AutoLogout from './AutoLogout';
import { DEMO_MODE } from '../lib/supabaseClient';
import { promptDueRenewalDecisions, applyDueEscalations, localDateIso } from '../lib/api';

export default function Layout({ children }) {
  const qc = useQueryClient();
  const ran = useRef(false);

  // On load: rent escalations whose effective date has arrived apply automatically
  // (they update the lease's base rent). Renewal options never apply on their own —
  // instead, when a decision is due we drop a "Is the tenant renewing?" prompt for
  // the owner to confirm. Neither happens early; nothing extends the term silently.
  //
  // This same engine runs nightly as a scheduled job (migrations 0034/0047), so
  // re-running it on every single app load just repeats that work and fires dozens
  // of queries per load. In live mode, gate it to once per calendar day per browser;
  // demo has no cron and resets in memory each reload, so it always runs there.
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!DEMO_MODE) {
      const DAY_KEY = 'amlak_engine_ran';
      const todayIso = localDateIso(); // local calendar day, matching the engine's own "today"
      try {
        if (localStorage.getItem(DAY_KEY) === todayIso) {
          qc.invalidateQueries({ queryKey: ['notifications'] });
          return;
        }
        localStorage.setItem(DAY_KEY, todayIso);
      } catch (_e) { /* storage blocked — just run it */ }
    }
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
        <div className="content">{children}</div>
      </div>
      <AutoLogout />
    </div>
  );
}
