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
 * Resolve the effective annual base rent for a lease in a given year.
 * Considers only APPLIED escalations with effective_date on/before Dec 31 of the year.
 * @param {{base_rent: number}} lease
 * @param {Array} escalations  rows with {effective_date, new_base_rent, status}
 * @param {number} year
 */
export function effectiveRent(lease, escalations, year) {
  const cutoff = parseDate(`${year}-12-31`);
  const applied = (escalations || [])
    .filter((e) => e.status === 'applied' && parseDate(e.effective_date) <= cutoff)
    .sort((a, b) => parseDate(b.effective_date) - parseDate(a.effective_date));
  return applied.length ? Number(applied[0].new_base_rent) : Number(lease.base_rent) || 0;
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
