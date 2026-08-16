// Slice 3 — what an expense actually COST you.
//
// A net-lease landlord's most important figure is not what they spent. It is what they
// spent LESS what tenants paid back — and until now Amlak computed that for exactly one
// bucket. v_property_totals has carried roof_recovered / roof_unrecovered since 0005
// because the roof is the one expense with a per-lease responsibility flag; for CAM and
// taxes it LOOKS like recovered equals spent, and it doesn't. Vacancy, a share override,
// and a line marked "not billed to tenants" each break that — silently, today.
//
// This generalizes the idea to every bucket and every tax category, CLIENT-SIDE, off data
// that already exists. No view, no table, no migration. The recovered figure is read out
// of v_tenant_shares (which the per-tenant breakdown on the same page already renders)
// and the spent figure out of cam_line_items (which the three itemized sections above it
// already render) — so this table can never disagree with the page it sits on.
//
// WHY THIS IS THE RECOVERABLE FIGURE, NOT THE BILLED ONE. A tenant pays an ESTIMATE all
// year and the difference is settled at reconciliation, so "recovered" here is each
// tenant's ACTUAL pro-rata share — what the year's true-up entitles the landlord to
// collect, whatever the estimate happened to be. That is also why it ties exactly to the
// roof figures the SQL view has been computing for months, which is this file's free
// cross-check against code that predates it by seventy migrations.
//
// A GROSS LEASE STILL RECOVERS (0073). Its share is carved OUT of the flat rent rather
// than billed on top, and v_tenant_shares' cam_amount / tax_amount / roof_amt are
// deliberately unchanged for it — the property does recover that money, out of the rent.
// So nothing here needs a gross branch, and the vacancy tie-out keeps balancing.
//
// NOTHING HERE BILLS ANYTHING. Every figure is derived; no caller writes. A wrong
// category produces a wrong report and never a wrong invoice.

import { bucketKey, categoryFor, categoryLabel, isOwnerCategory } from './expenseCategories';
import { monthOfYearIndex } from './isoDate';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const zero12 = () => Array(12).fill(0);

// The three itemized expense kinds — the cam_line_items.kind CHECK since 0074.
export const EXPENSE_KINDS = ['tax', 'cam', 'roof'];

// The tax line a kind rolls up to when neither a saved bucket nor the label registry
// answers. This is NOT a guess: a line entered in the property-taxes section IS a
// real-estate-tax line, and that is what the section means. CAM is deliberately null —
// a CAM bucket's category genuinely depends on what was bought, which is the question
// Slice 2 exists to ask.
const KIND_CATEGORY = { tax: 'taxes', cam: null, roof: 'repairs' };

// What an un-itemized kind is called in the table. A kind either has lines that sum to
// its total (syncKindTotal re-sums from the rows whenever any exist) or has no lines at
// all and one flat figure typed by hand — so this fills the second case rather than
// dropping it. A $127,000 tax bill missing from the table because nobody split it into
// instalments is the exact failure this slice exists to prevent.
const FLAT_LABEL = { tax: 'Property taxes', cam: 'CAM', roof: 'Roof' };

/**
 * The share of each expense kind that tenants reimburse, read straight out of the
 * per-tenant view.
 *
 * null — not zero — when nothing was spent on that kind. A 0 would read as "recovered
 * nothing", which is a different and wrong claim.
 *
 * ⚠ EACH SHARE IS WEIGHED BY THE MONTHS THAT TENANT WAS ACTUALLY HERE (`inTermByLease`,
 * leaseSchedule.js). `v_tenant_shares` states a tenant's share of the FULL year's expenses,
 * but ⚖ Reconcile settles them at `inTerm/12` of it (reconciliation.js:242-249) — so
 * without this weighting a tenant who moved in on 1 July was reported as reimbursing a
 * whole year's CAM while being billed for half of it. The gap is
 * `Σ actualᵢ × (1 − inTermᵢ/12)`, and it landed entirely in `recovered`, which is
 * subtracted from what the year cost you — so it overstated the bottom line on the
 * "What it cost you" table and in the Income-and-expenses workbook alike.
 *
 * ⚠ ONLY THE START PRORATES, matching reconciliation.js:216 exactly: months after term end
 * keep owing, because a lease past its end date with the tenant still in it is a HOLDOVER
 * (`is_active === false`), not a vacancy — the app has no move-out record and bills them on.
 * An omitted or unknown lease weighs 12/12, so every existing caller is unchanged to the cent.
 */
