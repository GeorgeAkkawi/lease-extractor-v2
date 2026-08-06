import { fmtDate, money0 } from './format';
import { DEFAULT_LEAD_DAYS } from './notifyPrefs';
import { optionLapseReason } from './renewals';
import { nextContractStep } from './contracts';

const DAY = 86400000;

// The landlord's LOCAL calendar date, matching api.js's localDateIso — so a lapse judged
// here can't disagree with the badge the lease page shows for the same option.
const localIso = (now) => {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// "June" · "May and June" · "April, May and June" · "January, February, March and 3 more"
// — readable in a one-line alert detail without ever running long.
function joinMonths(names, cap = 3) {
  if (names.length <= 1) return names[0] || '';
  if (names.length <= cap + 1) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, cap).join(', ')} and ${names.length - cap} more`;
}

// Dismiss / snooze of computed alerts are stored SERVER-SIDE (table alert_states),
// keyed by this stable alert_key, so they sync across the landlord's devices. A
// contract or annual-report alert has no lease, so its own id anchors the key (falls
// back to lease_id for every other alert type, keeping existing saved keys stable).
// property_id is the last resort — only the statement reminder reaches it, so adding it
// can't disturb any key already saved.
// ⚠ A NEW ALERT TYPE WITH ITS OWN ENTITY MUST BE ADDED TO THIS CHAIN. The anchor falls
// through to lease_id / property_id, so an alert keyed on something else collapses to
// `focus:undefined:date` — and every such alert then shares ONE dismissal. envelope_id sits
// FIRST because a signature alert also carries a lease_id (it is about a lease), which would
// otherwise make two envelopes on the same lease dismiss each other.
export const alertKey = (a) => `${a.focus}:${a.envelope_id || a.contract_id || a.report_id || a.lease_id || a.property_id}:${a.date}`;

// A STORED notification (the bell's "Is X renewing?", "rent applied ✓") lives in its own
// table and is dismissed by deleting the row — so it never needed a key. Snoozing does:
// "remind me next week" has to survive a reload without throwing the row away. It reuses
// the same server-synced alert_states store under its own namespace, which can't collide
// with an alertKey (those read `focus:id:date`). The row id is stable for as long as the
// prompt is open — promptDueRenewalDecisions updates an existing prompt rather than
// recreating it — so a snooze holds until the deadline it was deferred from.
export const notificationKey = (n) => `notification:${n?.id}`;

// Is this notification currently snoozed? Same lookup shape as the alert filter.
export const notificationSnoozed = (n, states = {}, nowMs = Date.now()) =>
  states.snoozedUntil?.[notificationKey(n)] > nowMs;

// Transform alert_states rows (from listAlertStates) into the lookup buildAlerts
// filters against: a Set of dismissed keys + a { key: untilMs } snooze map.
export function toAlertStates(stateRows) {
  const dismissed = new Set();
  const snoozedUntil = {};
  (stateRows || []).forEach((r) => {
    if (r.dismissed) dismissed.add(r.alert_key);
    if (r.snoozed_until) snoozedUntil[r.alert_key] = new Date(r.snoozed_until).getTime();
  });
  return { dismissed, snoozedUntil };
}

// How the Overview feed ranks what needs attention — "most urgent to least urgent by
// time left to handle", which is the one thing a plain `days` sort could NOT do.
//
// `days` is not one quantity. On a dated alert it counts down to a real deadline; on the
// three weight-based focuses (statement_reminder, missing_payment, insurance_chase) it is
// a sort weight that merely looks like days. Sorting them together put a statement
// reminder at −3 above a lease that ended five days ago. The presence of `horizonDays` is
// what separates the two — the same field the countdown and the urgency bar test, so a
// new alert type opts in to a real countdown and to this ordering in one stroke.
//
// Four tiers, most urgent first:
//   0  a date that has already passed          — longest overdue first
//   1  a standing problem with no date         — most severe first, then by weight
//   2  a date still ahead                      — soonest first
//   3  already happened, for information       — newest first (notifications only)
//
// Tier 1 is the honest home for the weight-based alerts: they ARE overdue in substance —
// money not received, a statement never imported, a certificate asked for and never sent —
// but have no deadline to count, so they rank above anything merely upcoming without
// pretending to a countdown they don't have.
export const URGENCY_TIER = { overdue: 0, standing: 1, upcoming: 2, fyi: 3 };
const TONE_RANK = { danger: 0, warn: 1, info: 2 };

// The sort key as a fixed-length tuple, compared left to right by compareUrgencyKeys.
export function alertUrgency(a) {
  const days = a?.days;
  const dated = a?.horizonDays != null && days != null;
  if (dated && days < 0) return [URGENCY_TIER.overdue, days, 0];
  if (!dated) return [URGENCY_TIER.standing, TONE_RANK[a?.tone] ?? 3, days ?? 0];
  return [URGENCY_TIER.upcoming, days, 0];
}

// Compares two urgency tuples. Ties return 0, and Array#sort is stable, so equal-urgency
// rows keep the order they arrived in rather than shuffling between renders.
export function compareUrgencyKeys(x, y) {
  for (let i = 0; i < 3; i += 1) {
    const d = (x?.[i] ?? 0) - (y?.[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

// An alert whose date passed more than a year ago is history, not a deadline — a
// countdown of "6,540 days over" tells the landlord nothing they can act on, and the bare
// ✕ reads as a temporary tidy-up rather than "stop showing me this". Those rows get an
// explicit, labelled **Ignore** instead (and no snooze — there is nothing to defer to).
// Dismissal is the same server-side alert_states write, so it syncs across devices.
export const LONG_PAST_DAYS = 365;
export const isLongPast = (a) => a?.horizonDays != null && a?.days != null && a.days < -LONG_PAST_DAYS;

// Snooze presets offered in the UI (label + duration to add to "now").
export const SNOOZE_OPTIONS = [
  { label: 'In 1 hour', ms: 3600_000 },
  { label: 'In 1 day', ms: 86_400_000 },
  { label: 'In 1 week', ms: 7 * 86_400_000 },
];

export function daysUntil(iso, now = new Date()) {
  if (!iso) return null;
  return Math.round((new Date(iso + 'T12:00:00') - now) / DAY);
}

// Bucket a date by proximity, showing it only within `horizonDays` (the owner's
// configured "notify me N days ahead" for that type). The near buckets (≤1 month)
// keep the urgent tones that match the reminder-email schedule; farther buckets are
// toned calm (info) so a far-off date reads as "on the radar", not "act now". Overdue
// always shows regardless of the horizon. Beyond 6 months (a lead the owner set long)
// the label is computed ("Within N months").
export function bucketFor(iso, now = new Date(), horizonDays = 183) {
  const d = daysUntil(iso, now);
  if (d == null) return null;
  if (d < 0) return { key: 'overdue', label: 'Overdue', tone: 'danger' };
  if (d > horizonDays) return null; // farther out than the owner wants to be notified
  if (d <= 7) return { key: '1w', label: 'Within 1 week', tone: 'danger' };
  if (d <= 14) return { key: '2w', label: 'Within 2 weeks', tone: 'warn' };
  if (d <= 31) return { key: '1m', label: 'Within 1 month', tone: 'warn' };
  if (d <= 92) return { key: '3m', label: 'Within 3 months', tone: 'warn' };
  if (d <= 183) return { key: '6m', label: 'Within 6 months', tone: 'info' };
  const months = Math.round(d / 30.44);
  return { key: 'far', label: `Within ${months} months`, tone: 'info' };
}

// The default 6-month horizon, kept as `bucket()` so the two label-only callers
// (abatement / annual-report, which gate on their own day counts) are unchanged.
export function bucket(iso, now = new Date()) {
  return bucketFor(iso, now, 183);
}

// null / undefined enabled set = "never chosen" = everything on. Mirrors
// isFeatureOn() in features.js; kept inline so this leaf module stays free of the
// react-query import that features.js carries.
const featureOn = (enabled, key) => (enabled == null ? true : enabled.includes(key));

// Derive urgent alerts from lease key dates (escalations / termination / renewal
// notice). `states` is the server dismiss/snooze lookup from toAlertStates().
//
// A date-driven alert also carries **horizonDays** — the window it became visible in
// (the owner's configured lead for that type, or a lease's own notify_lease_end_days
// override). This is the only place that window is known, and the Overview needs it to
// draw urgency honestly: "30 days out" is nearly here on a 31-day annual-report lead and
// barely a blip on a 183-day lease-end one, so a bar has to be filled against the alert's
// OWN horizon, not a fixed scale.
//
// Three focuses deliberately carry NO horizonDays, because their `days` is a sort weight
// rather than a count of days remaining: statement_reminder (−months.length),
// missing_payment (−10 − months.length) and insurance_chase (days SINCE the request, so
// always negative). Rendering any of them as "N days over" would be a lie; the UI checks
// for the field rather than the focus, so a new alert type opts in simply by stamping it.
//
// `opts` ties the alert feed to the Settings switchboard so a notification silences
// with the module it belongs to (and returns when re-enabled):
//   • features      — the enabled_features array (null = all on). Gates Insurance
//                     (expiry + chase-up) and Service-contract alerts.
//   • hiddenWidgets — the hidden_widgets array (reserved; no widget currently gates an alert).
// Core lease dates (escalations, term end, renewals) are never gated here.
export function buildAlerts(
  { leases, escalations, renewals, properties, insurance, contracts, contractSteps, abatements, insuranceRequests, annualReports, corporations, unloggedMonths, missingPayments, envelopes },
  states = { dismissed: new Set(), snoozedUntil: {} },
  now = new Date(),
  { features = null, hiddenWidgets = [], leadDays = null } = {}, // eslint-disable-line no-unused-vars
) {
  const insuranceOn = featureOn(features, 'insurance');
  const contractsOn = featureOn(features, 'contracts');
  const ledgerOn = featureOn(features, 'ledger');
  const esignOn = featureOn(features, 'esign');
  // How far ahead each type notifies — the owner's saved lead, else the default. A null
  // map (never configured) uses the defaults, which equal the prior hard-coded horizons,
  // so an untouched account produces byte-identical alerts.
  const lead = (key) => (leadDays?.[key] ?? DEFAULT_LEAD_DAYS[key]);

  const propMap = Object.fromEntries((properties || []).map((p) => [p.id, p]));
  const leaseById = Object.fromEntries((leases || []).map((l) => [l.id, l]));
  const escByLease = {};
  (escalations || []).forEach((e) => { (escByLease[e.lease_id] ||= []).push(e); });
  const renByLease = {};
  (renewals || []).forEach((r) => { (renByLease[r.lease_id] ||= []).push(r); });

  const out = [];
  (leases || []).forEach((l) => {
    if (l.is_active === false) return; // outdated/parked leases don't raise date alerts
    const corpId = propMap[l.property_id]?.corporation_id;
    const ctx = { lease_id: l.id, property_id: l.property_id, corporation_id: corpId, tenant: l.tenant_name };

    (escByLease[l.id] || []).filter((e) => e.status === 'scheduled').forEach((e) => {
      // A step dated on/after the committed term end belongs to an un-exercised renewal
      // option — don't alert on it until the renewal is confirmed (which extends the term).
      if (l.lease_termination_date && String(e.effective_date) >= String(l.lease_termination_date)) return;
      const escLead = lead('escalation');
      const b = bucketFor(e.effective_date, now, escLead);
      if (b) out.push({ ...ctx, focus: 'escalation', tone: b.tone, bucketLabel: b.label, date: e.effective_date, days: daysUntil(e.effective_date, now), horizonDays: escLead, title: `Rent escalation — ${l.tenant_name}`, detail: `Effective ${fmtDate(e.effective_date)}` });
    });
    if (l.lease_termination_date) {
      // Lease ending has a per-lease override (notify_lease_end_days) for the landlord
      // who wants a different heads-up on one lease; else the general lease_end lead.
      const leaseEndLead = (typeof l.notify_lease_end_days === 'number' && l.notify_lease_end_days > 0)
        ? l.notify_lease_end_days : lead('lease_end');
      const b = bucketFor(l.lease_termination_date, now, leaseEndLead);
      if (b) {
        // A lease is "ending with no renewal" when there's no live renewal option
        // on file, or the landlord has explicitly confirmed there is none. A
        // *declined* option is not a live prospect — it means the tenant said no —
        // so it must NOT soften the red warning. Only pending/applied options do.
        const liveRenewals = (renByLease[l.id] || []).filter((r) => r.status !== 'declined');
        const noRenewal = l.no_renewal_option === true || liveRenewals.length === 0;
        // A still-active lease whose term end has already passed is in HOLDOVER — the
        // tenant is occupying past the term. Say so plainly instead of the generic
        // "overdue lease ending", which reads like a mistake.
        const holdover = b.key === 'overdue';
        const expires = holdover ? 'expired' : 'expires';
        out.push({
          ...ctx,
          focus: 'termination',
          // Holdover or no renewal on the table are the urgent cases — flag red.
          tone: (holdover || noRenewal) ? 'danger' : b.tone,
          bucketLabel: holdover ? 'Holdover' : b.label,
          date: l.lease_termination_date,
          days: daysUntil(l.lease_termination_date, now),
          horizonDays: leaseEndLead,
          noRenewal,
          holdover,
          title: holdover
            ? `Tenant in holdover — ${l.tenant_name}`
            : (noRenewal ? `Lease ending — no renewal — ${l.tenant_name}` : `Lease ending — ${l.tenant_name}`),
          detail: holdover
            ? `Term ${expires} ${fmtDate(l.lease_termination_date)} · tenant still in possession`
            : (noRenewal
              ? `Term ${expires} ${fmtDate(l.lease_termination_date)} · no renewal option on file`
              : `Term ${expires} ${fmtDate(l.lease_termination_date)}`),
        });
      }
    }
    (renByLease[l.id] || []).forEach((r) => {
      if (!r.notice_by_date || r.status === 'applied') return; // applied renewals are done — no reminder
      // A LAPSED option is not a live deadline, so it must not be counted down to. The
      // rule is the shared one (0068): the term has already ended, or the notice date sits
      // more than 18 months before the committed term end and so belongs to an earlier
      // term. Without this the bell kept raising "Renewal notice — beauty and barber shop,
      // 6,540 days over" off a 2008 notice date on a lease running to 2030 — a countdown to
      // a deadline that stopped mattering eighteen years ago. The lease page already badges
      // the option "Lapsed" and explains why; that is where a dead option belongs.
      //
      // A genuinely MISSED notice still alerts: the ±18-month test is what separates
      // "you're two months late on next year's option" from "this belongs to a prior term".
      if (optionLapseReason(r, l.lease_termination_date, localIso(now))) return;
      const renLead = lead('renewal');
      const b = bucketFor(r.notice_by_date, now, renLead);
      if (b) out.push({ ...ctx, focus: 'renewal', renewal_id: r.id, tone: b.tone, bucketLabel: b.label, date: r.notice_by_date, days: daysUntil(r.notice_by_date, now), horizonDays: renLead, title: `Renewal notice — ${l.tenant_name}`, detail: `Notice due ${fmtDate(r.notice_by_date)}` });
    });
  });

  // Service-contract expiry — the same 6-month horizon as leases, so a contract can be
  // renewed or replaced before it lapses. Not tied to a lease; keyed by the contract id.
  // Silenced when the Service-contracts module is turned off in Settings.
  const stepsByContractId = {};
  (contractSteps || []).forEach((s) => { if (s?.contract_id) (stepsByContractId[s.contract_id] ||= []).push(s); });

  (contractsOn ? contracts || [] : []).forEach((c) => {
    const prop = propMap[c.property_id];
    const label = c.name || c.vendor || 'service contract';
    // Every contract alert carries the same anchors, so alertKey's contract_id link holds
    // and three focuses on one contract produce three distinct dismissal keys.
    const ctx = {
      contract_id: c.id, lease_id: null,
      property_id: c.property_id, corporation_id: prop?.corporation_id || null,
      vendor_email: c.vendor_email || null, contract_name: c.name || c.vendor || 'Service contract',
    };

    if (c.end_date) {
      const contractLead = lead('contract');
      const b = bucketFor(c.end_date, now, contractLead);
      if (b) {
        out.push({
          ...ctx, focus: 'contract',
          tone: b.tone, bucketLabel: b.label, date: c.end_date, days: daysUntil(c.end_date, now),
          horizonDays: contractLead,
          title: `Contract ending — ${label}`,
          detail: `${c.vendor ? c.vendor + ' · ' : ''}ends ${fmtDate(c.end_date)}`,
        });
      }
    }

    // ── THE CANCELLATION-NOTICE DEADLINE (0091) ──────────────────────────────────────
    // The deadline on a service contract that actually costs money. Miss it and the
    // agreement renews for another full term at the vendor's figure — which then flows
    // into CAM, and therefore into what the tenants are billed, for another year.
    //
    // ⚠ Fires whenever notice_by_date is set, REGARDLESS of auto_renew. The flag drives
    // the WORDING, not the alert's existence: a contract that merely ends still needs the
    // notice served to end cleanly, and a contract whose renewal terms were never read
    // (auto_renew null) is exactly the one nobody should be relying on silence from.
    if (c.notice_by_date) {
      const noticeLead = lead('contract_notice');
      const b = bucketFor(c.notice_by_date, now, noticeLead);
      if (b) {
        const renews = c.auto_renew === true;
        out.push({
          ...ctx, focus: 'contract_notice',
          tone: b.tone, bucketLabel: b.label, date: c.notice_by_date, days: daysUntil(c.notice_by_date, now),
          horizonDays: noticeLead,
          auto_renew: c.auto_renew ?? null,
          notice_days: c.notice_days ?? null,
          renewal_term_months: c.renewal_term_months ?? null,
          contract_end: c.end_date || null,
          title: `Cancellation notice due — ${label}`,
          detail: renews
            ? `Give notice by ${fmtDate(c.notice_by_date)} or it renews${c.renewal_term_months ? ` for ${c.renewal_term_months} more months` : ' automatically'}`
            : `Written notice due ${fmtDate(c.notice_by_date)}${c.notice_days ? ` (${c.notice_days} days)` : ''}`,
        });
      }
    }

    // ── A FEE STEP COMING DUE ────────────────────────────────────────────────────────
    // Dashboard-only, mirroring the lease's own `escalation` focus, which likewise has no
    // email sweep: there is no outside party to tell that your own cost is going up.
    const next = nextContractStep(stepsByContractId[c.id], localIso(now));
    if (next) {
      const escLead = lead('contract_escalation');
      const b = bucketFor(next.effective_date, now, escLead);
      if (b) {
        const per = c.frequency === 'monthly' ? '/mo' : '/yr';
        out.push({
          ...ctx, focus: 'contract_escalation',
          tone: b.tone, bucketLabel: b.label, date: next.effective_date, days: daysUntil(next.effective_date, now),
          horizonDays: escLead,
          new_amount: next.new_amount ?? null,
          title: `Contract fee increasing — ${label}`,
          detail: `${money0(next.new_amount)}${per} from ${fmtDate(next.effective_date)}`,
        });
      }
    }
  });

  // Insurance expiry — the landlord is notified for both their own building policy
  // and each tenant's policy as the expiry date nears. Silenced when the Insurance
  // module is turned off in Settings. A tenant alert carries insurer/expiry so its ✉
  // can draft the "please send the renewed certificate" letter; the landlord's own
  // policy has no outside recipient, so no ✉.
  (insuranceOn ? insurance || [] : []).forEach((p) => {
    if (!p.expiry_date) return;
    const insLead = lead('insurance');
    const b = bucketFor(p.expiry_date, now, insLead);
    if (!b) return;
    const isLandlord = p.party === 'landlord';
    const propertyId = isLandlord ? p.property_id : leaseById[p.lease_id]?.property_id;
    const leaseId = isLandlord ? null : p.lease_id;
    const corpId = propMap[propertyId]?.corporation_id;
    const who = isLandlord ? (propMap[propertyId]?.name || 'building') : (leaseById[p.lease_id]?.tenant_name || 'tenant');
    const expired = b.key === 'overdue';
    out.push({
      lease_id: leaseId, property_id: propertyId, corporation_id: corpId,
      focus: 'insurance', tone: b.tone, bucketLabel: b.label,
      date: p.expiry_date, days: daysUntil(p.expiry_date, now), horizonDays: insLead,
      // Carried so the tenant alert's ✉ can name the insurer + expiry in the letter.
      insurer: p.insurer || null, expiry_date: p.expiry_date, expired,
      title: `${isLandlord ? 'Landlord' : 'Tenant'} insurance ${expired ? 'expired' : 'expiring'} — ${who}`,
      detail: `${p.insurer ? p.insurer + ' · ' : ''}${expired ? 'expired' : 'expires'} ${fmtDate(p.expiry_date)}`,
    });
  });

  // Insurance chase-up — a certificate was requested from a tenant 21+ days ago and no
  // tenant policy has been saved/updated since. Nudges the landlord to follow up (its ✉
  // re-opens the same renewal-request letter). Gated with the Insurance module.
  //
  // …and, below it, the gap those two alerts could never show: a building or a tenant with
  // NO certificate on file AT ALL. Both blocks above need a policy (or a request) to
  // already exist, so a property nobody has ever entered insurance for was silent.
  // George, 2026-07-30: "make sure to list every property that doesn't yet have insurance,
  // but there needs to be nuance — if the insurance was requested that should be a
  // different type of notification; if it hasn't been requested that should be known as
  // well." Hence three mutually exclusive states, in escalating order of neglect.
  if (insuranceOn) {
    const lastReqByLease = {};
    (insuranceRequests || []).forEach((e) => {
      const d = e.event_date || (e.created_at ? String(e.created_at).slice(0, 10) : null);
      if (!d) return;
      if (!lastReqByLease[e.lease_id] || d > lastReqByLease[e.lease_id]) lastReqByLease[e.lease_id] = d;
    });
    const tenantPolByLease = {};
    const landlordPolByProperty = {};
    (insurance || []).forEach((p) => {
      if (p.party === 'tenant' && p.lease_id) tenantPolByLease[p.lease_id] = p;
      if (p.party === 'landlord' && p.property_id) landlordPolByProperty[p.property_id] = p;
    });
    const chased = new Set();
    Object.entries(lastReqByLease).forEach(([leaseId, reqDate]) => {
      const lease = leaseById[leaseId];
      if (!lease || lease.is_active === false) return;
      if (-daysUntil(reqDate, now) < lead('insurance_chase')) return; // requested too recently — still waiting patiently
      const pol = tenantPolByLease[leaseId];
      const polStamp = pol ? String(pol.updated_at || pol.created_at || '').slice(0, 10) : null;
      if (polStamp && polStamp >= reqDate) return; // a policy was saved/updated after the request → they responded
      const corpId = propMap[lease.property_id]?.corporation_id;
      chased.add(leaseId); // so the "none on file" block below doesn't say the same thing twice
      out.push({
        lease_id: leaseId, property_id: lease.property_id, corporation_id: corpId,
        focus: 'insurance_chase', tone: 'warn', bucketLabel: 'Follow-up',
        date: reqDate, days: daysUntil(reqDate, now),
        insurer: pol?.insurer || null, expiry_date: pol?.expiry_date || null,
        expired: pol?.expiry_date ? daysUntil(pol.expiry_date, now) < 0 : false,
        requested_on: reqDate, requested: true,
        title: `Insurance not received — ${lease.tenant_name || 'tenant'}`,
        detail: `Requested ${fmtDate(reqDate)} · renewed certificate not received`,
        action: 'Ask again — the ✉ writes a second-request letter naming the first date.',
      });
    });

    // ── (insurance continues below) ──────────────────────────────────────────────────
    // ── Nothing on file at all ───────────────────────────────────────────────────────
    // No date to count down to, so no horizonDays and no countdown chip — `days` here is
    // a sort weight, ranking the three states against each other inside the standing tier
    // (see the URGENCY_TIER note above). Tone stays WARN rather than danger for all of
    // them, deliberately: the app cannot tell "uninsured" from "not entered yet", so the
    // wording says what it actually knows — none on file — and never claims a lapse.
    (properties || []).forEach((p) => {
      if (landlordPolByProperty[p.id]) return;
      out.push({
        lease_id: null, property_id: p.id, corporation_id: p.corporation_id,
        focus: 'insurance_missing', tone: 'warn', bucketLabel: 'None on file',
        date: null, days: -2, requested: false, party: 'landlord',
        title: `No building insurance — ${p.name || 'property'}`,
        detail: 'No policy on file for this building',
        action: 'Add your building policy from the property card’s Insurance button.',
      });
    });

    (leases || []).forEach((l) => {
      if (l.is_active === false) return;
      if (tenantPolByLease[l.id]) return;      // a certificate is on file — the expiry alert owns it
      if (chased.has(l.id)) return;            // already chased above, don't say it twice
      const corpId = propMap[l.property_id]?.corporation_id;
      const reqDate = lastReqByLease[l.id] || null;
      out.push({
        lease_id: l.id, property_id: l.property_id, corporation_id: corpId,
        focus: 'insurance_missing', tone: reqDate ? 'info' : 'warn',
        bucketLabel: reqDate ? 'Requested' : 'Never requested',
        // Keyed on the request date when there is one, so asking again re-arms a row the
        // landlord had dismissed; a never-requested row keys on null and stays dismissed
        // until a certificate actually arrives (which removes it outright).
        date: reqDate, days: reqDate ? 0 : -1,
        requested_on: reqDate, requested: !!reqDate, party: 'tenant',
        title: reqDate
          ? `Certificate requested — ${l.tenant_name || 'tenant'}`
          : `No certificate on file — ${l.tenant_name || 'tenant'}`,
        detail: reqDate
          ? `Requested ${fmtDate(reqDate)} · waiting for the tenant`
          : 'No certificate on file, and none has been requested yet',
        action: reqDate
          ? 'Asked recently — this becomes a follow-up if nothing arrives.'
          : 'Send the request — the ✉ writes the letter to the tenant.',
      });
    });
  }

  // ── Documents out for signature ─────────────────────────────────────────────────────
  // Three states worth raising, and deliberately not a fourth:
  //   • SIGNED — the tenant has done their part and the document is stuck on the landlord.
  //     The only one he can clear in a single click.
  //   • EXECUTED but not applied — signed by both and still not pushed into the lease. A
  //     signed extension nobody applied is exactly how a term end goes quietly stale.
  //   • DECLINED (0096) — the other side answered NO. The odd one out: it is not work sitting
  //     undone, there is nothing here to finish, and that is exactly why it has to be said out
  //     loud. A refusal used to reach the landlord as one email and a red badge on a page he
  //     had no reason to open, so the addendum he believed was in flight was dead while the
  //     dashboard went on saying nothing at all.
  // Deliberately NOT raised: an envelope merely WAITING on the tenant. That is normal for
  // days at a time, and an alert the landlord can do nothing about is noise. The expiry
  // shows on the row in the lease card instead. A decline is the opposite case — it is the
  // waiting ending, and ending badly.
  //
  // All three are standing alerts (no horizonDays) — there is no deadline to count toward,
  // only work sitting undone (or a deal that just died), which is exactly what tier 1 is for.
  // Within that tier alertUrgency sorts by TONE before weight, so danger → warn → info puts
  // the refusal above the countersign above the unapplied; `days` is only the tie-break.
  //
  // ⚠ AN ENVELOPE NOW HAS TWO KINDS OF HOME (0093): a lease, or a SERVICE CONTRACT sent to a
  // vendor. Both raise the same two alerts, because the landlord owes the same two acts —
  // but the words, the anchor and the destination all differ, and getting any of them from
  // the lease branch would send him to a lease page that does not exist for a snow contract.
  if (esignOn) {
    const contractById = {};
    (contracts || []).forEach((c) => { contractById[c.id] = c; });
    (envelopes || []).forEach((env) => {
      const onContract = !!env.contract_id;
      // Both modules have to be on for a contract envelope to raise anything: turning
      // Service contracts off hides the tab these alerts send him to.
      if (onContract && !contractsOn) return;
      const corpId = propMap[env.property_id]?.corporation_id;
      const contract = env.contract_id ? contractById[env.contract_id] : null;
      const who = env.signer_typed_name || env.signer_name || (onContract ? 'The vendor' : 'The tenant');
      // What the document is ABOUT, for the second half of the detail line.
      const subject = onContract
        ? (contract?.name || contract?.vendor || 'service contract')
        : (leaseById[env.lease_id]?.tenant_name || 'tenant');
      const anchors = {
        envelope_id: env.id,
        lease_id: env.lease_id || null,
        contract_id: env.contract_id || null,
        property_id: env.property_id,
        corporation_id: corpId,
      };
      if (env.status === 'signed') {
        out.push({
          ...anchors,
          focus: 'signature_countersign', tone: 'warn', bucketLabel: 'Waiting on you',
          date: env.signed_at ? String(env.signed_at).slice(0, 10) : null, days: -6,
          title: `Signed — countersign “${env.title}”`,
          detail: `${who} signed ${env.signed_at ? fmtDate(String(env.signed_at).slice(0, 10)) : ''} · ${subject}`,
          action: onContract
            ? 'Open the Contracts tab and countersign it — that builds the signed copy and emails you both.'
            : 'Open the lease and countersign it — that builds the signed copy and emails you both.',
        });
      } else if (env.status === 'executed' && !env.applied_at) {
        out.push({
          ...anchors,
          focus: 'signature_apply', tone: 'info', bucketLabel: 'Signed, not applied',
          date: env.executed_at ? String(env.executed_at).slice(0, 10) : null, days: -4,
          // On a contract the unapplied state is not merely untidy: the signed fee has not
          // reached CAM, so every tenant is still being billed off the OLD figure.
          title: onContract
            ? `Signed but not read — “${env.title}”`
            : `Signed but not applied — “${env.title}”`,
          detail: onContract
            ? `Signed by both parties · ${subject}’s fee, term and renewal are still the old ones`
            : `Signed by both parties · nothing on ${subject}’s lease has changed yet`,
          action: onContract
            ? 'Open the Contracts tab and read the signed copy — Amlak shows what changes before anything moves.'
            : 'Open the lease to file it against the term, or leave it as a signed record.',
        });
      } else if (env.status === 'declined') {
        // declined_at is null on anything refused before 0096. The date is dropped rather
        // than guessed off updated_at, exactly as the countersign branch above drops a
        // missing signed_at — a wrong date on a refusal is worse than no date.
        const when = env.declined_at ? ` on ${fmtDate(String(env.declined_at).slice(0, 10))}` : '';
        const why = String(env.declined_reason || '').trim();
        out.push({
          ...anchors,
          focus: 'signature_declined', tone: 'danger', bucketLabel: 'Declined',
          date: env.declined_at ? String(env.declined_at).slice(0, 10) : null, days: -8,
          title: `Declined — “${env.title}”`,
          detail: `${who} declined to sign${when} · ${subject}`,
          // The reason they typed leads the action line, because it is the thing that decides
          // what the landlord does next — and it is the one part of this that lives nowhere
          // else on the dashboard.
          action: `${why ? `Reason given: “${why}”. ` : 'No reason was given. '}${onContract
            ? 'Nothing was signed, so the old contract stands — its fee, term and renewal are unchanged and the tenants are still billed off it.'
            : 'Nothing was signed, so no term on this lease changed. Send a revised copy or take it up with them directly.'}`,
        });
      }
    });
  }

  // Free-rent period ending — a rent abatement window closing within a month, so the
  // landlord knows full billing is about to resume. Owner heads-up only (no tenant email).
  (abatements || []).forEach((a) => {
    if (!a.end_date) return;
    const lease = leaseById[a.lease_id];
    if (!lease || lease.is_active === false) return;
    const d = daysUntil(a.end_date, now);
    const abateLead = lead('abatement');
    if (d == null || d < 0 || d > abateLead) return; // only as it approaches
    const corpId = propMap[lease.property_id]?.corporation_id;
    out.push({
      lease_id: a.lease_id, property_id: lease.property_id, corporation_id: corpId,
      focus: 'abatement', tone: d <= 7 ? 'warn' : 'info', bucketLabel: bucket(a.end_date, now)?.label || 'Within 1 month',
      date: a.end_date, days: d, horizonDays: abateLead,
      title: `Free rent ending — ${lease.tenant_name || 'tenant'}`,
      detail: `Free/reduced rent ends ${fmtDate(a.end_date)} · full billing resumes`,
    });
  });

  // Annual-report filing deadlines — one per corporation. Unlike leases, George only
  // wants a heads-up ~1 month ahead, so this alert appears ONLY within 31 days (no
  // 3/6-month noise). Past the deadline it turns red "Overdue" and stays shown until
  // he marks it filed (which rolls the date forward a year). Not tied to any Settings
  // module — a corporation's filing obligation is core. Keyed by the corp id.
  const corpNameById = Object.fromEntries((corporations || []).map((c) => [c.id, c.name]));
  (annualReports || []).forEach((r) => {
    if (!r.due_date) return;
    const d = daysUntil(r.due_date, now);
    if (d == null) return;
    const reportLead = lead('annual_report');
    if (d > reportLead) return; // only within the configured window of the deadline
    const overdue = d < 0;
    const name = corpNameById[r.corporation_id] || 'corporation';
    out.push({
      focus: 'annual_report', report_id: r.corporation_id, corporation_id: r.corporation_id,
      lease_id: null, property_id: null,
      tone: overdue ? 'danger' : 'warn',
      bucketLabel: overdue ? 'Overdue' : (bucket(r.due_date, now)?.label || 'Within 1 month'),
      date: r.due_date, days: d, horizonDays: reportLead, overdue,
      title: overdue ? `Annual report overdue — ${name}` : `Annual report due — ${name}`,
      detail: `File by ${fmtDate(r.due_date)}`,
    });
  });

  // Import your bank statement — ONE calm reminder per property, never one per tenant.
  //
  // This replaces the old per-tenant "behind on rent" alert, which was wrong twice over:
  // it judged a month the moment it began (the statement only lands after the month
  // CLOSES, so there was nothing to log yet), and it raised a separate alarm for every
  // tenant — turning one forgotten upload into a screenful of accusations about tenants
  // who may well have paid. An empty month means the landlord hasn't logged it, which is
  // the landlord's own to-do, so that's what the reminder says. Who actually paid stays
  // on the Ledger grid, where the month's cells give it context.
  //
  // In-app only (no owner email), gated by the Rent Ledger module. `unloggedMonths` is
  // precomputed in fetchAlertData from the same math the Ledger grid paints, already
  // honoring the configurable grace after month end. Keyed by property + the latest
  // unlogged month, so dismissing it re-arms when the NEXT month goes unlogged.
  (ledgerOn ? unloggedMonths || [] : []).forEach((u) => {
    const months = (u.months || []).filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
    if (!months.length) return;
    const propName = propMap[u.property_id]?.name || 'property';
    const corpId = propMap[u.property_id]?.corporation_id;
    const names = months.map((m) => MONTH_NAMES[m - 1]);
    const listed = joinMonths(names);
    const many = months.length > 1;
    // Anchor the date to the LAST day of the latest unlogged month — the point the
    // statement became available. Also what makes the dismiss key roll month to month.
    const latest = months[months.length - 1];
    const lastDay = new Date(u.year, latest, 0).getDate();
    out.push({
      property_id: u.property_id, corporation_id: corpId, lease_id: null,
      focus: 'statement_reminder',
      // A to-do, not a problem — it only firms up once several months have piled up.
      tone: months.length >= 3 ? 'warn' : 'info',
      bucketLabel: 'To log',
      date: `${u.year}-${String(latest).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      // Sorts just above what isn't due yet, below anything genuinely overdue; more
      // unlogged months float higher.
      days: -months.length,
      months, year: u.year,
      title: many
        ? `Import your bank statements — ${propName}`
        : `Import your ${names[0]} statement — ${propName}`,
      detail: `Nothing recorded for ${listed} — import ${many ? 'those statements' : 'the bank statement'} to log payments and expenses.`,
    });
  });

  // No payment recorded — the OTHER half, and the one that's genuinely about the tenant.
  // It fires only for months the property actually IMPORTED (proven by a payment carrying
  // an import_id), so the bank has been reconciled and this tenant simply isn't in it.
  // Hand-ticking one box never triggers it, and a month still running never does either —
  // which is what keeps it from becoming the wall of accusations it replaced. One alert
  // per TENANT listing every month they're missing, never one per month.
  (ledgerOn ? missingPayments || [] : []).forEach((p) => {
    const months = (p.months || []).filter((m) => m >= 1 && m <= 12).sort((a, b) => a - b);
    if (!months.length) return;
    const corpId = propMap[p.property_id]?.corporation_id;
    const listed = joinMonths(months.map((m) => MONTH_NAMES[m - 1]));
    const latest = months[months.length - 1];
    const lastDay = new Date(p.year, latest, 0).getDate();
    out.push({
      lease_id: p.lease_id, property_id: p.property_id, corporation_id: corpId,
      focus: 'missing_payment',
      tone: months.length >= 3 ? 'danger' : 'warn',
      bucketLabel: 'Not received',
      date: `${p.year}-${String(latest).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      // Above the statement reminder (this one is a real gap, not a to-do), below
      // anything with a genuinely overdue date of its own.
      days: -10 - months.length,
      months, year: p.year, amount: p.amount,
      title: `No payment recorded — ${p.tenant_name || 'tenant'}`,
      detail: `${listed} ${months.length > 1 ? 'are' : 'is'} imported with no payment from this tenant${p.amount > 0 ? ` — ${money0(p.amount)} outstanding` : ''}.`,
    });
  });

  const nowMs = now.getTime();
  return out
    .filter((a) => {
      const k = alertKey(a);
      return !states.dismissed?.has?.(k) && !(states.snoozedUntil?.[k] > nowMs);
    })
    .sort((a, b) => compareUrgencyKeys(alertUrgency(a), alertUrgency(b)));
}
