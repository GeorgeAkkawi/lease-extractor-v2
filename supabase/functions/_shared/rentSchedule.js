// Pure rent-schedule math shared by the extract-lease edge function and its unit test.
// The model reads RAW figures + a basis; WE do all arithmetic here, to the cent — models
// read reliably but multiply unreliably. Kept dependency-free so both Deno (edge) and
// Jest (frontend test) can import it.

// Deterministic annual rent from a raw figure + its basis. Returns null for an unusable
// amount or a $/SF basis with no square footage (the caller then keeps the model's own
// figure rather than inventing one).
export function annualRentFrom(amount, period, sqft) {
  const a = typeof amount === 'number' ? amount : Number(amount);
  if (!a || !isFinite(a) || a <= 0) return null;
  const cents = (x) => Math.round(x * 100) / 100; // keep cents — never round to whole dollars
  switch (period) {
    case 'per_month': return cents(a * 12);
    case 'per_year': return cents(a);
    case 'per_sqft_year': return sqft > 0 ? cents(a * sqft) : null;
    case 'per_sqft_month': return sqft > 0 ? cents(a * sqft * 12) : null;
    default: return null;
  }
}

// A prose rent-escalation FORMULA ("base rent increases 2% annually") with no printed
// period-by-period table. The model reads only the PERCENT and where the formula stops;
// we synthesize one relative step per lease year here — same compound, round-each-step
// math the frontend's computeEscalatedRent / renewal materialization use, so the figures
// are identical whether they come from here or are recomputed later.
//   baseAnnual  — the starting annual base rent (year 1)
//   pct         — the annual increase percent (2 for "2%")
//   termMonths  — the initial term length in months (bounds how many years escalate)
//   stopMonths  — offset in months where the formula ends / rent is renegotiated (else null)
// Returns an array of undated ({effective_date:null, months_from_start}) percent steps the
// app dates from the confirmed start, or null when there's nothing to generate.
export function percentEscalations(baseAnnual, pct, termMonths, stopMonths) {
  const base = Number(baseAnnual);
  const p = Number(pct);
  if (!base || !isFinite(base) || base <= 0) return null;
  if (!p || !isFinite(p) || p <= 0) return null;
  const round2 = (x) => Math.round(x * 100) / 100;
  const term = Number(termMonths);
  const stop = stopMonths == null || stopMonths === '' ? null : Number(stopMonths);
  // The formula governs to the term end, or to the renegotiation point if that's earlier.
  let limit = isFinite(term) && term > 0 ? term : null;
  if (stop != null && isFinite(stop) && stop > 0) limit = limit == null ? stop : Math.min(limit, stop);
  if (limit == null || limit <= 12) return null; // no horizon, or a single year → no steps
  const steps = [];
  let prior = base;
  for (let m = 12; m < limit; m += 12) {
    prior = round2(prior * (1 + p / 100)); // round each year — matches computeEscalatedRent
    steps.push({
      effective_date: null,
      months_from_start: m,
      escalation_type: 'percent',
      escalation_value: p,
      new_base_rent: prior,
    });
  }
  return steps.length ? steps : null;
}