export function recoveryFractions({ shares = [], expense = {}, inTermByLease = null } = {}) {
  const weight = (r) => {
    const m = inTermByLease ? inTermByLease[r?.lease_id] : undefined;
    // ⚠ `m == null` FIRST, and it is not pedantry: Number(null) is 0, not NaN, so a
    // Number.isFinite guard alone reads "no map supplied" as "in term for zero months"
    // and silently zeroes every recovery on the property. A lease genuinely in term for
    // 0 months still weighs 0 — that is the one case this must not swallow.
    if (m == null) return 1;
    const n = Number(m);
    return Number.isFinite(n) ? Math.min(12, Math.max(0, n)) / 12 : 1;
  };
  const sum = (field) => shares.reduce((s, r) => s + num(r[field]) * weight(r), 0);
  const frac = (recovered, total) => (total > 0 ? recovered / total : null);
  return {
    tax: frac(sum('tax_amount'), num(expense.taxes_total)),
    cam: frac(sum('cam_amount'), num(expense.cam_total)),
    roof: frac(sum('roof_amt'), num(expense.roof_total)),
  };
}

/**
 * Every expense line of every kind, normalized — with an un-itemized kind standing in
 * as a single line so no money is left out of the table.
 */
function expenseLines(items, expense) {
  const totalFor = {
    tax: num(expense.taxes_total),
    cam: num(expense.cam_total),
    roof: num(expense.roof_total),
  };
  const lines = items.map((it) => ({
    kind: EXPENSE_KINDS.includes(it.kind) ? it.kind : 'cam',
    label: String(it.label || '').trim() || '—',
    amount: num(it.amount),
    // Only "not billed to tenants" (0064) is a deliberate refusal to bill; anything
    // else — including a row that predates the column — bills as normal.
    billable: it.billable !== false,
    flat: false,
    // The day the money left the account (0074). NULLABLE and not backfilled, so this is
    // routinely absent — see `undated` below.
    paid_date: it.paid_date || null,
  }));
  for (const kind of EXPENSE_KINDS) {
    if (totalFor[kind] > 0 && !lines.some((l) => l.kind === kind)) {
      // A flat total is a single figure typed by hand for the whole year. It has no day
      // by definition, so it is undated rather than dated to some month nobody chose.
      lines.push({ kind, label: FLAT_LABEL[kind], amount: totalFor[kind], billable: true, flat: true, paid_date: null });
    }
  }
  return lines;
}

// ── The monthly breakdown (2026-08-12) ───────────────────────────────────────────────
//
// George: the Income-and-expenses workbook "should be itemized like a reconciliation … all
// income and expenses monthly with the main buckets and items."
//
// ⚠ IT IS GROWN HERE RATHER THAN BESIDE, and that is the whole reason it is in this file.
// Which category a line rolls up to is decided by exactly one piece of code — the
// saved-bucket → label-registry → what-the-section-means chain below — and a monthly grid
// built next to it would be a second copy of that chain, free to disagree about where a
// dollar belongs (CLAUDE.md §3). So the row gains `byMonth` / `undated` / `items` and every
// existing field keeps its exact value: the "What it cost you" table reads `spent`,
// `recovered`, `net` and `buckets`, ignores the rest, and cannot move.
//
// ⚠ `undated` IS NOT A ROUNDING BUCKET — it is a real and often large figure. `paid_date` is
// nullable and never backfilled (0074), a contract's derived CAM line never gets one, and a
// kind entered as a single flat total has no day at all. On real data that is thousands of
// dollars, so it gets its own column and its own flag rather than being spread over twelve
// months it was never in. `byMonth` sums stored 2-dp amounts, so months + undated === spent
// exactly, pinned by test.

const emptyBreakdown = () => ({ byMonth: zero12(), undated: 0, itemMap: new Map() });

// Add one line's amount to a category's grid and to its bucket's row within that grid.
function addToBreakdown(e, line, year) {
  const mi = monthOfYearIndex(line.paid_date, year);
  if (mi == null) e.undated += line.amount;
  else e.byMonth[mi] += line.amount;

  const key = bucketKey(line.label);
  let it = e.itemMap.get(key);
  if (!it) {
    it = { label: line.label, total: 0, byMonth: zero12(), undated: 0, flat: false };
    e.itemMap.set(key, it);
  }
  it.total += line.amount;
  if (line.flat) it.flat = true;
  if (mi == null) it.undated += line.amount;
  else it.byMonth[mi] += line.amount;
}

