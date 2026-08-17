// Income and expenses — the one workbook a landlord hands someone.
//
// It replaces three (the tax package, the 1099 worksheet and the lender package,
// removed 2026-08-12) because all three answered a question George does not have:
// they shaped his figures for a form, a filing deadline or an underwriter. What he
// actually wants is what came in, what went out, and what is left.
//
// It is laid out MONTH BY MONTH (George, 2026-08-12: "it should be itemized like a
// reconciliation … all income and expenses monthly with the main buckets and items"), so
// every figure here carries a length-12 array beside its annual total.
//
// ⚠ EVERY FIGURE IS READ FROM WHAT THE FINANCIALS PAGE ALREADY RENDERS, through the
// same functions and the same query keys. That is the single design rule here, and it
// is why this file is short: `recoverabilityRows` IS the "What it cost you" table,
// `summarizeOtherIncome` IS the Other income panel, and the rent comes off the same
// `getPropertyMonthlyRoll` → `componentizeSchedule` pair the Ledger grid is drawn from.
// A second implementation would drift, silently, because nothing compares them
// (CLAUDE.md §3).
//
// ⚠ THE ARITHMETIC RULE, and getting it wrong double-counts a year.
// `v_property_totals.total_revenue` is BASE RENT ONLY — `sum(effective_rent(...))`,
// migration 0049. It does NOT include what tenants reimbursed for CAM, taxes or the
// roof. So the reimbursement is netted off the COST side (spent − recovered = your net
// cost) rather than added to revenue. Adding it to revenue *and* subtracting the gross
// expense would report the same dollars twice.
//
// ⚠ THE UNDATED COLUMN IS NOT A ROUNDING BUCKET. `cam_line_items.paid_date` and
// `other_income.txn_date` are nullable on purpose and never backfilled (0074), a
// contract's derived CAM line never carries one, and a kind entered as a single flat
// figure has no day at all — on real data that is thousands of dollars. It gets its own
// column and its own flag rather than being spread across twelve months it was never in.
//
// ⚠ TWO BASES SINCE 2026-08-17, and they answer two different questions on purpose.
//
//   'projected' — the year as it is CONTRACTED to run. Rent from each lease's schedule
//                 INCLUDING steps that have not been swept into base_rent yet (the workbook
//                 was blind to those: `monthlyBases` counts applied steps only, so a step
//                 dated October printed the old rent all the way to December). CAM & tax at
//                 the estimate tenants are billed. Twelve months, whatever has happened.
//   'live'      — what has ACTUALLY happened. Every money-in figure is cash the Ledger says
//                 arrived, month by month; a month nobody paid is blank. George, on the ask:
//                 *"any months that haven't been paid and the ledger shouldn't show … it
//                 should be fully live based on the numbers on the ledger."*
//
// ⚠ THE LIVE BASIS IS CASH AND THE PROJECTED ONE IS ACCRUAL, so they are NOT two views of one
// number and must never be compared cell to cell. Only ONE thing is shared: the split into
// rent / CAM & tax / roof / charges. A payment does not record what it paid FOR — a deposit is
// stored as one lump (applyStatementImport writes a single row for the whole bank amount) — so
// a month's cash is apportioned across that month's BILLED components pro-rata. That is an
// assumption, it is the only one available, and the sheet says so out loud rather than
// letting a reader infer that the bank told us.
//
// Nothing here writes. Every function is pure over rows it was handed, except the one
// loader at the bottom.
import {
  listProperties, listExpenseBuckets, listCamLineItems, listTaxLineItems,
  listRoofLineItems, getExpenseRecord, getTenantShares, getPropertyTotals, listOtherIncome,
  getPropertyMonthlyRoll, listEscalationsByLeases,
} from './api';
import { propertyStandings } from './settle';
import { recoverabilityRows, absorbedFromItems } from './recoverability';
import { summarizeOtherIncome } from './otherIncome';
import { componentizeSchedule, allocatePayments } from './ledger';
import { inTermByLease } from './leaseSchedule';
import { adjustmentsForPnlRow, adjustmentKindRows, adjustmentMarks } from './adjustments';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const zero12 = () => Array(12).fill(0);
const add12 = (a, b) => a.map((n, i) => round2(n + b[i]));
const sub12 = (a, b) => a.map((n, i) => round2(n - b[i]));
const sum12 = (a) => round2(a.reduce((s, n) => s + n, 0));

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * What each lease was BILLED, month by month, split the way the invoice splits it.
 *
 * ⚠ THE CHANGE OF 2026-08-16, and George's complaint in one line: *"the monthly numbers are
 * way off … none of the rents match because it shows base rent."* They didn't match because
 * they were base rent — for a NET lease this returned `c.base` alone, which is the month's
 * owed MINUS everything recoverable. On the demo that is 18–23% low per tenant and $43,800 a
 * year on one property, and nothing on the sheet said so. The arithmetic was defensible (the
 * reimbursement came back on the cost side, so the bottom line was right) but no monthly cell
 * agreed with the Ledger, the invoice or the bank, which is what a landlord actually checks.
 *
 * So the components are now reported SEPARATELY instead of one being folded away:
 * `rent` + `camTax` + `roof` + `charges` per month === that month's owed, which is
 * `componentizeSchedule`'s own invariant (`base + camTax + roof + adj === owed`) printed
 * rather than collapsed. The bottom line is unchanged — the reimbursement stops being netted
 * silently off the cost side and is stated on both sides instead.
 *
 * ⚠ A CORRECTION RIDES THE ROW IT CORRECTS. `componentizeSchedule` derives base and camTax
 * from the SCHEDULED owed (owed − adj), so a `base` correction is added back onto rent and a
 * `camtax` correction onto CAM & tax — which is what keeps `Total billed === Σ owed` exact.
 * Everything else lands in `charges`; `pnlRow` (adjustments.js) is the single rule and is
 * where the reasoning lives.
 *
 * ⚠ `tieOut` IS NOT A DISPLAYED FIGURE and must keep the old formula. `rentDrift` compares
 * against `v_property_totals.total_revenue`, which is base-only for a net lease and the WHOLE
 * flat rent for a gross one (0073) — so the comparison figure still needs the gross carve
 * added back, and still excludes adjustments, or a true tie-out would start reading as drift.
 *
 * ⚠ `collected` TURNS THE SAME FIVE ROWS INTO CASH (2026-08-17), and it is an option on this
 * function rather than a second function beside it BECAUSE the split is the part that must not
 * drift. Each month's rows are scaled by that lease's own `received / owed` from
 * `allocatePayments` — the same allocation the Ledger grid is painted from — with RENT as the
 * remainder, exactly as `componentizeSchedule` makes base the remainder. So the five parts
 * still sum to a real figure (the cash) instead of to a rounded one.
 *   • A month the lease bills nothing for but money arrived on ('unbilled', ledger.js) puts the
 *     whole amount on rent: it was paid against the rent invoice and nothing else is claimable.
 *   • `credit` — untagged money left over after December — is REAL CASH with no month to sit
 *     in, so it rides the tenant's rent row as `undated` and is counted in its total. Dropping
 *     it would make a cash sheet under-report the bank.
 *   • `marks` are dropped: a tint means "a charge was posted on this month and its figure is
 *     inside the amount shown", which is a statement about the BILL. On a cash row it would be
 *     false.
 */
