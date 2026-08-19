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
// ⚠ THE SHAPE IS GEORGE'S OWN DESIGN STATEMENT (2026-08-18): *"the projected and live should be
// the same exact number at the end of the year, the only difference should be if there are any
// additional charges that come in. one is a projected count taken from the ledgers figures of
// what should be charged which we know. the other (live) is just a running counter taken from the
// bank statements as the year goes along."* Mid-year, then, the only honest gap is TIMING — and
// the first thing each measure says is which part of its gap is simply months that have not come
// round yet, before anything that reads like a problem.
//
// ⚠ WHICH TERMS ARE MEASURED AND WHICH ARE THE REMAINDER, because the difference decides what
// `unexplained` can catch:
//
//   MEASURED, from an independent source — `notDueYet` (the rows' own month arrays, either side
//   of today), `ahead` (the roll's own `projectedAhead`), `grossCarve` (the rows' own flag),
//   `corrections` (`adjustmentsForPnlRow`), `credit` and `unbilled` (the allocator). Revenue's
//   terms therefore over-determine `rentPosted`, and when they stop agreeing with it the gap
//   prints as `unexplained`. That is the real check here.
//
//   THE REMAINDER — `pastDue` on Revenue and Expenses. Nothing in the app measures "due and not
//   paid" a second way at this level, so it is what is left after the measured terms — which is
//   also why a wrong `notDueYet` cannot hide: it would push `pastDue` visibly wrong the other
//   way on a screen the Ledger contradicts. Said out loud rather than implied, because a
//   catch-all that cannot catch anything is worse than none: it reads as a guarantee.
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const DUST = 0.005;
// ⚠ A CAUSE WORTH NAMING IS WORTH AT LEAST A DOLLAR. Terms are computed to the cent and must
// still ADD to the cent, but a one-cent term printed with a full sentence of explanation is
// noise wearing a finding's clothes — and George met exactly that: "−$0.01 · the estimate is an
// annual figure, and the bill spreads it only across the months a tenant is in term", which is
// the rounding of a twelfth, not a fact about his year. Anything under a dollar is folded into
// the measure's REMAINDER term (the one that is already "whatever is left"), so nothing is
// dropped, the printed lines still sum to the live figure exactly, and no penny gets a sentence.
const TERM_FLOOR = 1;

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

/** Assemble a measure from its terms, appending the catch-all if anything is left over.
 *
 * `remainder` names the term that already IS the leftover for this measure — arrears on the two
 * component measures. Sub-dollar terms are folded there rather than printed or dropped. */