/**
 * The table: one row per tax category, carrying what you spent, what tenants pay back,
 * and what it cost you — plus, since 2026-08-12, the same figures month by month.
 *
 * Ordered by NET COST descending, because that is the question — the roof you absorbed
 * in full outranks a larger tax bill that came back almost whole. Uncategorized is
 * always last and, as in Slice 2, is never folded into the "Other" category.
 *
 * `year` is optional and only affects the monthly breakdown: a row stored under this year
 * whose date falls in another one is counted as undated rather than printed in a month it
 * did not belong to. Omit it and a date's own month is taken as read.
 *
 * Pure: takes rows, reads no clock and no network.
 */
// ⚠ OWNER CAPITAL IS SPLIT OUT, NOT SUMMED IN. A line whose category answers
// `isOwnerCategory` — today only `distribution`, the home owner draws moved to when the
// entity ledger was retired (2026-08-12) — is a real bank line that must appear
// somewhere, but it is NOT a cost of the building. It leaves in `owner` and is absent
// from both `rows` and `totals`, so every caller that renders a subtotal gets the right
// answer without knowing the rule. The Income-and-expenses workbook prints `owner`
// beneath the net line for the same reason.
export function recoverabilityRows({ items = [], shares = [], expense = {}, buckets = [], year = null, inTermByLease = null } = {}) {
  const fractions = recoveryFractions({ shares, expense, inTermByLease });
  const byCat = new Map();
  let uncategorized = null;

  for (const line of expenseLines(items, expense)) {
    // Saved bucket wins, then the label registry, then what the section itself means.
    const found = categoryFor(line.label, buckets);
    let category = found.category;
    let source = found.source;
    if (!category && KIND_CATEGORY[line.kind]) {
      category = KIND_CATEGORY[line.kind];
      source = 'default';
    }

    const f = fractions[line.kind];
    const recovered = !line.billable || f == null ? 0 : line.amount * f;

    let e;
    if (!category) {
      uncategorized ||= { key: null, label: 'Not categorized', spent: 0, recovered: 0, net: 0, buckets: [], anyDefault: false, anyFlat: false, ...emptyBreakdown() };
      e = uncategorized;
    } else {
      e = byCat.get(category);
      if (!e) {
        e = { key: category, label: categoryLabel(category), spent: 0, recovered: 0, net: 0, buckets: [], anyDefault: false, anyFlat: false, ...emptyBreakdown() };
        byCat.set(category, e);
      }
      if (source === 'default') e.anyDefault = true;
    }
    e.spent += line.amount;
    e.recovered += recovered;
    if (line.flat) e.anyFlat = true;
    if (!e.buckets.includes(line.label)) e.buckets.push(line.label);
    addToBreakdown(e, line, year);
  }

  const finish = (e) => {
    // Round the pair, then derive net FROM the rounded pair, so every row ties exactly
    // as displayed — spent = recovered + net, to the cent, always.
    e.spent = round2(e.spent);
    e.recovered = round2(e.recovered);
    e.net = round2(e.spent - e.recovered);
    e.buckets.sort((a, b) => a.localeCompare(b));
    // The grid, rounded the same way and ordered the same way the table is: biggest
    // first, so the bucket worth asking about is the one at the top of the group.
    e.byMonth = e.byMonth.map(round2);
    e.undated = round2(e.undated);
    e.items = [...e.itemMap.values()]
      .map((it) => ({ ...it, total: round2(it.total), undated: round2(it.undated), byMonth: it.byMonth.map(round2) }))
      .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
    delete e.itemMap;
    return e;
  };

  const all = [...byCat.values()].map(finish)
    .sort((a, b) => b.net - a.net || b.spent - a.spent || a.label.localeCompare(b.label));

  // The split, before anything is totalled. `uncategorized` can never be an owner row —
  // it has no category by definition — so it joins the expense side as it always did.
  const owner = all.filter((r) => isOwnerCategory(r.key));
  const rows = all.filter((r) => !isOwnerCategory(r.key));
  if (uncategorized) rows.push(finish(uncategorized));

  // Sum the ROUNDED rows, never the raw figures, so the totals line ties to the column
  // above it rather than being a hair off it. The months are summed the same way, from
  // the same rows, so the workbook's "Total out" line ties across as well as down.
  const totals = rows.reduce(
    (t, r) => ({
      spent: round2(t.spent + r.spent), recovered: round2(t.recovered + r.recovered), net: round2(t.net + r.net),
      byMonth: t.byMonth.map((n, i) => round2(n + r.byMonth[i])),
      undated: round2(t.undated + r.undated),
    }),
    { spent: 0, recovered: 0, net: 0, byMonth: zero12(), undated: 0 }
  );
  const ownerTotal = owner.reduce((t, r) => round2(t + r.spent), 0);

  return { rows, totals, owner, ownerTotal, fractions };
}

