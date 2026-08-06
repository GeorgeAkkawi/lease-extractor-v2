// Slice 7a — the package you hand your accountant.
//
// An ENTITY files a return, not a building, so this is scoped to a corporation and its
// properties. That is also the shape of the form itself: Form 8825 puts one column per
// property on a single sheet with a total column, and Schedule E does the same. So the
// summary here is literally that layout — categories down, properties across.
//
// ⚠ THE ARITHMETIC RULE THAT DECIDES THE WHOLE FILE: THE RETURN IS GROSS ON BOTH SIDES.
// A tenant's CAM and tax reimbursement is rental INCOME, and the expense it reimburses is
// deducted in FULL. Netting them — reporting only what the landlord carried — understates
// income and expenses by the same figure and is not permitted on either form. Slice 3's
// recoverability table nets on purpose, because "what did this cost me" is the question a
// landlord asks. This file must not, because it answers a different question. The
// recovered column still rides along, as CONTEXT beside the deductible figure, never
// subtracted from it.
//
// ⚠ AND A COST YOU DELIBERATELY DIDN'T BILL IS STILL DEDUCTIBLE. `syncCamTotal` sums only
// `billable !== false`, so an absorbed cost never reaches `cam_total`, therefore never
// reaches `total_expenses`, therefore never reaches NOI — the gap round 7 named. It is an
// ordinary expense of the property all the same, so it IS on the return here. That makes
// this package's expense total legitimately HIGHER than the app's, which is why the
// tie-out reconciles the two rather than hoping nobody notices.
//
// Nothing here writes. A wrong category makes a wrong report and can never make a wrong
// invoice.

import {
  getCorporation, listProperties, getExpenseRecord, getPropertyTotals,
  listCamLineItems, listTaxLineItems, listRoofLineItems, listExpenseBuckets,
  getTenantShares, listFixedAssets, listEntityLedger, listOtherIncome,
  listInvoicesForProperty, listPayments, listUnplacedLines, listLeases,
} from './api';
import { EXPENSE_CATEGORIES, categoryLabel } from './expenseCategories';
import { recoverabilityRows, recoveryFractions } from './recoverability';
import { summarizeAssets } from './depreciation';
import { summarizeEntityLedger, absorbedFromItems, partyBreakdown } from './entityLedger';
import { summarizeOtherIncome } from './otherIncome';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/**
 * Where each of Amlak's categories lands on each form, in the form's OWN wording.
 *
 * This mapping is the deliverable, not decoration. The registry is deliberately the
 * UNION of the two forms (expenseCategories.js), so three categories exist on one form
 * and not the other — and naming where a figure collapses into "Other" is exactly what
 * stops a CPA hunting for a line that isn't there:
 *
 *   • Management fees — Schedule E has a line; Form 8825 does not.
 *   • Supplies        — Schedule E has a line; Form 8825 does not.
 *   • Wages           — Form 8825 has a line; Schedule E does not.
 *
 * Line NUMBERS move between revisions; the LABELS are stable, which is why the label is
 * what the sheet leads with and the number is offered with the revision stated beside it.
 */
export const FORM_LINES = {
  advertising:  { f8825: { line: 3,  label: 'Advertising' },                        schedE: { line: 5,  label: 'Advertising' } },
  auto_travel:  { f8825: { line: 4,  label: 'Auto and travel' },                    schedE: { line: 6,  label: 'Auto and travel' } },
  cleaning:     { f8825: { line: 5,  label: 'Cleaning and maintenance' },           schedE: { line: 7,  label: 'Cleaning and maintenance' } },
  commissions:  { f8825: { line: 6,  label: 'Commissions' },                        schedE: { line: 8,  label: 'Commissions' } },
  insurance:    { f8825: { line: 7,  label: 'Insurance' },                          schedE: { line: 9,  label: 'Insurance' } },
  legal:        { f8825: { line: 8,  label: 'Legal and other professional fees' },  schedE: { line: 10, label: 'Legal and other professional fees' } },
  management:   { f8825: null,                                                      schedE: { line: 11, label: 'Management fees' } },
  interest:     { f8825: { line: 9,  label: 'Interest' },                           schedE: { line: 12, label: 'Mortgage interest paid to banks, etc.' } },
  repairs:      { f8825: { line: 10, label: 'Repairs' },                            schedE: { line: 14, label: 'Repairs' } },
  supplies:     { f8825: null,                                                      schedE: { line: 15, label: 'Supplies' } },
  taxes:        { f8825: { line: 11, label: 'Taxes' },                              schedE: { line: 16, label: 'Taxes' } },
  utilities:    { f8825: { line: 12, label: 'Utilities' },                          schedE: { line: 17, label: 'Utilities' } },
  wages:        { f8825: { line: 13, label: 'Wages and salaries' },                 schedE: null },
  depreciation: { f8825: { line: 14, label: 'Depreciation' },                       schedE: { line: 18, label: 'Depreciation expense or depletion' } },
  other:        { f8825: { line: 15, label: 'Other' },                              schedE: { line: 19, label: 'Other' } },
};

