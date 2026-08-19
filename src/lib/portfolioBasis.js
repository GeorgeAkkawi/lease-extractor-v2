// The Overview band's figures, per property — the BILL, read twice.
//
// George, 2026-08-18, after catching the first attempt: *"projected revenue should be just base
// rent · projected expenses is the estimated cam and tax — then there should be a total collumn
// instead of the whats left."*
//
// ⚠ WHY THE FIRST ATTEMPT WAS WRONG, because the shape below is the correction. It made
// projected revenue ALL-IN — base rent plus the CAM & tax estimate, prorated to each lease's
// term — which put $1,155,141 on the band while the pie chart under it said $1,032,564 for the
// same portfolio and the same year. Both were defensible; neither said which it was; and the
// landlord's first question was the right one: *"where is this coming from."* Two headline
// figures on one screen with nothing reconciling them is the §3 fault in its plainest form.
//
// So the three columns are now the INVOICE'S OWN STRUCTURE, which is the one shape a landlord
// already reads without being taught:
//
//   Revenue   base rent            ← the leases' own schedules, AND THE PIE'S OWN FIGURE
//   Expenses  CAM & tax at estimate← `billedComponents`, what the invoice bills
//   Total     the two together     ← what the tenant is charged
//
// You replace a subtraction ("what's left") with an addition ("Total") only when the columns
// genuinely add — and these do, because they are the two halves of one bill. It also retires
// the NOI reconciliation the old third column needed: there is nothing left to reconcile.
//
// ⚠ REVENUE MOVED OFF THE VIEW ON 2026-08-18 (3), and the identity with the donut survived the
// move because the DONUT MOVED WITH IT. George: *"we should make rent projections part of the
// projected rent because we know what those numbers are so that shouldn't be a discrepancy."*
// `total_revenue` is `sum(effective_rent)` — an annual RATE — so it counted a July raise as
// though it had run since January and could not see a raise still scheduled. Both showed on the
// band as a gap the landlord was asked to account for; neither was one. Revenue is now the year
// the leases contract to bill, each step dated to its own month, plus the months a scheduled
// step will re-price. The view is untouched and everything else still reads it.
//
// The CAM & tax estimate still comes from one bulk `v_tenant_shares` read through
// `billedComponents` — a §2 choke point, the same function the invoice and the Ledger price
// from, so the band cannot quote a different bill from the bill.
//
// Nothing here writes.
import {
  getPropertyMonthlyRoll, listTenantSharesByProperties, listOtherIncomeByProperties, localDateIso,
} from './api';
import { billedRowsFromRoll, contractedRoll } from './incomeExpense';
import { billedComponents } from './reconciliation';
import { summarizeOtherIncome } from './otherIncome';
import { adjustmentsForPnlRow } from './adjustments';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/** One group of `billedRowsFromRoll`, collapsed to its annual figure. */
const groupTotal = (rows = []) => round2((rows || []).reduce((s, r) => s + num(r.total), 0));

/** …and the part of it belonging to GROSS leases, which is a figure in its own right: for a
 *  gross tenant `total_revenue` counts the whole flat rent (0073) and `billedComponents`
 *  returns the CAM & tax carved out of that same rent, so the carve is on both sides of the
 *  band. `yearBridge` needs it named to close, and Total needs it subtracted not to
 *  double-count. The rows already carry the flag — this reads it, it does not re-derive it. */
const grossPart = (...groupLists) => round2(
  groupLists.reduce((s, rows) => s + (rows || []).filter((r) => r.gross).reduce((n, r) => n + num(r.total), 0), 0)
);

/** Each lease's adjustment rows, flattened once — the input `adjustmentsForPnlRow` wants. */
const allAdjRows = (roll = []) => (roll || []).flatMap((r) => r?.adjustmentRows || []);

/**
 * How many of a fiscal year's months are DUE as of `todayIso` — the boundary the band's timing
 * split reads. Rent falls due on the 1st, so the running month counts (George, 2026-08-13 — the
 * same reading `owesToDate` keeps; what waits for month-end is the *accusation*, and the band is
 * a balance, not an accusation). A year wholly past is all due; a year wholly ahead, none.
 *
 * Exported for its tests: the boundary must be pinned without depending on what today is.
 */
