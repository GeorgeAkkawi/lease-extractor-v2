// Income and expenses — the one workbook a landlord hands someone.
//
// It replaces three (the tax package, the 1099 worksheet and the lender package,
// removed 2026-08-12) because all three answered a question George does not have:
// they shaped his figures for a form, a filing deadline or an underwriter. What he
// actually wants is what came in, what went out, and what is left.
//
// ⚠ EVERY FIGURE IS READ FROM WHAT THE FINANCIALS PAGE ALREADY RENDERS, through the
// same functions and the same query keys. That is the single design rule here, and it
// is why this file is short: `recoverabilityRows` IS the "What it cost you" table and
// `summarizeOtherIncome` IS the Other income panel, so the workbook cannot print a
// figure the screen disagrees with. A second implementation would drift, silently,
// because nothing compares them (CLAUDE.md §3).
//
// ⚠ THE ARITHMETIC RULE, and getting it wrong double-counts a year.
// `v_property_totals.total_revenue` is BASE RENT ONLY — `sum(effective_rent(...))`,
// migration 0049. It does NOT include what tenants reimbursed for CAM, taxes or the
// roof. So the reimbursement is netted off the COST side (spent − recovered = your net
// cost) rather than added to revenue. Adding it to revenue *and* subtracting the gross
// expense would report the same dollars twice.
//
// Nothing here writes. Every function is pure over rows it was handed, except the one
// loader at the bottom.
import {
  listProperties, listExpenseBuckets, listCamLineItems, listTaxLineItems,
  listRoofLineItems, getExpenseRecord, getTenantShares, getPropertyTotals, listOtherIncome,
} from './api';
import { recoverabilityRows } from './recoverability';
import { summarizeOtherIncome } from './otherIncome';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/**
 * One property's year, shaped for the sheet. Pure — it takes the rows the loader read.
 *
 * `net` is the year's result: rent + other income − what the expenses actually cost you
 * after tenants paid their share. Owner money is carried BESIDE it, never inside it — a
 * distribution is not a cost of the building (see `isOwnerCategory`), and
 * `recoverabilityRows` has already split it out.
 */
export function shapeProperty({ property, totals, items, shares, expense, buckets, income }) {
  const rent = num(totals?.total_revenue);
  const inc = summarizeOtherIncome(income);
  const rec = recoverabilityRows({ items, shares, expense: expense || {}, buckets });

  const revenue = round2(rent + inc.total);
  const net = round2(revenue - rec.totals.net);

  return {
    id: property.id,
    name: property.name,
    address: property.address || null,
    rent,
    incomeGroups: inc.groups,
    otherIncome: inc.total,
    revenue,
    expenseRows: rec.rows,
    expenseTotals: rec.totals,
    net,
    // Owner money out. Reported, never counted. (There is no inward counterpart: money
    // the landlord puts in files as a `transfer` and records no amount — see otherIncome.js.)
    distributions: rec.owner,
    distributionsTotal: rec.ownerTotal,
    // Quoted so the workbook and the Performance card on screen are reconcilable rather
    // than mysteriously different: NOI subtracts the GROSS expense from base rent and
    // knows nothing about recovery or other income, which is exactly the gap this sheet
    // closes. net === noi + recovered + otherIncome, by construction.
    noi: num(totals?.noi),
    recovered: rec.totals.recovered,
  };
}

/** The corporation's totals — summed from the ROUNDED property figures, so the Summary
 *  sheet ties to the per-property sheets rather than sitting a cent away from them. */
export function consolidate(properties = []) {
  return properties.reduce(
    (t, p) => ({
      rent: round2(t.rent + p.rent),
      otherIncome: round2(t.otherIncome + p.otherIncome),
      revenue: round2(t.revenue + p.revenue),
      spent: round2(t.spent + p.expenseTotals.spent),
      recovered: round2(t.recovered + p.expenseTotals.recovered),
      netCost: round2(t.netCost + p.expenseTotals.net),
      net: round2(t.net + p.net),
      distributions: round2(t.distributions + p.distributionsTotal),
    }),
    { rent: 0, otherIncome: 0, revenue: 0, spent: 0, recovered: 0, netCost: 0, net: 0, distributions: 0 }
  );
}

/**
 * What the workbook should say about itself before anyone reads a figure. Same job the
 * removed packages' pre-flight served: a report that cannot tell a careful export from
 * one that quietly omitted something forces the reader to assume the worst.
 */
export function flags(properties = []) {
  const out = [];
  const uncategorized = properties.filter((p) => p.expenseRows.some((r) => r.key == null));
  if (uncategorized.length) {
    const amt = uncategorized.reduce((s, p) => s + p.expenseRows.filter((r) => r.key == null).reduce((n, r) => n + r.spent, 0), 0);
    out.push(`${uncategorized.length} propert${uncategorized.length === 1 ? 'y has' : 'ies have'} expenses with no category — $${round2(amt).toLocaleString('en-US', { minimumFractionDigits: 2 })} is grouped as "Not categorized" rather than guessed at.`);
  }
  const noExpenses = properties.filter((p) => p.expenseTotals.spent <= 0);
  if (noExpenses.length) {
    out.push(`${noExpenses.length} propert${noExpenses.length === 1 ? 'y has' : 'ies have'} no expenses recorded for this year: ${noExpenses.map((p) => p.name).join(', ')}.`);
  }
  const anyFlat = properties.filter((p) => p.expenseRows.some((r) => r.anyFlat));
  if (anyFlat.length) {
    out.push(`${anyFlat.length} propert${anyFlat.length === 1 ? 'y carries' : 'ies carry'} an un-itemized total — those figures are a single number, not a list of payments.`);
  }
  return out;
}

/** Read a corporation's year and shape every property in it. The only impure function
 *  here; every query key matches the one the Financials page uses, so a landlord who
 *  just looked at the page downloads from cache. */
export async function buildIncomeExpense(corporationId, year) {
  const [props, buckets] = await Promise.all([listProperties(corporationId), listExpenseBuckets()]);
  const properties = await Promise.all(
    (props || []).map(async (property) => {
      const [totals, camItems, taxItems, roofItems, expense, shares, income] = await Promise.all([
        getPropertyTotals(property.id, year),
        listCamLineItems(property.id, year),
        listTaxLineItems(property.id, year),
        listRoofLineItems(property.id, year),
        getExpenseRecord(property.id, year),
        getTenantShares(property.id, year),
        listOtherIncome(property.id, year),
      ]);
      return shapeProperty({
        property, totals, shares, expense, buckets, income,
        items: [...(taxItems || []), ...(camItems || []), ...(roofItems || [])],
      });
    })
  );
  properties.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return { year, properties, totals: consolidate(properties), flags: flags(properties) };
}
