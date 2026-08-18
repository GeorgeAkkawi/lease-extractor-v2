// The Overview's projected-vs-live figures, per property.
//
// George, 2026-08-18: *"weve built thi software around projected but there should be a live
// counter as well. and any over or undercharges only counts towards live count … projected
// expenses which come from the base rent and cam and tax estimates - the live counter comes
// from the ledger and the bank statements and live expenses."*
//
// ⚠ WHY THIS FILE EXISTS AT ALL, and it is a correction rather than an addition. The Overview
// already drew a cash bar, and the panel had to print a paragraph apologising for it:
//
//   Revenue    = v_property_totals.total_revenue = sum(effective_rent)
//                → BASE RENT ONLY, APPLIED STEPS ONLY (0049 / 0054). It counts none of the
//                  CAM & tax tenants reimburse and is blind to a rent step not yet swept in.
//   Collected  = every dollar off the Ledger — all-in, reimbursements included.
//
// Two different measures standing next to each other, inviting the one reading they cannot
// support ("70% collected"). So the pair is rebuilt as ONE measure read twice.
//
// ⚠ AND IT IS READ THROUGH THE WORKBOOK'S OWN FUNCTIONS, not beside them. `billedRowsFromRoll`
// is what the Income-and-expenses workbook's two bases are built from; calling it here means
// "Projected revenue" on the Overview and the projected workbook's `billedTotal` are one
// figure with two renderers. A second implementation would drift silently, because nothing
// compares them (CLAUDE.md §3) — which is exactly how the two bars above came to disagree.
// `portfolioBasis.test.js` asserts the equality rather than trusting it.
//
// Nothing here writes.
import { getPropertyMonthlyRoll, listExpenseSpendByProperty, localDateIso } from './api';
import { billedRowsFromRoll, contractedRoll } from './incomeExpense';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/** The five components of a bill, added up. The same five `shapeProperty` prints as rows. */
const groupsTotal = (res) => round2(
  ['rent', 'camTax', 'roof', 'charges', 'carried']
    .reduce((s, k) => s + (res?.[k] || []).reduce((t, r) => t + num(r.total), 0), 0)
);

/**
 * Both bases for every property, keyed by id.
 *
 * ⚠ ONE ROLL READ, TWO PASSES — and the second one is handed `contractedRoll`. The roll is
 * fetched WITH the projection (`includeScheduled`) because that is what the projected figure
 * needs; the live pass then strips it back off, because `monthExcess` decides "more arrived
 * than was billed" against `alloc.owed`, and nobody has been billed for a step that has not
 * happened. Measured against the projection a real surplus shrinks or disappears, and the
 * hold-back that keeps an unanswered over-payment out of live revenue stops working —
 * silently, and in the direction that counts money nobody has agreed is income.
 *
 * `confirmed` is the owner's keyed-decision store (`alert_states`, filtered to dismissed).
 * The Overview already holds it — the same cached `['alertStates']` read the Ledger and the
 * month panel share — so answering a surplus there repaints this without a second fetch.
 * Null means "nothing confirmed", which holds money OUT: the safe direction, since a surplus
 * counted because a read failed is income asserted on no authority at all.
 *
 * Returns per property:
 *   projectedRevenue  what the leases contract for the year, all-in, 12 months
 *   liveRevenue       cash the Ledger says arrived, all-in, unanswered surplus withheld
 *   liveCredit        of that, money beyond the whole year's bills — real, with no month
 *   unapplied         arrived beyond what a month billed and still waiting on an answer
 *   spentToDate       costs carrying a payment date on or before today
 *   spentDated        costs carrying ANY payment date — so the caller can name the undated
 *                     remainder against the stored total rather than dropping it
 */
export async function listBasisByProperty(propertyIds, year, { confirmed = null, today = null } = {}) {
  const ids = [...new Set((propertyIds || []).filter(Boolean))];
  if (ids.length === 0) return {};
  const todayIso = today || localDateIso();

  const [spendByProp, perProperty] = await Promise.all([
    listExpenseSpendByProperty(ids, year, todayIso),
    Promise.all(ids.map(async (id) => {
      // ⚠ Deliberately the whole roll, for the reason `buildIncomeExpense` states: a month's
      // rent means escalations, abatements, a part-year term and the estimate series, all of
      // which live behind `buildLeaseSchedule` — a §2 choke point. Re-deriving them cheaply
      // here would be a second implementation of the Ledger's own grid.
      const roll = await getPropertyMonthlyRoll(id, year, { includeScheduled: true });
      const projected = billedRowsFromRoll(roll);
      const live = billedRowsFromRoll(contractedRoll(roll), { collected: true, year, confirmed });
      return [id, {
        projectedRevenue: groupsTotal(projected),
        liveRevenue: groupsTotal(live),
        liveCredit: round2(live.creditTotal),
        unapplied: round2(live.unapplied),
      }];
    })),
  ]);

  const out = {};
  for (const [id, money] of perProperty) {
    const spend = spendByProp[id] || {};
    out[id] = { ...money, spentToDate: round2(spend.toDate), spentDated: round2(spend.dated) };
  }
  return out;
}