export function monthsDueThrough(year, todayIso) {
  const ty = Number(String(todayIso || '').slice(0, 4));
  const tm = Number(String(todayIso || '').slice(5, 7));
  if (!(ty > 0) || !(tm >= 1)) return 12; // an unreadable today never hides money as "not due"
  if (Number(year) < ty) return 12;
  if (Number(year) > ty) return 0;
  return tm;
}

/**
 * The first month of `year` that begins AFTER a lease's own end date — 1..12, or 13 when the
 * term covers (or outlives, or never stated) the year. Month granularity matches the term's
 * own un-prorated end (`monthlyScheduleForYear` zeroes months before the tenancy and never
 * after — deliberate, the holdover rule): a term ending 15 Sep keeps all of September.
 *
 * ⚠ THIS DOES NOT SHORTEN ANY SCHEDULE. The bill keeps running past the end date on purpose —
 * a holdover tenant keeps owing until removed, a decision taken once, reversed never (see the
 * deploy log: "a lease past its end date is NOT a fault"). What this feeds is the BRIDGE's
 * honesty: the slice of the projection sitting past a lease's own end is real only if the
 * tenant stays, and a panel that files it under "not due yet" states a certainty nobody has.
 */
export function afterTermStart(year, termIso) {
  const t = String(termIso || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return 13;
  for (let m = 1; m <= 12; m++) {
    if (`${year}-${String(m).padStart(2, '0')}-01` > t) return m;
  }
  return 13;
}

/** Σ of the months from the due boundary UP TO each lease's own end — the not-yet-due slice.
 *  `byMonth` is on every row of both passes (`billedRowsFromRoll`); nothing is re-derived.
 *  Months past a lease's end are excluded here and measured by `afterPart` instead: rent the
 *  calendar has not reached is CERTAIN, rent past the term is conditional on the tenant
 *  staying, and one line must not claim both. */
const futurePart = (groupLists, due, afterByLease) => round2(
  groupLists.reduce((s, rows) => s + (rows || []).reduce((n, r) => {
    const bm = r?.byMonth || [];
    const cap = Math.min(12, (afterByLease?.get(r.lease_id) ?? 13) - 1);
    let t = 0;
    for (let i = due; i < cap; i++) t += num(bm[i]);
    return n + t;
  }, 0), 0)
);

/** Σ of the months past each lease's own end — past AND future months both, because the app
 *  cannot tell a holdover in possession from a tenant who left (recording the departure is a
 *  missing feature, not a schedule fault). Paid holdover months net to zero here. */
const afterPart = (groupLists, afterByLease) => round2(
  groupLists.reduce((s, rows) => s + (rows || []).reduce((n, r) => {
    const bm = r?.byMonth || [];
    let t = 0;
    for (let i = (afterByLease?.get(r.lease_id) ?? 13) - 1; i < 12; i++) t += num(bm[i]);
    return n + t;
  }, 0), 0)
);

/**
 * Both readings of the bill for every property, keyed by id.
 *
 * `confirmed` is the owner's keyed-decision store (`alert_states`, filtered to dismissed) —
 * the same cached `['alertStates']` read the Ledger and the month panel share, so answering a
 * surplus there repaints this without a second fetch. Null means "nothing confirmed", which
 * holds money OUT: a surplus counted because a read failed is income asserted on no authority.
 *
 * Returns per property:
 *   rentProjected    the base rent this year's leases contract to bill, month by month
 *   camTaxProjected  the CAM, tax and roof this year's leases bill at estimate
 *   rentLive         base rent actually collected
 *   camTaxLive       CAM, tax and roof actually collected
 *   chargesLive      fees and credits collected; `chargesProjected` is what was posted
 *   otherLive        income that rides no invoice — parking, storage, a write-in category
 *   unapplied        arrived beyond what a month billed, still waiting on an answer
 *   rentNotDue /     the part of each gap sitting in months that have not come round yet —
 *   camTaxNotDue     the timing half of "projected vs live", measured, never inferred
 *   rentAfterTerm /  the slice billed past a lease's own end date — in the bill on purpose
 *   camTaxAfterTerm  (holdover keeps owing) but conditional on the tenant staying
 *
 * ⚠ THERE IS NO `otherProjected`, AND ITS ABSENCE IS THE ANSWER TO GEORGE'S QUESTION (*"what
 * happens when a landlord has other sources of income"*). `other_income` (0078) is recorded as
 * it arrives; the app forecasts none of it and has no table that could. So it can only land on
 * the live side — and the band says that out loud rather than inventing a projection for it or,
 * worse, dropping it and letting Total live quietly under-report the bank.
 */
export async function listBasisByProperty(propertyIds, year, { confirmed = null } = {}) {
  const ids = [...new Set((propertyIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  // The due boundary for the timing split, read once — `localDateIso` is the JS half of the
  // `app_today()` twin (CLAUDE.md §3), the same "today" every other date decision uses.
  const due = monthsDueThrough(year, localDateIso());

  const [sharesByProp, incomeByProp, perProperty] = await Promise.all([
    listTenantSharesByProperties(ids, year),
    listOtherIncomeByProperties(ids, year),
    Promise.all(ids.map(async (id) => {
      // ⚠ Deliberately the whole roll, for the reason `buildIncomeExpense` states: apportioning
      // a month's cash means the schedule it was billed against, and that means escalations,
      // abatements, a part-year term and the estimate series — all behind `buildLeaseSchedule`,
      // a §2 choke point. Re-deriving them cheaply here would be a second implementation of the
      // Ledger's own grid.
      //
      // ⚠ AND WITH `includeScheduled`, WHICH IS NEW AND IS NOT A LICENCE TO PROJECT ANYTHING
      // ELSE (2026-08-18 (3)). George: *"we should make rent projections part of the projected
      // rent because we know what those numbers are so that shouldn't be a discrepancy."* The
      // flag buys exactly ONE figure — `projectedAhead`, the rent a scheduled-but-unswept step
      // adds — and every other reading below must go on being measured against the BILL:
      //
      //   • cash is apportioned across what the tenant was actually charged. Price a month
      //     against a step nobody has been billed for and a real over-payment shrinks or
      //     disappears, and the surplus hold-back silently stops holding anything
      //     (`portfolioBasis.test.js` pins this and is the assertion to watch).
      //   • `tenantStanding` reads the schedule to decide who is BEHIND — a projected roll turns
      //     a future raise into arrears in a figure a landlord may well send a tenant.
      //
      // So the projected roll is unwrapped exactly once, for its one number, and `contractedRoll`
      // puts the bill back for everything else.
      const projectedRoll = await getPropertyMonthlyRoll(id, year, { includeScheduled: true });
      const roll = contractedRoll(projectedRoll);
      // The rent this year's leases contract to bill that no invoice can carry yet: a step with a
      // 2026 effective date that the nightly sweep has not reached. Read straight off the roll —
      // `annual − contracted.annual` from ONE lease built twice with only `includeScheduled`
      // differing (`api.js`), so the delta is the rent step and nothing else.
      const projectedAhead = round2((projectedRoll || []).reduce((s, r) => s + num(r?.projectedAhead), 0));
      // Where each lease's own term runs out, month-granular — the roll rows already carry
      // `lease_termination_date` (the view appends it; the mock mirrors it, mockClient:141).
      const afterByLease = new Map(
        (roll || []).map((r) => [r.lease_id, afterTermStart(year, r.lease_termination_date)])
      );
      const live = billedRowsFromRoll(roll, { collected: true, year, confirmed });
      // The same roll read a second time, as POSTED rather than as paid. Free — both passes
      // are pure over rows already in hand — and it is the only source for the fees and
      // credits sitting on this year's bills, which belong to the projected Total exactly as
      // they belong to the live one.
      const posted = billedRowsFromRoll(roll);
      const adj = allAdjRows(roll);
      return [id, {
        rentLive: groupTotal(live.rent),
        // Roof rides with CAM & tax: it is a recoverable billed the same way, and a fourth
        // column for a figure that is $0 on most portfolios would cost the other three their
        // width. The band's foot says so.
        camTaxLive: round2(groupTotal(live.camTax) + groupTotal(live.roof)),
        chargesLive: round2(groupTotal(live.charges) + groupTotal(live.carried)),
        chargesProjected: round2(groupTotal(posted.charges) + groupTotal(posted.carried)),
        unapplied: round2(live.unapplied),
        // ── Everything below is for `yearBridge`, and every one of it was ALREADY COMPUTED
        // above and thrown away. Naming the causes of the band's gap costs no extra read;
        // that is the whole reason the bridge lives beside the band rather than deriving a
        // second reading of the same year somewhere else (CLAUDE.md §2).
        //
        // ── THE BAND'S PROJECTED REVENUE, and since 2026-08-18 (3) it is DERIVED HERE rather
        // than taken from `v_property_totals.total_revenue`.
        //
        // `total_revenue` is `sum(effective_rent)` — one annual RATE per lease, applied flat to
        // all twelve months. It therefore priced a raise that landed in July as though it had
        // run since January (−$4,307.31 on George's own FY 2026) and could not see a raise still
        // scheduled at all (+$3,368.06). Both were printed on the band as a difference the
        // landlord was asked to explain, and neither was one: the leases say exactly what each
        // month bills.
        //
        //   rentProjected = tieOut          the year as contracted, each applied step dated
        //                 + projectedAhead  the months a scheduled step will re-price
        //
        // ⚠ THE VIEW ITSELF IS UNTOUCHED, deliberately. NOI, every `financial_snapshots` row
        // already written, the Financials page's "Projected revenue (annualized)", History's YoY
        // cards and `syncRentPctCamItems` (which WRITES — a % management fee re-struck from
        // `total_revenue`) all still read it and none of them moved.
        rentProjected: round2(num(posted.tieOut) + projectedAhead),
        projectedAhead,
        // ── THE TIMING SPLIT (George, 2026-08-18): *"the projected and live should be the same
        // exact number at the end of the year … one is a projected count taken from the ledgers
        // figures of what should be charged which we know. the other (live) is just a running
        // counter taken from the bank statements as the year goes along."* So mid-year the only
        // honest gap is TIMING, and the bridge owes it in two lines, not one lump that reads as
        // arrears: the part of the gap sitting in months that have not come round yet, per
        // measure. Both passes carry `byMonth` on every row already; this is two array sums.
        rentNotDue: round2(futurePart([posted.rent], due, afterByLease) - futurePart([live.rent], due, afterByLease)),
        camTaxNotDue: round2(
          futurePart([posted.camTax, posted.roof], due, afterByLease)
          - futurePart([live.camTax, live.roof], due, afterByLease)
        ),
        // ── THE AFTER-TERM SLICE (2026-08-18 (12)). The bill runs past a lease's own end on
        // purpose — the holdover rule — so this money IS billed and IS in the projection. But
        // it is the one part of the year that is conditional (a tenant who stays keeps owing
        // it; one who leaves never pays it), and the bridge owes it its own sentence instead
        // of filing it under "not due yet" as though the calendar alone would deliver it.
        rentAfterTerm: round2(afterPart([posted.rent], afterByLease) - afterPart([live.rent], afterByLease)),
        camTaxAfterTerm: round2(
          afterPart([posted.camTax, posted.roof], afterByLease)
          - afterPart([live.camTax, live.roof], afterByLease)
        ),
        // What the leases contract to bill, at their own rates — still the JS half of the
        // `effective_rent` twin, and the lead half of `rentProjected` above (the test pin
        // `rentProjected === rentScheduled + projectedAhead` reads it; no screen does).
        rentScheduled: round2(posted.tieOut),
        // What the Rent row actually posts, and what CAM & tax actually posts.
        rentPosted: groupTotal(posted.rent),
        camTaxPosted: round2(groupTotal(posted.camTax) + groupTotal(posted.roof)),
        grossCarve: grossPart(posted.camTax, posted.roof),
        rentCorrections: round2(num(adjustmentsForPnlRow(adj, 'rent').total)),
        camTaxCorrections: round2(num(adjustmentsForPnlRow(adj, 'camtax').total)),
        // Cash with no month to settle: paid past the whole year's bills, and paid onto a
        // month the lease bills nothing for. Both are inside the live figures already.
        tenantCredit: round2(live.creditTotal),
        unbilled: round2(live.unbilled),
        // The issued bills against what the leases now say — `invoiceDrift`, already measured on
        // the roll. In NEITHER column of the band (an invoice is a third record), so the bridge
        // carries it as a caveat with somewhere to go, never as a term.
        driftTotal: round2(posted.driftTotal),
      }];
    })),
  ]);

  const out = {};
  for (const [id, live] of perProperty) {
    // What the leases bill for CAM, tax and roof — the ESTIMATE where one is set, the actual
    // share where it is not. `billedComponents` is the single rule for that preference; a
    // second copy here is how the band and the invoice would come to disagree.
    const projected = (sharesByProp[id] || []).reduce((acc, s) => {
      const b = billedComponents(s);
      return round2(acc + num(b.camTax) + num(b.roof));
    }, 0);
    out[id] = {
      ...live,
      camTaxProjected: projected,
      otherLive: round2(summarizeOtherIncome(incomeByProp[id] || [], year).total),
    };
  }
  return out;
}
