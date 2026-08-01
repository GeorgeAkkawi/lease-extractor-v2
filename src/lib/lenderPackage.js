// Slice 7c — the package you hand a lender.
//
// A lender asks three questions in order: what does this property earn, what does it
// cost to run, and can it cover the debt. Amlak can answer the first two better than
// any accounting package, because it holds the leases. It cannot answer the third at
// all, and this module is built around that admission.
//
// ⚠ THE ARITHMETIC CORRECTION THIS ROUND TURNS ON, AND IT IS A REAL DEFECT, NOT A
// PRESENTATION CHOICE. `v_property_totals.noi` is `Σ effective_rent − (taxes + CAM +
// roof)` — base rent alone on the income side, the WHOLE expense on the other. So an
// expense the tenants reimbursed is subtracted as though the landlord ate it, and the
// reimbursement is counted nowhere. It is neither the gross view (rent + reimbursements
// − full expense) nor the net view (rent − unrecovered expense) — and those two are the
// SAME number, which is what proves the third one wrong. On live Pershing FY2026 the
// omission is $141,531.57 against a reported NOI of $161,334.92 — a lender underwrites
// $302,866.49, so the figure on screen is a little over half of it.
//
// This round does NOT redefine the view — round 7 refused that (it would silently
// re-value every chart point, every closed-year snapshot and every Ask Amlak fact) and
// round 12 refused it again. So the package computes the underwritable NOI itself and
// the tie-out sheet reconciles it to the app's own, exactly as round 12's tie-out
// reconciles the return's expenses to the app's.
//
// ⚠ AND THE DENOMINATOR IS NOT AMLAK'S TO KNOW. DSCR is NOI ÷ debt service, and Slice 6
// (debt) is deferred until a client actually has a mortgage. Three wrong answers were
// available: drop DSCR (it is the number a lender opens with, and the forward version is
// the whole reason this package is worth more than a spreadsheet); derive debt service
// from something (there is nothing to derive it from); or store a figure and let Amlak
// pose as knowing the loan (a second source of truth for a loan Slice 6 will model
// properly). So debt service is TYPED AT EXPORT AND NOT STORED — one number off a
// mortgage statement — and with none entered the DSCR reads "—", never 0 and never ∞.
import {
  getCorporation, listProperties, getExpenseRecord, getPropertyTotals,
  listCamLineItems, listTaxLineItems, listRoofLineItems, listExpenseBuckets,
  getTenantShares, listOtherIncome, listInvoicesForProperty, listPayments,
  listLeases, listRenewalsByLeases, listUnplacedLines, localDateIso,
} from './api';
import { money } from './format';
import { recoverabilityRows } from './recoverability';
import { summarizeOtherIncome } from './otherIncome';
import { optionLapseReason } from './renewals';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// What a lender deducts whether or not the owner pays it, because they are underwriting
// the asset under a hypothetical new owner rather than reporting what happened. Stated
// as ranges, never applied silently — an unadjusted NOI is the OPTIMISTIC one, so a
// landlord who never sees these will be surprised by the lender's own number.
export const LENDER_ADJUSTMENTS = {
  mgmtPct: { low: 3, high: 5, label: 'Management fee', basis: '% of effective gross income' },
  reservePsf: { low: 0.15, high: 0.25, label: 'Replacement reserve', basis: '$ per square foot of building, per year' },
};

export const ADJUSTMENT_NOTE =
  'A lender deducts a management fee and a replacement reserve whether or not you pay them — they are underwriting the building under a new owner, not reporting your year. Typically ' +
  `${LENDER_ADJUSTMENTS.mgmtPct.low}–${LENDER_ADJUSTMENTS.mgmtPct.high}% of effective gross income and ` +
  `$${LENDER_ADJUSTMENTS.reservePsf.low.toFixed(2)}–$${LENDER_ADJUSTMENTS.reservePsf.high.toFixed(2)} per square foot. ` +
  'Leave them blank and this package reports your own NOI, which will be higher than the one the lender uses.';

export const PERIOD_NOTE =
  'A lender often asks for a trailing twelve months ending last month. This is the fiscal year by month, because that is what every figure in Amlak is keyed to. The month columns carry what actually arrived and what carries a payment date — nothing is spread evenly across twelve months to fill them.';

const isInYear = (iso, year) => typeof iso === 'string' && iso.slice(0, 4) === String(year);
const monthOf = (iso) => (typeof iso === 'string' && iso.length >= 7 ? Number(iso.slice(5, 7)) : 0);

