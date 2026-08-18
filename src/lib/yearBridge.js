// Why the band's two readings of one year differ, in terms that add up.
//
// George, 2026-08-18: *"at the end of the year it should give a summary of any differences in
// the numbers and where they came from for the projected vs live stats"*.
//
// `BasisBand` prints three measures twice — as the leases bill them, and as the money actually
// arrived — and a gap between the two. It has never said what the gap IS. This does, as a list
// of named causes under each measure, with the discipline `noiBridge` established
// (`incomeExpense.js`) and `flags()` proved out: state only the causes that are actually
// present, quote each in dollars, and print whatever is left over as "not accounted for"
// rather than swallowing it.
//
// ⚠ IT DERIVES NOTHING. Every figure here was already computed by `listBasisByProperty` — which
// runs `billedRowsFromRoll` twice per property and used to throw most of both results away — and
// carried through `basisRows` untouched. That is not an optimisation, it is the §2 rule: a
// second reading of "what this year billed" beside the first is how two boxes on one screen come
// to quote different dollars for the same year.
//
// ⚠ WHICH TERMS ARE MEASURED AND WHICH ARE THE REMAINDER, because the difference decides what
// `unexplained` can catch:
//
//   MEASURED, from an independent source — `basis` (the JS schedule against the SQL view),
//   `grossCarve` (the rows' own flag), `corrections` (`adjustmentsForPnlRow`), `credit` and
//   `unbilled` (the allocator). Revenue's five therefore over-determine `rentPosted`, and when
//   they stop agreeing with it the gap prints as `unexplained`. That is the real check here.
//
//   THE REMAINDER — `arrears` on Revenue and Expenses, and `proration` on Expenses. Nothing in
//   the app measures "billed and not yet in" a second way, so these are what is left after the
//   measured terms. Expenses and Total therefore close by construction and their `unexplained`
//   only ever catches an arithmetic slip. Said out loud rather than implied, because a
//   catch-all that cannot catch anything is worse than none: it reads as a guarantee.
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const DUST = 0.005;

/** Sum one field across the property rows. */
const col = (rows, key) => round2((rows || []).reduce((s, r) => s + num(r[key]), 0));

/**
 * One term of one measure: what it is, how much, and which properties it came from.
 *
 * `amount` is signed the way the measure reads — `live = projected + Σ amount` — so a term that
 * pushes live BELOW projected is negative and prints with a minus. The evidence rows carry the
 * same sign, and a property contributing nothing is left out rather than printed as $0.00.
 */
function term(key, label, rows, amountOf, extra = {}) {
  const evidence = (rows || [])
    .map((r) => ({ id: r.id, label: r.name, amount: round2(amountOf(r)) }))
    .filter((e) => Math.abs(e.amount) > DUST)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.label.localeCompare(b.label));
  const amount = round2(evidence.reduce((s, e) => s + e.amount, 0));
  if (Math.abs(amount) <= DUST) return null;
  // One property is not a list. Naming it in the term's own line reads better than a trailing
  // chip repeating the only name there is, and the component uses this to decide.
  return { key, label, amount, rows: evidence, ...extra };
}

/** Assemble a measure from its terms, appending the catch-all if anything is left over. */
function measure(key, label, sub, projected, live, terms) {
  const kept = terms.filter(Boolean);
  const stated = round2(kept.reduce((s, t) => s + t.amount, projected));
  const residual = round2(live - stated);
  if (Math.abs(residual) > DUST) {
    kept.push({
      key: 'unexplained',
      label: 'not accounted for — the causes above and these figures disagree by this much',
      amount: residual,
      rows: [],
      unexplained: true,
    });
  }
  // Largest first: a landlord reading three lines should meet the one that matters in the first.
  kept.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  return {
    key,
    label,
    sub,
    projected: round2(projected),
    live: round2(live),
    delta: round2(live - projected),
    // Null rather than 0 when nothing is projected — "0% in" against a year that bills nothing
    // is a fabricated accusation. Same rule as `portfolioBasis`.
    share: projected > 0 ? live / projected : null,
    terms: kept,
  };
}

/**
 * The whole bridge for a year, over the per-property rows `basisRows` builds.
 *
 * Returns null when there is nothing to explain — no property with any figure on either side.
 * A panel reading "$0 projected, $0 live, nothing to report" is a row of noise posing as a
 * finding, which is the rule `WhatStayedStrip` and `BasisBand` already keep.
 */