export const FORM_REVISION_NOTE =
  'Line numbers follow the 2025 revisions of Form 8825 and Schedule E. The labels are what matter — confirm the numbering against the year you are filing.';

/**
 * The line a category files on, for one form. A category with no line of its own on that
 * form reports the "Other" line it rolls into and says so (`viaOther`), rather than
 * silently vanishing or silently pretending it has its own line.
 *
 * An unknown key — a category added by a later round and read by an older bundle —
 * returns null rather than being guessed onto a line. Same refusal `treatmentInfo`,
 * `assetKindInfo` and `entityKindInfo` make.
 */
export function formLine(key, form = 'f8825') {
  const entry = FORM_LINES[key];
  if (!entry) return null;
  const own = entry[form];
  if (own) return { ...own, viaOther: false };
  const other = FORM_LINES.other[form];
  return other ? { ...other, viaOther: true } : null;
}

export const RETURN_BASES = [
  {
    key: 'accrual',
    label: 'Accrual',
    hint: 'The year an expense belongs to and the rent billed for it — what every screen in Amlak already shows.',
  },
  {
    key: 'cash',
    label: 'Cash',
    hint: 'Only money that actually moved in the year: rent received, and expenses carrying a payment date.',
  },
];

const isInYear = (iso, year) => typeof iso === 'string' && iso.slice(0, 4) === String(year);

/**
 * Split a year's expense lines by what a CASH basis can actually place.
 *
 * ⚠ An undated line is NEVER treated as though it were paid in the year, and never
 * silently dropped either. It is counted and reported (`undatedTotal`), because
 * `paid_date` is nullable and deliberately not backfilled — stamping Dec 31 on a
 * hand-typed figure is a lie that looks like a real date forever.
 *
 * An un-itemized kind — a flat total nobody split into instalments — carries no date at
 * all, so on a cash basis it is undated by definition. The kind totals handed back are
 * summed from the KEPT lines, which is what stops recoverabilityRows resurrecting that
 * flat figure as a synthetic row inside a basis that cannot place it.
 */
export function splitByBasis({ items = [], expense = {}, year, basis = 'accrual' } = {}) {
  const flatUndated = [];
  if (basis !== 'cash') {
    return { kept: items, keptExpense: expense, undated: [], undatedTotal: 0, flatUndated };
  }
  const kept = [];
  const undated = [];
  for (const it of items) (isInYear(it?.paid_date, year) ? kept : undated).push(it);

  const sumKind = (k) => kept.reduce((s, it) => ((it.kind || 'cam') === k ? s + num(it.amount) : s), 0);
  const keptExpense = { taxes_total: sumKind('tax'), cam_total: sumKind('cam'), roof_total: sumKind('roof') };

  // A kind with a total and no lines of its own is a flat hand-typed figure. It has no
  // day, so it cannot be placed — say so with its own name rather than dropping it.
  const FLAT = { tax: ['Property taxes', 'taxes_total'], cam: ['CAM', 'cam_total'], roof: ['Roof', 'roof_total'] };
  for (const [kind, [label, field]] of Object.entries(FLAT)) {
    const total = num(expense[field]);
    if (total > 0 && !items.some((it) => (it.kind || 'cam') === kind)) {
      flatUndated.push({ kind, label, amount: total });
    }
  }

  const undatedTotal = round2(
    undated.reduce((s, it) => s + num(it.amount), 0) + flatUndated.reduce((s, f) => s + f.amount, 0)
  );
  return { kept, keptExpense, undated, undatedTotal, flatUndated };
}