/** Whole months from `fromIso` to `toIso`; negative once the date has passed. */
export function monthsBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const [ay, am, ad] = String(fromIso).slice(0, 10).split('-').map(Number);
  const [by, bm, bd] = String(toIso).slice(0, 10).split('-').map(Number);
  if (!ay || !by) return null;
  let m = (by - ay) * 12 + (bm - am);
  if (bd < ad) m -= 1;
  return m;
}

/**
 * One tenant's row on a lender's rent roll.
 *
 * ⚠ THE GROSS-LEASE TRAP, and it is live (Card Pop, Joliet). `v_tenant_shares` computes
 * a pro-rata CAM/tax share for EVERY lease including a gross one — deliberately, since
 * 0073 left those columns alone — but a gross tenant's reimbursement is carved OUT of
 * their flat rent rather than billed on top of it. Adding it to their contract rent
 * would count the same dollars twice. So it is reported as "already inside the rent"
 * and never added to income.
 */
function rentRollRow(share, { buildingSf, todayIso, options }) {
  const gross = share.lease_type === 'gross';
  const rent = round2(num(share.base_rent));
  const reimbursement = round2(num(share.cam_amount) + num(share.tax_amount) + num(share.roof_amt));
  const sf = num(share.square_footage);
  const end = share.lease_termination_date || null;
  const monthsLeft = end ? monthsBetween(todayIso, end) : null;
  const opts = options.filter((o) => o.lease_id === share.lease_id);
  const pending = opts.filter((o) => o.status === 'pending');
  const live = pending.filter((o) => !optionLapseReason(o, end, todayIso));
  const notice = live.map((o) => o.notice_by_date).filter(Boolean).sort()[0] || null;

  return {
    lease_id: share.lease_id,
    tenant: share.tenant_name || 'Unnamed tenant',
    suite: share.premises_address || '',
    sf,
    shareOfBuilding: buildingSf > 0 ? sf / buildingSf : null,
    start: share.lease_start || null,
    end,
    monthsLeft,
    holdover: end != null && String(end) < String(todayIso),
    rent,
    psf: sf > 0 ? round2(rent / sf) : null,
    gross,
    // Income counted for this tenant. For a gross lease the reimbursement is already in
    // `rent`, so it contributes 0 here and is carried separately for reporting.
    reimbursement: gross ? 0 : reimbursement,
    reimbursementInsideRent: gross ? reimbursement : 0,
    total: round2(rent + (gross ? 0 : reimbursement)),
    optionsPending: live.length,
    optionsLapsed: pending.length - live.length,
    noticeBy: notice,
  };
}

/**
 * One property, underwritten. Pure — no I/O — so the arithmetic is unit-testable with
 * fixtures, exactly as `shapePropertyReturn` is.
 */