// ── What actually stayed ─────────────────────────────────────────────────────────────
//
// Moved here from entityLedger.js when that module was retired (2026-08-12). It belongs
// beside recoverabilityRows because both answer the same question from opposite ends —
// that one says what each category cost, this one says what the year left in the bank —
// and both now depend on the same owner-capital rule.

/**
 * The costs the landlord entered and deliberately did NOT bill, split from the owner's
 * own withdrawals.
 *
 * ⚠ These figures are *visible* on the Expense entry panel and reach NO total. That was
 * deliberate (2026-07-21: "folding them into NOI = v2"), and the consequence is that NOI
 * is overstated by exactly the amount the landlord ate. The strip counts it BESIDE NOI,
 * never inside it — folding it into `cam_total` would bill tenants for costs deliberately
 * absorbed, which is the exact thing `billable=false` exists to prevent, and redefining
 * `v_property_totals.noi` would silently re-value every historical chart point and every
 * `financial_snapshots` row already written.
 *
 * ⚠ AND IT MUST SPLIT, not sum. Since the entity ledger was retired, an owner draw is
 * ALSO a `billable = false` line — same shape, different meaning. Summing them would put
 * "money you took out" under the label "costs you absorbed", which is the misstatement
 * the entity ledger existed to prevent in the first place. The total leaving the account
 * is identical either way; only the two labels are at stake, and they are the point.
 * `buckets` is what resolves a line's category, so a caller that omits it gets every
 * non-billable line as absorbed — the pre-2026-08-12 answer, and a safe degradation.
 */
export function absorbedFromItems(items = [], buckets = []) {
  let total = 0, count = 0, ownerTotal = 0, ownerCount = 0;
  for (const it of items || []) {
    if (it?.billable !== false) continue;
    const amt = Math.abs(Number(it.amount) || 0);
    if (isOwnerCategory(categoryFor(it.label, buckets).category)) {
      ownerTotal = round2(ownerTotal + amt);
      ownerCount += 1;
    } else {
      total = round2(total + amt);
      count += 1;
    }
  }
  return { total, count, ownerTotal, ownerCount };
}

/**
 * The reconciliation strip: NOI as billed, then every real movement it doesn't know
 * about, ending at what actually stayed in the account.
 *
 * Returns ordered lines so the UI renders a subtraction anyone can follow rather than a
 * table of unrelated figures. A line whose figure is zero is omitted — a strip full of
 * "$0.00 distributions" reads as noise and hides the ones that matter. `noi` always
 * shows, even at zero, because it is what the subtraction starts from.
 *
 * Owner CONTRIBUTIONS carried a line here until 2026-08-12. They no longer have a home
 * that records an amount — money the landlord puts in files as a `transfer`, which is
 * placed and counted nowhere (otherIncome.js explains the refusal). So this reconciles
 * NOI to what the PROPERTY's year left in the account, which is the question it was
 * always really answering.
 */
export function whatStayed({ noi = 0, absorbed = 0, otherIncome = 0, distributions = 0 } = {}) {
  const lines = [
    { key: 'noi', label: 'Net operating income', sub: 'as billed', amount: round2(noi), sign: 1, always: true },
    { key: 'otherIncome', label: 'Other income', sub: 'not tenant rent', amount: round2(otherIncome), sign: 1 },
    { key: 'absorbed', label: 'Costs you absorbed', sub: 'entered, not billed to tenants', amount: round2(absorbed), sign: -1 },
    { key: 'distributions', label: 'Owner distributions', sub: 'money you took out', amount: round2(distributions), sign: -1 },
  ];
  const shown = lines.filter((l) => l.always || Math.abs(l.amount) > 0.005);
  // Summed from the lines SHOWN, never from the inputs — a strip whose figures don't add
  // up to its own total is worse than no strip. (Omitted lines are exactly zero, so this
  // is the same number either way; it stays tied by construction.)
  const stayed = round2(shown.reduce((n, l) => n + l.sign * l.amount, 0));
  return { lines: shown, stayed };
}
