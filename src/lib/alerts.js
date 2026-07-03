import { fmtDate } from './format';

const DAY = 86400000;

// Dismiss / snooze of computed alerts are stored SERVER-SIDE (table alert_states),
// keyed by this stable alert_key, so they sync across the landlord's devices. A
// contract alert has no lease, so its own id anchors the key (falls back to lease_id
// for every other alert type, keeping existing saved keys stable).
export const alertKey = (a) => `${a.focus}:${a.contract_id || a.lease_id}:${a.date}`;

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

// Derive urgent alerts from lease key dates (escalations / termination / renewal
// notice). `states` is the server dismiss/snooze lookup from toAlertStates().
export function buildAlerts({ leases, escalations, renewals, properties, insurance, contracts }, states = { dismissed: new Set(), snoozedUntil: {} }, now = new Date()) {
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
        // on file, or the landlord has explicitly confirmed there is none.
        const liveRenewals = (renByLease[l.id] || []).filter((r) => r.status !== 'applied');
        const noRenewal = l.no_renewal_option === true || liveRenewals.length === 0;
        out.push({
          ...ctx,
          focus: 'termination',
          // No renewal on the table is the more urgent case — flag it red.
          tone: noRenewal ? 'danger' : b.tone,
          bucketLabel: b.label,
          date: l.lease_termination_date,
          days: daysUntil(l.lease_termination_date, now),
          noRenewal,
          title: noRenewal ? `Lease ending — no renewal — ${l.tenant_name}` : `Lease ending — ${l.tenant_name}`,
          detail: noRenewal
            ? `Term expires ${fmtDate(l.lease_termination_date)} · no renewal option on file`
            : `Term expires ${fmtDate(l.lease_termination_date)}`,
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
  (contracts || []).forEach((c) => {
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
  // and each tenant's policy as the expiry date nears.
  (insurance || []).forEach((p) => {
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
      title: `${isLandlord ? 'Landlord' : 'Tenant'} insurance ${expired ? 'expired' : 'expiring'} — ${who}`,
      detail: `${p.insurer ? p.insurer + ' · ' : ''}${expired ? 'expired' : 'expires'} ${fmtDate(p.expiry_date)}`,
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