export function underwriteProperty({
  property = {}, totals = null, expense = {}, items = [], shares = [], buckets = [],
  otherIncome = [], invoices = [], payments = [], options = [], year, todayIso,
} = {}) {
  const y = Number(year);
  const buildingSf = num(totals?.building_sf) || shares.reduce((s, r) => s + num(r.square_footage), 0);

  const rows = shares.map((s) => rentRollRow(s, { buildingSf, todayIso, options }))
    .sort((a, b) => b.rent - a.rent || a.tenant.localeCompare(b.tenant));

  // ── Income ────────────────────────────────────────────────────────────────
  // IN-PLACE CONTRACT RENT, not invoiced rent. A lender underwrites what the leases
  // oblige, and that figure cannot be inflated by a stale CAM estimate or zeroed by an
  // invoice nobody raised. It is also what makes the rent roll and the operating
  // statement tie: the rent roll sums to this line exactly.
  const inPlaceRent = round2(rows.reduce((s, r) => s + r.rent, 0));
  const reimbursements = round2(rows.reduce((s, r) => s + r.reimbursement, 0));
  const grossInsideRent = round2(rows.reduce((s, r) => s + r.reimbursementInsideRent, 0));
  const other = round2(summarizeOtherIncome(otherIncome).total);
  const egi = round2(inPlaceRent + reimbursements + other);

  // Billed is a CROSS-CHECK, never the income line — it is what the invoices actually
  // raised (base plus the CAM/tax ESTIMATE), which is a different question and settles
  // against the actual share at reconciliation.
  const live = (invoices || []).filter((i) => i && i.status !== 'void' && Number(i.year) === y);
  const billed = round2(live.reduce((s, i) => s + num(i.total_amount), 0));

  // ── Operating expenses ────────────────────────────────────────────────────
  // Straight from the recoverability table, so the categories, the figures and the
  // recovered column can never disagree with what the Financials page already shows.
  const { rows: catRows, totals: catTotals } = recoverabilityRows({ items, shares, expense, buckets });
  const uncategorized = catRows.find((r) => r.key === null) || null;
  const categories = catRows.filter((r) => r.key !== null);
  const opex = round2(catTotals.spent);

  const noi = round2(egi - opex);
  const appNoi = totals?.noi != null ? round2(num(totals.noi)) : null;

  // ── What can honestly be placed in a month ────────────────────────────────
  const collectedByMonth = Array(12).fill(0);
  let collectedUndated = 0;
  for (const p of payments || []) {
    const amt = num(p.amount);
    if (!isInYear(p?.paid_date, y)) { collectedUndated = round2(collectedUndated + amt); continue; }
    const m = monthOf(p.paid_date);
    if (m >= 1 && m <= 12) collectedByMonth[m - 1] = round2(collectedByMonth[m - 1] + amt);
  }
  const expenseByMonth = Array(12).fill(0);
  let expenseUndated = 0;
  for (const it of items || []) {
    const amt = num(it.amount);
    // ⚠ An undated line is counted and named, NEVER spread across twelve months. Slice 1
    // left `paid_date` nullable and deliberately un-backfilled; inventing a month here
    // would be the same lie one column over.
    if (!isInYear(it?.paid_date, y)) { expenseUndated = round2(expenseUndated + amt); continue; }
    const m = monthOf(it.paid_date);
    if (m >= 1 && m <= 12) expenseByMonth[m - 1] = round2(expenseByMonth[m - 1] + amt);
  }
  // A kind with a total and no lines of its own is a flat hand-typed figure with no day
  // at all — undated by definition, exactly as the cash basis treats it (round 12).
  const flatUndated = round2(
    ['taxes_total', 'cam_total', 'roof_total'].reduce((s, field, i) => {
      const kind = ['tax', 'cam', 'roof'][i];
      const total = num(expense[field]);
      return total > 0 && !items.some((it) => (it.kind || 'cam') === kind) ? s + total : s;
    }, 0)
  );

  const leasedSf = round2(rows.reduce((s, r) => s + r.sf, 0));
  const rentWithTerm = rows.filter((r) => r.monthsLeft != null);
  const rentedTotal = round2(rentWithTerm.reduce((s, r) => s + r.rent, 0));
  // Weighted average lease term, in years, weighted by rent. A tenant already holding
  // over contributes 0 rather than a negative — their term is up, not owed backwards.
  const walt = rentedTotal > 0
    ? round2(rentWithTerm.reduce((s, r) => s + r.rent * Math.max(0, r.monthsLeft) / 12, 0) / rentedTotal)
    : null;

  return {
    property_id: property.id || null,
    name: property.name || 'Unnamed property',
    address: property.address || '',
    year: y,
    buildingSf,
    leasedSf,
    vacantSf: Math.max(0, round2(buildingSf - leasedSf)),
    occupancy: buildingSf > 0 ? leasedSf / buildingSf : null,
    income: { inPlaceRent, reimbursements, grossInsideRent, otherIncome: other, egi, billed },
    categories,
    uncategorized,
    recovered: catTotals.recovered,
    opex,
    noi,
    appNoi,
    noiGap: appNoi == null ? null : round2(noi - appNoi),
    expensesEntered: opex > 0.005,
    collectedByMonth,
    collectedUndated,
    collectedTotal: round2(collectedByMonth.reduce((s, v) => s + v, 0)),
    expenseByMonth,
    expenseUndated: round2(expenseUndated + flatUndated),
    datedLines: (items || []).filter((it) => isInYear(it?.paid_date, y)).length,
    lineCount: (items || []).length,
    rentRoll: rows,
    walt,
  };
}

/**
 * When the rent rolls off — and, because Amlak holds the leases, what leaving actually
 * costs.
 *
 * ⚠ THE ARITHMETIC ONLY AMLAK CAN DO. A departing tenant takes their rent AND their
 * expense reimbursement, and the expense itself stays — their share becomes vacancy the
 * landlord eats. So the NOI at risk is rent PLUS reimbursement, never rent alone. Using
 * rent alone understates the exposure by exactly the recovered share, which on a
 * net-lease building is a third of it.
 */
