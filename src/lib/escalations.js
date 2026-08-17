// Code-only escalation math. Mirrors the SQL `effective_rent` function so the UI
// can compute/preview without a round-trip. NEVER routes through the AI API.

/**
 * Compute the new base rent for an escalation, given the prior rent.
 * @param {number} priorRent
 * @param {{escalation_type: string, escalation_value: number, new_base_rent?: number}} esc
 * @returns {number}
 */
export function computeEscalatedRent(priorRent, esc) {
  const v = Number(esc.escalation_value) || 0;
  switch (esc.escalation_type) {
    case 'percent':
      return round2(priorRent * (1 + v / 100));
    case 'fixed':
      return round2(priorRent + v);
    case 'cpi':
      // CPI is externally sourced; treat escalation_value as the resolved % for now.
      return round2(priorRent * (1 + v / 100));
    case 'manual':
    default:
      return round2(esc.new_base_rent != null ? esc.new_base_rent : priorRent);
  }
}

/**
 * Resolve the effective annual base rent for a lease in a given year — ERA-AWARE.
 * Mirrors the SQL effective_rent() (migration 0054): base_rent is the CURRENT rent
 * (kept live by applyDueEscalations, renewals, and manual edits), so it wins for the
 * current era. The ledger is only consulted for a HISTORICAL year — one that has an
 * applied step dated AFTER it, proving a later rent superseded it. This prevents a
 * renewed lease (whose base_rent moved but whose ledger stayed put) from reporting a
 * stale rent in the rent roll / financials.
 * @param {{base_rent: number}} lease
 * @param {Array} escalations  rows with {effective_date, new_base_rent, status}
 * @param {number} year
 */
export function effectiveRent(lease, escalations, year) {
  const cutoff = parseDate(`${year}-12-31`);
  const applied = (escalations || []).filter((e) => e.status === 'applied');
  // Historical year: an applied step is dated after it → answer from the ledger.
  const supersededLater = applied.some((e) => parseDate(e.effective_date) > cutoff);
  if (supersededLater) {
    const atOrBefore = applied
      .filter((e) => parseDate(e.effective_date) <= cutoff)
      .sort((a, b) => parseDate(b.effective_date) - parseDate(a.effective_date));
    return atOrBefore.length ? Number(atOrBefore[0].new_base_rent) : Number(lease.base_rent) || 0;
  }
  // Current era: base_rent is the live, authoritative rent.
  return Number(lease.base_rent) || 0;
}

/**
 * Escalations that are due (effective_date within `withinDays`) and still 'scheduled'.
 * These power the EscalationRecommendationCard.
 */
export function dueEscalations(escalations, withinDays = 31, now = new Date()) {
  const horizon = new Date(now.getTime() + withinDays * 86400000);
  return (escalations || []).filter(
    (e) => e.status === 'scheduled' && parseDate(e.effective_date) <= horizon
  );
}

/**
 * Occupancy start for a lease — the earliest date it was actually being occupied,
 * for prorating a mid-year start (a July-start tenant owes Jul–Dec, not the whole year)
 * and for knowing which months a tenant is "behind" on.
 *
 * = min(lease_start, earliest APPLIED escalation date). Why not lease_start alone: a
 * catch-up renewal moves lease_start forward to the CURRENT term's start, so a
 * long-time tenant renewed in place would look like it just moved in. But a renewed
 * lease keeps its old applied rent steps — evidence it was occupied earlier — so the
 * earliest applied step pulls the occupancy start back to the real move-in. A genuinely
 * new tenancy's only applied step is at/after its start, so lease_start wins. Returns
 * null when neither is known (an old lease with no start on file bills the full year —
 * the safe, unchanged default).
 */
export function occupancyStart(lease, escalations) {
  const dates = [];
  if (lease?.lease_start) dates.push(String(lease.lease_start));
  (escalations || []).forEach((e) => { if (e.status === 'applied' && e.effective_date) dates.push(String(e.effective_date)); });
  if (!dates.length) return null;
  dates.sort(); // yyyy-mm-dd sorts lexicographically == chronologically
  return dates[0];
}

