// The Rent Ledger's money math — pure, dependency-light, unit-tested first.
//
// Three jobs, one source of truth:
//   • allocatePayments  — which months a tenant's payments actually cover (the grid's
//     ✓ / ◐ / open states), honoring month tags and pooling untagged money FIFO.
//   • componentizeSchedule — split each month's owed into base | CAM&tax | roof for the
//     cell sub-line, without ever breaking "components sum to the month's owed".
//   • ledgerRowSummary  — the row's Collected-of-projected / months-behind / credit
//     figures, derived from the SAME allocation the grid paints from, so the number and
//     the cells can never disagree.
//
// Why not reuse arStatus.monthsBehindForInvoice for the row figures? That walk is
// paid-SCALAR FIFO — it ignores month tags entirely. If a tenant tags a December
// payment while March sits open, the grid honors the tag (December ✓, March open) but
// arStatus's FIFO would spend that money on March. The two would name different
// months — and different dollars, since money parked on a not-yet-due month reduces
// arStatus's arrears but not the ledger's owes-to-date. One derivation, used for
// everything the page shows. arStatus stays as the no-schedule legacy fallback and a
// parity cross-check (with no tags and no future-parked money, the two agree).

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const monthStart = (y, m) => new Date(y, m - 1, 1, 12);

// Accept either a length-12 array [Jan..Dec] or a buildLeaseSchedule map
// ({ 1..12: { owed } }); always hand back the plain array.
export function owedArray(owedByMonth) {
  if (Array.isArray(owedByMonth)) {
    const a = [];
    for (let m = 1; m <= 12; m++) a.push(round2(Number(owedByMonth[m - 1]) || 0));
    return a;
  }
  const a = [];
  for (let m = 1; m <= 12; m++) a.push(round2(Number(owedByMonth?.[m]?.owed) || 0));
  return a;
}