// Rebuild the schedule from the supplement's raw rows so EVERY amount (base + each step)
// is computed in code. The earliest dated period becomes base_rent; later periods become
// manual escalations. Also cross-checks our exact figure against the model's OWN
// new_base_rent (the main call did the math itself) — a wide gap means the model handed
// over a pre-computed amount it got wrong (the raw rate wasn't read cleanly), which we
// surface as a flag for a human to eyeball before saving.
//
// Inputs:  { rentSchedule: [{ effective_date, months_from_start, amount, period }], sqft,
//            modelEscalations, escalationPct, escalationStopMonths, termMonths }
// Returns: { baseRent, baseDate, escalations, flag } — any of which may be null (no
//          change). baseDate is the earliest period's effective date (the addendum
//          import uses it to date the opening rent step; the lease import ignores it).
//
// Two modes, chosen by the rows themselves:
//   • DATED — at least one row prints a real calendar date. The earliest dated period is
//     base_rent, later dated periods become escalations. Undated rows are dropped (they
//     can't be scheduled). This is the addendum path and any lease that prints real dates.
//   • RELATIVE — NO row prints a date but rows carry months_from_start (a lease-year table
//     with no commencement date, e.g. Wingstop "Year 1 … Year 6"). We can't know the real
//     dates, so escalations come back with effective_date:null + months_from_start, and the
//     app anchors them to the start date the user confirms (buildEscalations' anchorDate).
//
// A printed rent TABLE always wins: the prose percent formula (escalationPct) is only
// applied when the document prices at most ONE period (no real step-up rows to honor).
export function rebuildRentSchedule({ rentSchedule, sqft, modelEscalations, escalationPct, escalationStopMonths, termMonths } = {}) {
  const asOffset = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Math.trunc(Number(v)));
  const rawRows = (Array.isArray(rentSchedule) ? rentSchedule : []).map((r) => ({
    date: typeof r?.effective_date === 'string' ? r.effective_date : null,
    months: asOffset(r?.months_from_start),
    period: r?.period,
    amount: r?.amount,
    annual: annualRentFrom(r?.amount, r?.period, sqft),
  }));

  // A $/SF row we couldn't resolve (no square footage anywhere) would otherwise be
  // dropped and silently fall back to the model's own math — surface it instead.
  const unresolved = rawRows
    .filter((r) => r.annual == null && (r.period === 'per_sqft_year' || r.period === 'per_sqft_month'))
    .map((r) => ({ effective_date: r.date, amount: r.amount, period: r.period }));

  const usable = rawRows.filter((r) => r.annual != null);

  // When the printed schedule has at most one priced period, there's no real step-up
  // table to honor — so a prose "X% per year" formula (if the model found one) becomes
  // the escalations. A multi-row table always wins and this is skipped.
  const withFormula = (baseRent, baseDate, escalations, flag, tableRowCount) => {
    if ((escalations == null || escalations.length === 0) && tableRowCount <= 1) {
      const pctSteps = percentEscalations(baseRent, escalationPct, termMonths, escalationStopMonths);
      if (pctSteps) return { baseRent, baseDate, escalations: pctSteps, flag };
    }
    return { baseRent, baseDate, escalations, flag };
  };

  // RELATIVE mode: no printed dates, but lease-year offsets are present. Sort by offset,
  // earliest is base_rent, the rest are undated steps carrying months_from_start.
  const anyDate = usable.some((r) => r.date);
  const relativeMode = !anyDate && usable.some((r) => r.months != null);
  if (relativeMode) {
    const off = (r) => (r.months == null ? 0 : r.months);
    const rel = usable.slice().sort((a, b) => off(a) - off(b));
    const baseRent = rel[0].annual;
    const steps = rel.slice(1);
    const escalations = steps.length
      ? steps.map((r) => ({
          effective_date: null,
          months_from_start: off(r),
          escalation_type: 'manual',
          escalation_value: null,
          new_base_rent: r.annual,
        }))
      : null;
    const flag = unresolved.length ? { reason: 'missing_sqft_for_psf', diverged: [], unresolved } : null;
    return withFormula(baseRent, null, escalations, flag, rel.length);
  }

  const rows = usable
    .slice()
    .sort((a, b) => (a.date || '9999-99-99').localeCompare(b.date || '9999-99-99'));

  const modelByDate = new Map();
  for (const e of (Array.isArray(modelEscalations) ? modelEscalations : [])) {
    if (e && typeof e.effective_date === 'string' && e.new_base_rent != null) {
      modelByDate.set(e.effective_date, Number(e.new_base_rent));
    }
  }
  const diverged = [];
  const crossCheck = (date, code) => {
    if (!date) return;
    const model = modelByDate.get(date);
    // tolerate normal rounding drift; catch real disagreement (~0.25% or $5)
    if (model != null && Math.abs(model - code) > Math.max(5, code * 0.0025)) {
      diverged.push({ effective_date: date, code, model });
    }
  };

  let baseRent = null;
  let baseDate = null;
  let escalations = null;
  if (rows.length) {
    crossCheck(rows[0].date, rows[0].annual);
    baseRent = rows[0].annual;
    baseDate = rows[0].date;
    const steps = rows.slice(1).filter((r) => r.date);
    if (steps.length) {
      steps.forEach((r) => crossCheck(r.date, r.annual));
      escalations = steps.map((r) => ({
        effective_date: r.date,
        escalation_type: 'manual',
        escalation_value: null,
        new_base_rent: r.annual,
      }));
    }
  }

  const flag = (unresolved.length || diverged.length)
    ? { reason: unresolved.length ? 'missing_sqft_for_psf' : 'model_math_divergence', diverged, unresolved }
    : null;

  return withFormula(baseRent, baseDate, escalations, flag, rows.length);
}