export function rolloverSchedule(rows = [], { todayIso, years = 5 } = {}) {
  const thisYear = Number(String(todayIso).slice(0, 4));
  const buckets = [];
  const push = (key, label, note) => {
    const b = { key, label, note, leases: [], rent: 0, reimbursement: 0, atRisk: 0, count: 0 };
    buckets.push(b);
    return b;
  };
  const holding = push('holdover', 'Holding over', 'Term already ended — this rent is exposed today.');
  const byYear = new Map();
  for (let i = 0; i < years; i += 1) {
    byYear.set(thisYear + i, push(String(thisYear + i), String(thisYear + i), null));
  }
  const beyond = push('beyond', `After ${thisYear + years - 1}`, null);

  for (const r of rows) {
    // A lease with no end date on file is not exposure — it is a gap in the record, and
    // dating it would invent a rollover that may not exist. Counted, never bucketed.
    if (!r.end) continue;
    const bucket = r.holdover ? holding : (byYear.get(Number(String(r.end).slice(0, 4))) || beyond);
    bucket.leases.push(r);
    bucket.rent = round2(bucket.rent + r.rent);
    bucket.reimbursement = round2(bucket.reimbursement + r.reimbursement);
    bucket.atRisk = round2(bucket.atRisk + r.total);
    bucket.count += 1;
  }

  const undated = rows.filter((r) => !r.end);
  const totalRent = round2(rows.reduce((s, r) => s + r.rent, 0));
  return {
    buckets: buckets.filter((b) => b.count > 0),
    undated,
    totalRent,
    // Every bucket's share of the rent roll, summed from the buckets shown so the sheet
    // can never disagree with its own arithmetic.
    shareOf: (b) => (totalRent > 0 ? b.rent / totalRent : null),
  };
}

/** The rent + reimbursement exposed within `months` — holdovers included, they are exposed now. */
export function atRiskWithin(rows = [], { todayIso, months = 12 } = {}) {
  const at = rows.filter((r) => r.end && (r.holdover || (monthsBetween(todayIso, r.end) ?? 999) <= months));
  return {
    months,
    leases: at.sort((a, b) => String(a.end).localeCompare(String(b.end))),
    rent: round2(at.reduce((s, r) => s + r.rent, 0)),
    total: round2(at.reduce((s, r) => s + r.total, 0)),
    // A tenant with a live unexercised option MAY stay. It is a mitigant, not a
    // certainty, so it is named beside the figure rather than discounted out of it.
    withOption: at.filter((r) => r.optionsPending > 0).length,
    nextNotice: at.map((r) => r.noticeBy).filter(Boolean).sort()[0] || null,
  };
}

const scenario = (egi, opex, mgmtPct, reserve) => {
  const mgmtFee = round2(num(egi) * (num(mgmtPct) / 100));
  return { egi: round2(egi), opex: round2(opex), mgmtFee, reserve: round2(reserve), noi: round2(num(egi) - num(opex) - mgmtFee - num(reserve)) };
};

/**
 * The coverage block — today's, and the one that matters.
 *
 * Every accounting package computes DSCR backwards: last year's NOI over last year's
 * debt service. Amlak knows every lease's expiry, every unexercised option and every
 * notice deadline, so it can also compute it FORWARD — which is the underwriting
 * conversation, not the accounting report.
 *
 * ⚠ `dscr` is null, never 0 and never Infinity, when no debt service was entered. A
 * ratio with an unknown denominator is not a small ratio; it is not a ratio. Same
 * refusal round 9 makes for a building whose land has never been valued.
 */
export function coverage({ egi = 0, opex = 0, atRisk = 0, buildingSf = 0, debtService = null, mgmtPct = null, reservePsf = null } = {}) {
  const reserve = round2(num(reservePsf) * num(buildingSf));
  const pct = num(mgmtPct);
  const now = scenario(egi, opex, pct, reserve);
  // On the downside the rent and its reimbursement go, the operating expense stays (you
  // still pay it — that is what makes vacancy expensive on a net-lease building), the
  // management fee falls with the income it is charged on, and the reserve does not
  // move because the building does not shrink.
  const down = scenario(round2(num(egi) - num(atRisk)), opex, pct, reserve);
  const ds = num(debtService);
  const ratio = (noi) => (ds > 0 ? Math.round((noi / ds) * 100) / 100 : null);

  return {
    debtService: ds > 0 ? round2(ds) : null,
    adjusted: pct > 0 || reserve > 0,
    now: { ...now, dscr: ratio(now.noi) },
    down: { ...down, dscr: ratio(down.noi), atRisk: round2(atRisk) },
    // How far NOI could fall before coverage breaks — the number a lender's covenant is
    // written against. Null without a debt service, for the same reason the ratio is.
    breakEvenNoi: ds > 0 ? round2(ds) : null,
    headroom: ds > 0 ? round2(now.noi - ds) : null,
  };
}