/**
 * One property's column of the return. Pure — no I/O — so it is unit-testable with
 * fixtures, exactly as `shapeTenantReport` is.
 */
export function shapePropertyReturn({
  property = {}, expense = {}, items = [], shares = [], buckets = [],
  assets = [], otherIncome = [], invoices = [], payments = [],
  totals = null, year, basis = 'accrual',
} = {}) {
  const y = Number(year);
  const cash = basis === 'cash';

  // ── Income ────────────────────────────────────────────────────────────────
  // Billed: every live invoice raised FOR this year — the annual rent plus any
  // reconciliation true-up. Received: every payment banked DURING this year, whatever
  // year's invoice it settles, which is what a cash basis means.
  const live = (invoices || []).filter((i) => i && i.status !== 'void');
  const billed = round2(live.filter((i) => Number(i.year) === y).reduce((s, i) => s + num(i.total_amount), 0));

  const invYear = new Map(live.map((i) => [i.id, Number(i.year)]));
  let received = 0;
  let receivedPriorYear = 0;
  for (const p of payments || []) {
    if (!isInYear(p?.paid_date, y)) continue;
    const amt = num(p.amount);
    received = round2(received + amt);
    // ⚠ THE CAM STRADDLE, stated rather than picked. A 2026 shortfall is billed in 2026
    // and collected in 2027; on a cash basis that money is 2027 income. Reporting the
    // figure is worth more than any automatic answer.
    const iy = invYear.get(p.invoice_id);
    if (iy != null && iy < y) receivedPriorYear = round2(receivedPriorYear + amt);
  }

  const oi = (otherIncome || []).filter((r) => !cash || isInYear(r?.txn_date, y));
  const oiUndated = cash ? (otherIncome || []).filter((r) => !isInYear(r?.txn_date, y)) : [];
  const otherIncomeTotal = round2(summarizeOtherIncome(oi).total);
  const otherIncomeUndated = round2(oiUndated.reduce((s, r) => s + num(r.amount), 0));

  const rent = cash ? received : billed;
  const income = {
    billed,
    received,
    receivedPriorYear,
    otherIncome: otherIncomeTotal,
    otherIncomeUndated,
    rent,
    total: round2(rent + otherIncomeTotal),
  };

  // ── Expenses by category ──────────────────────────────────────────────────
  const split = splitByBasis({ items, expense, year: y, basis });
  // The recovery rate is a property-level truth about the whole year; a cash filter must
  // not distort it (see recoverabilityRows' `fractions` note).
  const fractions = recoveryFractions({ shares, expense });
  const { rows, totals: catTotals } = recoverabilityRows({
    items: split.kept, shares, expense: split.keptExpense, buckets, fractions,
  });

  const uncategorized = rows.find((r) => r.key === null) || null;
  const categories = rows.filter((r) => r.key !== null);

  // ── Depreciation ──────────────────────────────────────────────────────────
  // Non-cash and unaffected by the basis — it is the one deduction that never crossed
  // the account, which is exactly why "what actually stayed" leaves it out and a return
  // must not.
  const dep = summarizeAssets(assets, y);

  const spent = round2(categories.reduce((s, r) => s + r.spent, 0) + (uncategorized?.spent || 0));
  const deductible = round2(spent + dep.thisYear);
  const absorbed = absorbedFromItems(split.kept);

  // ── The tie-out against the app's own figures ─────────────────────────────
  const appExpenses = round2(num(expense.taxes_total) + num(expense.cam_total) + num(expense.roof_total));
  const appNoi = totals?.noi != null ? round2(num(totals.noi)) : null;

  return {
    property_id: property.id || null,
    name: property.name || 'Unnamed property',
    address: property.address || '',
    year: y,
    basis,
    income,
    categories,
    uncategorized,
    recovered: catTotals.recovered,
    depreciation: { amount: dep.thisYear, count: dep.count, blocked: dep.blocked, rows: dep.rows },
    spent,
    deductible,
    absorbed,
    netIncome: round2(income.total - deductible),
    undated: { total: split.undatedTotal, lines: split.undated, flat: split.flatUndated },
    lines: split.kept,
    appExpenses,
    appNoi,
  };
}