export function yearBridge(rows = [], { year = null } = {}) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return null;

  // ── Revenue ──────────────────────────────────────────────────────────────────────────────
  //
  // `arrears` is the remainder, and it is written to make what it absorbs explicit: cash that
  // settles no bill (`tenantCredit`, `unbilled`) is added back BEFORE the subtraction, so it is
  // named on its own line instead of quietly making the arrears figure look smaller.
  const rentArrears = (r) => -(num(r.rentPosted) + num(r.tenantCredit) + num(r.unbilled) - num(r.rentLive));
  const revenue = measure('revenue', 'Revenue', 'base rent', col(list, 'rentProjected'), col(list, 'rentLive'), [
    term('arrears', 'rent billed and not yet in', list, rentArrears),
    term('basis', 'the annual rate the Financials page quotes, against these leases’ own month-by-month schedule — a tenancy that began or ended part-way through the year is counted only from the month it ran', list,
      (r) => num(r.rentScheduled) - num(r.rentProjected)),
    term('grossCarve', 'a gross lease’s CAM & tax, which its flat rent already covers — counted under Expenses instead of twice', list,
      (r) => -num(r.grossCarve)),
    term('corrections', 'base-rent corrections posted on tenants’ bills', list, (r) => num(r.rentCorrections)),
    term('credit', 'paid beyond the whole year’s bills, so there is no month left to settle', list, (r) => num(r.tenantCredit)),
    term('unbilled', 'cash on a month the lease bills nothing for — before a term started, after it ended, or a free month', list, (r) => num(r.unbilled)),
  ]);

  // ── Expenses ─────────────────────────────────────────────────────────────────────────────
  const camTaxProration = (r) => num(r.camTaxPosted) - num(r.camTaxCorrections) - num(r.camTaxProjected);
  const camTaxArrears = (r) => -(num(r.camTaxPosted) - num(r.camTaxLive));
  const expenses = measure('expenses', 'Expenses', 'CAM & tax billed', col(list, 'camTaxProjected'), col(list, 'camTaxLive'), [
    term('arrears', 'CAM & tax billed and not yet in', list, camTaxArrears),
    term('proration', 'the estimate is an annual figure, and the bill spreads it only across the months a tenant is in term', list, camTaxProration),
    term('corrections', 'CAM & tax corrections posted on tenants’ bills', list, (r) => num(r.camTaxCorrections)),
  ]);

  // ── Total ────────────────────────────────────────────────────────────────────────────────
  //
  // ⚠ TOTAL DOES NOT RECITE THE TWO LISTS ABOVE. It carries each measure's whole gap as one
  // line and adds only what is in NEITHER of them — the fees and credits, the gross carve that
  // stops a flat rent being counted twice, and the other income nothing forecasts. Repeating
  // nine terms under a fourth heading is how a panel that explains a figure becomes a panel
  // nobody opens.
  const total = measure('total', 'Total', 'what tenants are charged', col(list, 'totalProjected'), col(list, 'totalLive'), [
    term('revenue', 'the rent gap above', list, (r) => num(r.rentLive) - num(r.rentProjected)),
    term('expenses', 'the CAM & tax gap above', list, (r) => num(r.camTaxLive) - num(r.camTaxProjected)),
    term('charges', 'fees and credits billed and not yet in', list, (r) => num(r.chargesLive) - num(r.chargesProjected)),
    term('grossCarve', 'a gross lease’s CAM & tax, counted once here rather than in both columns above', list, (r) => num(r.grossCarve)),
    term('otherIncome', 'other income — parking, storage, a write-in. It rides no invoice and the app forecasts none of it, so it can only land on the live side', list,
      (r) => num(r.otherLive), { link: 'income' }),
  ]);

  // ── In no column at all ──────────────────────────────────────────────────────────────────
  //
  // These are NOT terms, and the distinction is the whole reason they are listed separately: a
  // term explains the gap, a caveat is money the gap does not know about. Each asks the landlord
  // to go and do something, which is why each carries somewhere to go.
  const caveats = [
    term('unapplied', 'arrived beyond what those months billed, and is counted in nothing above until you say what it is', list,
      (r) => num(r.unapplied), { link: 'ledger', action: 'Answer it on the Ledger' }),
    term('invoiceDrift', 'the invoices you actually issued differ from what these leases now say — an issued bill is frozen and does not follow a later change', list,
      (r) => num(r.driftTotal), { link: 'ledger', action: 'The Ledger offers Rebuild' }),
  ].filter(Boolean);

  const measures = [revenue, expenses, total];
  return {
    year,
    measures,
    caveats,
    // The one sentence the folded panel shows. Computed here so the panel and anything else
    // that ever quotes it cannot drift apart.
    headline: headlineFor(total, measures),
    // True when every measure closes with no catch-all — what a test asserts, and what the
    // panel needs to tell "checked and clean" apart from "nothing has been logged".
    clean: measures.every((m) => !m.terms.some((t) => t.unexplained)),
  };
}

/** `Your leases bill $X and $Y has come in — $Z short. Most of it is …` */
function headlineFor(total, measures) {
  const { projected, live, delta } = total;
  if (projected <= DUST && live <= DUST) return null;
  if (Math.abs(delta) <= 0.5) {
    return { projected, live, delta: 0, direction: 'even', cause: null };
  }
  // The biggest single CAUSE, taken from Revenue and Expenses rather than Total — Total's lines
  // are gaps, and "most of it is the rent gap" tells a landlord nothing they cannot already see.
  const causes = measures
    .filter((m) => m.key !== 'total')
    .flatMap((m) => m.terms)
    .filter((t) => !t.unexplained);
  const cause = causes.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0] || null;
  return {
    projected,
    live,
    delta,
    direction: delta < 0 ? 'short' : 'ahead',
    // Only claim "most of it" when it genuinely is most of it.
    cause: cause && Math.abs(cause.amount) >= Math.abs(delta) * 0.5 ? cause : null,
  };
}