/**
 * What this package deliberately does NOT contain, with the reason.
 *
 * Round 6's rule — a dollar is either recorded somewhere or explicitly excluded WITH A
 * REASON — applied for the fourth time, now to an underwriting package. A lender who
 * cannot tell a careful export from one that quietly omitted the debt has to assume the
 * worst, and the omissions here are all structural rather than accidental.
 */
export function notInPackage({ properties = [], unplaced = { count: 0, total: 0 } } = {}) {
  const noExpenses = properties.filter((p) => !p.expensesEntered);
  const groups = [
    {
      key: 'debt',
      label: 'Your loans',
      why: 'Amlak does not hold your mortgages yet, so the debt schedule, the maturity ladder and the interest expense are not here. The debt service used for coverage is the figure you typed on the way out — it is not saved, and it is not read from any statement.',
      always: true,
    },
    {
      key: 'capex',
      label: 'Capital expenditure and tenant improvements',
      why: 'A capitalized cost is recorded as an asset, not an operating expense, so it is correctly outside NOI. A lender will ask for it separately — it is on the asset register.',
      always: true,
    },
    {
      key: 'noExpenses',
      label: 'Operating expenses on some properties',
      amount: null,
      count: noExpenses.length,
      names: noExpenses.map((p) => p.name),
      why: 'No expenses are entered for the year, so the NOI shown for these is the income with nothing taken out. That is not a real NOI and a lender will not accept it.',
    },
    {
      key: 'unplaced',
      label: 'Bank lines not yet placed',
      amount: round2(unplaced.total || 0),
      count: unplaced.count || 0,
      why: 'Read from a statement and not yet given a home. Nothing is assumed about them — place them and re-export.',
    },
  ];
  return groups.filter((g) => g.always || (g.count || 0) > 0 || Math.abs(num(g.amount)) > 0.005);
}

/** The pre-flight: everything worth answering before this leaves the building. */
export function lenderFlags(pkg, cov) {
  const flags = [];
  const props = pkg?.properties || [];
  const missing = props.filter((p) => !p.expensesEntered);
  if (missing.length) {
    flags.push({
      key: 'noExpenses',
      text: `No expenses are entered for ${pkg.year} on ${missing.length === props.length ? 'any property' : missing.map((p) => p.name).join(' · ')}, so the NOI reads as income with nothing taken out.`,
      fix: 'Enter the year’s taxes, CAM and roof on the Expense entry — a lender checks this first.',
    });
  }
  if (!cov?.debtService) {
    flags.push({
      key: 'noDebt',
      text: 'No annual debt service entered, so the coverage ratio is not computed — it is shown as “—”, never as a number.',
      fix: 'Type your total annual principal and interest above. It is used for this export only and is not saved.',
    });
  }
  if (cov && !cov.adjusted) {
    flags.push({
      key: 'noAdjust',
      text: 'No lender adjustments applied, so this reports YOUR NOI — the one a lender uses will be lower.',
      fix: ADJUSTMENT_NOTE,
    });
  }
  const uncategorized = props.reduce((s, p) => s + (p.uncategorized?.spent || 0), 0);
  if (uncategorized > 0.005) {
    flags.push({
      key: 'uncategorized',
      // money(), not round2() — every other figure in this flag list is currency, and a
      // bare "6000" on a lender-facing screen reads as a count rather than a dollar figure.
      text: `${money(uncategorized)} of expenses carry no category, so the operating statement shows them on their own line rather than filed as “Other”.`,
      fix: 'Set the category once per bucket on the Expense entry.',
    });
  }
  const dated = props.reduce((s, p) => s + p.datedLines, 0);
  const lines = props.reduce((s, p) => s + p.lineCount, 0);
  if (lines > 0 && dated === 0) {
    flags.push({
      key: 'undated',
      text: `None of your ${lines} expense lines carry a payment date, so the month-by-month expense columns are empty — the figures are not spread evenly to fill them.`,
      fix: 'Dates arrive automatically on every statement you import from here.',
    });
  }
  const holdovers = props.flatMap((p) => p.rentRoll.filter((r) => r.holdover));
  if (holdovers.length) {
    flags.push({
      key: 'holdover',
      text: `${holdovers.length === 1 ? holdovers[0].tenant + ' is' : holdovers.length + ' tenants are'} holding over past the end of the lease term — that rent is exposed today, not at some future date.`,
      fix: 'A lender reads a holdover as month-to-month income; extend or re-paper the lease if it is really renewed.',
    });
  }
  return flags;
}