/**
 * The consolidated summary: every category as a row, every property as a column.
 *
 * ⚠ Uncategorized is its OWN row and is never folded into the "Other" category. Those
 * are different claims — one is a decision to file something as Other, the other is
 * nobody having decided — and collapsing them is precisely what Slice 2 exists to
 * prevent. It also renders the whole package untrustworthy if it happens silently.
 */
export function consolidate(properties = []) {
  const keys = [];
  for (const cat of EXPENSE_CATEGORIES) {
    if (properties.some((p) => p.categories.some((c) => c.key === cat.key)) || cat.key === 'depreciation') {
      keys.push(cat.key);
    }
  }

  const cell = (p, key) => {
    if (key === 'depreciation') return p.depreciation.amount;
    return p.categories.find((c) => c.key === key)?.spent || 0;
  };

  const rows = keys.map((key) => {
    const byProperty = properties.map((p) => round2(cell(p, key)));
    return {
      key,
      label: categoryLabel(key),
      byProperty,
      total: round2(byProperty.reduce((s, v) => s + v, 0)),
      f8825: formLine(key, 'f8825'),
      schedE: formLine(key, 'schedE'),
    };
  }).filter((r) => Math.abs(r.total) > 0.005);

  const uncategorized = properties.some((p) => p.uncategorized)
    ? {
        key: null,
        label: 'Not categorized',
        byProperty: properties.map((p) => round2(p.uncategorized?.spent || 0)),
        total: round2(properties.reduce((s, p) => s + (p.uncategorized?.spent || 0), 0)),
        buckets: [...new Set(properties.flatMap((p) => p.uncategorized?.buckets || []))].sort((a, b) => a.localeCompare(b)),
      }
    : null;

  const sumOf = (pick) => round2(properties.reduce((s, p) => s + num(pick(p)), 0));
  // Every total is summed from the ROWS SHOWN, never derived a second way, so the sheet
  // can never disagree with its own arithmetic.
  const expenseTotal = round2(rows.reduce((s, r) => s + r.total, 0) + (uncategorized?.total || 0));

  return {
    rows,
    uncategorized,
    income: {
      rent: sumOf((p) => p.income.rent),
      otherIncome: sumOf((p) => p.income.otherIncome),
      total: sumOf((p) => p.income.total),
      billed: sumOf((p) => p.income.billed),
      received: sumOf((p) => p.income.received),
      receivedPriorYear: sumOf((p) => p.income.receivedPriorYear),
    },
    expenseTotal,
    byPropertyExpense: properties.map((p) => round2(p.deductible)),
    recovered: sumOf((p) => p.recovered),
    absorbed: sumOf((p) => p.absorbed.total),
    undated: sumOf((p) => p.undated.total),
    netIncome: round2(sumOf((p) => p.income.total) - expenseTotal),
  };
}

/**
 * What is deliberately NOT on this return, with the reason.
 *
 * ⚠ THIS IS THE SHEET THAT MAKES THE REST TRUSTWORTHY — round 6's rule ("a dollar is
 * either recorded somewhere or explicitly excluded WITH A REASON") and round 11's
 * refused-charges list, applied to a tax package. Without it a CPA cannot tell a careful
 * package from one that quietly dropped every distribution.
 *
 * Each of these is money that really moved and really must not be on Schedule E or Form
 * 8825. Getting any of them wrong is expensive in a specific direction: a draw filed as
 * an expense understates income by exactly the amount the CPA taxes.
 */
