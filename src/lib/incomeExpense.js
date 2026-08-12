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
// Nothing here writes. Every function is pure over rows it was handed, except the one
// loader at the bottom.
import {
  listProperties, listExpenseBuckets, listCamLineItems, listTaxLineItems,
  listRoofLineItems, getExpenseRecord, getTenantShares, getPropertyTotals, listOtherIncome,
  getPropertyMonthlyRoll,
} from './api';
import { recoverabilityRows, absorbedFromItems } from './recoverability';
import { summarizeOtherIncome } from './otherIncome';
import { componentizeSchedule } from './ledger';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const zero12 = () => Array(12).fill(0);
const add12 = (a, b) => a.map((n, i) => round2(n + b[i]));
const sub12 = (a, b) => a.map((n, i) => round2(n - b[i]));
const sum12 = (a) => round2(a.reduce((s, n) => s + n, 0));

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The rent each lease owes, month by month.
 *
 * ⚠ THE GROSS BRANCH IS LOAD-BEARING, not a nicety. On a NET lease the CAM/tax/roof
 * component of a month is the REIMBURSEMENT, which this workbook takes off the cost side —
 * adding it to rent as well would count the same dollars twice. On a GROSS lease (0073)
 * that component is carved OUT of a flat rent the tenant pays anyway, and
 * `v_property_totals.total_revenue` counts the whole flat figure — so leaving it out would
 * under-report the rent by exactly the carve. Same field, opposite meaning; `share.gross`
 * is what tells them apart.
 *
 * `adj` is deliberately excluded: a one-off credit or charge on the invoice is not rent,
 * and `effective_rent` — the figure this has to tie to — knows nothing about it.
 */
export function rentRowsFromRoll(roll = []) {
  return (roll || []).map((r) => {
    const comp = r?.schedule
      ? componentizeSchedule({
        schedule: r.schedule, factor: r.factor, camTaxAnnual: r.camTaxAnnual, roofAnnual: r.roofAnnual,
        camTaxByMonth: r.camTaxByMonth, roofByMonth: r.roofByMonth, adjustments: r.adjustments,
      })
      : null;
    const byMonth = Array.from({ length: 12 }, (_, i) => {
      const c = comp?.[i + 1];
      if (!c) return 0;
      return round2(num(c.base) + (r.gross ? num(c.camTax) + num(c.roof) : 0));
    });
    return {
      lease_id: r.lease_id,
      label: String(r.tenant_name || '').trim() || 'Tenant',
      gross: !!r.gross,
      byMonth,
      total: sum12(byMonth),
      undated: 0,   // a lease schedule always knows its months
    };
  }).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

/**
 * One property's year, shaped for the sheet. Pure — it takes the rows the loader read.
 *
 * `net` is the year's result: rent + other income − what the expenses actually cost you
 * after tenants paid their share. Owner money is carried BESIDE it, never inside it — a
 * distribution is not a cost of the building (see `isOwnerCategory`), and
 * `recoverabilityRows` has already split it out.
 */
export function shapeProperty({ property, year, totals, items, shares, expense, buckets, income, roll }) {
  const inc = summarizeOtherIncome(income, year);
  const rec = recoverabilityRows({ items, shares, expense: expense || {}, buckets, year });

  const rentRows = rentRowsFromRoll(roll);
  const rentByMonth = rentRows.reduce((acc, r) => add12(acc, r.byMonth), zero12());
  const rent = sum12(rentByMonth);

  // ⚠ THE TIE-OUT. Until 2026-08-12 this sheet quoted `total_revenue` — one annual figure
  // straight out of the view. Laying rent across months means deriving it from the lease
  // SCHEDULE instead, which is the JS half of a JS↔SQL twin (`effectiveRent` ↔
  // `effective_rent`, CLAUDE.md §3). The two are MEANT to agree; this is how we find out
  // if they ever stop, rather than shipping a workbook that quietly disagrees with the
  // Performance card on the same screen.
  const rentQuoted = round2(num(totals?.total_revenue));
  const rentDrift = round2(rent - rentQuoted);

  const inByMonth = add12(rentByMonth, inc.byMonth);
  const inUndated = round2(inc.undated);
  const outByMonth = rec.totals.byMonth;
  const outUndated = rec.totals.undated;

  const revenue = round2(rent + inc.total);
  // What the grid itself adds up to — money in less the GROSS expense. It is not the
  // headline: the reimbursement comes back below, because no month exists for it.
  const grossNet = round2(revenue - rec.totals.spent);
  const net = round2(revenue - rec.totals.net);

  return {
    id: property.id,
    name: property.name,
    address: property.address || null,
    rent,
    rentRows,
    rentByMonth,
    rentQuoted,
    rentDrift,
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
    //   net === noi + recovered + otherIncome − absorbed
    //
    // ⚠ `absorbed` IS THE TERM THAT IS EASY TO FORGET, and leaving it out is a real error
    // rather than a rounding one — this sheet shipped on 2026-08-12 claiming
    // `net === noi + recovered + otherIncome`, which is off by exactly the not-billed
    // costs (on the demo, $2,950). NOI is `total_revenue − total_expenses`, and
    // `total_expenses` comes from `cam_total`, which `syncCamTotal` builds from
    // `billable is not false` lines only. So a cost the landlord entered and chose to eat
    // is in this sheet's `spent` and in none of NOI. It is subtracted here for the same
    // reason "What actually stayed" subtracts it on screen.
    noi: num(totals?.noi),
    recovered: rec.totals.recovered,
    absorbed: absorbedFromItems(items, buckets).total,
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
      grossNet: round2(t.grossNet + p.grossNet),
      net: round2(t.net + p.net),
      distributions: round2(t.distributions + p.distributionsTotal),
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
      rent: 0, otherIncome: 0, revenue: 0, spent: 0, recovered: 0, netCost: 0, grossNet: 0, net: 0, distributions: 0,
      rentByMonth: zero12(), incomeByMonth: zero12(), inByMonth: zero12(), outByMonth: zero12(), netByMonth: zero12(),
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
  const undatedOut = round2(properties.reduce((s, p) => s + p.outUndated, 0));
  if (undatedOut > 0) {
    out.push(`${dollars(undatedOut)} of expenses carry no payment date and sit in the "No date" column rather than in a month. Dating those lines on the Financials page moves them into the grid.`);
  }
  const undatedIn = round2(properties.reduce((s, p) => s + p.inUndated, 0));
  if (undatedIn > 0) {
    out.push(`${dollars(undatedIn)} of other income carries no date and sits in the "No date" column.`);
  }

  // The rent tie-out. A difference is information, not an error — but it must be stated in
  // dollars rather than left for the reader to notice.
  const drifted = properties.filter((p) => Math.abs(p.rentDrift) > 1);
  for (const p of drifted) {
    out.push(`${p.name}: the rent laid out here totals ${dollars(p.rent)}, and the Revenue figure on the Financials page reads ${dollars(p.rentQuoted)} — a difference of ${dollars(Math.abs(p.rentDrift))}. The months come from each lease's own schedule; the page's figure comes from the database view.`);
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
export async function buildIncomeExpense(corporationId, year) {
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
        getPropertyMonthlyRoll(property.id, year),
      ]);
      return shapeProperty({
        property, year, totals, shares, expense, buckets, income, roll,
        items: [...(taxItems || []), ...(camItems || []), ...(roofItems || [])],
      });
    })
  );
  properties.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return {
    year,
    properties,
    totals: consolidate(properties),
    categories: consolidateCategories(properties),
    flags: flags(properties),
  };
}
