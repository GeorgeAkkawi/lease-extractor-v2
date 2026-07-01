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

// Rebuild the schedule from the supplement's raw rows so EVERY amount (base + each step)
// is computed in code. The earliest dated period becomes base_rent; later periods become
// manual escalations. Also cross-checks our exact figure against the model's OWN
// new_base_rent (the main call did the math itself) — a wide gap means the model handed
// over a pre-computed amount it got wrong (the raw rate wasn't read cleanly), which we
// surface as a flag for a human to eyeball before saving.
//
// Inputs:  { rentSchedule: [{ effective_date, amount, period }], sqft, modelEscalations }
// Returns: { baseRent, escalations, flag } — any of which may be null (no change).
export function rebuildRentSchedule({ rentSchedule, sqft, modelEscalations } = {}) {
  const rawRows = (Array.isArray(rentSchedule) ? rentSchedule : []).map((r) => ({
    date: typeof r?.effective_date === 'string' ? r.effective_date : null,
    period: r?.period,
    amount: r?.amount,
    annual: annualRentFrom(r?.amount, r?.period, sqft),
  }));

  // A $/SF row we couldn't resolve (no square footage anywhere) would otherwise be
  // dropped and silently fall back to the model's own math — surface it instead.
  const unresolved = rawRows
    .filter((r) => r.annual == null && (r.period === 'per_sqft_year' || r.period === 'per_sqft_month'))
    .map((r) => ({ effective_date: r.date, amount: r.amount, period: r.period }));

  const rows = rawRows
    .filter((r) => r.annual != null)
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
  let escalations = null;
  if (rows.length) {
    crossCheck(rows[0].date, rows[0].annual);
    baseRent = rows[0].annual;
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

  return { baseRent, escalations, flag };
}