export function billedRowsFromRoll(roll = [], { collected = false } = {}) {
  const groups = { rent: [], camTax: [], roof: [], charges: [], carried: [] };
  let tieOut = 0;
  let creditTotal = 0;
  // ⚠ WHAT THE SHEET SAYS AND WHAT THE INVOICE SAYS ARE TWO DIFFERENT THINGS, and only one
  // of them is in the tenant's hands. These rows are built UP from each lease's current
  // terms; a stored invoice is a frozen copy that does not rebuild itself (CLAUDE.md §1).
  // Move a property's CAM or tax total — which importing a bank statement does, and which
  // calls no resync at all — and this sheet re-prices while the issued bill does not. The
  // Ledger row already says "bill behind by $X · Rebuild"; the workbook is the thing you
  // HAND SOMEONE, so it cannot be the only surface that doesn't know.
  const drifted = [];
  for (const r of roll || []) {
    const split = (schedule, factor) => componentizeSchedule({
      schedule, factor, camTaxAnnual: r.camTaxAnnual, roofAnnual: r.roofAnnual,
      camTaxByMonth: r.camTaxByMonth, roofByMonth: r.roofByMonth, adjustments: r.adjustments,
    });
    const comp = r?.schedule ? split(r.schedule, r.factor) : null;
    // ⚠ THE TIE-OUT IS MEASURED ON THE CONTRACTED SCHEDULE, NOT THE PROJECTION. `getPropertyMonthlyRoll`
    // attaches `contractedSchedule` only when it was asked to project (a scheduled rent step that
    // has not been swept yet). `total_revenue` is `sum(effective_rent)` — applied steps only —
    // so measuring the projection against it would report drift on every lease with a future
    // step and turn the JS↔SQL twin check into noise. The step is stated by its own flag instead.
    const tieComp = r?.contractedSchedule ? split(r.contractedSchedule, r.contractedFactor) : comp;
    const label = String(r.tenant_name || '').trim() || 'Tenant';
    const adjRows = r?.adjustmentRows || [];
    const extraFor = (pnlRow) => adjustmentsForPnlRow(adjRows, pnlRow).byMonth;
    const compAt = (i, pick) => { const c = comp?.[i + 1]; return c ? num(c[pick]) : 0; };
    const rentX = extraFor('rent');
    const camX = extraFor('camtax');
    // Everything not attached to a component of the bill — a late fee, a concession — as
    // ONE row per lease, itemized by kind at the property level below.
    const chX = extraFor('charges');
    // ⚠ THE FIFTH GROUP, AND IT IS WHAT KEEPS THE LEDGER TIE ALIVE (Slice 4). A kind whose
    // `pnlRow` is null — a balance brought forward, a refund — reaches none of the four rows
    // above, yet `buildLeaseSchedule` adds EVERY adjustment to the month's `owed`. Left out,
    // `Total billed` would fall short of the Ledger by exactly its amount, silently, on the
    // one figure this sheet promises ties. So it is stated on its own row, counted INTO Total
    // billed, and then taken back out before Total earned — because it is real money the
    // tenant owes and is not this year's income. Both facts, both said.
    const cfX = extraFor(null);
    // The five components of the BILL, month by month. base + camTax + roof + Σadj === owed
    // (componentizeSchedule's invariant), and Σadj is exactly rentX + camX + chX + cfX — so
    // these five add up to the month's owed by construction, not by coincidence.
    const m = {
      rent: Array.from({ length: 12 }, (_, i) => round2(compAt(i, 'base') + rentX[i])),
      camTax: Array.from({ length: 12 }, (_, i) => round2(compAt(i, 'camTax') + camX[i])),
      roof: Array.from({ length: 12 }, (_, i) => round2(compAt(i, 'roof'))),
      charges: chX.map(round2),
      carried: cfX.map(round2),
    };
    let credit = 0;
    if (collected) {
      const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments, adjustments: r.adjustments });
      for (let i = 0; i < 12; i++) {
        const owedM = round2(alloc.owed[i]);
        const got = round2(alloc.received[i]);
        if (owedM > 0.005) {
          // Rent is the REMAINDER so the four parts sum to the cash exactly — the same reason
          // componentizeSchedule makes base the remainder. Scaling all five independently
          // would leave the rounding cents nowhere.
          const f = got / owedM;
          m.camTax[i] = round2(m.camTax[i] * f);
          m.roof[i] = round2(m.roof[i] * f);
          m.charges[i] = round2(m.charges[i] * f);
          m.carried[i] = round2(m.carried[i] * f);
          m.rent[i] = round2(got - m.camTax[i] - m.roof[i] - m.charges[i] - m.carried[i]);
        } else {
          m.rent[i] = got;
          m.camTax[i] = 0; m.roof[i] = 0; m.charges[i] = 0; m.carried[i] = 0;
        }
      }
      credit = round2(alloc.credit);
      creditTotal = round2(creditTotal + credit);
    }
    // `marks` says which of those months carry a POSTED charge or credit — never which
    // came in short of cash. See `adjustmentMarks`; the condition is load-bearing.
    const mk = (key, marks, undated = 0) => ({
      lease_id: r.lease_id, label, gross: !!r.gross,
      byMonth: m[key], total: round2(sum12(m[key]) + undated), undated,
      marks: collected ? null : marks,
    });
    groups.rent.push(mk('rent', adjustmentMarks(adjRows, 'rent'), credit));
    groups.camTax.push(mk('camTax', adjustmentMarks(adjRows, 'camtax')));
    groups.roof.push(mk('roof', null));
    groups.charges.push(mk('charges', adjustmentMarks(adjRows, 'charges')));
    groups.carried.push(mk('carried', adjustmentMarks(adjRows, null)));
    // The old formula, kept for the tie-out only.
    for (let i = 0; i < 12; i++) {
      const c = tieComp?.[i + 1];
      if (c) tieOut = round2(tieOut + num(c.base) + (r.gross ? num(c.camTax) + num(c.roof) : 0));
    }
    // `drift` is already measured on the roll (`invoiceDrift`, api.js) — schedule less the
    // stored invoice total. Positive = the sheet is ahead of the bill.
    const d = round2(num(r?.drift));
    if (Math.abs(d) > 0.005) drifted.push({ lease_id: r.lease_id, label, amount: d });
  }
  const byTotal = (a, b) => b.total - a.total || a.label.localeCompare(b.label);
  for (const k of Object.keys(groups)) groups[k].sort(byTotal);
  drifted.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.label.localeCompare(b.label));
  return { ...groups, tieOut: round2(tieOut), creditTotal, drifted, driftTotal: round2(drifted.reduce((s, d) => s + d.amount, 0)) };
}