// Which months this tenant's payments cover — the "paid = paid" model.
//   1. Every payment tagged period_month (1-12) adds to that month's tagged sum —
//      several payments tagged the same month SUM (check + Zelle in one month works).
//      The tag ALWAYS holds, even on a month the lease bills nothing for (before the
//      tenancy began, or a $0 month): money that actually arrived in May is money that
//      arrived in May. It settles no charge (coverage stays 0) and the month reads
//      'unbilled' so the grid says so out loud. Re-pooling it instead — which is what
//      this used to do — silently moved a brand-new tenant's first deposits onto
//      whatever month the lease happened to open in.
//   2. A tag SETTLES its month (settled_m = tagged_m > 0). A settled month reads "paid"
//      whatever the amount — short or over — because the landlord recorded a payment for
//      it. The gap between what was received and what was projected is NOT hidden in the
//      checkbox; it flows to the running collected-vs-projected figure (ledgerRowSummary)
//      and the year-end reconciliation. There is NO partial (◐) state for a tagged month,
//      and tagged EXCESS does not roll forward to prepay later months (only an untagged
//      lump does) — this is what makes a mid-year estimate change forward-only.
//   3. Untagged money pools in paid-date order and fills each month's RESIDUAL need
//      (owed − tagged), months 1→12 FIFO — so a lump completes a partially-tagged month
//      (or an untagged one) and, when it runs out mid-June, reads Jan–May ✓, Jun ◐,
//      Jul–Dec open. Whatever is left after month 12 is `credit` (owed to the tenant).
//   4. coverage_m = settled_m ? owed_m : min(owed_m, poolDraw_m) — bill-satisfaction-
//      shaped, so a settled month reads satisfied (gap 0) for the owes / bulk-mark /
//      statement-matching logic no matter the amount tagged. received_m = tagged_m +
//      poolDraw_m — the real dollars on that month, for the cells and closeYear.
//      Invariant: Σ received + credit = totalPaid.
// States: null (owed ≤ 0, nothing received) · 'unbilled' (owed ≤ 0 but money was
// tagged here) · 'covered' (settled, or pool ≥ owed − dust) · 'partial' (pool > 0) ·
// 'open' (0); the caller renders "—"/"Free" for a null month.
//
// ⚠ 0082 — `adjustments` (a length-12 signed array of per-month charges/credits) changes
// ONE line: a settled month's coverage caps at the SCHEDULED owed rather than the
// adjusted owed. Without it `settled ⇒ coverage = owed` means a charge posted on a month
// that was already paid produces gap 0 and NEVER appears in owesToDate — and correcting
// a month you already collected is the commonest reason to post one. With the cap, a
// +$400 charge produces $400 of real arrears while a plain payment difference still does
// not (the "paid = paid" rule holds, because a payment difference doesn't move
// `scheduled`). With no adjustments scheduled === owed, so this is byte-identical.
export function allocatePayments({ owedByMonth, payments = [], adjustments = null, dust = 0.05 } = {}) {
  const owed = owedArray(owedByMonth);
  const adj = Array.isArray(adjustments) ? adjustments : null;
  const scheduledOwed = owed.map((o, i) => round2(o - (Number(adj?.[i]) || 0)));
  const tagged = Array(12).fill(0);
  let pool = 0;
  const sorted = [...(payments || [])].sort((a, b) => String(a?.paid_date || '').localeCompare(String(b?.paid_date || '')));
  let totalPaid = 0;
  for (const p of sorted) {
    const amt = Number(p?.amount) || 0;
    if (!(amt > 0)) continue;
    totalPaid = round2(totalPaid + amt);
    const m = Number(p?.period_month);
    if (m >= 1 && m <= 12) tagged[m - 1] = round2(tagged[m - 1] + amt);
    else pool = round2(pool + amt);
  }
  // A tag settles its month at the received amount — no cap, and (the fix) NO excess
  // rollover into the pool. Untagged money still pools and tops up each month's
  // residual need, so a partial month can be completed by a later lump.
  const settled = tagged.map((t) => t > 0);
  const poolDraw = Array(12).fill(0);
  for (let i = 0; i < 12 && pool > 0; i++) {
    const need = round2(owed[i] - tagged[i]);
    if (need <= 0) continue;
    const draw = Math.min(pool, need);
    poolDraw[i] = round2(draw);
    pool = round2(pool - draw);
  }
  const coverage = [];
  const received = [];
  const states = [];
  for (let i = 0; i < 12; i++) {
    received.push(round2(tagged[i] + poolDraw[i]));
    // Coverage is bill-satisfaction: a tag on an unbilled month settles nothing. A
    // settled month satisfies the SCHEDULED bill whatever the amount ("paid = paid"),
    // but never an adjustment posted on top of it — that is new money that has not
    // arrived, so it stays owed until it is recorded or written off.
    // (Real dollars from an untagged lump still pay an adjustment down — hence + poolDraw,
    // which is also what makes "record the remaining difference" settle the month.)
    const c = settled[i] && owed[i] > 0
      ? round2(Math.min(owed[i], round2(scheduledOwed[i] + poolDraw[i])))
      : round2(Math.min(owed[i], poolDraw[i]));
    coverage.push(c);
    if (!(owed[i] > 0)) states.push(tagged[i] > 0 ? 'unbilled' : null);
    else if (settled[i] || c >= owed[i] - dust) states.push('covered');
    else if (c > 0) states.push('partial');
    else states.push('open');
  }
  return { owed, coverage, tagged, poolDraw, received, settled, states, credit: round2(pool), totalPaid };
}

