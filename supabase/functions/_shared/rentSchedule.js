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

// Estimated additional-rent charges (CAM / property tax / roof) some leases state as a
// specific figure the tenant pays during the year — "estimated CAM charges of $4.50 per
// square foot per annum", "estimated monthly tax charges of $833.33". The model reads each
// figure RAW with its basis (same contract as rent_schedule); this converts them to the
// ANNUAL dollars the lease est_* columns store. One figure per charge — the FIRST stated
// entry wins (a later re-estimate clause never silently overrides the primary one), and a
// 'combined' figure (one amount covering CAM + taxes together) lands on cam only when no
// separate CAM figure exists. Unusable rows (unknown basis, $/SF with no sqft) are skipped
// — better no prefill than a wrong one.
// Returns { cam, tax, roof, quotes: {cam,tax,roof}, confidence: {cam,tax,roof} } — every
// value null when not stated.
export function estimateAnnualsFrom(estimates, sqft) {
  const out = { cam: null, tax: null, roof: null, quotes: {}, confidence: {} };
  const rows = Array.isArray(estimates) ? estimates : [];
  const put = (key, r, annual) => {
    if (out[key] != null) return; // first stated figure wins
    out[key] = annual;
    if (typeof r.source_quote === 'string' && r.source_quote) out.quotes[key] = r.source_quote;
    if (isFinite(Number(r.confidence))) out.confidence[key] = Number(r.confidence);
  };
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const annual = annualRentFrom(r.amount, r.period, sqft);
    if (annual == null) continue;
    if (r.charge === 'cam' || r.charge === 'tax' || r.charge === 'roof') put(r.charge, r, annual);
  }
  // A combined CAM+tax figure only fills the gap a separate CAM figure didn't.
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.charge !== 'combined') continue;
    const annual = annualRentFrom(r.amount, r.period, sqft);
    if (annual != null) put('cam', r, annual);
  }
  return out;
}

// A renewal/EXTENSION option that prices its term with a year-by-year rent table (e.g.
// Busey's Exhibit D: five monthly installments stepping up over the 5-year option). The
// model reads each period's RAW figure + basis (same never-let-the-model-multiply rule as
// the base schedule); we annualize here to the cent. Offsets are months from the OPTION
// start (Year 1 → 0, Year 2 → 12 …). Returns
//   { rows: [{ months_from_option_start, amount, period, annual }], firstYearAnnual }
// sorted by offset, or null when nothing is usable (empty/flat/percent/unpriced option, or
// only $/SF rows with no square footage). Pure — shared by the edge fn and its unit test.
export function annualizeOptionSchedule(rentSchedule, sqft) {
  const asOffset = (v) => (v == null || v === '' || !isFinite(Number(v)) ? 0 : Math.trunc(Number(v)));
  const raw = (Array.isArray(rentSchedule) ? rentSchedule : []).map((r) => ({
    months: asOffset(r?.months_from_option_start),
    period: r?.period,
    amount: r?.amount,
    annual: annualRentFrom(r?.amount, r?.period, sqft),
  }));
  // Same period stated two ways (a $/SF rate AND a plain dollar) → ONE period, not a step.
  // Keep the most reliable row: resolvable over unresolvable, plain-dollar over $/SF.
  const rank = (r) => {
    if (r.annual == null) return 2;
    return r.period === 'per_sqft_year' || r.period === 'per_sqft_month' ? 1 : 0;
  };
  const bestByOffset = new Map();
  for (const r of raw) {
    const cur = bestByOffset.get(r.months);
    if (!cur || rank(r) < rank(cur)) bestByOffset.set(r.months, r);
  }
  const usable = [...bestByOffset.values()].filter((r) => r.annual != null);
  if (!usable.length) return null;
  usable.sort((a, b) => a.months - b.months);
  // Normalize offsets so the earliest period is 0 — defends against a model that measured
  // from the LEASE start (e.g. 120/132/…) instead of the option start.
  const minOff = usable[0].months;
  const rows = usable.map((r) => ({
    months_from_option_start: r.months - minOff,
    amount: r.amount,
    period: r.period,
    annual: r.annual,
  }));
  return { rows, firstYearAnnual: rows[0].annual };
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

  // Collapse rows that describe the SAME period two different ways into one. A lease often
  // states its base rent both as a $/SF rate AND a plain monthly/annual dollar (e.g.
  // "$21.00 PSf" alongside "Monthly Base Rent: $1904.00"), and the model dutifully returns
  // BOTH — as two rows at the same offset (or the same printed date). Those are ONE period,
  // not a step-up. Left alone the duplicate is mistaken for a rent step, which (a) invents a
  // bogus escalation equal to the base and (b) — worse — makes the escalations array look
  // non-empty, suppressing the prose "X% per year" formula whose yearly steps only generate
  // when there are no real step rows. Group by period identity (printed date if any, else
  // month offset) and keep the most reliable row: a resolvable amount over an unresolvable
  // one, and a plain-dollar basis over a $/SF rate. Rows at genuinely different offsets /
  // dates (a real graduated table) have distinct keys and are never merged.
  const periodKey = (r) => (r.date != null ? `d:${r.date}` : `m:${r.months == null ? 0 : r.months}`);
  const rowRank = (r) => {
    if (r.annual == null) return 2;                                               // unresolvable ($/SF w/o sqft)
    return r.period === 'per_sqft_year' || r.period === 'per_sqft_month' ? 1 : 0; // prefer a plain-dollar row
  };
  const bestByPeriod = new Map();
  for (const r of rawRows) {
    const k = periodKey(r);
    const cur = bestByPeriod.get(k);
    if (!cur || rowRank(r) < rowRank(cur)) bestByPeriod.set(k, r);
  }
  const collapsed = [...bestByPeriod.values()];

  // A $/SF row we couldn't resolve (no square footage anywhere) would otherwise be
  // dropped and silently fall back to the model's own math — surface it instead.
  const unresolved = collapsed
    .filter((r) => r.annual == null && (r.period === 'per_sqft_year' || r.period === 'per_sqft_month'))
    .map((r) => ({ effective_date: r.date, amount: r.amount, period: r.period }));

  const usable = collapsed.filter((r) => r.annual != null);

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