/** The lease-level rows of one group, collapsed to a length-12 array. */
const groupByMonth = (rows = []) => (rows || []).reduce((acc, r) => add12(acc, r.byMonth), zero12());

/** …and its annual figure, which is the months PLUS anything undated. Only the rent row on the
 *  live basis has an undated figure (a tenant's year-end credit), and summing the months alone
 *  would lose it off the one sheet that is meant to equal the bank. */
const groupTotal = (rows = []) => round2((rows || []).reduce((s, r) => s + num(r.total), 0));

/**
 * The bridge from the app's own NOI to this sheet's bottom line, as TERMS rather than a
 * sentence — because a sentence is how it went wrong.
 *
 * ⚠ THIS NOTE PRINTS AN EQUATION AND CLAIMS IT BALANCES, so an omitted term is not a
 * wording problem, it is a wrong sum in front of an accountant. It shipped on 2026-08-12
 * missing `absorbed`, gained `charges` on 2026-08-16, and was STILL short one term on the
 * only demo property that has a part-year tenancy: Oak Center printed
 * `NOI $79,000 + $33,833.33 reimbursed = $94,833.39` — out by $17,999.94, under the words
 * "these figures reconcile to it exactly".
 *
 * The missing term is the rent BASIS. NOI is `total_revenue − total_expenses` and
 * `total_revenue` is `sum(effective_rent)` — an annual RATE, which prorates neither end of
 * a term (and, for a gross lease, counts the whole flat rent this sheet splits into rent
 * and CAM & tax). This sheet counts rent month by month from each lease's schedule. The
 * difference between those two readings of the same rent is `rent − rentQuoted`, and it is
 * the residual exactly.
 *
 * ⚠ AND THE LAST TERM IS A CATCH-ALL, deliberately: whatever is left over after the named
 * terms is printed as "not accounted for" rather than swallowed. A future figure nobody
 * added here then shows up as a visible difference instead of turning the equation into a
 * lie — which is the same discipline as the "No date" column and the rent-drift flag.
 */
export function noiBridge({ noi = 0, net = 0, recovered = 0, otherIncome = 0, absorbed = 0, charges = 0, rentBasis = 0 } = {}) {
  const start = round2(noi);
  const terms = [
    { key: 'recovered', label: 'tenants reimbursed', amount: round2(recovered) },
    { key: 'otherIncome', label: 'other income', amount: round2(otherIncome) },
    { key: 'absorbed', label: 'of costs you entered and chose not to bill', amount: -round2(absorbed) },
    { key: 'charges', label: 'of charges and credits on tenants’ bills', amount: round2(charges) },
    {
      key: 'rentBasis',
      label: 'of rent that this sheet counts month by month and the Revenue figure counts at a full annual rate',
      amount: round2(rentBasis),
    },
  ].filter((t) => Math.abs(t.amount) > 0.005);
  const stated = terms.reduce((s, t) => round2(s + t.amount), start);
  const residual = round2(round2(net) - stated);
  if (Math.abs(residual) > 0.005) {
    terms.push({ key: 'unexplained', label: 'not accounted for — the app’s own figures and this sheet disagree by this much', amount: residual, unexplained: true });
  }
  return { noi: start, terms, total: round2(net) };
}

/**
 * One property's year, shaped for the sheet. Pure — it takes the rows the loader read.
 *
 * `net` is the year's result: rent + other income − what the expenses actually cost you
 * after tenants paid their share. Owner money is carried BESIDE it, never inside it — a
 * distribution is not a cost of the building (see `isOwnerCategory`), and
 * `recoverabilityRows` has already split it out.
 */
