// The Rent Ledger's money math — pure, dependency-light, unit-tested first.
//
// Three jobs, one source of truth:
//   • allocatePayments  — which months a tenant's payments actually cover (the grid's
//     ✓ / ◐ / open states), honoring month tags and pooling untagged money FIFO.
//   • componentizeSchedule — split each month's owed into base | CAM&tax | roof for the
//     cell sub-line, without ever breaking "components sum to the month's owed".
//   • ledgerRowSummary  — the row's Collected / Owes / months-behind / credit figures,
//     derived from the SAME allocation the grid paints from, so the number and the
//     cells can never disagree.
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

// Which months this tenant's payments cover. The exact derivation:
//   1. Every payment tagged period_month (1-12) adds to that month's tagged sum —
//      several payments tagged the same month SUM (check + Zelle in one month works).
//      A tag pointing at a month that owes nothing (before the tenancy, or a $0 month)
//      falls back to the untagged pool — the tag can't invent a charge to cover.
//   2. Untagged money pools in paid-date order; the pool fills each month's residual
//      need (owed − tagged), months 1→12 FIFO — a lump that runs out mid-June reads
//      Jan–May ✓, Jun ◐, Jul–Dec open.
//   3. A tagged month's EXCESS (paid more than that month owes) rolls into the pool
//      too — the standard prepayment treatment: excess money covers the next open
//      charges first and only counts as credit when nothing is left to cover. This is
//      also what keeps the ledger's dollar total consistent with the invoice balance.
//   4. coverage_m = min(owed_m, tagged_m + poolDraw_m) — never negative, never above
//      the month's owed. Whatever the pool has left after month 12 is `credit`
//      (overpayment — owed to the tenant; ≈ the invoice's negative balance).
// States by coverage: 'covered' (≥ owed − dust), 'partial' (> 0), 'open' (0);
// months owing nothing get state null (the caller renders "—"/"Free" from the schedule).
export function allocatePayments({ owedByMonth, payments = [], dust = 0.05 } = {}) {
  const owed = owedArray(owedByMonth);
  const tagged = Array(12).fill(0);
  let pool = 0;
  const sorted = [...(payments || [])].sort((a, b) => String(a?.paid_date || '').localeCompare(String(b?.paid_date || '')));
  let totalPaid = 0;
  for (const p of sorted) {
    const amt = Number(p?.amount) || 0;
    if (!(amt > 0)) continue;
    totalPaid = round2(totalPaid + amt);
    const m = Number(p?.period_month);
    if (m >= 1 && m <= 12 && owed[m - 1] > 0) tagged[m - 1] = round2(tagged[m - 1] + amt);
    else pool = round2(pool + amt);
  }
  // Tagged excess rolls into the pool (step 3).
  for (let i = 0; i < 12; i++) {
    if (tagged[i] > owed[i]) {
      pool = round2(pool + round2(tagged[i] - owed[i]));
      tagged[i] = owed[i];
    }
  }
  const poolDraw = Array(12).fill(0);
  for (let i = 0; i < 12 && pool > 0; i++) {
    const need = round2(owed[i] - tagged[i]);
    if (need <= 0) continue;
    const draw = Math.min(pool, need);
    poolDraw[i] = round2(draw);
    pool = round2(pool - draw);
  }
  const coverage = [];
  const states = [];
  for (let i = 0; i < 12; i++) {
    const c = round2(Math.min(owed[i], tagged[i] + poolDraw[i]));
    coverage.push(c);
    if (!(owed[i] > 0)) states.push(null);
    else if (c >= owed[i] - dust) states.push('covered');
    else if (c > 0) states.push('partial');
    else states.push('open');
  }
  return { owed, coverage, tagged, poolDraw, states, credit: round2(pool), totalPaid };
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
export function componentizeSchedule({ schedule, factor = 1, camTaxAnnual = 0, roofAnnual = 0 } = {}) {
  const f = Number(factor) > 0 ? Number(factor) : 1;
  const camTaxMonthly = round2(((Number(camTaxAnnual) || 0) / 12) * f);
  const roofMonthly = round2(((Number(roofAnnual) || 0) / 12) * f);
  const out = {};
  for (let m = 1; m <= 12; m++) {
    const c = schedule?.[m] || {};
    const owedM = round2(Number(c.owed) || 0);
    if (c.outsideTerm || owedM <= 0) { out[m] = { base: 0, camTax: 0, roof: 0 }; continue; }
    let roof = Math.min(roofMonthly, owedM);
    let camTax;
    if (c.abated && c.kind === 'free') {
      camTax = round2(owedM - roof); // base is $0 by construction; CAM&tax absorbs fold-cents
    } else {
      camTax = Math.min(camTaxMonthly, round2(owedM - roof));
    }
    const base = round2(owedM - camTax - roof);
    out[m] = { base, camTax: round2(camTax), roof: round2(roof) };
  }
  return out;
}

// The row's headline figures — every one derived from the SAME allocation the grid
// paints from (see the header note for why arStatus can't be the source here).
//   collected    — every dollar recorded against the year invoice
//   owesToDate   — Σ (owed − coverage) over months that have COME DUE (their 1st is
//                  on/before today) — free/out-of-term months owe nothing by construction
//   monthsBehind — how many of those due months are uncovered beyond dust
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
  let owes = 0;
  let monthsBehind = 0;
  for (let m = 1; m <= 12; m++) {
    if (monthStart(Number(year), m) > today) continue; // not yet due
    const gap = round2(owed[m - 1] - (alloc.coverage[m - 1] || 0));
    if (gap > dust) { owes = round2(owes + gap); monthsBehind += 1; }
  }
  return {
    collected: round2(alloc.totalPaid || 0),
    owesToDate: owes,
    monthsBehind,
    credit: round2(alloc.credit || 0),
    settled: owes <= dust && (alloc.credit || 0) <= dust,
  };
}