// Split each month's owed into base | CAM&tax | roof for the cell sub-line.
//   schedule     — buildLeaseSchedule's map (owed / abated / kind / outsideTerm per month)
//   factor       — buildLeaseSchedule's invoice-scaling ratio (1 when no scaling ran),
//                  so the components scale exactly as the whole month did
//   camTaxAnnual — the year's billed CAM & tax (est-preferred, billedComponents' camTax)
//   roofAnnual   — the year's billed roof share (0 when not responsible)
// The BINDING invariant is base + camTax + roof === owed for every month — conflicts
// resolve by adjusting camTax/roof, never by breaking the sum. In particular a FULLY
// FREE month ('free' abatement) forces base = $0 and CAM&tax absorbs the whole owed:
// its owed is exactly the never-abated CAM&tax(+roof) portion, and BOTH penny-folds
// (abatement.js's and buildLeaseSchedule's) can land the year's rounding cents on it —
// without this rule the fold-cents would print as "base $0.03" on a free month.
// Partially-abated months (percent/amount) keep base-as-remainder: the reduction
// comes out of base, CAM&tax/roof stay whole.
//
// ⚠ 0082 — `adjustments` (a length-12 signed array) adds a FOURTH component and extends
// the invariant to **base + camTax + roof + adj === owed**. Every one of the three
// derived components is computed off the SCHEDULED owed (owed − adj), never the adjusted
// owed — otherwise a +$400 correction would print as $400 of extra BASE RENT (base is a
// remainder, ledger.js's oldest trap), and a −$150 credit would silently shrink the
// printed CAM & tax via the `min` below rather than showing as its own line. The
// `kind === 'free'` branch reads scheduled too, or a charge on a free month would print
// as an invented CAM & tax expense.
// ⚠ 0089 — `camTaxByMonth` / `roofByMonth` are the dated-estimate twins of camTaxAnnual /
// roofAnnual: length-12 arrays of the ANNUAL rate in effect each month (monthlyEstimates,
// reconciliation.js). They MUST be threaded wherever buildLeaseSchedule got `otherByMonth`,
// or the split silently misreports: the month's owed already carries the segmented CAM, but
// a flat camTaxAnnual/12 would be subtracted from it — and since base is the REMAINDER, the
// whole difference would print as a change in BASE RENT (ledger.js's oldest trap, above),
// making an estimate change look like a rent step-up. Omitted → the flat annual, as before.
export function componentizeSchedule({ schedule, factor = 1, camTaxAnnual = 0, roofAnnual = 0, camTaxByMonth = null, roofByMonth = null, adjustments = null } = {}) {
  const f = Number(factor) > 0 ? Number(factor) : 1;
  const flatCamTax = round2(((Number(camTaxAnnual) || 0) / 12) * f);
  const flatRoof = round2(((Number(roofAnnual) || 0) / 12) * f);
  const perMonth = (arr, m, fallback) => (arr && arr[m - 1] != null
    ? round2(((Number(arr[m - 1]) || 0) / 12) * f)
    : fallback);
  const adj = Array.isArray(adjustments) ? adjustments : null;
  const out = {};
  for (let m = 1; m <= 12; m++) {
    const c = schedule?.[m] || {};
    const camTaxMonthly = perMonth(camTaxByMonth, m, flatCamTax);
    const roofMonthly = perMonth(roofByMonth, m, flatRoof);
    const owedM = round2(Number(c.owed) || 0);
    const adjM = round2(Number(adj?.[m - 1]) || 0);
    const sOwed = round2(owedM - adjM); // what the SCHEDULE alone says for this month
    if (c.outsideTerm || sOwed <= 0) { out[m] = { base: 0, camTax: 0, roof: 0, adj: round2(owedM) }; continue; }
    let roof = Math.min(roofMonthly, sOwed);
    let camTax;
    if (c.abated && c.kind === 'free') {
      camTax = round2(sOwed - roof); // base is $0 by construction; CAM&tax absorbs fold-cents
    } else {
      camTax = Math.min(camTaxMonthly, round2(sOwed - roof));
    }
    const base = round2(sOwed - camTax - roof);
    out[m] = { base, camTax: round2(camTax), roof: round2(roof), adj: adjM };
  }
  return out;
}