export function shapeProperty({ property, year, totals, items, shares, expense, buckets, income, roll, escByLease = {}, basis = 'projected' }) {
  const live = basis === 'live';
  const inc = summarizeOtherIncome(income, year);
  // ⚠ The term weighting is passed, not defaulted, and it is the SAME call the "What it
  // cost you" table on screen makes. Those two are one rule with two renderers; letting
  // one prorate a mid-year tenant's recovery and the other not is the §3 drift that puts
  // two different net figures in front of the same landlord on the same afternoon.
  const rec = recoverabilityRows({
    items, shares, expense: expense || {}, buckets, year,
    inTermByLease: inTermByLease({ year, shares, escByLease }),
  });

  // ⚠ THE BILLED ROWS ARE BUILT ON BOTH BASES, and on the live one they are not what the sheet
  // prints. `rentScheduled` / `rentDrift` (the JS↔SQL twin check) and the issued-invoice drift
  // are statements about what was BILLED — they mean nothing measured against cash, and
  // dropping them on the live basis would hide a real fault from whoever downloaded that copy.
  const billed = billedRowsFromRoll(roll);
  const shown = live ? billedRowsFromRoll(roll, { collected: true }) : billed;
  const rentRows = shown.rent;
  const rentByMonth = groupByMonth(shown.rent);
  const rent = groupTotal(shown.rent);
  const camTaxByMonth = groupByMonth(shown.camTax);
  const roofByMonth = groupByMonth(shown.roof);
  const chargesByMonth = groupByMonth(shown.charges);
  const carriedByMonth = groupByMonth(shown.carried);
  const camTaxBilled = groupTotal(shown.camTax);
  const roofBilled = groupTotal(shown.roof);
  const charges = groupTotal(shown.charges);
  const carried = groupTotal(shown.carried);
  // Money a tenant paid beyond the whole year's bills. Real cash, no month — see
  // `billedRowsFromRoll`. Always 0 on the projected basis.
  const tenantCredit = round2(shown.creditTotal);
  // How much of the projected rent comes from steps that have not taken effect yet — the whole
  // reason the projected basis exists, and the one figure a reader has to be told about it.
  const projectedAhead = round2((roll || []).reduce((s, r) => s + num(r?.projectedAhead), 0));
  // Itemized by kind at the property level, so a late fee and a write-off never merge into
  // one unexplained figure on the sheet.
  // ⚠ ON THE LIVE BASIS THE PER-KIND BREAKDOWN IS THE PER-TENANT ONE. `adjustmentKindRows` reads
  // the posted `lease_adjustments` rows straight — which is what was CHARGED, not what came in —
  // so on a cash sheet it would print a "Charges & credits" parent whose children add to a
  // different figure. The tenant rows are already scaled, so they are what gets indented there.
  const allAdjRows = (roll || []).flatMap((r) => r?.adjustmentRows || []);
  const chargeRows = live ? shown.charges.filter((r) => Math.abs(r.total) > 0.005) : adjustmentKindRows(allAdjRows, 'charges');
  const carriedRows = live ? shown.carried.filter((r) => Math.abs(r.total) > 0.005) : adjustmentKindRows(allAdjRows, null);

  // ⚠ THE TIE-OUT. Until 2026-08-12 this sheet quoted `total_revenue` — one annual figure
  // straight out of the view. Laying rent across months means deriving it from the lease
  // SCHEDULE instead, which is the JS half of a JS↔SQL twin (`effectiveRent` ↔
  // `effective_rent`, CLAUDE.md §3). The two are MEANT to agree; this is how we find out
  // if they ever stop, rather than shipping a workbook that quietly disagrees with the
  // Performance card on the same screen.
  const rentQuoted = round2(num(totals?.total_revenue));
  // ⚠ TWO FIGURES, TWO JOBS, AND THEY ARE NOT INTERCHANGEABLE.
  //   `rentScheduled` (= tieOut) is the LIKE-FOR-LIKE comparable to `total_revenue`: base
  //     rent at contract rates, plus a gross lease's carve (because the view counts the
  //     whole flat rent there, 0073), and no adjustments (the view knows of none). It is
  //     what `rentDrift` measures and what the flag must QUOTE — quoting the sheet's Rent
  //     row instead prints three figures where the third is not the difference of the
  //     first two, which is what this said until 2026-08-16.
  //   `rent` is what the sheet's Rent ROW prints: base only for a gross lease (its CAM
  //     carve is stated on its own row now) and including a base-rent correction.
  // They are equal on any property with no gross lease and no base correction — which is
  // every property on the demo seed, and why the divergence was invisible.
  const rentScheduled = billed.tieOut;
  const rentDrift = round2(rentScheduled - rentQuoted);

  // ⚠ MONEY IN IS NOW EVERY COMPONENT OF THE BILL, not the rent alone. Each month of
  // `inByMonth` therefore equals what the Ledger shows that month as owed, plus that month's
  // other income — which is the whole point of the change and the thing to check first if
  // this ever looks wrong.
  const inByMonth = [rentByMonth, camTaxByMonth, roofByMonth, chargesByMonth, carriedByMonth, inc.byMonth]
    .reduce((acc, a) => add12(acc, a), zero12());
  const inUndated = round2(inc.undated + tenantCredit);
  const outByMonth = rec.totals.byMonth;
  const outUndated = rec.totals.undated;

  const billedTotal = round2(rent + camTaxBilled + roofBilled + charges + carried + inc.total);

  // ⚠ THE YEAR-END RECONCILIATION LINE — George, 2026-08-16: *"should that update based on
  // the CAM and TAX reconciliation at the end of the year based on the actual that was
  // charged to the tenants?"* Yes, and this is where. Tenants pay the ESTIMATE month by
  // month; what they actually OWE for the year is their share of the actual expense, which
  // is `recovered`. The gap is exactly what ⚖ Reconcile settles — a genuine year-end event,
  // so it gets one line and not twelve. Spreading it back over the months would invent
  // figures and break the promise that every monthly cell equals the Ledger.
  //
  // ⚠ DERIVED AS `recovered − billed`, NOT SUMMED FROM reconcileFigures, and that is
  // deliberate: it makes the sheet tie by construction. Revenue already carries the billed
  // CAM/tax/roof, so adding this brings the income side to the tenants' true entitlement —
  // the same figure the cost side nets off — and `net` lands on precisely what it always
  // was, plus the charges & credits that used to reach no sheet at all. A property with no
  // estimates bills its actual share, so this is exactly $0 there.
  //
  // ⚠ ON THE LIVE BASIS THIS IS THE ACTUAL-CAM-AND-TAX FIGURE GEORGE ASKED FOR, and the
  // arithmetic does not change — only what it is measured against. `camTaxBilled`/`roofBilled`
  // there are what tenants have actually PAID toward their share, so the line reads "their
  // real pro-rata share for the year, less what has come in against it". It is the one figure
  // on a cash sheet that is not cash, so the sheet labels it as such and gives it no months.
  const trueUp = round2(rec.totals.recovered - round2(camTaxBilled + roofBilled));
  // ⚠ `− carried` IS THE OTHER HALF OF THE FIFTH ROW. Total billed carries it so the monthly
  // grid still equals the Ledger; Total EARNED must not, because a balance brought forward
  // was last year's income and a refund was never income at all. Both are year-end movements
  // with no month of their own on the earnings side, which is why this sits beside the
  // reconciliation line rather than inside the grid.
  const earned = round2(billedTotal + trueUp - carried);
  const revenue = earned;
  // What the monthly grid itself adds up to — money in less the GROSS expense. Still not the
  // headline, because the year-end line above has no month.
  const grossNet = round2(billedTotal - rec.totals.spent);
  // ⚠ THE BOTTOM LINE MOVES BY THE CHARGES AND BY NOTHING ELSE. Substitute trueUp and the
  // reimbursement cancels: (rent + camTax + roof + charges + other) + (recovered − camTax −
  // roof) − spent === (rent + charges + other) − (spent − recovered). That right-hand side
  // is the old formula with `charges` added — the write-off George asked about, and the fee
  // and the concession with it. Everything else is presentation. `net === earned − spent` is
  // asserted in incomeExpense.test.js so the two can never quietly part company.
  const net = round2(earned - rec.totals.spent);
  const absorbed = absorbedFromItems(items, buckets).total;

  return {
    id: property.id,
    name: property.name,
    address: property.address || null,
    // Which question this shape answers. Everything downstream — the sheet's labels, its
    // notes, the flags, the filename — reads it from here rather than being told twice.
    basis,
    rent,
    rentRows,
    rentByMonth,
    rentQuoted,
    rentScheduled,
    rentDrift,
    // Rent on this sheet that comes from a step not yet in effect (projected basis only).
    projectedAhead,
    // Cash paid beyond the year's bills, with no month to sit in (live basis only).
    tenantCredit,
    // The leases whose ISSUED invoice no longer matches these rows, and by how much.
    invoiceDrifted: billed.drifted,
    invoiceDriftTotal: billed.driftTotal,
    // The bill's other components, each with the per-lease rows the sheet indents under it.
    camTaxRows: shown.camTax,
    camTaxByMonth,
    camTaxBilled,
    roofRows: shown.roof,
    roofByMonth,
    roofBilled,
    chargeRows,
    chargesByMonth,
    charges,
    // Slice 4 — money the tenant owes that is not this year's income. In Total billed (so
    // the months still equal the Ledger), out again before Total earned.
    carriedRows,
    carriedByMonth,
    carried,
    // Where each tenant stands: billed · received · charges & credits · closing balance.
    // Derived through `allocatePayments` / `ledgerRowSummary`, the same pair the Ledger grid
    // is painted from, so the balance printed here is the balance the Settle up button acts on.
    standings: propertyStandings({ roll, year }),
    trueUp,
    billedTotal,
    earned,
    incomeGroups: inc.groups,
    otherIncome: inc.total,
    incomeByMonth: inc.byMonth,
    incomeUndated: round2(inc.undated),
    revenue,
    inByMonth,
    inUndated,
    expenseRows: rec.rows,
    expenseTotals: rec.totals,
    outByMonth,
    outUndated,
    netByMonth: sub12(inByMonth, outByMonth),
    netUndated: round2(inUndated - outUndated),
    grossNet,
    net,
    // Owner money out. Reported, never counted. (There is no inward counterpart: money
    // the landlord puts in files as a `transfer` and records no amount — see otherIncome.js.)
    distributions: rec.owner,
    distributionsTotal: rec.ownerTotal,
    // Quoted so the workbook and the Performance card on screen are reconcilable rather
    // than mysteriously different. NOI is not a smaller version of `net`; it answers a
    // different question and is built from a different set of dollars:
    //
    //   net === noi + recovered + otherIncome − absorbed + charges + (rent − rentQuoted)
    //
    // ⚠ EVERY ONE OF THOSE TERMS HAS BEEN FORGOTTEN AT LEAST ONCE, which is why the note
    // is no longer written as a sentence: `noiBridge` above builds it, `noiBridge` carries
    // a catch-all residual so a missing term can never make the printed sum wrong again,
    // and `incomeExpenseExcel` only renders what it is handed.
    //   `absorbed`  — shipped missing 2026-08-12, out by the not-billed costs ($2,950 on
    //                 the demo). `total_expenses` comes from `cam_total`, which counts
    //                 `billable is not false` lines only, so a cost the landlord chose to
    //                 eat is in this sheet's `spent` and in none of NOI.
    //   `charges`   — added 2026-08-16. `total_revenue` is `sum(effective_rent)` and knows
    //                 nothing about `lease_adjustments`, so a late fee or a write-off
    //                 reaches `net` and reaches NOI through nothing at all.
    //   rent basis  — added 2026-08-16 (the audit). `effective_rent` is a RATE: it
    //                 prorates neither end of a term, and for a gross lease it is the whole
    //                 flat rent. See `noiBridge`.
    //
    // ⚠ NULL ON THE LIVE BASIS, and that is not a shortcut. Every term above is accrual —
    // `total_revenue` is `sum(effective_rent)`, an annual RATE nobody paid in twelve equal
    // pieces — so bridging it to a cash bottom line would put the whole of the year's arrears
    // into the catch-all residual and print an equation whose largest term is "not accounted
    // for". The projected copy of the workbook is where that reconciliation belongs.
    noi: num(totals?.noi),
    recovered: rec.totals.recovered,
    absorbed,
    noiBridge: live ? null : noiBridge({
      noi: num(totals?.noi), net, recovered: rec.totals.recovered, otherIncome: inc.total,
      absorbed, charges, rentBasis: round2(rent - rentQuoted),
    }),
  };
}

