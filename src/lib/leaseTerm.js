// Pure date-arithmetic resolver: given a lease's original term + its ordered rent
// escalations + renewal options, work out which period TODAY falls in and the
// rent in effect. No AI, no DB writes. Mirrors the chaining in apply_due_renewals
// and the rent lookup in effectiveRent(). Drives the intake back-fill
// (backfillLeaseToToday in api.js) and the "Current term" display.
import { addMonths } from './renewals';

// Parse an ISO date (or Date) at local noon so day-only strings don't shift back
// in timezones behind UTC — same convention as src/lib/format.js fmtDate.
function noon(d) {
  if (!d) return null;
  const s = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d;
  const t = new Date(s);
  return isNaN(t) ? null : t;
}
const num = (n) => Number(n) || 0;
const time = (d) => { const t = noon(d); return t ? t.getTime() : null; };

// Order renewal options the way apply_due_renewals does (notice_by_date nulls
// last, then option_label) so chaining is deterministic and matches the engines.
export function cmpRenewal(a, b) {
  const an = a.notice_by_date, bn = b.notice_by_date;
  if (an && bn && an !== bn) return an < bn ? -1 : 1;
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  return String(a.option_label || '').localeCompare(String(b.option_label || ''));
}

/**
 * Resolve the period + rent in effect today.
 * @returns {{
 *   periodLabel: string, periodStart: string|null, periodEnd: string|null,
 *   currentRent: number, status: 'active'|'expired',
 *   consumedEscalationIds: string[], consumedRenewalIds: string[],
 *   currentRenewalId: string|null,
 * }}
 */
export function resolveCurrentTerm({ lease, escalations = [], renewals = [], today } = {}) {
  const now = noon(today) || new Date();
  const nowT = now.getTime();
  const baseRent = num(lease?.base_rent);
  const origStart = lease?.lease_start || null;
  const origEnd = lease?.lease_termination_date || null;

  // Only NOT-yet-applied options chain forward. Applied options have already been
  // folded into the lease's live dates/rent, so excluding them keeps the resolver
  // idempotent: re-running after a back-fill won't double-count past renewals.
  const opts = (renewals || []).filter((r) => r.status !== 'applied').sort(cmpRenewal);

  // 1) Chained windows: the original term, then each option after the prior end.
  const windows = [{ kind: 'original', label: 'Original term', start: origStart, end: origEnd, renewalId: null, rent: baseRent }];
  let prevEnd = origEnd;
  opts.forEach((r, i) => {
    const start = prevEnd;
    const end = start ? addMonths(start, r.term_months || 12) : null;
    windows.push({
      kind: 'renewal',
      label: r.option_label || `Renewal option ${i + 1}`,
      start, end, renewalId: r.id,
      rent: r.new_rent != null ? Number(r.new_rent) : null, // null = carry prior rent
    });
    prevEnd = end;
  });

  // 2) Which window contains today? (start <= today < end; open start/end allowed.)
  const contains = (w) => {
    const s = time(w.start), e = time(w.end);
    if (s != null && nowT < s) return false;
    if (e != null && nowT >= e) return false;
    return true;
  };
  let idx = windows.findIndex(contains);
  let status = 'active';
  if (idx === -1) {
    const firstStart = time(windows[0].start);
    if (firstStart != null && nowT < firstStart) idx = 0; // on file but not yet started
    else { idx = windows.length - 1; status = 'expired'; }
  }
  const current = windows[idx];

  // 3) Current rent = the rent of the latest rent-change event on/before today.
  //    Events: original base rent at the start, each chained option's new_rent at
  //    its window start, and every escalation at its effective date.
  const events = [{ t: origStart ? time(origStart) : -Infinity, rent: baseRent }];
  windows.forEach((w) => { if (w.kind === 'renewal' && w.rent != null && w.start != null) events.push({ t: time(w.start), rent: w.rent }); });
  const escDated = (escalations || []).filter((e) => e.effective_date);
  escDated.forEach((e) => events.push({ t: time(e.effective_date), rent: num(e.new_base_rent) }));

  let currentRent = baseRent;
  let best = -Infinity;
  for (const ev of events) {
    if (ev.t != null && ev.t <= nowT && ev.t >= best) { best = ev.t; currentRent = ev.rent; }
  }
  if (status === 'expired') {
    // past the whole schedule → the last known rent (latest event overall)
    currentRent = events.reduce((acc, ev) => ((ev.t ?? -Infinity) >= (acc.t ?? -Infinity) ? ev : acc), events[0]).rent;
  }

  // 4) What to mark applied at back-fill: escalations already in effect, and every
  //    option we've ENTERED (window start on/before today — includes the current one).
  const consumedEscalationIds = escDated.filter((e) => time(e.effective_date) <= nowT).map((e) => e.id);
  const consumedRenewalIds = windows
    .filter((w) => w.kind === 'renewal' && w.start != null && time(w.start) <= nowT)
    .map((w) => w.renewalId);

  return {
    periodLabel: status === 'expired' ? 'Expired' : current.label,
    periodStart: current.start || null,
    periodEnd: current.end || null,
    currentRent,
    status,
    consumedEscalationIds,
    consumedRenewalIds,
    currentRenewalId: current.kind === 'renewal' ? current.renewalId : null,
  };
}

// Human label for the period a lease is in NOW, for display. After a back-fill the
// lease's own dates already hold the current window, so the label comes from how
// many renewal options have been applied (consumed) to reach today.
export function currentTermLabel(lease, renewals = []) {
  if (lease?.is_active === false) return 'Outdated';
  const applied = (renewals || []).filter((r) => r.status === 'applied');
  if (!applied.length) return 'Original term';
  const last = [...applied].sort(cmpRenewal).pop();
  return last?.option_label || `Renewal option ${applied.length}`;
}
