import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSearchIndex, fetchAlertData, listNotifications, dismissNotification, listAlertStates, upsertAlertState, confirmRenewalForLease, declineRenewalForLease, restoreRenewal, getHiddenWidgets, draftAlertEmail, listPropertyTotalsByYear, logInsuranceRequest, getNotifyLeadTimes } from '../lib/api';
import { listBasisByProperty } from '../lib/portfolioBasis';
import { buildAlerts, alertKey, toAlertStates, SNOOZE_OPTIONS, alertUrgency, compareUrgencyKeys, URGENCY_TIER, isLongPast, notificationKey, notificationSnoozed } from '../lib/alerts';
import { groupFeed, rowSubject } from '../lib/notifyTypes';
import { resolveLeadDays } from '../lib/notifyPrefs';
import { useFeatures, isFeatureOn } from '../lib/features';
import { LIVE_QUERY } from '../lib/liveQuery';
import { usePageChrome, useChrome } from '../context/ChromeContext';
import { money, fmtDate } from '../lib/format';
import NotificationEmailModal from '../components/NotificationEmailModal';
import { useConfirm } from '../components/ConfirmDialog';
import { PageSkeleton } from '../components/Skeleton';
import PortfolioCharts from '../components/PortfolioCharts';
import BasisBand from '../components/BasisBand';
import { basisRows, portfolioBasis } from '../lib/portfolioCharts';
import { yearBridge } from '../lib/yearBridge';
import { downloadRentRollXlsx } from '../lib/rentRollExcel';