/** The corporation's totals — summed from the ROUNDED property figures, so the Summary
 *  sheet ties to the per-property sheets rather than sitting a cent away from them. */
export function consolidate(properties = []) {
  return properties.reduce(
    (t, p) => ({
      rent: round2(t.rent + p.rent),
      camTaxBilled: round2(t.camTaxBilled + p.camTaxBilled),
      roofBilled: round2(t.roofBilled + p.roofBilled),
      charges: round2(t.charges + p.charges),
      carried: round2(t.carried + p.carried),
      trueUp: round2(t.trueUp + p.trueUp),
      billedTotal: round2(t.billedTotal + p.billedTotal),
      earned: round2(t.earned + p.earned),
      camTaxByMonth: add12(t.camTaxByMonth, p.camTaxByMonth),
      roofByMonth: add12(t.roofByMonth, p.roofByMonth),
      chargesByMonth: add12(t.chargesByMonth, p.chargesByMonth),
      carriedByMonth: add12(t.carriedByMonth, p.carriedByMonth),
      owed: round2(t.owed + p.standings.totals.owed),
      inCredit: round2(t.inCredit + p.standings.totals.inCredit),
      otherIncome: round2(t.otherIncome + p.otherIncome),
      revenue: round2(t.revenue + p.revenue),
      spent: round2(t.spent + p.expenseTotals.spent),
      recovered: round2(t.recovered + p.expenseTotals.recovered),
      netCost: round2(t.netCost + p.expenseTotals.net),
      grossNet: round2(t.grossNet + p.grossNet),
      net: round2(t.net + p.net),
      distributions: round2(t.distributions + p.distributionsTotal),
      projectedAhead: round2(t.projectedAhead + p.projectedAhead),
      tenantCredit: round2(t.tenantCredit + p.tenantCredit),
      rentByMonth: add12(t.rentByMonth, p.rentByMonth),
      incomeByMonth: add12(t.incomeByMonth, p.incomeByMonth),
      inByMonth: add12(t.inByMonth, p.inByMonth),
      outByMonth: add12(t.outByMonth, p.outByMonth),
      netByMonth: add12(t.netByMonth, p.netByMonth),
      inUndated: round2(t.inUndated + p.inUndated),
      outUndated: round2(t.outUndated + p.outUndated),
      netUndated: round2(t.netUndated + p.netUndated),
    }),
    {
      rent: 0, camTaxBilled: 0, roofBilled: 0, charges: 0, carried: 0, trueUp: 0, billedTotal: 0, earned: 0,
      otherIncome: 0, revenue: 0, spent: 0, recovered: 0, netCost: 0, grossNet: 0, net: 0, distributions: 0,
      owed: 0, inCredit: 0, projectedAhead: 0, tenantCredit: 0,
      rentByMonth: zero12(), camTaxByMonth: zero12(), roofByMonth: zero12(), chargesByMonth: zero12(),
      carriedByMonth: zero12(),
      incomeByMonth: zero12(), inByMonth: zero12(), outByMonth: zero12(), netByMonth: zero12(),
      inUndated: 0, outUndated: 0, netUndated: 0,
    }
  );
}

