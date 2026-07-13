import { fmtDate, money } from './format';
import { occupancyStart } from './escalations';
import { monthsBehindForInvoice } from './arStatus';

const DAY = 86400000;

// Dismiss / snooze of computed alerts are stored SERVER-SIDE (table alert_states),
// keyed by this stable alert_key, so they sync across the landlord's devices. A
// contract or annual-report alert has no lease, so its own id anchors the key (falls
// back to lease_id for every other alert type, keeping existing saved keys stable).
export const alertKey = (a) => `${a.focus}:${a.contract_id || a.report_id || a.lease_id}:${a.date}`;

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

// Bucket a date by proximity. The near buckets (≤1 month) keep the urgent tones that
// match the reminder-email schedule; the two far buckets show items up to 6 months out
// so nothing is a surprise, toned calm (info) rather than red so a far-off date reads
// as "on the radar", not "act now".
export function bucket(iso, now = new Date()) {
  const d = daysUntil(iso, now);
  if (d == null) return null;
  if (d < 0) return { key: 'overdue', label: 'Overdue', tone: 'danger' };
  if (d <= 7) return { key: '1w', label: 'Within 1 week', tone: 'danger' };
  if (d <= 14) return { key: '2w', label: 'Within 2 weeks', tone: 'warn' };
  if (d <= 31) return { key: '1m', label: 'Within 1 month', tone: 'warn' };
  if (d <= 92) return { key: '3m', label: 'Within 3 months', tone: 'warn' };
  if (d <= 183) return { key: '6m', label: 'Within 6 months', tone: 'info' };
  return null;
}

// null / undefined enabled set = "never chosen" = everything on. Mirrors
// isFeatureOn() in features.js; kept inline so this leaf module stays free of the
// react-query import that features.js carries.
const featureOn = (enabled, key) => (enabled == null ? true : enabled.includes(key));