/**
 * Fetch everything the package needs for a corporation + year and shape one entry per
 * property. Nothing here writes.
 */
export async function buildLenderPackage({ corporationId, year, todayIso = null }) {
  const y = Number(year);
  const today = todayIso || localDateIso();
  const [corporation, properties, buckets] = await Promise.all([
    getCorporation(corporationId),
    listProperties(corporationId),
    listExpenseBuckets().catch(() => []),
  ]);

  const shaped = await Promise.all((properties || []).map(async (property) => {
    const [expense, totals, cam, tax, roof, shares, otherIncome, invoices, leases] = await Promise.all([
      getExpenseRecord(property.id, y).catch(() => ({})),
      getPropertyTotals(property.id, y).catch(() => null),
      listCamLineItems(property.id, y).catch(() => []),
      listTaxLineItems(property.id, y).catch(() => []),
      listRoofLineItems(property.id, y).catch(() => []),
      getTenantShares(property.id, y).catch(() => []),
      listOtherIncome(property.id, y).catch(() => []),
      listInvoicesForProperty(property.id).catch(() => []),
      listLeases(property.id).catch(() => []),
    ]);
    const live = (invoices || []).filter((i) => i && i.status !== 'void');
    const payments = (await Promise.all(live.map((i) => listPayments(i.id).catch(() => [])))).flat();
    const options = await listRenewalsByLeases((leases || []).map((l) => l.id)).catch(() => []);

    return underwriteProperty({
      property, totals, expense: expense || {}, items: [...tax, ...cam, ...roof], shares, buckets,
      otherIncome, invoices: live, payments, options, year: y, todayIso: today,
    });
  }));

  const unplacedRows = (await Promise.all(
    (properties || []).map((p) => listUnplacedLines(p.id).catch(() => []))
  )).flat();
  const unplaced = {
    count: unplacedRows.length,
    total: round2(unplacedRows.reduce((s, r) => s + Math.abs(num(r.amount)), 0)),
  };

  const sum = (pick) => round2(shaped.reduce((s, p) => s + num(pick(p)), 0));
  const allRows = shaped.flatMap((p) => p.rentRoll);
  const buildingSf = sum((p) => p.buildingSf);
  const leasedSf = sum((p) => p.leasedSf);

  const portfolio = {
    buildingSf,
    leasedSf,
    vacantSf: Math.max(0, round2(buildingSf - leasedSf)),
    occupancy: buildingSf > 0 ? leasedSf / buildingSf : null,
    inPlaceRent: sum((p) => p.income.inPlaceRent),
    reimbursements: sum((p) => p.income.reimbursements),
    grossInsideRent: sum((p) => p.income.grossInsideRent),
    otherIncome: sum((p) => p.income.otherIncome),
    egi: sum((p) => p.income.egi),
    billed: sum((p) => p.income.billed),
    opex: sum((p) => p.opex),
    noi: sum((p) => p.noi),
    appNoi: shaped.some((p) => p.appNoi != null) ? sum((p) => p.appNoi || 0) : null,
    collectedTotal: sum((p) => p.collectedTotal),
    walt: (() => {
      const withTerm = allRows.filter((r) => r.monthsLeft != null);
      const rent = round2(withTerm.reduce((s, r) => s + r.rent, 0));
      return rent > 0 ? round2(withTerm.reduce((s, r) => s + r.rent * Math.max(0, r.monthsLeft) / 12, 0) / rent) : null;
    })(),
  };
  portfolio.noiGap = portfolio.appNoi == null ? null : round2(portfolio.noi - portfolio.appNoi);

  return {
    corporation: corporation || {},
    year: y,
    todayIso: today,
    properties: shaped,
    portfolio,
    rentRoll: allRows,
    rollover: rolloverSchedule(allRows, { todayIso: today }),
    atRisk: atRiskWithin(allRows, { todayIso: today, months: 12 }),
    unplaced,
    notIncluded: notInPackage({ properties: shaped, unplaced }),
  };
}