/**
 * The expense categories rolled up across every property, for the Summary grid — one row
 * per category, no bucket detail. Built from the per-property rows rather than re-derived,
 * so the Summary and the property sheets cannot disagree about where a dollar filed.
 */
export function consolidateCategories(properties = []) {
  const byKey = new Map();
  for (const p of properties) {
    for (const r of p.expenseRows) {
      const k = r.key == null ? ' none' : r.key;
      let e = byKey.get(k);
      if (!e) { e = { key: r.key, label: r.label, spent: 0, recovered: 0, net: 0, byMonth: zero12(), undated: 0 }; byKey.set(k, e); }
      e.spent = round2(e.spent + r.spent);
      e.recovered = round2(e.recovered + r.recovered);
      e.net = round2(e.net + r.net);
      e.byMonth = add12(e.byMonth, r.byMonth);
      e.undated = round2(e.undated + r.undated);
    }
  }
  // Same order the table on screen uses: by what it cost you, uncategorized pinned last
  // so the roll-up can neither bury the nag nor promote it above real categories.
  const all = [...byKey.values()];
  return [
    ...all.filter((r) => r.key != null).sort((a, b) => b.net - a.net || b.spent - a.spent || a.label.localeCompare(b.label)),
    ...all.filter((r) => r.key == null),
  ];
}

const dollars = (n) => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/**
 * What the workbook should say about itself before anyone reads a figure. Same job the
 * removed packages' pre-flight served: a report that cannot tell a careful export from
 * one that quietly omitted something forces the reader to assume the worst.
 */