/**
 * The annual base rent in effect during each of the 12 months of `year`, as an array
 * [Jan..Dec]. Lets a monthly schedule bill the OLD rate for the months before a
 * mid-year escalation and the NEW rate after — instead of applying the post-step rent
 * to the whole year (which over-bills). ERA-AWARE, mirroring effectiveRent(): base_rent
 * is the live authoritative rent for the current era (the segment at/after the latest
 * applied step), and the ledger supplies the rate for historical segments. A month
 * before any recorded applied step falls back to base_rent (its true prior rate isn't
 * recoverable once base_rent moved — a small, bounded degradation, never a crash).
 * ⚠ `includeScheduled` IS OPT-IN, AND THE DEFAULT MUST NEVER MOVE. This function is a §2
 * choke point: it feeds buildLeaseSchedule → the Ledger grid, every invoice, owedByMonthForInvoice,
 * closeYear and the dashboard alerts, and it has an SQL twin (`effective_rent`, migration 0054)
 * that knows only about APPLIED steps. Flip the default and the app starts billing rent that has
 * not taken effect.
 *
 * The opt-in exists for ONE reader: the Income-and-expenses workbook's **projected** basis
 * (2026-08-17, George: *"right now, it doesn't show escalations if there is one on the Excel
 * sheet"*). A step only flips to `applied` on its effective date (nightly, `apply_due_escalations()`),
 * so a step dated October is invisible in a workbook downloaded in August and every month from
 * October on prints the OLD rent. A projection is the one place that is wrong.
 *
 * The era rule survives intact: base_rent is authoritative from the latest APPLIED step onward,
 * so a step later than every applied one is read straight off its row — the ledger states that
 * future rent outright and base_rent has not moved to it yet.
 *
 * @param {Array} escalations rows with {effective_date, new_base_rent, status}
 * @param {number} baseRent   lease.base_rent (the current authoritative annual rent)
 * @param {number} year
 * @param {{includeScheduled?: boolean}} opts
 * @returns {number[]} length-12 array of annual base rents, index 0 = January
 */
export function monthlyBases(escalations, baseRent, year, { includeScheduled = false } = {}) {
  const base = Number(baseRent) || 0;
  const usable = (escalations || []).filter((e) => e.effective_date && e.new_base_rent != null);
  const at = (list) => list
    .map((e) => ({ t: parseDate(e.effective_date).getTime(), rent: Number(e.new_base_rent) || 0 }))
    .sort((a, b) => a.t - b.t);
  const applied = at(usable.filter((e) => e.status === 'applied'));
  const maxT = applied.length ? applied[applied.length - 1].t : null;
  // With the opt-in off this IS `applied`, so every existing caller behaves byte for byte.
  const steps = includeScheduled
    ? at(usable.filter((e) => e.status === 'applied' || e.status === 'scheduled'))
    : applied;
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const ref = new Date(year, m - 1, 1, 12).getTime(); // first day of the month, local noon
    const prior = steps.filter((s) => s.t <= ref);
    if (!prior.length) { out.push(base); continue; } // before any step → current best
    const latest = prior[prior.length - 1];
    // A step dated after every APPLIED one has not been swept into base_rent yet, so the row
    // is the only place the new rent exists. (Unreachable unless includeScheduled is on.)
    if (maxT == null || latest.t > maxT) { out.push(latest.rent); continue; }
    // Latest applicable step is the globally-latest applied step → the current era →
    // base_rent is authoritative. Otherwise a later step supersedes it → historical
    // segment → read the ledger rate.
    out.push(latest.t === maxT ? base : latest.rent);
  }
  return out;
}

/**
 * The rent in effect immediately before `date` — the most recent escalation's
 * new_base_rent before that date, else the lease base rent.
 */