function measure(key, label, sub, projected, live, terms, remainder = null) {
  let kept = terms.filter(Boolean);
  const home = kept.find((t) => t.key === remainder);
  if (home) {
    const tiny = kept.filter((t) => t !== home && Math.abs(t.amount) < TERM_FLOOR);
    if (tiny.length) {
      // ⚠ FOLD THE EVIDENCE, NOT JUST THE TOTAL. Moving the amount alone leaves a term whose
      // named properties no longer add up to the figure beside them — a landlord checking the
      // one thing this panel exists to let them check would find it off by the fold.
      const byId = new Map(home.rows.map((r) => [r.id, { ...r }]));
      for (const t of tiny) {
        for (const r of t.rows) {
          const at = byId.get(r.id);
          if (at) at.amount = round2(at.amount + r.amount);
          else byId.set(r.id, { ...r });
        }
      }
      home.rows = [...byId.values()]
        .filter((r) => Math.abs(r.amount) > DUST)
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.label.localeCompare(b.label));
      home.amount = round2([...byId.values()].reduce((n, r) => n + r.amount, 0));
      kept = kept.filter((t) => !tiny.includes(t));
    }
  }
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
  // The gap splits at TODAY. `notDueYet` is measured (the rows' own month arrays, summed past
  // the due boundary); `pastDue` is the remainder — the old arrears figure less the not-yet-due
  // part — written to make what it absorbs explicit: cash that settles no bill (`tenantCredit`,
  // `unbilled`) is added back BEFORE the subtraction, so it is named on its own line instead of
  // quietly making the past-due figure look smaller. On 18 August the lump this replaces was
  // mostly September-through-December rent wearing an arrears sentence — an accusation the
  // calendar, not any tenant, was responsible for.
  //
  // The running month counts as DUE — rent falls due on the 1st (George, 2026-08-13, the
  // `owesToDate` reading; `monthsDueThrough`, portfolioBasis.js, is the one place that decides).
  const rentPastDue = (r) => -(num(r.rentPosted) + num(r.tenantCredit) + num(r.unbilled) - num(r.rentLive)) + num(r.rentNotDue);
  // ⚠ `ahead` IS A TERM, NOT A CAVEAT, because it is inside projected — and it is the one line
  // that is NOT pure timing: the projection counts a raise the leases schedule for later this
  // year, and the issued invoice will not carry it until it lands. A landlord reading the gap is
  // owed the sentence saying that slice is a raise nobody has been asked to pay yet.
  const revenue = measure('revenue', 'Revenue', 'base rent', col(list, 'rentProjected'), col(list, 'rentLive'), [
    term('notDueYet', 'rent for months that have not come round yet — the leases bill it later this year, so it is not late, it is just not due', list,
      (r) => -num(r.rentNotDue)),
    term('pastDue', 'rent already due and not yet in — this month and the months before it', list,
      rentPastDue, { link: 'ledger' }),
    term('ahead', 'a rent raise your leases schedule for later this year — the projection counts it because the lease says it, but no invoice includes it yet and no tenant has been asked to pay it', list,
      (r) => -num(r.projectedAhead)),
    term('grossCarve', 'a gross lease’s CAM & tax, which its flat rent already covers — counted under Expenses instead of twice', list,
      (r) => -num(r.grossCarve)),
    term('corrections', 'base-rent corrections posted on tenants’ bills', list, (r) => num(r.rentCorrections)),
    term('credit', 'paid beyond the whole year’s bills, so there is no month left to settle', list, (r) => num(r.tenantCredit)),
    term('unbilled', 'cash on a month the lease bills nothing for — before a term started, after it ended, or a free month', list, (r) => num(r.unbilled)),
  ], 'pastDue');

  // ── Expenses ─────────────────────────────────────────────────────────────────────────────
  const camTaxProration = (r) => num(r.camTaxPosted) - num(r.camTaxCorrections) - num(r.camTaxProjected);
  const camTaxPastDue = (r) => -(num(r.camTaxPosted) - num(r.camTaxLive)) + num(r.camTaxNotDue);
  const expenses = measure('expenses', 'Expenses', 'CAM & tax billed', col(list, 'camTaxProjected'), col(list, 'camTaxLive'), [
    term('notDueYet', 'CAM & tax for months that have not come round yet — billed later this year', list,
      (r) => -num(r.camTaxNotDue)),
    term('pastDue', 'CAM & tax already due and not yet in — this month and the months before it', list,
      camTaxPastDue, { link: 'ledger' }),
    term('proration', 'the estimate is an annual figure, and the bill spreads it only across the months a tenant is in term', list, camTaxProration),
    term('corrections', 'CAM & tax corrections posted on tenants’ bills', list, (r) => num(r.camTaxCorrections)),
  ], 'pastDue');

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
  ], 'revenue');

  // ── In no column at all ──────────────────────────────────────────────────────────────────
  //
  // These are NOT terms, and the distinction is the whole reason they are listed separately: a
  // term explains the gap, a caveat is money the gap does not know about. Each asks the landlord
  // to go and do something, which is why each carries somewhere to go.
  // ⚠ NO `annualRate` CAVEAT ANY MORE (2026-08-18 (10)). For one afternoon this list also
  // compared the band to the Financials page's "Projected revenue (annualized)" — a THIRD number,
  // in neither column, answering a question George never asked. He asked what it meant three
  // times; that was the answer about the caveat, and it came off. If the two screens are ever to
  // agree, the fix is on the Financials page's caption, not a footnote here.
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