export function excludedFromReturn({ entity = {}, deposits = 0, unplaced = { count: 0, total: 0 } } = {}) {
  const groups = [
    {
      key: 'draws',
      label: 'Owner draws',
      amount: round2(entity.draws || 0),
      why: 'A distribution reduces equity. It is not an expense and files on no line of either form — your accountant needs it for the capital account, not the P&L.',
      // WHO took it (0098). A capital account is PER MEMBER, so "Owner draws: $100,000"
      // is not an answer to the question this line exists to answer — three cheques to
      // three people is three capital accounts. Unattributed rows ride along under their
      // own name so these always sum to `amount` (see partyBreakdown).
      parties: partyBreakdown(entity, 'draw'),
    },
    {
      key: 'contributions',
      label: 'Owner contributions',
      amount: round2(entity.contributions || 0),
      why: 'Money you put in is equity, not rental income.',
      parties: partyBreakdown(entity, 'contribution'),
    },
    {
      key: 'deposits',
      label: 'Security deposits held',
      amount: round2(deposits || 0),
      why: 'The tenant’s money, held. A liability until it is returned or applied — income only in the year it is applied.',
    },
    {
      key: 'unplaced',
      label: 'Bank lines not yet placed',
      amount: round2(unplaced.total || 0),
      count: unplaced.count || 0,
      why: 'Read from a statement and not yet given a home. Nothing is assumed about them — place them and re-export.',
    },
  ].filter((g) => Math.abs(g.amount) > 0.005 || (g.count || 0) > 0);

  return { groups, total: round2(groups.reduce((s, g) => s + g.amount, 0)) };
}

/**
 * Fetch everything the package needs for a corporation + year and shape one entry per
 * property. Returns the whole workbook's data, ready to format.
 */
export async function buildCpaPackage({ corporationId, year, basis = 'accrual' }) {
  const y = Number(year);
  const [corporation, properties, buckets, entityRows] = await Promise.all([
    getCorporation(corporationId),
    listProperties(corporationId),
    listExpenseBuckets().catch(() => []),
    listEntityLedger({ corporationId, year: y }).catch(() => []),
  ]);

  const shaped = await Promise.all((properties || []).map(async (property) => {
    const [expense, totals, cam, tax, roof, shares, assets, otherIncome, invoices] = await Promise.all([
      getExpenseRecord(property.id, y).catch(() => ({})),
      getPropertyTotals(property.id, y).catch(() => null),
      listCamLineItems(property.id, y).catch(() => []),
      listTaxLineItems(property.id, y).catch(() => []),
      listRoofLineItems(property.id, y).catch(() => []),
      getTenantShares(property.id, y).catch(() => []),
      listFixedAssets(property.id).catch(() => []),
      listOtherIncome(property.id, y).catch(() => []),
      listInvoicesForProperty(property.id).catch(() => []),
    ]);
    const live = (invoices || []).filter((i) => i && i.status !== 'void');
    const payments = (await Promise.all(live.map((i) => listPayments(i.id).catch(() => [])))).flat();

    return shapePropertyReturn({
      property, expense: expense || {}, items: [...tax, ...cam, ...roof], shares, buckets,
      assets, otherIncome, invoices: live, payments, totals, year: y, basis,
    });
  }));

  // Deposits held are a lease TERM (round 8), not a transaction — so they are read from
  // the leases, exactly as the lease page states them.
  const leaseLists = await Promise.all((properties || []).map((p) => listLeases(p.id).catch(() => [])));
  const deposits = round2(leaseLists.flat().reduce((s, l) => s + num(l?.security_deposit), 0));

  const unplacedRows = (await Promise.all(
    (properties || []).map((p) => listUnplacedLines(p.id).catch(() => []))
  )).flat();
  const unplaced = {
    count: unplacedRows.length,
    total: round2(unplacedRows.reduce((s, r) => s + Math.abs(num(r.amount)), 0)),
  };

  const entity = summarizeEntityLedger(entityRows);
  return {
    corporation: corporation || {},
    year: y,
    basis,
    properties: shaped,
    summary: consolidate(shaped),
    entity,
    excluded: excludedFromReturn({ entity, deposits, unplaced }),
    deposits,
    unplaced,
  };
}