export function priorRentBefore(lease, escalations, date) {
  const base = Number(lease.base_rent) || 0;
  if (!date) return base;
  const cutoff = parseDate(date);
  const earlier = (escalations || [])
    .filter((e) => parseDate(e.effective_date) < cutoff)
    .sort((a, b) => parseDate(b.effective_date) - parseDate(a.effective_date));
  return earlier.length ? Number(earlier[0].new_base_rent) : base;
}

// ─── Two rent steps on one day ───────────────────────────────────────────────────────
//
// George, 2026-08-17, on the beauty and barber shop: *"see how it says two values for june
// 2025? if you look at the 3rd addendumn … it read the monthly value and the yearly value
// as two different numbers which they are becaue they are off by 4 cents. if this happens
// it should flag and tell the user that number is off and have them choose what theyd like
// to do just for the sake of the software not flagging it every time."*
//
// The real rows: 2025-06-01 carries **$31,800.96** (read 24 Jul) and **$31,801.00** (written
// by applyAddendum on 12 Aug from the fourth addendum). The document says both — *"$31,801.00
// annually or $2,650.08 monthly"* — and $2,650.08 × 12 = $31,800.96. It disagrees with itself.
//
// ⚠ DELIBERATELY DETECTED ON READ, NOT DEDUPED ON INSERT. Two steps on one date are
// sometimes a real disagreement the landlord has to see, and silently dropping one picks a
// winner without asking — the wrong pick moves the rent. So: find it, say what it is, let
// them choose, and remember the choice.
//
// `kind` is the whole diagnosis, and the test for it is not a tolerance — it is whether the
// two figures are the SAME MONTHLY RENT. $31,800.96 / 12 and $31,801.00 / 12 both round to
// $2,650.08, which is exactly why the screen can say "these are the same rent, rounded two
// ways" rather than "these are four cents apart" and leave the landlord to work out which.
// A pair that genuinely disagrees ($31,800 vs $31,801 → $2,650.00 vs $2,650.08) comes back
// as 'conflict' and gets no such reassurance.
//
// @param escalations  rows with {id, effective_date, new_base_rent}
// @param dismissed    a Set of alert keys the landlord answered "keep both" to (see
//                     rentDupKey) — pass none and nothing is filtered
// @param leaseId      only needed to build those keys
// @returns [{ date, rows (highest first), spread, monthly, kind }]
export function duplicateRentSteps(escalations, { leaseId = null, dismissed = null } = {}) {
  const byDate = new Map();
  for (const e of escalations || []) {
    if (!e?.effective_date || e.new_base_rent == null) continue;
    const k = String(e.effective_date);
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(e);
  }
  const out = [];
  for (const [date, list] of byDate) {
    if (list.length < 2) continue;
    if (dismissed?.has(rentDupKey(leaseId, date))) continue;
    const amounts = list.map((e) => Number(e.new_base_rent) || 0);
    const hi = Math.max(...amounts);
    const lo = Math.min(...amounts);
    // Same monthly rent to the cent → the annual figures differ only in the rounding.
    const sameMonthly = hi / 12 - lo / 12 <= 0.005;
    out.push({
      date,
      rows: [...list].sort((a, b) => (Number(b.new_base_rent) || 0) - (Number(a.new_base_rent) || 0)),
      spread: round2(hi - lo),
      monthly: sameMonthly ? round2(hi / 12) : null,
      kind: sameMonthly ? 'rounding' : 'conflict',
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// "Keep both" is remembered in `alert_states` (migration 0028) rather than in a column of
// its own — it is a keyed decision, which is precisely what that table is, and InsuranceVault
// already uses it the same way. Built here so the lease page's folded summary and the editor
// that offers the buttons can never key it two different ways.
export const rentDupKey = (leaseId, date) => `rent_dup:${leaseId}:${date}`;

// Parse a date-only string (yyyy-mm-dd) at LOCAL noon so comparisons don't shift a
// day in timezones behind UTC — matching src/lib/format.js + src/lib/leaseTerm.js.
function parseDate(d) {
  if (!d) return null;
  const s = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d;
  return new Date(s);
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