// Detect a mid-year BASE-RENT step-up — a scheduled rent escalation crossing a month
// boundary — so the Ledger can flag it (a tenant's two different monthly box values then
// read as the intended raise, not a mismatch). Derived purely from the SAME per-month
// base the boxes are painted from (componentizeSchedule's `comp`) + the schedule's
// term/abatement flags, so a cue from it can never disagree with the boxes.
//   Returns [{ month, owed, base, prevBase }] for each month m (2–12) whose base steps
//   UP vs m-1, guarded so only a genuine escalation qualifies:
//     - skip if m or m-1 is outsideTerm (a mid-year lease START is not a raise — its
//       prior month is out-of-term, base 0) or abated (an abatement ENDING shows base
//       0 → X, also not a raise),
//     - require prevBase > 0 and curBase > prevBase + 0.02 (increases only, cents-safe).
//   Normally length 1 (escalations are annual); returns all when a lease steps twice.
export function escalationStepMonths({ schedule, comp } = {}) {
  if (!schedule || !comp) return [];
  const out = [];
  for (let m = 2; m <= 12; m++) {
    const cur = schedule[m] || {};
    const prev = schedule[m - 1] || {};
    if (cur.outsideTerm || prev.outsideTerm) continue;
    if (cur.abated || prev.abated) continue;
    const curBase = round2(Number(comp[m]?.base) || 0);
    const prevBase = round2(Number(comp[m - 1]?.base) || 0);
    if (prevBase > 0 && curBase > prevBase + 0.02) {
      out.push({ month: m, owed: round2(Number(cur.owed) || 0), base: curBase, prevBase });
    }
  }
  return out;
}

// The month whose figure best represents "what this tenant pays right now" — used for
// the identity sub-line under the tenant name. On a STEPPED tenant a year-average
// (annual ÷ months) equals no single box and doesn't even match its own base·CAM&tax
// breakdown, which reads a single month; this returns the representative month so the
// sub-line's headline dollars, its breakdown, AND that month's box all agree.
//   - the CURRENT month in the current fiscal year, when it's a normal billed,
//     non-abated month (so the sub-line tracks a mid-year raise the day it lands),
//   - else the first billed non-abated month (a past/future FY, or a mid-year lease
//     whose current month is out of term / free → its starting rate).
// Returns 1–12, or 0 when no month is billed (fully abated / vacant) — the caller then
// falls back to whatever monthly it has.
export function representativeMonth({ owedByMonth = [], schedule = {}, isCurrentFy = false, curMonth = 0 } = {}) {
  const owed = (m) => Number(owedByMonth[m - 1]) || 0;
  const abated = (m) => !!schedule?.[m]?.abated;
  if (isCurrentFy && curMonth >= 1 && curMonth <= 12 && owed(curMonth) > 0 && !abated(curMonth)) return curMonth;
  for (let m = 1; m <= 12; m++) if (owed(m) > 0 && !abated(m)) return m;
  return 0;
}

// The row's headline figures — every one derived from the SAME allocation the grid
// paints from (see the header note for why arStatus can't be the source here).
//   collected    — every dollar recorded against the year invoice (Σ received + credit)
//   projected    — the year total the "collected" is measured against: Σ over months of
//                  (settled ? received : owed) — forward-only, so a fully settled year
//                  reads 100% and a mid-year estimate change moves only unsettled months
//   billed       — Σ owed: what the LEASE says for the year (base + CAM & tax estimate
//                  + roof), untouched by what came in. Where `projected` freezes a paid
//                  month at the cheque that settled it, `billed` keeps the bill — the
//                  pair is what makes a payment difference visible at all
//   variance     — Σ (received − owed) over months that have come due AND are settled.
//                  Settled-only on purpose: an unpaid or part-covered month is already
//                  reported by owesToDate / monthsBehind, and an untagged lump draws
//                  exactly each month's residual need, so it can never invent a variance
//   rate         — collected / projected (null when projected 0; unclamped, may exceed 1)
//   owesToDate   — Σ (owed − coverage) over months that have COME DUE (their 1st is
//                  on/before today) — settled/free/out-of-term months owe nothing here
//   monthsBehind — due months with owed > dust and NOTHING received (the red badge)
//   credit       — the allocation's leftover (overpayment, owed to the tenant)
// ---- Year-close collection history (Stage 3) --------------------------------
// closeYear (api.js) freezes each tenant's projected / collected /
// collection_rate / collected_by_month into the snapshot breakdown. These pure
// selectors read them back for History. Snapshots from before the Rent Ledger
// simply lack the keys → null, and every consumer renders "—" (no NaN).

