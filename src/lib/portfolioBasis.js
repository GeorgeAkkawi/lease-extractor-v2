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
//   Revenue   base rent            ← `v_property_totals.total_revenue`, THE PIE'S OWN FIGURE
//   Expenses  CAM & tax at estimate← `billedComponents`, what the invoice bills
//   Total     the two together     ← what the tenant is charged
//
// You replace a subtraction ("what's left") with an addition ("Total") only when the columns
// genuinely add — and these do, because they are the two halves of one bill. It also retires
// the NOI reconciliation the old third column needed: there is nothing left to reconcile.
//
// ⚠ THE PROJECTED SIDE NO LONGER TOUCHES THE ROLL. Revenue comes from the view the pie already
// reads, and the CAM & tax estimate from one bulk `v_tenant_shares` read through
// `billedComponents` — a §2 choke point, the same function the invoice and the Ledger price
// from, so the band cannot quote a different bill from the bill. Only the LIVE side needs the
// roll, because only cash needs allocating.
//
// Nothing here writes.
import {
  getPropertyMonthlyRoll, listTenantSharesByProperties, listOtherIncomeByProperties,
} from './api';
import { billedRowsFromRoll } from './incomeExpense';
import { billedComponents } from './reconciliation';
import { summarizeOtherIncome } from './otherIncome';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/** One group of `billedRowsFromRoll`, collapsed to its annual figure. */
const groupTotal = (rows = []) => round2((rows || []).reduce((s, r) => s + num(r.total), 0));

/**
 * Both readings of the bill for every property, keyed by id.
 *
 * `confirmed` is the owner's keyed-decision store (`alert_states`, filtered to dismissed) —
 * the same cached `['alertStates']` read the Ledger and the month panel share, so answering a
 * surplus there repaints this without a second fetch. Null means "nothing confirmed", which
 * holds money OUT: a surplus counted because a read failed is income asserted on no authority.
 *
 * Returns per property:
 *   camTaxProjected  the CAM, tax and roof this year's leases bill at estimate
 *   rentLive         base rent actually collected
 *   camTaxLive       CAM, tax and roof actually collected
 *   chargesLive      fees and credits collected; `chargesProjected` is what was posted
 *   otherLive        income that rides no invoice — parking, storage, a write-in category
 *   unapplied        arrived beyond what a month billed, still waiting on an answer
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
      // ⚠ AND WITHOUT `includeScheduled`. Cash is apportioned across what the tenant was
      // actually BILLED; a rent step nobody has been charged for would move real money onto a
      // row it never touched, and would hide a genuine over-payment by raising the month's
      // owed above it.
      const roll = await getPropertyMonthlyRoll(id, year);
      const live = billedRowsFromRoll(roll, { collected: true, year, confirmed });
      // The same roll read a second time, as POSTED rather than as paid. Free — both passes
      // are pure over rows already in hand — and it is the only source for the fees and
      // credits sitting on this year's bills, which belong to the projected Total exactly as
      // they belong to the live one.
      const posted = billedRowsFromRoll(roll);
      return [id, {
        rentLive: groupTotal(live.rent),
        // Roof rides with CAM & tax: it is a recoverable billed the same way, and a fourth
        // column for a figure that is $0 on most portfolios would cost the other three their
        // width. The band's foot says so.
        camTaxLive: round2(groupTotal(live.camTax) + groupTotal(live.roof)),
        chargesLive: round2(groupTotal(live.charges) + groupTotal(live.carried)),
        chargesProjected: round2(groupTotal(posted.charges) + groupTotal(posted.carried)),
        unapplied: round2(live.unapplied),
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
