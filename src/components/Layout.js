import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import { DEMO_MODE } from '../lib/supabaseClient';
import { applyDueRenewals, applyDueEscalations } from '../lib/api';

export default function Layout({ children }) {
  const qc = useQueryClient();
  const ran = useRef(false);

  // On load, automatically apply anything whose date has arrived: rent
  // escalations on their effective date (updates the lease's base rent) and lease
  // renewals on their term-end date. Both notify the owner; neither happens early.
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    Promise.allSettled([applyDueEscalations(), applyDueRenewals()])
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
    </div>
  );
}
