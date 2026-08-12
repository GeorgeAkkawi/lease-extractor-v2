// Pure helpers for a service contract's cost over time. A multi-year contract can
// escalate its fee each year; these say whether it covers a given fiscal year and the
// escalated annual cost for that year. No AI, no DB — mirrored by syncContractCamItems
// in api.js, which turns these figures into CAM line items automatically each year.
//
// ⚠ contractAnnualCost is a CHOKE POINT (CLAUDE.md §2). Three readers price a contract
// through it — syncContractCamItems (→ cam_line_items → cam_total → tenant shares →
// a stored invoice), the Contracts tab row, and the contract review dialog. Change the
// rule here and all three move together; give one of them its own arithmetic and two
// screens quote different annual costs for the same contract. (A fourth reader,
// vendorRowsFor, went with the 1099 worksheet on 2026-08-12.)

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

/**
 * The dated fee step in effect for a fiscal year (contract_escalations, 0091).
 *
 * THE RULE: the LAST step, by effective_date, whose effective date's CALENDAR YEAR is
 * less than or equal to `year`.
 *
 * Deliberately year-of, and the two obvious alternatives are both wrong for this data:
 *   • "effective_date <= Jan 1 of year" lags a mid-year-start contract a full year — a
 *     snow contract whose season fee steps every 1 November would bill the old figure
 *     for the whole of the year it rose in.
 *   • month precision within the year (pricing January at the old figure and December at
 *     the new one) is what the LEASE side does, because a lease bills monthly. A contract
 *     feeds ONE annual CAM line item per fiscal year — there is no month to attach a
 *     split to, so a part-year rule would have to invent a proration the CAM row cannot
 *     express.
 * Year-of also reproduces the pre-0091 `steps = year − startYear` compounding exactly, so
 * a contract with no steps is priced byte for byte as it was before this table existed.
 *
 * `steps` may be null/empty — that is the normal case and the reason every caller can
 * pass it lazily.
 */
export function contractStepFor(steps, year) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const y = Number(year);
  if (!Number.isFinite(y)) return null;
  let best = null;
  for (const s of steps) {
    const sy = yearOf(s?.effective_date);
    if (sy == null || sy > y) continue;
    if (!best || String(s.effective_date) > String(best.effective_date)) best = s;
  }
  return best;
}

/**
 * The escalated ANNUAL cost of a contract in a given year.
 *
 * Base = the fee annualized by frequency (monthly ×12; annual / one-time as-is). Which fee:
 *   • a dated step in effect (contract_escalations) wins — it IS the schedule, so the
 *     scalar escalation_pct does NOT compound on top of it; and
 *   • otherwise the contract's own `amount`, grown by escalation_pct once per year since
 *     the start year — the pre-0091 behaviour, unchanged.
 *
 * ⚠ A step's new_amount is in the contract's OWN frequency (a monthly contract stores a
 * monthly figure), matching service_contracts.amount. Storing an annual figure on a
 * monthly contract multiplies it by twelve.
 *
 * Returns 0 when the contract doesn't cover the year or has no fee.
 */
export function contractAnnualCost(c, year, steps = null) {
  if (!contractCoversYear(c, year)) return 0;
  const step = contractStepFor(steps, year);
  const raw = step ? Number(step.new_amount) : Number(c?.amount);
  const amt = Number.isFinite(raw) ? raw : 0;
  if (amt <= 0) return 0;
  const annual = c.frequency === 'monthly' ? amt * 12 : amt;
  // A dated schedule prices each era itself — compounding a percent on top would apply the
  // escalation twice.
  if (step) return Math.round(annual * 100) / 100;
  const pct = Number(c?.escalation_pct) || 0;
  const startY = yearOf(c.start_date);
  const nSteps = pct > 0 && startY != null && Number(year) > startY ? Number(year) - startY : 0;
  return Math.round(annual * Math.pow(1 + pct / 100, nSteps) * 100) / 100;
}

// The next fee step that has not taken effect yet, as of `today` — what the dashboard's
// "fee step coming due" alert watches. Null when the schedule is empty or fully in the past.
export function nextContractStep(steps, today) {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const t = String(today || '');
  let best = null;
  for (const s of steps) {
    const d = s?.effective_date ? String(s.effective_date) : null;
    if (!d || d <= t) continue;
    if (!best || d < String(best.effective_date)) best = s;
  }
  return best;
}

// Group a flat list of contract_escalations rows by contract_id — the shape every bulk
// caller wants after ONE read (never a per-contract waterfall).
export function stepsByContract(rows) {
  const by = new Map();
  for (const r of rows || []) {
    if (!r?.contract_id) continue;
    if (!by.has(r.contract_id)) by.set(r.contract_id, []);
    by.get(r.contract_id).push(r);
  }
  return by;
}