// Derive urgent alerts from lease key dates (escalations / termination / renewal
// notice). `states` is the server dismiss/snooze lookup from toAlertStates().
//
// `opts` ties the alert feed to the Settings switchboard so a notification silences
// with the module it belongs to (and returns when re-enabled):
//   • features      — the enabled_features array (null = all on). Gates Insurance
//                     (expiry + chase-up) and Service-contract alerts.
//   • hiddenWidgets — the hidden_widgets array. The 'ar' (receivables) key gates the
//                     overdue-invoice and free-rent-ending alerts.
// Core lease dates (escalations, term end, renewals) are never gated here.
export function buildAlerts(
  { leases, escalations, renewals, properties, insurance, contracts, invoices, abatements, insuranceRequests, annualReports, corporations },
  states = { dismissed: new Set(), snoozedUntil: {} },
  now = new Date(),
  { features = null, hiddenWidgets = [] } = {},
) {
  const insuranceOn = featureOn(features, 'insurance');
  const contractsOn = featureOn(features, 'contracts');
  const arOn = !(hiddenWidgets || []).includes('ar');

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
      const b = bucket(e.effective_date, now);
      if (b) out.push({ ...ctx, focus: 'escalation', tone: b.tone, bucketLabel: b.label, date: e.effective_date, days: daysUntil(e.effective_date, now), title: `Rent escalation — ${l.tenant_name}`, detail: `Effective ${fmtDate(e.effective_date)}` });
    });
    if (l.lease_termination_date) {
      const b = bucket(l.lease_termination_date, now);
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
      const b = bucket(r.notice_by_date, now);
      if (b) out.push({ ...ctx, focus: 'renewal', renewal_id: r.id, tone: b.tone, bucketLabel: b.label, date: r.notice_by_date, days: daysUntil(r.notice_by_date, now), title: `Renewal notice — ${l.tenant_name}`, detail: `Notice due ${fmtDate(r.notice_by_date)}` });
    });
  });

  // Service-contract expiry — the same 6-month horizon as leases, so a contract can be
  // renewed or replaced before it lapses. Not tied to a lease; keyed by the contract id.
  // Silenced when the Service-contracts module is turned off in Settings.
  (contractsOn ? contracts || [] : []).forEach((c) => {
    if (!c.end_date) return;
    const b = bucket(c.end_date, now);
    if (!b) return;
    const prop = propMap[c.property_id];
    const label = c.name || c.vendor || 'service contract';
    out.push({
      focus: 'contract', contract_id: c.id, lease_id: null,
      property_id: c.property_id, corporation_id: prop?.corporation_id || null,
      vendor_email: c.vendor_email || null, contract_name: c.name || c.vendor || 'Service contract',
      tone: b.tone, bucketLabel: b.label, date: c.end_date, days: daysUntil(c.end_date, now),
      title: `Contract ending — ${label}`,
      detail: `${c.vendor ? c.vendor + ' · ' : ''}ends ${fmtDate(c.end_date)}`,
    });
  });

  // Insurance expiry — the landlord is notified for both their own building policy
  // and each tenant's policy as the expiry date nears. Silenced when the Insurance
  // module is turned off in Settings. A tenant alert carries insurer/expiry so its ✉
  // can draft the "please send the renewed certificate" letter; the landlord's own
  // policy has no outside recipient, so no ✉.
  (insuranceOn ? insurance || [] : []).forEach((p) => {
    if (!p.expiry_date) return;
    const b = bucket(p.expiry_date, now);
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
      date: p.expiry_date, days: daysUntil(p.expiry_date, now),
      // Carried so the tenant alert's ✉ can name the insurer + expiry in the letter.
      insurer: p.insurer || null, expiry_date: p.expiry_date, expired,
      title: `${isLandlord ? 'Landlord' : 'Tenant'} insurance ${expired ? 'expired' : 'expiring'} — ${who}`,
      detail: `${p.insurer ? p.insurer + ' · ' : ''}${expired ? 'expired' : 'expires'} ${fmtDate(p.expiry_date)}`,
    });
  });

  // Insurance chase-up — a certificate was requested from a tenant 21+ days ago and no
  // tenant policy has been saved/updated since. Nudges the landlord to follow up (its ✉
  // re-opens the same renewal-request letter). Gated with the Insurance module.
  if (insuranceOn) {
    const lastReqByLease = {};
    (insuranceRequests || []).forEach((e) => {
      const d = e.event_date || (e.created_at ? String(e.created_at).slice(0, 10) : null);
      if (!d) return;
      if (!lastReqByLease[e.lease_id] || d > lastReqByLease[e.lease_id]) lastReqByLease[e.lease_id] = d;
    });
    const tenantPolByLease = {};
    (insurance || []).forEach((p) => { if (p.party === 'tenant' && p.lease_id) tenantPolByLease[p.lease_id] = p; });
    Object.entries(lastReqByLease).forEach(([leaseId, reqDate]) => {
      const lease = leaseById[leaseId];
      if (!lease || lease.is_active === false) return;
      if (-daysUntil(reqDate, now) < 21) return; // requested less than 3 weeks ago — still waiting patiently
      const pol = tenantPolByLease[leaseId];
      const polStamp = pol ? String(pol.updated_at || pol.created_at || '').slice(0, 10) : null;
      if (polStamp && polStamp >= reqDate) return; // a policy was saved/updated after the request → they responded
      const corpId = propMap[lease.property_id]?.corporation_id;
      out.push({
        lease_id: leaseId, property_id: lease.property_id, corporation_id: corpId,
        focus: 'insurance_chase', tone: 'warn', bucketLabel: 'Follow-up',
        date: reqDate, days: daysUntil(reqDate, now),
        insurer: pol?.insurer || null, expiry_date: pol?.expiry_date || null,
        expired: pol?.expiry_date ? daysUntil(pol.expiry_date, now) < 0 : false,
        title: `Insurance not received — ${lease.tenant_name || 'tenant'}`,
        detail: `Requested ${fmtDate(reqDate)} · renewed certificate not received`,
      });
    });
  }

  // Behind on rent (+ overdue reconciliations). The old model flagged an annual invoice
  // the moment its single due date passed — turning every tenant red from ~Aug 1, because a
  // whole-year bill comes due once even though rent is really paid monthly. Now an ANNUAL
  // invoice raises an alert only for the months that have come DUE and remain unpaid (see
  // arStatus.js: months due = in-term months whose 1st ≤ today, minus what's been paid),
  // so a mid-year tenant and a new-August lease aren't wrongly red. A RECONCILIATION
  // invoice is a one-off year-end true-up, so it keeps the plain past-the-due-date test.
  // Always shown until cleared (money on the table); silenced with the Outstanding
  // (receivables) display toggle. Both use focus:'invoice' so the dashboard routes/emails
  // them the same way.
  (arOn ? invoices || [] : []).forEach((inv) => {
    if ((Number(inv.balance) || 0) <= 0) return;
    const lease = leaseById[inv.lease_id];
    // Occupancy start = min(lease_start, earliest applied step) — so a July-start tenant is
    // only "behind" on the months they actually owe (Jul–Dec), never Jan–Jun.
    const occ = lease ? occupancyStart({ lease_start: lease.lease_start }, escByLease[inv.lease_id] || []) : null;
    const status = monthsBehindForInvoice(inv, { occupancyStartIso: occ }, now);
    if (!status.behind) return;
    const corpId = propMap[inv.property_id]?.corporation_id;
    if (status.isReconciliation) {
      out.push({
        lease_id: inv.lease_id, property_id: inv.property_id, corporation_id: corpId,
        focus: 'invoice', tone: 'danger', bucketLabel: 'Overdue', reconciliation: true,
        date: inv.due_date, days: inv.due_date ? daysUntil(inv.due_date, now) : 0,
        balance: Number(inv.balance) || 0, invoice_year: inv.year ?? null,
        title: `Reconciliation overdue — ${lease?.tenant_name || 'tenant'}`,
        detail: `${money(status.amountBehind)} unpaid · was due ${fmtDate(inv.due_date)}`,
      });
      return;
    }
    const n = status.monthsBehind;
    out.push({
      lease_id: inv.lease_id, property_id: inv.property_id, corporation_id: corpId,
      focus: 'invoice', tone: n >= 2 ? 'danger' : 'warn',
      bucketLabel: n >= 2 ? `${n} months behind` : '1 month behind',
      // Sort by the annual invoice's (past) due date so behind tenants surface near the top.
      date: inv.due_date || `${inv.year}-01-01`, days: inv.due_date ? daysUntil(inv.due_date, now) : 0,
      // Carried so the ✉ payment-reminder email can state the exact figures.
      balance: Number(inv.balance) || 0, invoice_year: inv.year ?? null,
      months_behind: n, amount_behind: status.amountBehind,
      title: `Behind on rent — ${lease?.tenant_name || 'tenant'}`,
      detail: `${n} month${n === 1 ? '' : 's'} behind · ${money(status.amountBehind)} · FY ${inv.year}`,
    });
  });

  // Free-rent period ending — a rent abatement window closing within a month, so the
  // landlord knows full billing is about to resume. Owner heads-up only (no tenant
  // email). Gated with the receivables display toggle (it's a billing signal).
  (arOn ? abatements || [] : []).forEach((a) => {
    if (!a.end_date) return;
    const lease = leaseById[a.lease_id];
    if (!lease || lease.is_active === false) return;
    const d = daysUntil(a.end_date, now);
    if (d == null || d < 0 || d > 31) return; // only as it approaches (within ~1 month)
    const corpId = propMap[lease.property_id]?.corporation_id;
    out.push({
      lease_id: a.lease_id, property_id: lease.property_id, corporation_id: corpId,
      focus: 'abatement', tone: d <= 7 ? 'warn' : 'info', bucketLabel: bucket(a.end_date, now)?.label || 'Within 1 month',
      date: a.end_date, days: d,
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
    if (d > 31) return; // only within a month of the deadline
    const overdue = d < 0;
    const name = corpNameById[r.corporation_id] || 'corporation';
    out.push({
      focus: 'annual_report', report_id: r.corporation_id, corporation_id: r.corporation_id,
      lease_id: null, property_id: null,
      tone: overdue ? 'danger' : 'warn',
      bucketLabel: overdue ? 'Overdue' : (bucket(r.due_date, now)?.label || 'Within 1 month'),
      date: r.due_date, days: d, overdue,
      title: overdue ? `Annual report overdue — ${name}` : `Annual report due — ${name}`,
      detail: `File by ${fmtDate(r.due_date)}`,
    });
  });

  const nowMs = now.getTime();
  return out
    .filter((a) => {
      const k = alertKey(a);
      return !states.dismissed?.has?.(k) && !(states.snoozedUntil?.[k] > nowMs);
    })
    .sort((a, b) => a.days - b.days);
}
