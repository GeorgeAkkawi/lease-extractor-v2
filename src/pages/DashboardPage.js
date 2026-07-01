import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSearchIndex, getPortfolioAR, fetchAlertData, listNotifications, dismissNotification, listAlertStates, upsertAlertState, confirmRenewalForLease, declineRenewalForLease, restoreRenewal, getHiddenWidgets } from '../lib/api';
import { buildAlerts, daysUntil, alertKey, toAlertStates, SNOOZE_OPTIONS } from '../lib/alerts';
import { usePageChrome } from '../context/ChromeContext';
import { money, sf, psf, fmtDate } from '../lib/format';
import NotificationEmailModal from '../components/NotificationEmailModal';
import { PageSkeleton } from '../components/Skeleton';
import { downloadRentRollXlsx } from '../lib/rentRollExcel';

// Portfolio overview — the landlord's one-glance home: rent roll, occupancy,
// receivables outstanding, leases expiring soon, and today's alerts. All assembled
// from data the app already exposes (search index + AR rollup + alerts).
export default function DashboardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [snoozeFor, setSnoozeFor] = useState(null);
  const [emailNotif, setEmailNotif] = useState(null);
  const [busyNotif, setBusyNotif] = useState(null);
  const [undoDecline, setUndoDecline] = useState(null); // { id, tenant } after "Not renewing"
  usePageChrome([{ label: 'Overview' }]);

  // Which Overview widgets the landlord has chosen to hide (Display settings).
  // Defaults to showing everything; `show(key)` gates each block below.
  const { data: hidden = [] } = useQuery({ queryKey: ['dashboardPrefs'], queryFn: getHiddenWidgets });
  const show = (k) => !hidden.includes(k);

  const { data: index } = useQuery({ queryKey: ['searchIndex'], queryFn: fetchSearchIndex });
  // Skip the receivables fetch entirely when that card is hidden.
  const { data: ar } = useQuery({ queryKey: ['portfolioAR'], queryFn: () => getPortfolioAR(), enabled: show('ar') });
  const { data: alerts = [] } = useQuery({
    queryKey: ['alerts'],
    queryFn: async () => {
      const [data, states] = await Promise.all([fetchAlertData(), listAlertStates()]);
      return buildAlerts(data, toAlertStates(states));
    },
    refetchInterval: 60_000,
  });
  const { data: notifications = [] } = useQuery({ queryKey: ['notifications'], queryFn: listNotifications, refetchInterval: 60_000 });

  // Hold the page until the portfolio data is in, so the metrics/tables appear
  // fully formed rather than counting up from zero on first load.
  const indexLoading = !index;

  async function clearNotification(id) { await dismissNotification(id); qc.invalidateQueries({ queryKey: ['notifications'] }); }
  // Answer a "Is the tenant renewing?" prompt. Yes rolls the lease into the new term
  // (and swaps in a ready-to-send tenant email); No closes the option. Either way the
  // prompt clears. Refresh everything the renewal touches.
  function refreshAfterRenewal() {
    ['notifications', 'alerts', 'leases', 'lease', 'escalations', 'renewals', 'expiredLeases', 'searchIndex', 'propertyTotals', 'tenantShares']
      .forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  }
  async function confirmRenewal(n) { setBusyNotif(n.id); try { await confirmRenewalForLease(n.lease_id); } finally { setBusyNotif(null); refreshAfterRenewal(); } }
  async function declineRenewal(n) {
    setBusyNotif(n.id);
    try {
      const declinedId = await declineRenewalForLease(n.lease_id);
      if (declinedId) setUndoDecline({ id: declinedId, tenant: (n.title || '').replace(/^Is /, '').replace(/ renewing\?$/, '') || 'this tenant' });
    } finally { setBusyNotif(null); refreshAfterRenewal(); }
  }
  async function undoDeclineNow() { const u = undoDecline; setUndoDecline(null); if (u) { await restoreRenewal(u.id); refreshAfterRenewal(); } }
  // Dismiss / snooze persist server-side (alert_states) so they sync across devices.
  async function clearAlert(a) { await upsertAlertState({ alert_key: alertKey(a), dismissed: true }); qc.invalidateQueries({ queryKey: ['alerts'] }); }
  async function snooze(a, ms) { await upsertAlertState({ alert_key: alertKey(a), snoozed_until: new Date(Date.now() + ms).toISOString() }); setSnoozeFor(null); qc.invalidateQueries({ queryKey: ['alerts'] }); }

  const leases = (index?.leases || []).filter((l) => l.is_active !== false);
  const properties = index?.properties || [];

  const rentRoll = leases.reduce((s, l) => s + (Number(l.base_rent) || 0), 0);
  const leasedSf = leases.reduce((s, l) => s + (Number(l.square_footage) || 0), 0);
  const buildingSf = properties.reduce((s, p) => s + (Number(p.building_sf) || 0), 0);
  const occupancy = buildingSf > 0 ? Math.round((leasedSf / buildingSf) * 100) : null;
  const vacantSf = buildingSf > 0 ? Math.max(0, buildingSf - leasedSf) : 0;

  // Leases expiring within 90 days (active only), soonest first.
  const expiring = leases
    .filter((l) => l.lease_termination_date)
    .map((l) => ({ ...l, days: daysUntil(l.lease_termination_date) }))
    .filter((l) => l.days != null && l.days >= 0 && l.days <= 90)
    .sort((a, b) => a.days - b.days);

  const b = ar?.buckets || {};
  const lateTotal = (b.d30 || 0) + (b.d60 || 0) + (b.d90 || 0);

  // Which blocks to render, per the landlord's Display settings. The two panels
  // share a 2-column grid — if only one shows, it goes full-width.
  const showCards = ['rent_roll', 'ar', 'occupancy', 'expiring'].some(show);
  const showExpirations = show('expirations');
  const showAlerts = show('alerts');
  const twoPanels = showExpirations && showAlerts;
  const nothingShown = !showCards && !showExpirations && !showAlerts;

  if (indexLoading) return <PageSkeleton />;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <div className="muted">
            {properties.length} propert{properties.length === 1 ? 'y' : 'ies'} · {leases.length} active tenant{leases.length === 1 ? '' : 's'}
            {occupancy != null ? ` · ${occupancy}% occupied` : ''}
          </div>
        </div>
        <div className="head-actions">
          <button className="secondary" onClick={() => downloadRentRollXlsx({ leases, properties })} disabled={!leases.length}>⬇ Download rent roll (Excel)</button>
        </div>
      </div>

      {showCards && (
      <div className="metric-group">
        <div className="metrics">
          {show('rent_roll') && <Card label="Annual rent roll" main={money(rentRoll)} foot={leasedSf ? `${psf(rentRoll / leasedSf)} blended` : null} onClick={() => navigate('/financials')} />}
          {show('ar') && <Card label="Outstanding (AR)" main={money(ar?.outstanding || 0)} foot={ar ? `${ar.count} unpaid · ${money(lateTotal)} late` : null} tone={lateTotal > 0 ? 'danger' : undefined} />}
          {show('occupancy') && <Card label="Occupancy" main={occupancy != null ? `${occupancy}%` : '—'} foot={buildingSf ? `${sf(vacantSf)} vacant` : 'add building sizes'} />}
          {show('expiring') && <Card label="Expiring ≤ 90 days" main={String(expiring.length)} foot={expiring.length ? `next: ${fmtDate(expiring[0].lease_termination_date)}` : 'none'} tone={expiring.length ? 'warn' : undefined} />}
        </div>
      </div>
      )}

      {nothingShown && (
        <div className="panel">
          <p className="empty-line muted" style={{ margin: 0 }}>
            You’ve hidden every Overview widget. Turn them back on any time in <Link to="/display">Display settings</Link>.
          </p>
        </div>
      )}

      {(showExpirations || showAlerts) && (
      <div className="dash-cols" style={{ display: 'grid', gridTemplateColumns: twoPanels ? '1fr 1fr' : '1fr', gap: 16, alignItems: 'start' }}>
        {showExpirations && (
        <div className="panel">
          <div className="panel-head">
            <strong>Lease expirations · next 90 days</strong>
            <span className="muted">Act before notice deadlines pass</span>
          </div>
          {expiring.length === 0 ? (
            <p className="empty-line muted">No leases expiring in the next 90 days.</p>
          ) : (
            <div className="table-wrap">
              <table style={{ minWidth: 0 }}>
                <thead><tr><th>Tenant</th><th>Property</th><th>Ends</th><th className="num">In</th><th>Renewal</th></tr></thead>
                <tbody>
                  {expiring.slice(0, 8).map((l) => (
                    <tr key={l.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/leases/${l.corporation_id}/${l.property_id}/${l.id}`)}>
                      <td>{l.tenant_name}</td>
                      <td>{l.property_name}</td>
                      <td>{fmtDate(l.lease_termination_date)}</td>
                      <td className="num">{l.days}d</td>
                      <td>{l.has_renewal ? <span className="badge good">option</span> : <span className="badge danger">none</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}

        {showAlerts && (
        <div className="panel">
          <div className="panel-head">
            <strong>Alerts &amp; notifications</strong>
            <span className="muted">{notifications.length + alerts.length} active</span>
          </div>
          {notifications.length + alerts.length === 0 ? (
            <p className="empty-line muted">All clear — nothing needs attention. 🎉</p>
          ) : (
            <div className="alert-list">
              {/* Just declined a renewal? Offer an immediate, friendly undo. */}
              {undoDecline && (
                <div className="callout" style={{ marginBottom: 8, display: 'flex', gap: 10, alignItems: 'center', borderLeftColor: 'var(--accent)' }}>
                  <div style={{ flex: 1 }}>
                    <div className="alert-title"><strong>Marked {undoDecline.tenant} as not renewing.</strong></div>
                    <div className="muted" style={{ fontSize: 12.5 }}>Changed your mind? You can put it back to pending.</div>
                  </div>
                  <button className="secondary" onClick={undoDeclineNow}>↩ Undo</button>
                  <button className="icon-btn dismiss-x" title="Dismiss" onClick={() => setUndoDecline(null)}>✕</button>
                </div>
              )}
              {/* Updates that already happened (rent applied, lease renewed) — dismiss only. */}
              {notifications.map((n) => (
                <div key={n.id} className="callout" style={{ marginBottom: 8, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <div role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                      onClick={() => n.lease_id && navigate(`/leases/${n.corporation_id}/${n.property_id}/${n.lease_id}`)}>
                      <div className="alert-title"><strong>{n.title}</strong></div>
                      <div className="muted" style={{ fontSize: 12.5 }}>{n.body}</div>
                    </div>
                    {n.email_body && (
                      <span className="bell-link" role="button" tabIndex={0} style={{ cursor: 'pointer' }}
                        onClick={(e) => { e.stopPropagation(); setEmailNotif(n); }}>✉ View / send tenant email</span>
                    )}
                    {n.kind === 'renewal_decision' && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button className="secondary" disabled={busyNotif === n.id}
                          onClick={(e) => { e.stopPropagation(); confirmRenewal(n); }}>
                          {busyNotif === n.id ? 'Working…' : 'Yes — apply renewal'}
                        </button>
                        <button className="ghost" disabled={busyNotif === n.id}
                          onClick={(e) => { e.stopPropagation(); declineRenewal(n); }}>
                          No — not renewing
                        </button>
                      </div>
                    )}
                  </div>
                  <button className="icon-btn dismiss-x" title="Dismiss" onClick={() => clearNotification(n.id)}>✕</button>
                </div>
              ))}

              {/* Upcoming key dates — describe what + when, with dismiss + remind-me-later. */}
              {alerts.map((a, i) => { const k = alertKey(a); return (
                <div key={`${k}-${i}`} className="callout" style={{ marginBottom: 8, display: 'flex', gap: 10, alignItems: 'flex-start', borderLeftColor: a.tone === 'danger' ? 'var(--danger)' : a.tone === 'warn' ? 'var(--accent)' : 'var(--line)' }}>
                  <div role="button" tabIndex={0} style={{ flex: 1, cursor: 'pointer' }}
                    onClick={() => a.lease_id
                      ? navigate(`/leases/${a.corporation_id}/${a.property_id}/${a.lease_id}?focus=${a.focus || ''}`)
                      : navigate(`/leases/${a.corporation_id}`)}>
                    <div className="alert-title"><strong>{a.title}</strong></div>
                    <div className="muted" style={{ fontSize: 12.5 }}>{a.detail}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{a.bucketLabel} · {fmtDate(a.date)}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 4, position: 'relative' }}>
                    <button className="icon-btn" title="Remind me later" aria-label="Remind me later" onClick={() => setSnoozeFor(snoozeFor === k ? null : k)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
                        <circle cx="12" cy="12" r="9" />
                        <path d="M12 7.5V12l3 2" />
                      </svg>
                    </button>
                    <button className="icon-btn dismiss-x" title="Dismiss" onClick={() => clearAlert(a)}>✕</button>
                    {snoozeFor === k && (
                      <div className="snooze-menu" style={{ position: 'absolute', top: '100%', right: 0, zIndex: 5, background: 'var(--surface, #fff)', border: '1px solid var(--line, #ddd)', borderRadius: 8, padding: 6, boxShadow: '0 6px 20px rgba(0,0,0,.12)', minWidth: 130 }}>
                        <div className="muted" style={{ fontSize: 11, padding: '2px 8px 6px' }}>Remind me…</div>
                        {SNOOZE_OPTIONS.map((o) => (
                          <button key={o.label} className="ghost" style={{ display: 'block', width: '100%', textAlign: 'left', fontSize: 12.5 }} onClick={() => snooze(a, o.ms)}>{o.label}</button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ); })}
            </div>
          )}
        </div>
        )}
      </div>
      )}

      {emailNotif && (
        <NotificationEmailModal
          notif={emailNotif}
          onClose={() => setEmailNotif(null)}
          onSent={async () => { await clearNotification(emailNotif.id); setEmailNotif(null); }}
        />
      )}
    </div>
  );
}

function Card({ label, main, foot, tone, onClick }) {
  return (
    <div className="metric stat" style={onClick ? { cursor: 'pointer' } : undefined} onClick={onClick}>
      <div className="label">{label}</div>
      <div className={`value${tone === 'danger' ? ' neg' : ''}`}>{main}</div>
      {foot && <div className="stat-foot"><span className="stat-cap">{foot}</span></div>}
    </div>
  );
}
