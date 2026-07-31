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

import { categoryFor, categoryLabel } from './expenseCategories';

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

  const rows = [...byCat.values()].map(finish)
    .sort((a, b) => b.net - a.net || b.spent - a.spent || a.label.localeCompare(b.label));
  if (uncategorized) rows.push(finish(uncategorized));

  // Sum the ROUNDED rows, never the raw figures, so the totals line ties to the column
  // above it rather than being a hair off it.
  const totals = rows.reduce(
    (t, r) => ({ spent: round2(t.spent + r.spent), recovered: round2(t.recovered + r.recovered), net: round2(t.net + r.net) }),
    { spent: 0, recovered: 0, net: 0 }
  );

  return { rows, totals, fractions };
}
