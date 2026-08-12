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

import { categoryFor, categoryLabel, isOwnerCategory } from './expenseCategories';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

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
 */
export function recoveryFractions({ shares = [], expense = {} } = {}) {
  const sum = (field) => shares.reduce((s, r) => s + num(r[field]), 0);
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
  }));
  for (const kind of EXPENSE_KINDS) {
    if (totalFor[kind] > 0 && !lines.some((l) => l.kind === kind)) {
      lines.push({ kind, label: FLAT_LABEL[kind], amount: totalFor[kind], billable: true, flat: true });
    }
  }
  return lines;
}

/**
 * The table: one row per tax category, carrying what you spent, what tenants pay back,
 * and what it cost you.
 *
 * Ordered by NET COST descending, because that is the question — the roof you absorbed
 * in full outranks a larger tax bill that came back almost whole. Uncategorized is
 * always last and, as in Slice 2, is never folded into the "Other" category.
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
export function recoverabilityRows({ items = [], shares = [], expense = {}, buckets = [] } = {}) {
  const fractions = recoveryFractions({ shares, expense });
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
      uncategorized ||= { key: null, label: 'Not categorized', spent: 0, recovered: 0, net: 0, buckets: [], anyDefault: false, anyFlat: false };
      e = uncategorized;
    } else {
      e = byCat.get(category);
      if (!e) {
        e = { key: category, label: categoryLabel(category), spent: 0, recovered: 0, net: 0, buckets: [], anyDefault: false, anyFlat: false };
        byCat.set(category, e);
      }
      if (source === 'default') e.anyDefault = true;
    }
    e.spent += line.amount;
    e.recovered += recovered;
    if (line.flat) e.anyFlat = true;
    if (!e.buckets.includes(line.label)) e.buckets.push(line.label);
  }

  const finish = (e) => {
    // Round the pair, then derive net FROM the rounded pair, so every row ties exactly
    // as displayed — spent = recovered + net, to the cent, always.
    e.spent = round2(e.spent);
    e.recovered = round2(e.recovered);
    e.net = round2(e.spent - e.recovered);
    e.buckets.sort((a, b) => a.localeCompare(b));
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
  // above it rather than being a hair off it.
  const totals = rows.reduce(
    (t, r) => ({ spent: round2(t.spent + r.spent), recovered: round2(t.recovered + r.recovered), net: round2(t.net + r.net) }),
    { spent: 0, recovered: 0, net: 0 }
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