export function flags(properties = []) {
  const out = [];
  // The basis rides on the shapes rather than being passed in again — one source, so a flag
  // can never describe a copy of the workbook the reader is not holding.
  const live = properties[0]?.basis === 'live';

  // ⚠ THE FIRST FLAG ON EITHER BASIS SAYS WHICH ONE THIS IS. The two workbooks have the same
  // sheets, the same row titles and very different figures, and a landlord who downloads both
  // in one afternoon will otherwise have two files on their desktop and no way to tell them
  // apart six weeks later.
  if (live) {
    out.push('This is the LIVE copy: every Money-in figure is cash the Ledger says arrived, month by month, so '
      + 'a month nobody has paid is blank rather than showing the bill. Money out is what has been recorded so far. '
      + 'It is a cash statement — do not compare it cell for cell with the projected copy, which counts what was billed.');
  } else {
    out.push('This is the PROJECTED copy: the year as the leases contract it to run — every month billed, including '
      + 'rent steps that have not taken effect yet, and CAM & tax at the estimate tenants are billed. What has '
      + 'actually been collected is the live copy.');
  }

  const uncategorized = properties.filter((p) => p.expenseRows.some((r) => r.key == null));
  if (uncategorized.length) {
    const amt = uncategorized.reduce((s, p) => s + p.expenseRows.filter((r) => r.key == null).reduce((n, r) => n + r.spent, 0), 0);
    out.push(`${uncategorized.length} propert${uncategorized.length === 1 ? 'y has' : 'ies have'} expenses with no category — ${dollars(amt)} is grouped as "Not categorized" rather than guessed at.`);
  }

  // ⚠ THE ONE FLAG THE MONTHLY LAYOUT MADE NECESSARY. Before this sheet had months, an
  // undated expense was simply part of the year. Now it is a dollar the grid cannot place,
  // and a reader scanning across the months would otherwise never learn how much of the
  // year isn't on them. 0074 wrote the rule this obeys: anything that reads dates has to
  // state how many dollars it could not date.
  //
  // ⚠ IT CARRIES THE CAUSES, and that is not padding. The export dialog used to print its
  // own sentence explaining WHY a figure has no date, immediately above this flag saying
  // the same total a second way — two near-identical paragraphs in one small dialog. The
  // explanation belongs on the flag, because the flag is the copy that also reaches the
  // workbook, where there is nobody to ask.
  const undatedOut = round2(properties.reduce((s, p) => s + p.outUndated, 0));
  if (undatedOut > 0) {
    out.push(`${dollars(undatedOut)} of expenses carry no payment date and sit in the "No date" column rather than in a month — an expense typed by hand with the date left blank, a figure entered as one annual total, or a cost carried in from a service contract. Dating those lines on the Financials page moves them into the grid.`);
  }
  const undatedIn = round2(properties.reduce((s, p) => s + p.inUndated, 0));
  if (undatedIn > 0) {
    out.push(`${dollars(undatedIn)} of other income carries no date and sits in the "No date" column rather than in a month.`);
  }

  // ⚠ THE STEPS THAT ARE NOT IN EFFECT YET, NAMED IN DOLLARS. This is the whole reason the
  // projected basis exists (George: *"right now, it doesn't show escalations if there is one on
  // the Excel sheet"*) — and it is also money nobody has been billed for, so a reader handed
  // this sheet has to be told how much of it is a forecast rather than a bill.
  const ahead = round2(properties.reduce((s, p) => s + (p.projectedAhead || 0), 0));
  if (!live && ahead > 0.005) {
    const who = properties.filter((p) => (p.projectedAhead || 0) > 0.005).map((p) => p.name).join(', ');
    out.push(`${dollars(ahead)} of the rent on this sheet comes from rent steps that have not taken effect yet — `
      + `${who}. The lease schedules them, so a full year's projection has to count them; no invoice has been issued `
      + 'for them and no tenant has been asked to pay one. They apply from the month of the step, not the whole year.');
  }

  // ⚠ AND THE CASH THAT HAS NO MONTH. A tenant who paid more than the whole year's bills leaves
  // money the allocation cannot put in a month — real dollars that would otherwise fall off a
  // sheet meant to equal the bank. It sits in "No date" and this is what says so.
  const overpaid = round2(properties.reduce((s, p) => s + (p.tenantCredit || 0), 0));
  if (live && overpaid > 0.005) {
    out.push(`${dollars(overpaid)} was paid beyond the whole year's bills, so there is no month it settles. It is in `
      + 'the "No date" column on the Rent row rather than being dropped — it did reach the bank. The Ledger names '
      + 'which tenants are ahead.');
  }

  // The rent tie-out. A difference is information, not an error — but it must be stated in
  // dollars rather than left for the reader to notice.
  //
  // ⚠ PROJECTED ONLY, both this and the invoice drift below. Both compare what the leases say
  // was BILLED against another record of the same — meaningless against cash, where a
  // difference is just a tenant who has not paid yet, and printed on a live sheet they would
  // read as faults on a sheet that is working exactly as intended.
  const drifted = live ? [] : properties.filter((p) => Math.abs(p.rentDrift) > 1);
  for (const p of drifted) {
    // ⚠ NAME THE USUAL CAUSE. `effective_rent` is a RATE — it does not prorate a lease that
    // started or ended part-way through the year, while the schedule these months are built
    // from does. So a property with any part-year tenancy drifts by design, and a flag that
    // only stated the two figures read as an unexplained error on a perfectly correct sheet.
    //
    // ⚠ AND QUOTE THE FIGURE THE DIFFERENCE IS ACTUALLY TAKEN FROM. `rentDrift` measures
    // `rentScheduled`, not the sheet's Rent row — quoting the row instead (as this did
    // until the 2026-08-16 audit) prints three figures where the third is not the
    // difference of the first two the moment a gross lease or a base-rent correction makes
    // the two diverge.
    // ⚠ AND IT NAMES EVERY CAUSE IT CAN HAVE. A scheduled rent step joined the list on
    // 2026-08-17: the Rent row counts it and this comparison deliberately does not, so a flag
    // that offered only the old two causes would send a reader looking for a gross lease that
    // isn't there.
    const alsoRow = Math.abs(round2(p.rentScheduled - p.rent)) > 1
      ? ` The Rent row above reads ${dollars(p.rent)} rather than ${dollars(p.rentScheduled)}: `
        + `${(p.projectedAhead || 0) > 0.005 ? `${dollars(p.projectedAhead)} of it is a rent step not yet in effect, ` : ''}`
        + 'a gross lease\'s flat rent is split there into rent and CAM & tax, and a base-rent correction rides the Rent row.'
      : '';
    out.push(`${p.name}: these leases schedule ${dollars(p.rentScheduled)} of rent at their contract rates, and the Revenue figure on the Financials page reads ${dollars(p.rentQuoted)} — a difference of ${dollars(Math.abs(p.rentDrift))}. These months come from each lease's own schedule, so a tenancy that began part-way through the year is counted only from the month it began. The page's figure is the annual rate from the database view, which is not prorated.${alsoRow}`);
  }

  // ⚠ THE BILL YOU ACTUALLY SENT. Everything above is built UP from each lease's current
  // terms; an issued invoice is a frozen copy that does not rebuild itself. Importing a bank
  // statement moves a property's CAM or tax total and calls NO resync, so this is the
  // ordinary case, not the exotic one — on the demo, one imported tax payment puts City
  // Dental's sheet $2,718 ahead of its invoice. The Ledger row has always said so; the
  // workbook is the copy that leaves the building, so it says so too. It is the LAST flag
  // deliberately: it asks the reader to go and do something, and the others do not.
  for (const p of live ? [] : properties) {
    if (!p.invoiceDrifted?.length) continue;
    // ⚠ THE SIGN IS SAID IN WORDS, PER LEASE. A bare "+$2,718.00" beside the phrase
    // "$2,718.00 below" reads as a contradiction, and with two leases drifting opposite
    // ways one direction in the headline cannot describe both.
    const who = p.invoiceDrifted.map((d) => `${d.label} ${dollars(Math.abs(d.amount))} ${d.amount > 0 ? 'below' : 'above'}`).join(' · ');
    const dir = p.invoiceDriftTotal > 0 ? 'below' : 'above';
    out.push(`${p.name}: the invoices you actually issued come to ${dollars(Math.abs(p.invoiceDriftTotal))} ${dir} what this sheet shows, on ${p.invoiceDrifted.length} lease${p.invoiceDrifted.length === 1 ? '' : 's'} — ${who}. These months are built from each lease's terms as they stand today; an invoice is frozen when it is issued and does not follow a later change, and importing a bank statement that moves your CAM or tax total does not re-price one. The Ledger names the same figure on the tenant's row and offers Rebuild, which brings the bill up to this sheet.`);
  }

  const noExpenses = properties.filter((p) => p.expenseTotals.spent <= 0);
  if (noExpenses.length) {
    out.push(`${noExpenses.length} propert${noExpenses.length === 1 ? 'y has' : 'ies have'} no expenses recorded for this year: ${noExpenses.map((p) => p.name).join(', ')}.`);
  }
  const anyFlat = properties.filter((p) => p.expenseRows.some((r) => r.anyFlat));
  if (anyFlat.length) {
    out.push(`${anyFlat.length} propert${anyFlat.length === 1 ? 'y carries' : 'ies carry'} an un-itemized total — those figures are a single number, not a list of payments, so they have no month.`);
  }
  return out;
}

