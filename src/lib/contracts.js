// Pure helpers for a service contract's cost over time. A multi-year contract can
// escalate its fee each year; these say whether it covers a given fiscal year and the
// escalated annual cost for that year. No AI, no DB — mirrored by syncContractCamItems
// in api.js, which turns these figures into CAM line items automatically each year.

const yearOf = (iso) => (iso ? new Date(iso + 'T12:00:00').getFullYear() : null);

// Does the contract's term cover this fiscal year? A contract with no dates is treated
// as ongoing (covers every year). A one-time fee lands only in its start year and never
// recurs into a later year's CAM.
export function contractCoversYear(c, year) {
  if (!c) return false;
  const y = Number(year);
  if (c.frequency === 'one-time') {
    const startY = yearOf(c.start_date);
    return startY != null && startY === y;
  }
  const startY = yearOf(c.start_date);
  const endY = yearOf(c.end_date);
  if (startY != null && y < startY) return false;
  if (endY != null && y > endY) return false;
  return true;
}

// The escalated ANNUAL cost of a contract in a given year. Base = the fee annualized by
// frequency (monthly ×12; annual / one-time as-is), grown by escalation_pct once per
// year since the start year. No start_date or no pct → flat (no growth). Returns 0 when
// the contract doesn't cover the year or has no fee.
export function contractAnnualCost(c, year) {
  if (!contractCoversYear(c, year)) return 0;
  const amt = Number(c?.amount) || 0;
  if (amt <= 0) return 0;
  const annual = c.frequency === 'monthly' ? amt * 12 : amt;
  const pct = Number(c?.escalation_pct) || 0;
  const startY = yearOf(c.start_date);
  const steps = pct > 0 && startY != null && Number(year) > startY ? Number(year) - startY : 0;
  return Math.round(annual * Math.pow(1 + pct / 100, steps) * 100) / 100;
}