// Property-level totals for ONE snapshot, or null when its breakdown carries no
// collection data (a pre-ledger snapshot).
export function snapshotCollectionSummary(snap) {
  const rows = (snap?.breakdown || []).filter((b) => b && b.projected != null);
  if (!rows.length) return null;
  const projected = round2(rows.reduce((s, b) => s + (Number(b.projected) || 0), 0));
  const collected = round2(rows.reduce((s, b) => s + (Number(b.collected) || 0), 0));
  return {
    projected,
    collected,
    // Raw, unclamped — an overpaid year truthfully reads > 100%.
    rate: projected > 0 ? collected / projected : null,
  };
}

// The YoY series for the History chart/table: [{ year, projected, collected,
// rate }], oldest first, skipping snapshots with no collection data.
export function collectionSeries(snaps) {
  return (snaps || [])
    .map((s) => {
      const sum = snapshotCollectionSummary(s);
      return sum ? { year: Number(s.year), ...sum } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.year - b.year);
}

export function ledgerRowSummary({ year, owedByMonth, allocation, today = new Date(), dust = 0.05 } = {}) {
  const owed = owedArray(owedByMonth);
  const alloc = allocation || allocatePayments({ owedByMonth: owed, payments: [] });
  const settled = alloc.settled || Array(12).fill(false);
  const received = alloc.received || Array(12).fill(0);
  let owes = 0;
  let monthsBehind = 0;
  let projected = 0;
  let billed = 0;
  let variance = 0;
  for (let m = 1; m <= 12; m++) {
    const i = m - 1;
    // Forward-only projection: a settled month is frozen at what was received, an
    // unsettled month reflects the CURRENT owed. So a mid-year estimate change moves
    // only the months still open, and a fully settled year reads exactly 100%.
    // A month the lease doesn't bill can carry received money (see 'unbilled' above)
    // without inflating the year total — it settles no charge, so it projects nothing.
    const settledBill = settled[i] && owed[i] > 0;
    projected = round2(projected + (settledBill ? (received[i] || 0) : owed[i]));
    billed = round2(billed + owed[i]);
    if (monthStart(Number(year), m) > today) continue; // not yet due
    if (settledBill) variance = round2(variance + round2((received[i] || 0) - owed[i]));
    const gap = round2(owed[i] - (alloc.coverage[i] || 0));
    if (gap > dust) owes = round2(owes + gap);
    // Genuinely behind = a due month with NO payment recorded against it at all
    // (a settled-short or pool-partial month has money on it → feeds owes, not the badge).
    if (owed[i] > dust && !(received[i] > dust)) monthsBehind += 1;
  }
  const collected = round2(alloc.totalPaid || 0);
  return {
    collected,
    projected,
    billed,
    variance,
    rate: projected > 0 ? collected / projected : null,
    owesToDate: owes,
    monthsBehind,
    credit: round2(alloc.credit || 0),
    settled: owes <= dust && (alloc.credit || 0) <= dust,
  };
}

// ---- "Which months still need logging?" — the bank-statement reminder -------
// A landlord receives their bank statement AFTER the month closes, so a month with no
// money on it does NOT mean the tenants are late — it means the month hasn't been
// LOGGED yet. Judging it any earlier accuses tenants of something the app can't know,
// and doing it per tenant turns one forgotten upload into a screenful of alarms.
// These two selectors drive the single calm per-property reminder that replaces the
// old per-tenant "behind on rent" alert. The genuinely-behind picture still lives
// where it can be read in context: the Ledger grid's cells and Collected column.

// Is `month` of `year` over AND far enough past its end for the statement to have
// arrived? graceDays is the owner's configurable lead (default 7 days after month end),
// so nothing is ever raised about a month still in progress.
export function monthClosedForLogging(year, month, today = new Date(), graceDays = 7) {
  const y = Number(year);
  const m = Number(month);
  if (!(y > 0) || !(m >= 1 && m <= 12)) return false;
  const nextStart = m === 12 ? monthStart(y + 1, 1) : monthStart(y, m + 1);
  const grace = Number(graceDays) > 0 ? Number(graceDays) : 0;
  return today.getTime() >= nextStart.getTime() + grace * 86400000;
}

// Months of `year` that have closed with no money recorded anywhere on the property.
// `rows` is one entry per lease carrying the SAME arrays the Ledger grid paints
// ({ owed: owedByMonthForInvoice, received: allocatePayments().received }), so this can
// never disagree with the grid. A month qualifies only when the property actually
// BILLED something (never nag about a month nothing was due) and NOT ONE tenant has
// money on it — a single recorded payment proves the month was logged, and whether an
// individual tenant paid is the Ledger's job to show, not the bell's.
export function unloggedMonths({ year, rows = [], today = new Date(), graceDays = 7, dust = 0.05 } = {}) {
  const norm = (rows || []).map((r) => ({
    owed: owedArray(r?.owed),
    received: Array.isArray(r?.received) ? r.received : [],
  }));
  const out = [];
  for (let m = 1; m <= 12; m++) {
    if (!monthClosedForLogging(year, m, today, graceDays)) continue;
    let billed = false;
    let logged = false;
    for (const r of norm) {
      if (r.owed[m - 1] > dust) billed = true;
      if ((Number(r.received[m - 1]) || 0) > dust) { logged = true; break; }
    }
    if (billed && !logged) out.push(m);
  }
  return out;
}

// The other half of the picture: once a month's statement IS imported, a tenant with
// nothing on it is a real gap the landlord should chase — the bank has been reconciled
// and this tenant simply isn't in it.
//
// `importedMonths` are the months the property has a payment carrying an import_id
// (see computeLedgerAlerts in api.js), which is what separates "I reconciled this month
// against the bank" from "I ticked one box by hand". Without that proof this stays
// silent, so hand-marking a single tenant can never accuse the other eight.
//
// One entry per TENANT listing every month they're missing — never one per month — with
// the outstanding total. `rows` carries the same owed/received arrays as unloggedMonths
// plus the lease's identity. Mutually exclusive with unloggedMonths by construction: an
// imported month has money on it, so it can never also be reported as unlogged.
export function missingOnImportedMonths({
  year, rows = [], importedMonths = [], today = new Date(), graceDays = 7, dust = 0.05,
} = {}) {
  const imported = new Set((importedMonths || []).map(Number).filter((m) => m >= 1 && m <= 12));
  const months = [];
  for (let m = 1; m <= 12; m++) {
    // Still only judge a CLOSED month: a statement imported mid-month covers a partial
    // period, and a tenant absent from it may simply not have paid yet.
    if (imported.has(m) && monthClosedForLogging(year, m, today, graceDays)) months.push(m);
  }
  if (!months.length) return [];
  const out = [];
  for (const r of rows || []) {
    const owed = owedArray(r?.owed);
    const received = Array.isArray(r?.received) ? r.received : [];
    const missing = [];
    let amount = 0;
    for (const m of months) {
      const i = m - 1;
      if (!(owed[i] > dust)) continue;                  // out of term or free — nothing to miss
      if ((Number(received[i]) || 0) > dust) continue;  // money on it, however little
      missing.push(m);
      amount = round2(amount + owed[i]);
    }
    if (missing.length) {
      out.push({ lease_id: r?.lease_id, tenant_name: r?.tenant_name, months: missing, amount });
    }
  }
  return out;
}
