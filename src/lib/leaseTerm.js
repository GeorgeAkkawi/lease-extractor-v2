// Pure date-arithmetic resolver: given a lease's committed term + its ordered rent
// escalations, work out which period TODAY falls in and the rent in effect. No AI,
// no DB writes. Renewal OPTIONS are deliberately NOT chained into the term — a
// pending option is a right, not a commitment, and only extends the lease once the
// landlord confirms it (confirmRenewal in api.js) writes the new dates directly.
// Drives the intake back-fill (backfillLeaseToToday in api.js) and the display.

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
 * Resolve the period + rent in effect today. (Renewal options are intentionally not
 * consulted — see the file header. Callers may still pass `renewals`; it's ignored.)
 * @returns {{
 *   periodLabel: string, periodStart: string|null, periodEnd: string|null,
 *   currentRent: number, status: 'active'|'expired',
 *   consumedEscalationIds: string[], consumedRenewalIds: string[],
 *   currentRenewalId: string|null,
 * }}
 */
export function resolveCurrentTerm({ lease, escalations = [], today } = {}) {
  const now = noon(today) || new Date();
  const nowT = now.getTime();
  const baseRent = num(lease?.base_rent);
  const origStart = lease?.lease_start || null;
  const origEnd = lease?.lease_termination_date || null;

  // The committed term is the lease's OWN window — nothing else. A renewal option
  // is the tenant's *right* to extend, not a commitment, so it is NEVER chained into
  // the term here: an un-exercised option must never push lease_termination_date
  // forward. A renewal only lengthens the term once the landlord explicitly confirms
  // it (confirmRenewal in api.js), which writes the new dates onto the lease directly
  // and lays in the rent steps — so by the time we resolve, the lease's own dates
  // already reflect every *confirmed* renewal. Pending/declined options are ignored.
  const windows = [{ kind: 'original', label: 'Original term', start: origStart, end: origEnd, renewalId: null, rent: baseRent }];

  // 1) Which window contains today? (start <= today < end; open start/end allowed.)
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

  // 2) Current rent = the rent of the latest rent-change event on/before today.
  //    Events: original base rent at the start, and every escalation at its
  //    effective date. (Confirmed renewals materialize as escalations, so they're
  //    already covered here.)
  const events = [{ t: origStart ? time(origStart) : -Infinity, rent: baseRent }];
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

  // 3) What to mark applied at back-fill: escalations already in effect. Renewal
  //    options are never auto-consumed — they only change status via an explicit
  //    landlord confirm/decline, so we never touch them here.
  const consumedEscalationIds = escDated.filter((e) => time(e.effective_date) <= nowT).map((e) => e.id);

  return {
    periodLabel: status === 'expired' ? 'Expired' : current.label,
    periodStart: current.start || null,
    periodEnd: current.end || null,
    currentRent,
    status,
    consumedEscalationIds,
    consumedRenewalIds: [],
    currentRenewalId: null,
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