// Portfolio overview — the landlord's one-glance home: rent roll, occupancy,
// leases expiring soon, and today's alerts. All assembled from data the app
// already exposes (search index + property totals + alerts).
export default function DashboardPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [snoozeFor, setSnoozeFor] = useState(null);
  const [emailNotif, setEmailNotif] = useState(null);
  const [busyNotif, setBusyNotif] = useState(null);
  const [emailBusyAlert, setEmailBusyAlert] = useState(null); // alertKey while drafting its email
  // One line above the board for anything that goes wrong on a row's own controls — drafting
  // a letter, dismissing, snoozing. All three were bare async handlers with no catch and the
  // page has no error boundary, so a failure was total silence.
  const [feedNote, setFeedNote] = useState(null);
  const [undoDecline, setUndoDecline] = useState(null); // { id, tenant } after "Not renewing"
  const [rentEntry, setRentEntry] = useState(null); // { leaseId, value } when a renewal has no listed rent
  const askConfirm = useConfirm();
  usePageChrome([{ label: 'Overview' }]);
  const { year } = useChrome(); // shared fiscal year — same selector the property pages use

  // Which Overview widgets the landlord has chosen to hide (Display settings).
  // Defaults to showing everything; `show(key)` gates each block below.
  const { data: hidden = [] } = useQuery({ queryKey: ['dashboardPrefs'], queryFn: getHiddenWidgets });
  const show = (k) => !hidden.includes(k);

  // ⚠ THE ONE PLACE ON SCREEN THAT SHOWS LIVE REVENUE, AND THE LEDGER NOW POINTS AT IT
  // (2026-08-21 (11)). Answering a surplus says the money "is in your live income and expenses";
  // until now nothing said WHERE, and the property Financials page cannot help — its revenue card
  // is `v_property_totals.total_revenue`, the annual RATE, which no payment moves. `?focus=basis`
  // scrolls the band into view and flashes it, the same scroll-and-flash the lease page's alerts
  // use. ⚠ The Ledger only OFFERS the link when `portfolio_charts` is shown, so this effect never
  // has to explain a band the landlord has hidden.
  //
  // ⚠ A CALLBACK REF, NOT `useRef`. This page renders a skeleton until the portfolio loads, so
  // the band does not exist on the render that reads `?focus=`. A `.current` read there is null
  // and a plain ref never re-triggers the effect — the landlord would arrive at the top of an
  // un-scrolled page. Holding the element in STATE makes its arrival the thing the effect waits
  // on, which is also true when the band declines to render at all (nothing billed, nothing in).
  const [searchParams] = useSearchParams();
  const focus = searchParams.get('focus');
  const [basisEl, setBasisEl] = useState(null);
  const [basisFlash, setBasisFlash] = useState(false);
  useEffect(() => {
    if (focus !== 'basis' || !basisEl) return;
    setBasisFlash(true);
    // Optional-call: jsdom does not implement scrollIntoView, and the flash is the half that
    // matters — the same guard `AddendumEnvelopeRows` already uses.
    basisEl.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setBasisFlash(false), 2600);
    return () => clearTimeout(t);
  }, [focus, basisEl]);
  // The enabled feature set, so alerts belonging to a switched-off module silence too
  // (Insurance, Contracts). null/undefined = everything on.
  const { enabled: enabledFeatures } = useFeatures();

  const { data: index } = useQuery({ queryKey: ['searchIndex'], queryFn: fetchSearchIndex });
  // Portfolio revenue/occupancy come from the SAME per-property, per-year view the
  // property Financials page reads (v_property_totals) — so the Overview totals match
  // each property exactly, including year-aware escalated rent (effective_rent) and the
  // building-SF occupancy denominator. Summed across properties, keyed by the shared year.
  const propIds = (index?.properties || []).map((p) => p.id);
  const { data: totalsByProp } = useQuery({
    queryKey: ['portfolioTotals', year, propIds.length],
    queryFn: () => listPropertyTotalsByYear(propIds, year),
    enabled: !!index,
  });
  // The same server-synced decision store buildAlerts filters against, read here on its own
  // so a STORED notification can be snoozed too — a notification is a row, not a computed
  // alert, so "remind me next week" has nowhere else to live.
  //
  // ⚠ IT IS ALSO WHAT DECIDES WHETHER AN OVER-PAYMENT IS REVENUE (2026-08-17), which is why
  // the basis query below waits on it rather than fetching its own copy: the Ledger, the
  // month panel and this page all read one cached `['alertStates']`, so answering a surplus
  // there repaints the live counter here without a second round-trip.
  const { data: stateRows = [] } = useQuery({ queryKey: ['alertStates'], queryFn: listAlertStates, ...LIVE_QUERY });
  const notifStates = toAlertStates(stateRows);
  const confirmedOverpay = useMemo(
    () => new Set((stateRows || []).filter((s) => s?.dismissed).map((s) => String(s.alert_key))),
    [stateRows],
  );

  // The live half of the band (2026-08-18). Only the LIVE side needs this: projected Revenue
  // is `total_revenue` — already in `totalsByProp` above, and the same figure the donut sums —
  // and projected CAM & tax comes from `billedComponents` inside the loader. What needs a roll
  // read is cash, because cash has to be apportioned across the months it was billed against.
  //
  // ⚠ THE CONFIRMED SET IS IN THE KEY, not just the argument. An unanswered surplus is held
  // OUT of the live figure; answering it on the Ledger writes an `alert_states` row, and
  // without that fingerprint here the band would keep serving the withheld figure from cache
  // — the landlord would answer and watch nothing happen.
  const overpayFingerprint = useMemo(
    () => [...confirmedOverpay].filter((k) => k.startsWith('overpay')).sort().join('|'),
    [confirmedOverpay],
  );
  const { data: basisByProp } = useQuery({
    queryKey: ['portfolioBasis', year, propIds.length, overpayFingerprint],
    queryFn: () => listBasisByProperty(propIds, year, { confirmed: confirmedOverpay }),
    enabled: !!index,
  });
  // The landlord's per-type notification lead times ("notify me N ahead"). Folded into
  // the alerts key so changing a lead in Settings re-filters the feed immediately.
  const { data: leadPrefs = {} } = useQuery({ queryKey: ['notifyLeadTimes'], queryFn: getNotifyLeadTimes });
  const { data: alerts = [] } = useQuery({
    // Feature/widget prefs + lead times are part of the key so toggling a module or
    // changing a lead re-filters the feed.
    queryKey: ['alerts', enabledFeatures, hidden, leadPrefs],
    queryFn: async () => {
      const leadDays = resolveLeadDays(leadPrefs);
      const ledgerOn = isFeatureOn(enabledFeatures, 'ledger');
      const esignOn = isFeatureOn(enabledFeatures, 'esign');
      const [data, states] = await Promise.all([fetchAlertData({ leadDays, ledgerOn, esignOn }), listAlertStates()]);
      return buildAlerts(data, toAlertStates(states), new Date(), { features: enabledFeatures, hiddenWidgets: hidden, leadDays });
    },
    // The three feeds below all take LIVE_QUERY — same 60s interval they have always run at,
    // plus the refetch-on-focus they lacked. A tenant signs, the landlord reads the email and
    // clicks back to Amlak: without it he waited out the rest of the minute in front of a
    // feed that already knew better. (staleTime is 5min globally, which is why LIVE_QUERY
    // says 'always' rather than true — see liveQuery.js.)
    ...LIVE_QUERY,
  });
  const { data: notifications = [] } = useQuery({ queryKey: ['notifications'], queryFn: listNotifications, ...LIVE_QUERY });

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
  // Yes → apply the renewal. If the option states no rent (the lease left it open), the
  // API returns { needsRent } instead of applying — reveal a rent input and re-call with
  // the figure the landlord types.
  async function confirmRenewal(n, newRent) {
    setBusyNotif(n.id);
    try {
      const opts = newRent != null ? { newRent } : {};
      let res = await confirmRenewalForLease(n.lease_id, new Date(), opts);
      if (res?.needsRent) { setRentEntry({ leaseId: n.lease_id, value: '' }); return; }
      if (res?.needsTermEnd) { window.alert('Set this lease’s term-end date first — a renewal extends the term from where it ends, so there’s nothing to roll forward without it.'); return; }
      // The option books LESS than the rent in effect today — usually a stale option
      // quoting an earlier term's figure. Show both figures before writing anything;
      // the lease page shows the same warning in its own dialog.
      if (res?.needsDecreaseOk) {
        const ok = await askConfirm({
          title: 'Apply a renewal that LOWERS the rent?',
          message: `${res.optionLabel || 'This option'} books ${money(res.newRent)}/yr from ${fmtDate(res.effectiveFrom)}.`,
          implications: [
            `The rent in effect today is ${money(res.currentRent)} — this is ${money(res.currentRent - res.newRent)}/yr less.`,
            'A stated rent well below today’s usually means the option belongs to an earlier term the lease has since been extended past.',
            'An applied option can’t be undone from here.',
          ],
          confirmLabel: 'Apply anyway',
          tone: 'danger',
        });
        if (!ok) return;
        res = await confirmRenewalForLease(n.lease_id, new Date(), { ...opts, acceptDecrease: true });
      }
      setRentEntry(null);
      refreshAfterRenewal();
    } finally { setBusyNotif(null); }
  }
  async function declineRenewal(n) {
    setBusyNotif(n.id);
    try {
      const declinedId = await declineRenewalForLease(n.lease_id);
      if (declinedId) setUndoDecline({ id: declinedId, tenant: (n.title || '').replace(/^Is /, '').replace(/ renewing\?$/, '') || 'this tenant' });
    } finally { setBusyNotif(null); refreshAfterRenewal(); }
  }
  async function undoDeclineNow() { const u = undoDecline; setUndoDecline(null); if (u) { await restoreRenewal(u.id); refreshAfterRenewal(); } }
  // Does this reminder have an outside recipient to email? (Landlord's own insurance
  // policy doesn't — it has no lease/tenant.) Drives whether the ✉ button shows.
  const alertCanEmail = (a) => {
    if (a.focus === 'contract') return true;
    // The cancellation notice HAS an outside recipient — the vendor — and the letter is the
    // whole point of the alert: it drafts the non-renewal notice the contract requires.
    // ⚠ It drafts; it never sends. The ✉ opens the send modal.
    if (a.focus === 'contract_notice') return true;
    // A fee step has no outside party to tell. Dashboard-only, like the lease's own
    // `escalation` focus — your cost going up is not news to the vendor who raised it.
    if (a.focus === 'contract_escalation') return false;
    if (a.focus === 'renewal') return !!a.renewal_id;
    // Every insurance reminder writes to the same tenant, and draftAlertEmail branches on
    // the focus for the right letter: expiry → "please send the renewed certificate",
    // chase-up → the SECOND request (the first ask went unanswered), none-on-file → the
    // plain first request. The landlord's OWN building policy has no lease and no outside
    // recipient, so it correctly gets no ✉.
    if (a.focus === 'insurance' || a.focus === 'insurance_chase' || a.focus === 'insurance_missing') return !!a.lease_id;
    // A raise the tenant never picked up has an outside recipient and a letter already
    // written for it — buildPaymentShortfallEmail, the same one the statement review
    // drafts. It drafts; the landlord sends it himself from the modal.
    return a.focus === 'termination' || a.focus === 'escalation' || a.focus === 'escalation_short';
  };
  // Draft the reminder's ready-to-send email and open the send modal. Sending it does NOT
  // dismiss the reminder — the date still matters until it's actually handled.
  async function emailForAlert(a) {
    const k = alertKey(a);
    setEmailBusyAlert(k);
    setFeedNote(null);
    try {
      const n = await draftAlertEmail(a);
      if (n) setEmailNotif(n);
      // ⚠ NULL IS AN ANSWER, NOT A NO-OP. `draftAlertEmail` returns null when the record the
      // reminder points at is gone — the renewal option applied or the contract deleted in
      // another tab — which means the reminder itself is stale. Silence here read as the
      // button not working, so the landlord clicked it again and again.
      else {
        setFeedNote('That reminder points at a record that no longer exists, so there is nothing to write. Refreshing the list now.');
        qc.invalidateQueries({ queryKey: ['alerts'] });
      }
    } catch (e) {
      setFeedNote(`Couldn't write that letter — ${e?.message || 'the request failed'}. Nothing was sent; try again in a moment.`);
    } finally { setEmailBusyAlert(null); }
  }
  // Make a click-only element keyboard-activatable (Enter/Space) — the role="button"
  // divs/rows below aren't real buttons, so without this they can be focused but not used.
  const keyActivate = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e); } };
  // Dismiss / snooze persist server-side (alert_states) so they sync across devices.
  // Where clicking an alert takes the landlord.
  function goToAlert(a) {
    if (a.focus === 'annual_report') navigate('/leases'); // corporations grid → Annual report button
    // All three ledger reminders land on the Ledger grid — where ⬆ Import statement lives
    // and where a month's cell can be marked paid — rather than the lease page. The raise
    // one especially: its evidence IS the row (the ↗ note, the month boxes, the short
    // chip), none of which exists on the lease page.
    else if ((a.focus === 'statement_reminder' || a.focus === 'missing_payment' || a.focus === 'escalation_short') && a.property_id) navigate(`/financials/${a.corporation_id}/${a.property_id}/ledger`);
    // The three contract focuses, plus anything anchored to a contract rather than a lease —
    // which is how a signature alert on a contract envelope (0093) finds its way to the
    // Contracts tab instead of falling through to a lease page it doesn't have.
    else if ((a.focus === 'contract' || a.focus === 'contract_notice' || a.focus === 'contract_escalation'
              || (a.contract_id && !a.lease_id)) && a.property_id) navigate(`/leases/${a.corporation_id}/${a.property_id}/contracts`);
    else if (a.lease_id) navigate(`/leases/${a.corporation_id}/${a.property_id}/${a.lease_id}?focus=${a.focus || ''}`);
    else navigate(`/leases/${a.corporation_id}`);
  }

  // Dismiss / snooze both write one alert_states row. Keyed by alertKey for a computed
  // alert and by notificationKey for a stored one, so the two share this plumbing and can
  // present the identical row of controls.
  async function clearAlert(a) {
    try {
      await upsertAlertState({ alert_key: alertKey(a), dismissed: true });
      qc.invalidateQueries({ queryKey: ['alerts'] });
    } catch (e) {
      setFeedNote(`Couldn't dismiss that reminder — ${e?.message || 'the request failed'}. It is still on the list.`);
    }
  }
  async function snoozeKey(key, ms) {
    try {
      await upsertAlertState({ alert_key: key, snoozed_until: new Date(Date.now() + ms).toISOString() });
      setSnoozeFor(null);
      qc.invalidateQueries({ queryKey: ['alerts'] });
      qc.invalidateQueries({ queryKey: ['alertStates'] });
    } catch (e) {
      setFeedNote(`Couldn't snooze that reminder — ${e?.message || 'the request failed'}. It will keep showing.`);
    }
  }

  const leases = (index?.leases || []).filter((l) => l.is_active !== false);
  const properties = index?.properties || [];

  // Leased SF / occupancy summed from the property-page view (year-aware), so the
  // Overview never disagrees with what each property shows. buildingSf from the view is
  // already coalesced to leased SF when a property has no building size entered. Feeds
  // the page-head subtitle; the charts below compute their own from the same rows.
  const totalsList = Object.values(totalsByProp || {});
  const leasedSf = totalsList.reduce((s, t) => s + (Number(t.total_sf) || 0), 0);
  const buildingSf = totalsList.reduce((s, t) => s + (Number(t.building_sf) || 0), 0);
  const occupancy = buildingSf > 0 ? Math.round((leasedSf / buildingSf) * 100) : null;

  // The headline band's three pairs. Revenue is the year the leases contract to bill — every
  // applied step dated to its own month, plus the months a scheduled step will re-price — and it
  // is the SAME `rentProjected` `revenueByProperty` sums for the donut below. That identity is
  // the whole point of the rebuild and is asserted in portfolioCharts.test.js; it is also why
  // `basisByProp` now goes to BOTH, rather than the band deriving one figure and the donut
  // reading a view (2026-08-18 (3)).
  const bandRows = basisRows(properties, totalsByProp, basisByProp);
  const bandTotals = bandRows.length ? portfolioBasis(bandRows) : null;
  // …and WHY the two readings differ, from the same rows. Nothing is read for this: the causes
  // ride on the rows `listBasisByProperty` already built (CLAUDE.md §2 — one reading of the
  // year, not two). Null while the live side is still loading, so the panel never states a gap
  // it is about to revise.
  const bandBridge = bandRows.length && !bandTotals?.loading ? yearBridge(bandRows, { year }) : null;
  // Where each caveat sends the landlord: the property carrying the MOST of it. A caveat
  // that names a figure and then can't say where to fix it is a complaint, not a prompt —
  // and with one property that link is simply the right one anyway.
  const worstBy = (key) => bandRows.reduce((best, r) => (r[key] > (best?.[key] || 0) ? r : best), null);
  const hrefFor = (row, tab) => {
    const p = row ? properties.find((x) => x.id === row.id) : null;
    return p ? `/financials/${p.corporation_id}/${p.id}${tab}` : null;
  };
  // ⚠ The Ledger tab is hidden when the module is off (FinancialsTabs.js), so the link has
  // to be too — pointing a landlord at a tab that isn't there is the worst version of §7.
  const ledgerHref = isFeatureOn(enabledFeatures, 'ledger') ? hrefFor(worstBy('unapplied'), '/ledger') : null;
  const incomeHref = hrefFor(worstBy('otherLive'), '');

  // Which blocks to render, per the landlord's Display settings.
  const showCharts = show('portfolio_charts');
  const showAlerts = show('alerts');
  const nothingShown = !showCharts && !showAlerts;

  // Everything that wants attention, in ONE list ordered most urgent first. A snoozed
  // notification drops out until its time is up (alerts are already filtered inside
  // buildAlerts against the same store).
  const liveNotifications = notifications.filter((n) => !notificationSnoozed(n, notifStates));
  const feed = buildFeed(liveNotifications, alerts);
  // …then split into one column per kind of thing, so the whole feed reads across the
  // page instead of down it. Empty columns still render ("All clear") so the headings
  // stay put — George's pick.
  const columns = groupFeed(feed);

  // An alert names a lease or a property by id but never by name, so the "who and where"
  // line is joined here from the search index the page has already loaded — no extra query.
  const propNameById = Object.fromEntries(properties.map((p) => [p.id, p.name]));
  const tenantByLeaseId = Object.fromEntries((index?.leases || []).map((l) => [l.id, l.tenant_name]));
  // Where an alert sits: "City Dental · Maple Plaza". Falls back to whichever half is known.
  function alertWhere(a) {
    const who = a.tenant || tenantByLeaseId[a.lease_id] || null;
    const where = propNameById[a.property_id] || null;
    return [who, where].filter(Boolean).join(' · ');
  }

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

      {/* ⚠ THE FIRST SCREEN A NEW ACCOUNT EVER SEES, and it used to be eight columns of "All
          clear" over a portfolio that has never held a record — a page reporting the absence
          of problems to someone who has no properties, with nothing on it to click. "All
          clear" is the right answer for a landlord whose buildings are in order and the wrong
          one for a client who hasn't started; the difference is whether anything exists yet.
          Everything below still renders, so this replaces nothing — it just says what to do. */}
      {properties.length === 0 && (
        <div className="callout" style={{ marginBottom: 16, borderLeftColor: 'var(--accent)' }}>
          <div className="alert-main">
            <div className="alert-title"><strong>Welcome — nothing here yet</strong></div>
            <div className="muted">
              This page fills in on its own once your buildings are in. Start in{' '}
              <Link to="/leases">Portfolio</Link>: add the company that holds the property, then the
              property itself, then a tenant — the rent, CAM and reminders all follow from those three.
              You can upload a lease PDF and let Amlak read the terms out of it.
            </div>
          </div>
        </div>
      )}

      {/* ⚠ ABOVE the chart band, not inside it — George, 2026-08-18: *"that should be way
          more prominent in the overview page graphs."* It is the sentence the four panels
          below elaborate on, and it shares their one Display-settings switch rather than
          taking a second, which would let a landlord hide half of one idea. */}
      {showCharts && <BasisBand totals={bandTotals} bridge={bandBridge} year={year} ledgerHref={ledgerHref} incomeHref={incomeHref} anchorRef={setBasisEl} flashing={basisFlash} />}

      {showCharts && <PortfolioCharts properties={properties} totalsByProp={totalsByProp} basisByProp={basisByProp} leases={leases} year={year} />}

      {nothingShown && (
        <div className="panel">
          <p className="empty-line muted" style={{ margin: 0 }}>
            You’ve hidden every Overview widget. Turn them back on any time in <Link to="/display">Display settings</Link>.
          </p>
        </div>
      )}

      {showAlerts && (
        <div className="panel">
          <div className="panel-head">
            <strong>Alerts &amp; notifications</strong>
            <span className="muted">{feed.length} active</span>
          </div>
          {/* Just declined a renewal? Offer an immediate, friendly undo. */}
          {undoDecline && (
            <div className="callout" style={{ marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center', borderLeftColor: 'var(--accent)' }}>
              <div style={{ flex: 1 }}>
                <div className="alert-title"><strong>Marked {undoDecline.tenant} as not renewing.</strong></div>
                <div className="muted" style={{ fontSize: 12.5 }}>Changed your mind? You can put it back to pending.</div>
              </div>
              <button className="secondary" onClick={undoDeclineNow}>↩ Undo</button>
              <button className="icon-btn dismiss-x" title="Dismiss" onClick={() => setUndoDecline(null)}>✕</button>
            </div>
          )}
          {/* One column per kind of thing. Stored notifications and computed alerts are
              still ONE urgency-ordered feed (buildFeed) — groupFeed only deals them into
              columns, so the order inside each is unchanged. */}
          {feedNote && (
            <div className="note-msg" style={{ color: '#b42318', margin: '6px 0 10px', fontSize: 12.5 }} role="status">
              {feedNote}{' '}
              <button type="button" className="ghost btn-sm" onClick={() => setFeedNote(null)}>Dismiss</button>
            </div>
          )}
          <div className="notif-board">
            {columns.map((col) => (
              <div key={col.key} className="notif-col">
                <div className="notif-col-head">
                  <span>{col.label}</span>
                  {col.rows.length > 0 && <span className="notif-count">{col.rows.length}</span>}
                </div>
                {col.rows.length === 0 ? (
                  <p className="notif-clear">All clear</p>
                ) : (
                  // The LAST row of a column opens its hover panel upward: it is the one
                  // sitting against the bottom of the board, where a downward panel would
                  // spill out of the panel and stretch the page's scroll height.
                  col.rows.map((row, i) => {
                    const up = i === col.rows.length - 1;
                    return row.type === 'notification'
                      ? renderNotification(row.item, up)
                      : renderAlert(row.item, i, up);
                  })
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {emailNotif && (
        <NotificationEmailModal
          notif={emailNotif}
          onClose={() => setEmailNotif(null)}
          onSend={async ({ to, subject }) => {
            // Record COI requests sent straight from the insurance-expiry reminder, so the
            // tenant's Insurance panel shows "Last requested" just like the lease-page button.
            if (emailNotif.kind === 'insurance_request' && emailNotif.lease_id) {
              await logInsuranceRequest({ propertyId: emailNotif.property_id, leaseId: emailNotif.lease_id, tenantName: emailNotif.tenant_name, to, subject });
              qc.invalidateQueries({ queryKey: ['insuranceRequests', emailNotif.lease_id] });
              qc.invalidateQueries({ queryKey: ['historyEvents', emailNotif.property_id] });
            }
          }}
          onSent={async () => {
            // The "renewal approaching" email rides on the still-open decision prompt —
            // sending it must NOT dismiss the Yes/No prompt. A reminder-drafted email has
            // no stored notification (no id) — nothing to dismiss. Terminal notices
            // (renewed / not renewing) dismiss on send as before.
            if (emailNotif.id && emailNotif.kind !== 'renewal_decision') await clearNotification(emailNotif.id);
            setEmailNotif(null);
          }}
        />
      )}
    </div>
  );

  // ---- feed rows -------------------------------------------------------------
  // Kept as functions rather than components so they close over the page's handlers
  // and state exactly as they did when they were two inline maps; only the ORDER of
  // the rows changed.

  // The controls every row in this list carries, in one place — ✉ · remind me later · ✕.
  // They used to be written twice: a computed alert had this column, while a stored
  // notification had a wordy "✉ View / send tenant email" link buried in its body and no
  // snooze at all, so two rows asking for the same kind of decision (the renewal Yes/No
  // prompt beside a renewal-notice alert) read as different kinds of thing.
  //
  // `onEmail` null = nothing to write to, so no ✉. `ignore` swaps the bare ✕ for a
  // labelled Ignore and drops the clock (see isLongPast — nothing to defer to).
  function rowActions({ k, onEmail, emailTitle, emailBusy = false, onSnooze, onDismiss, ignore = false, ignoreTitle }) {
    return (
      <div style={{ display: 'flex', gap: 4, position: 'relative' }}>
        {onEmail && (
          <button className="icon-btn" title={emailTitle} aria-label="Email reminder" disabled={emailBusy} onClick={onEmail}>
            {emailBusy ? '…' : '✉'}
          </button>
        )}
        {!ignore && (
          <button className="icon-btn" title="Remind me later" aria-label="Remind me later" onClick={() => setSnoozeFor(snoozeFor === k ? null : k)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5V12l3 2" />
            </svg>
          </button>
        )}
        {ignore ? (
          <button className="ghost btn-sm alert-ignore" title={ignoreTitle} onClick={onDismiss}>Ignore</button>
        ) : (
          <button className="icon-btn dismiss-x" title="Dismiss" onClick={onDismiss}>✕</button>
        )}
        {snoozeFor === k && (
          <div className="snooze-menu" style={{ position: 'absolute', top: '100%', right: 0, zIndex: 5, background: 'var(--surface, #fff)', border: '1px solid var(--line, #ddd)', borderRadius: 8, padding: 6, boxShadow: '0 6px 20px rgba(0,0,0,.12)', minWidth: 130 }}>
            <div className="muted" style={{ fontSize: 11, padding: '2px 8px 6px' }}>Remind me…</div>
            {SNOOZE_OPTIONS.map((o) => (
              <button key={o.label} className="ghost" style={{ display: 'block', width: '100%', textAlign: 'left', fontSize: 12.5 }} onClick={() => onSnooze(o.ms)}>{o.label}</button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // An update that already happened (rent applied, lease renewed) — dismiss only —
  // or the renewal Yes/No prompt, which is a question waiting on an answer.
  function renderNotification(n, popUp = false) {
    const k = notificationKey(n);
    const go = () => n.lease_id && navigate(`/leases/${n.corporation_id}/${n.property_id}/${n.lease_id}`);
    // A question waiting on an answer keeps its buttons visible and its controls out of
    // the hover-reveal; everything else in the bell has already happened.
    const decision = n.kind === 'renewal_decision';
    return (
                <div key={n.id} className={`callout nrow${decision ? ' has-decision warn' : ''}`}>
                  <div className="nrow-line">
                    <span className={`nrow-dot ${decision ? 'warn' : 'done'}`} aria-hidden="true" />
                    <span className="nrow-subject" role="button" tabIndex={0}
                      onClick={go} onKeyDown={keyActivate(go)}>
                      {rowSubject(n)}
                    </span>
                    {rowActions({
                      k,
                      onEmail: n.email_body ? () => setEmailNotif(n) : null,
                      emailTitle: 'View / send the tenant email',
                      onSnooze: (ms) => snoozeKey(k, ms),
                      onDismiss: () => clearNotification(n.id),
                    })}
                  </div>
                  <div className="nrow-body">
                    {decision && (
                      rentEntry?.leaseId === n.lease_id ? (
                        <div style={{ marginTop: 8 }}>
                          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                            This option’s rent wasn’t set in the lease — enter the agreed new base rent to apply it.
                          </div>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                            <label className="form-field" style={{ marginBottom: 0, maxWidth: 180 }}>
                              <span>New base rent ($/yr)</span>
                              <input className="text-input num" type="number" step="any" autoFocus value={rentEntry.value}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setRentEntry({ leaseId: n.lease_id, value: e.target.value })} />
                            </label>
                            <button className="secondary" disabled={busyNotif === n.id || !(Number(rentEntry.value) > 0)}
                              onClick={(e) => { e.stopPropagation(); confirmRenewal(n, Number(rentEntry.value)); }}>
                              {busyNotif === n.id ? 'Working…' : 'Apply renewal'}
                            </button>
                            <button className="ghost" disabled={busyNotif === n.id}
                              onClick={(e) => { e.stopPropagation(); setRentEntry(null); }}>Cancel</button>
                          </div>
                        </div>
                      ) : (
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
                      )
                    )}
                  </div>
                  <UrgencyBar tone={decision ? 'warn' : ''} fill={rowFill({ type: 'notification', item: n })} />
                  <RowPopover up={popUp} title={n.title} detail={n.body}
                    foot={n.created_at ? fmtDate(String(n.created_at).slice(0, 10)) : null} />
                </div>
    );
  }

  // A key date, on one line. Everything the old three-line row carried — the full title,
  // the who/where, the detail, the bucket and the date — moves into the hover panel rather
  // than being dropped: the column heading says what kind of thing it is, and the subject
  // + countdown are what a landlord scans for.
  function renderAlert(a, i, popUp = false) {
    const k = alertKey(a);
    const where = alertWhere(a);
    return (
                <div key={`${k}-${i}`} className={`callout nrow ${a.tone || 'info'}`}>
                  <div className="nrow-line">
                    <span className={`nrow-dot ${a.tone || 'info'}`} aria-hidden="true" />
                    <span className="nrow-subject" role="button" tabIndex={0}
                      onClick={() => goToAlert(a)}
                      onKeyDown={keyActivate(() => goToAlert(a))}>
                      {rowSubject(a)}
                    </span>
                    <AlertCountdown alert={a} />
                    {/* Long past its date? There is nothing to defer to and nothing to count
                        down — so the clock goes and the ✕ becomes a labelled Ignore that says
                        what it does. Same dismissal either way. */}
                    {rowActions({
                      k,
                      onEmail: alertCanEmail(a) ? () => emailForAlert(a) : null,
                      emailTitle: 'Email a ready-to-send reminder',
                      emailBusy: emailBusyAlert === k,
                      onSnooze: (ms) => snoozeKey(k, ms),
                      onDismiss: () => clearAlert(a),
                      ignore: isLongPast(a),
                      ignoreTitle: 'Stop showing this — its date is long past',
                    })}
                  </div>
                  <UrgencyBar tone={a.tone} fill={rowFill({ type: 'alert', item: a })} />
                  <RowPopover
                    up={popUp}
                    title={a.title} where={where} detail={a.detail} action={a.action}
                    extras={alertExtras(a)}
                    foot={[a.bucketLabel, a.date ? fmtDate(a.date) : null].filter(Boolean).join(' · ')}
                  />
                </div>
    );
  }
}

// The extra facts an alert carries that the one-line row can't show. Insurance is the one
// family where the row's subject genuinely isn't enough — "No certificate on file — City
// Dental" doesn't say whether anyone has asked, which is the distinction George wanted
// visible ("if the insurance was requested, that should be a different type of
// notification … if it hasn't been requested, that should be known as well"). Any alert
// type can grow entries here by stamping the fields in buildAlerts.
function alertExtras(a) {
  const out = [];
  if (a.insurer) out.push(['Insurer', a.insurer]);
  if (a.expiry_date) out.push([a.expired ? 'Expired' : 'Expires', fmtDate(a.expiry_date)]);
  if (a.requested_on) out.push(['Last requested', fmtDate(a.requested_on)]);
  else if (a.focus === 'insurance_missing' && a.party === 'tenant') out.push(['Last requested', 'Never']);
  // Every contract alert rendered a BLANK hover panel until now — it carried the vendor and
  // the dates all along and simply listed none of them.
  if (a.contract_id) {
    if (a.contract_name) out.push(['Contract', a.contract_name]);
    if (a.vendor_email) out.push(['Vendor email', a.vendor_email]);
    if (a.focus === 'contract_notice') {
      if (a.notice_days) out.push(['Notice required', `${a.notice_days} days`]);
      if (a.contract_end) out.push(['Term ends', fmtDate(a.contract_end)]);
      out.push(['Renews itself', a.auto_renew === true ? (a.renewal_term_months ? `Yes — ${a.renewal_term_months} more months` : 'Yes') : a.auto_renew === false ? 'No' : 'Not stated']);
    }
    if (a.focus === 'contract_escalation' && a.new_amount != null) out.push(['New fee', money(a.new_amount)]);
  }
  // A raise that went unpaid is three figures or it's an accusation with no evidence:
  // what the lease now bills a month, how much of that is the increase, and how far under
  // the money is landing. The same three the Ledger row states, from the same fields.
  if (a.focus === 'escalation_short') {
    if (a.owedMonthly) out.push(['Scheduled rent', `${money(a.owedMonthly)}/mo`]);
    if (a.stepAmount) out.push(['The increase', `${money(a.stepAmount)}/mo`]);
    if (a.shortPerMonth) out.push(['Coming in short', `${money(a.shortPerMonth)}/mo`]);
  }
  return out;
}

// The hover panel — George, 2026-07-30: "if I hover over one of the insurance
// notifications, it kind of expands and tells me more in-depth details."
//
// It replaces the native `title=` the compact rows shipped with. A browser tooltip is
// slow, unstyleable and can't lay out label/value pairs — and with a real panel there
// would have been two tooltips fighting on one row. Positioned left:0/right:0 against the
// row, so it is exactly the column's width: it reads as the row expanding downward over
// its neighbours, and can never push the board sideways however narrow the window gets.
//
// aria-hidden because everything in here is already reachable — the row's own subject, and
// the alert's page one click away. It stays in the DOM (hidden by CSS, not unmounted) so
// there is no hover-latency and so a test can read it.
function RowPopover({ title, where, detail, extras = [], action, foot, up = false }) {
  return (
    <div className={`nrow-pop${up ? ' nrow-pop-up' : ''}`} aria-hidden="true">
      <div className="nrow-pop-title">{title}</div>
      {where && <div className="nrow-pop-where">{where}</div>}
      {detail && <p className="nrow-pop-detail">{detail}</p>}
      {extras.length > 0 && (
        <dl className="nrow-pop-facts">
          {extras.map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
      )}
      {action && <p className="nrow-pop-action">{action}</p>}
      {foot && <div className="nrow-pop-foot">{foot}</div>}
    </div>
  );
}

// The urgency bar, back as an actual bar. It ran as a 2px hairline with a transparent
// track after the row was compacted, which reads as a stray rule rather than a measure —
// George, 2026-07-30: "I still want progress bars for the alerts and notifications." Now
// a visible track with a coloured fill, still on the row's bottom edge so the row stays
// one line tall.
function UrgencyBar({ tone, fill }) {
  const cls = tone === 'danger' ? 'danger' : tone === 'warn' ? 'warn' : '';
  return (
    <div className={`alert-progress ${cls}`} aria-hidden="true">
      <span style={{ width: `${Math.round(Math.max(0, Math.min(1, fill || 0)) * 100)}%` }} />
    </div>
  );
}

// The Overview feed: stored notifications and computed alerts in ONE ordered list.
//
// They used to render as two blocks — every notification first, unsorted, then the alerts
// — so an "escalation applied ✓" notice sat above a lease already in holdover. Both are
// now ranked by the shared rule in alerts.js, exported here so a test can pin the order
// without rendering the page.
export function buildFeed(notifications = [], alerts = []) {
  return [
    ...notifications.map((n) => ({ type: 'notification', item: n, key: notificationUrgency(n) })),
    ...alerts.map((a) => ({ type: 'alert', item: a, key: alertUrgency(a) })),
  ]
    .sort((x, y) => compareUrgencyKeys(x.key, y.key))
    .map(({ type, item }) => ({ type, item }));
}

// A stored notification carries no date to count down to. The renewal Yes/No prompt is a
// question waiting on an answer, so it ranks with the other standing problems; everything
// else in the bell has already happened (rent applied, lease renewed) and is for
// information — newest first.
function notificationUrgency(n) {
  if (n?.kind === 'renewal_decision') return [URGENCY_TIER.standing, 1, 0];
  const ms = n?.created_at ? new Date(n.created_at).getTime() : 0;
  return [URGENCY_TIER.fyi, -(Number.isFinite(ms) ? ms : 0), 0];
}

// Anything inside this many days is close in plain terms, whatever notice window the
// alert belongs to.
const SOON_DAYS = 90;

// How full the urgency bar runs — fuller means sooner, empty means plenty of time, and a
// date already passed is pinned full.
//
// It's the FULLER of two readings, because one alone lies in a way the landlord would
// notice. Measured only against the alert's own notice window, a filing due in 30 days on
// a 31-day lead reads nearly empty — technically "you've barely used your notice period",
// visibly nonsense next to the words "30 days left". Measured only against a fixed scale,
// a lease ending in 150 days on a 183-day lead reads empty right up until it isn't, and
// the window the landlord chose stops meaning anything.
//
// So: how close the date is in absolute terms (dominant inside ~3 months), OR how far
// through this reminder's own window we are (what gives a long-lead alert a rising bar
// before it gets close) — whichever is further along. Never quite zero, so a bar always
// reads as a bar rather than an empty box.
export function urgencyFill(days, horizonDays) {
  if (days == null || !(horizonDays > 0)) return null;
  if (days < 0) return 1;
  const soon = 1 - days / SOON_DAYS;              // absolute closeness
  const window = 1 - days / horizonDays;          // progress through this alert's own lead
  return Math.min(1, Math.max(0.04, soon, window));
}

// How full one FEED row's bar runs. Every row has a bar now, so that reading down a column
// the bars descend — George's "descending from most urgent to least urgent in terms of
// days" made visible, rather than an order you have to take on trust.
//
// Three cases, because `days` doesn't mean one thing across the feed:
//   • a dated alert           → urgencyFill: fuller as its date approaches
//   • a STANDING row          → pinned FULL. It has no deadline to measure, but it ranks
//     (no horizonDays, and the   above everything merely upcoming precisely because it's a
//      renewal Yes/No prompt)    problem right now — money not received, a certificate
//                                never sent, a question waiting on an answer. An empty bar
//                                mid-column would break the descent it genuinely belongs to.
//   • an update that already   → EMPTY. Nothing is pending; the empty track confirms it.
//     happened (rent applied)
export function rowFill({ type, item } = {}) {
  if (type === 'notification') return item?.kind === 'renewal_decision' ? 1 : 0;
  return urgencyFill(item?.days, item?.horizonDays) ?? 1;
}

// "118d" · "63d over" — how soon, in the width of a chip, because how soon is the whole
// point of a reminder. Stays SILENT for alerts that have no real countdown: the three
// weight-based focuses carry a sort weight in `days`, not a date, and "−2d" would be a
// fabrication (see the horizonDays note in alerts.js). The chip tints with the same
// urgencyFill the hairline uses, so the signal survives at one line tall.
function AlertCountdown({ alert }) {
  if (alert.horizonDays == null || alert.days == null) return null;
  const over = alert.days < 0;
  const n = Math.abs(alert.days);
  const fill = urgencyFill(alert.days, alert.horizonDays) ?? 0;
  return (
    <span
      className={`alert-days ${alert.tone || ''}`}
      style={{ '--fill': fill }}
      title={over ? `${n} day${n === 1 ? '' : 's'} past its date` : `${n} day${n === 1 ? '' : 's'} left`}
    >
      {n}d{over ? <span className="alert-days-cap"> over</span> : null}
    </span>
  );
}