/** Read a corporation's year and shape every property in it. The only impure function
 *  here; every query key matches the one the Financials page uses, so a landlord who
 *  just looked at the page downloads from cache. */
export async function buildIncomeExpense(corporationId, year, { basis = 'projected' } = {}) {
  const [props, buckets] = await Promise.all([listProperties(corporationId), listExpenseBuckets()]);
  const properties = await Promise.all(
    (props || []).map(async (property) => {
      const [totals, camItems, taxItems, roofItems, expense, shares, income, roll] = await Promise.all([
        getPropertyTotals(property.id, year),
        listCamLineItems(property.id, year),
        listTaxLineItems(property.id, year),
        listRoofLineItems(property.id, year),
        getExpenseRecord(property.id, year),
        getTenantShares(property.id, year),
        listOtherIncome(property.id, year),
        // ⚠ Deliberately the whole roll rather than a lighter query. It fans out one
        // listPayments per invoice that this sheet never reads, and that overhead is
        // accepted: building a month's rent means escalations, abatements, a part-year
        // term and the estimate series, all of which live behind `buildLeaseSchedule` —
        // a §2 choke point. Re-deriving them here would be a second implementation of
        // the Ledger's own grid.
        //
        // ⚠ `includeScheduled` ONLY on the projected basis. The live basis needs the schedule
        // as the DENOMINATOR it apportions each month's cash across, and that has to be what
        // the tenant was actually billed — apportioning a real payment across a rent step
        // nobody has been charged for would move cash onto a row it never touched.
        getPropertyMonthlyRoll(property.id, year, { includeScheduled: basis !== 'live' }),
      ]);
      // ⚠ Sequential on purpose — it needs the lease ids the shares query just returned.
      // One query for the whole property, and the same key TenantShareTable /
      // RecoverabilityTable use, so a landlord who just looked at the Financials page
      // downloads from cache exactly as the rest of this loader does.
      const escByLease = (shares || []).length
        ? await listEscalationsByLeases((shares || []).map((s) => s.lease_id))
        : {};
      return shapeProperty({
        property, year, totals, shares, expense, buckets, income, roll, escByLease, basis,
        items: [...(taxItems || []), ...(camItems || []), ...(roofItems || [])],
      });
    })
  );
  properties.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return {
    year,
    basis,
    properties,
    totals: consolidate(properties),
    categories: consolidateCategories(properties),
    flags: flags(properties),
  };
}
