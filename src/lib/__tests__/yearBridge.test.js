// The band's gap, decomposed — and the arithmetic is the feature.
//
// George, 2026-08-18: *"at the end of the year it should give a summary of any differences in
// the numbers and where they came from for the projected vs live stats"*.
//
// ⚠ THE ONE THING THAT WOULD MAKE THIS FILE USELESS is asserting that the labels are nice. A
// bridge whose terms do not add up to the gap is worse than no bridge: it is a list of causes
// that reads as complete and is not. So the weight here is on closure — every measure, on every
// property shape the seed can be made to take — and on the two figures that can be quietly
// counted twice (a tenant's year-end credit, a gross lease's CAM & tax carve).
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { listBasisByProperty } from '../portfolioBasis';
import { basisRows, portfolioBasis } from '../portfolioCharts';
import { yearBridge } from '../yearBridge';
import {
  getPropertyTotals, listProperties, updateLease, ensureInvoice,
  recordPayment, deletePayment, upsertAlertState, getPropertyMonthlyRoll,
} from '../api';
import { overpayKey } from '../ledger';
import { currentYear } from '../format';

const Y = currentYear();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

/** The Overview's own pipeline, end to end: loader → rows → bridge.
 *
 * ⚠ BOTH CORPORATIONS. prop-1 is Acme's and prop-2 is Northwind's, so reading one drops the
 * other — silently, because `basisRows` just returns a shorter list. That is how the first
 * version of the gross test below "passed" against zero rows. */
async function bridgeFor(propIds, opts = {}) {
  const all = [...(await listProperties('corp-1')), ...(await listProperties('corp-2'))];
  const props = all.filter((p) => propIds.includes(p.id));
  expect(props.length, 'every property asked for must be found').toBe(propIds.length);
  const basis = await listBasisByProperty(propIds, Y, opts);
  const totals = {};
  for (const id of propIds) totals[id] = await getPropertyTotals(id, Y);
  const rows = basisRows(props, totals, basis);
  return { rows, band: portfolioBasis(rows), bridge: yearBridge(rows, { year: Y }) };
}

const stated = (m) => round2(m.terms.reduce((s, t) => s + t.amount, m.projected));

describe('yearBridge — every measure closes', () => {
  // ⚠ THE HEADLINE ASSERTION, and it is deliberately made against the SAME rows the band sums.
  // A bridge that closes against figures it computed itself proves nothing; this one has to
  // land on the exact `live` the column above it prints, or the panel explains a gap the band
  // is not showing.
  it('adds its named causes to exactly the live figure the band prints', async () => {
    const { band, bridge } = await bridgeFor(['prop-1', 'prop-2']);
    expect(bridge).toBeTruthy();
    expect(bridge.measures.map((m) => m.key)).toEqual(['revenue', 'expenses', 'total']);
    for (const m of bridge.measures) {
      expect(stated(m), `${m.key} must reach its live figure from its projected one`).toBeCloseTo(m.live, 2);
    }
    // …and the three measures ARE the band's three pairs, not a second reading of them.
    expect(bridge.measures[0].projected).toBe(band.rent.projected);
    expect(bridge.measures[0].live).toBe(band.rent.live);
    expect(bridge.measures[1].projected).toBe(band.camTax.projected);
    expect(bridge.measures[2].projected).toBe(band.total.projected);
    expect(bridge.measures[2].live).toBe(band.total.live);
    expect(bridge.measures[2].delta).toBe(band.total.delta);
  });

  // ⚠ THE CATCH-ALL MUST STAY SILENT ON A CLEAN SEED, or it is noise that teaches a landlord to
  // ignore the one line that matters. `clean` is the same fact, exposed for the panel.
  it('names nothing it cannot account for', async () => {
    const { bridge } = await bridgeFor(['prop-1', 'prop-2']);
    for (const m of bridge.measures) {
      const un = m.terms.find((t) => t.unexplained);
      expect(un, `${m.key} left ${un ? un.amount : 0} unexplained`).toBeUndefined();
    }
    expect(bridge.clean).toBe(true);
  });

  // …and it must NOT stay silent when the identity it checks actually breaks. Revenue's terms
  // over-determine what the Rent row POSTED — the leases' own schedule, the roll's unswept-step
  // figure, the gross flag, the adjustments and the allocator are five separate sources — so
  // corrupting one has to surface as a dollar figure rather than being absorbed into arrears.
  it('prints the whole gap when a cause goes missing, instead of swallowing it', async () => {
    const { rows } = await bridgeFor(['prop-1']);
    const hurt = rows.map((r) => ({ ...r, rentPosted: round2(r.rentPosted - 5000) }));
    const bridge = yearBridge(hurt, { year: Y });
    const revenue = bridge.measures.find((m) => m.key === 'revenue');
    const un = revenue.terms.find((t) => t.unexplained);
    expect(un).toBeTruthy();
    expect(Math.abs(un.amount)).toBeCloseTo(5000, 2);
    expect(bridge.clean).toBe(false);
    // Still closes WITH the catch-all — that is the point of having one.
    expect(stated(revenue)).toBeCloseTo(revenue.live, 2);
  });

  it('says nothing at all when there is nothing to read', () => {
    expect(yearBridge([], { year: Y })).toBe(null);
    expect(yearBridge(null)).toBe(null);
  });

  // A term with no dollars behind it is not a term. `flags()` learned this the hard way
  // (George, 2026-08-17): reciting every possible cause sends a landlord hunting for a gross
  // lease that isn't there.
  it('names only the causes that are actually present', async () => {
    const { bridge } = await bridgeFor(['prop-1', 'prop-2']);
    for (const m of bridge.measures) {
      for (const t of m.terms) {
        expect(Math.abs(t.amount), `${m.key}/${t.key} is dust and should not print`).toBeGreaterThan(0.005);
        for (const r of t.rows) expect(Math.abs(r.amount)).toBeGreaterThan(0.005);
      }
      // The demo has no gross lease, so that cause must be absent from every measure.
      expect(m.terms.some((t) => t.key === 'grossCarve')).toBe(false);
    }
  });

  // Every term names where it came from — the whole ask. A figure with no property behind it is
  // the "10 findings" report CLAUDE.md's §5 refuses.
  it('names the properties behind each cause, and they sum to the cause', async () => {
    const { bridge } = await bridgeFor(['prop-1', 'prop-2']);
    const terms = bridge.measures.flatMap((m) => m.terms).filter((t) => !t.unexplained);
    expect(terms.length).toBeGreaterThan(0);
    for (const t of terms) {
      expect(t.rows.length, `${t.key} must name its properties`).toBeGreaterThan(0);
      expect(round2(t.rows.reduce((s, r) => s + r.amount, 0))).toBeCloseTo(t.amount, 2);
    }
  });
});

describe('the two figures that would otherwise be counted twice', () => {
  // ⚠ AN UNANSWERED SURPLUS IS IN NO COLUMN, so it must be in no TERM either. `billedRowsFromRoll`
  // already holds it out of every live figure, so adding it as a term would count it against a
  // gap it is not part of — and the arrears line would shrink by money nobody has decided about.
  it('keeps an unanswered over-payment out of every term, and moves it in once confirmed', async () => {
    const inv = await ensureInvoice('lease-3', 'prop-2', Y);
    const roll = await getPropertyMonthlyRoll('prop-2', Y);
    const row = roll.find((r) => r.lease_id === 'lease-3');
    const owed = round2(Number(row.schedule[6].owed) || 0);
    expect(owed, 'the month must bill something, or the whole cheque is surplus').toBeGreaterThan(0);
    const surplus = 2500;
    const pay = await recordPayment({
      invoice_id: inv.id, lease_id: 'lease-3', amount: round2(owed + surplus),
      paid_date: `${Y}-06-05`, method: 'check', period_month: 6, source: 'manual',
    });
    cleanup.push(() => deletePayment(pay.id));

    const held = await bridgeFor(['prop-2']);
    const cav = held.bridge.caveats.find((c) => c.key === 'unapplied');
    expect(cav, 'the surplus must be named as a caveat').toBeTruthy();
    expect(cav.amount).toBeCloseTo(surplus, 2);
    // …and in NO term of any measure.
    const allTerms = held.bridge.measures.flatMap((m) => m.terms);
    expect(allTerms.some((t) => t.key === 'unapplied')).toBe(false);
    for (const m of held.bridge.measures) expect(stated(m)).toBeCloseTo(m.live, 2);

    // The landlord says it is revenue. Now it is in the live rent — and the bridge still closes.
    const key = overpayKey('lease-3', Y, 6, surplus);
    await upsertAlertState({ alert_key: key, dismissed: true });
    cleanup.push(() => upsertAlertState({ alert_key: key, dismissed: false }));
    const answered = await bridgeFor(['prop-2'], { confirmed: new Set([key]) });
    expect(answered.bridge.caveats.some((c) => c.key === 'unapplied')).toBe(false);
    expect(answered.band.rent.live).toBeCloseTo(held.band.rent.live + surplus, 2);
    for (const m of answered.bridge.measures) expect(stated(m)).toBeCloseTo(m.live, 2);
  });
});

// ── The gross lease: the one shape the demo seed never takes ──────────────────────────────
//
// ⚠ THIS BLOCK IS THE REASON THE `totalProjected` FIX SHIPPED. `total_revenue` counts a gross
// tenant's whole flat rent (0049 + `effective_rent`) and `billedComponents` returns the CAM & tax
// carved out of that same rent (0073), so the band's projected Total was adding the carve twice
// — invisibly, because no seeded lease is gross. Nothing but this test looks.
describe('a gross lease is charged once, not twice', () => {
  beforeAll(async () => {
    await updateLease('lease-4', { lease_type: 'gross', est_cam_annual: 25000, est_tax_annual: 0 });
    await ensureInvoice('lease-4', 'prop-2', Y);
  });
  afterEach(async () => {
    await updateLease('lease-4', { lease_type: 'net', est_cam_annual: null, est_tax_annual: null });
    await ensureInvoice('lease-4', 'prop-2', Y);
  });

  it('subtracts the carve from projected Total and names it as a cause', async () => {
    const { rows, band, bridge } = await bridgeFor(['prop-2']);
    const carve = round2(rows.reduce((s, r) => s + r.grossCarve, 0));
    expect(carve, 'the flipped lease must actually produce a carve').toBeGreaterThan(0);

    // The band no longer counts it in both columns and again in Total.
    expect(band.total.projected).toBeCloseTo(
      round2(band.rent.projected + band.camTax.projected + rows.reduce((s, r) => s + r.chargesProjected, 0) - carve), 2,
    );

    // Revenue subtracts it (the flat rent covers it, Expenses bills it); Total adds it back so
    // the two columns above are reconciled to one charge.
    const revenue = bridge.measures.find((m) => m.key === 'revenue');
    const total = bridge.measures.find((m) => m.key === 'total');
    expect(revenue.terms.find((t) => t.key === 'grossCarve').amount).toBeCloseTo(-carve, 2);
    expect(total.terms.find((t) => t.key === 'grossCarve').amount).toBeCloseTo(carve, 2);
    // …and Expenses gains no gross term at all: the carve is on both sides there and cancels.
    expect(bridge.measures.find((m) => m.key === 'expenses').terms.some((t) => t.key === 'grossCarve')).toBe(false);

    // Everything still closes, which is the only thing that makes the above safe to believe.
    for (const m of bridge.measures) expect(stated(m)).toBeCloseTo(m.live, 2);
    expect(bridge.clean).toBe(true);
  });
});

// ── The one thing the projection knows and the bill cannot ────────────────────────────────
//
// ⚠ WHAT THIS BLOCK REPLACED, because the reason matters more than the assertions. Three terms
// used to live here — `rentStep`, `partYear` and a leftover `basis` — explaining why an
// unprorated annual rate differed from the leases' own months. They were correct and they were
// the answer to the wrong question: George, shown the difference, said *"we should make rent
// projections part of the projected rent because we know what those numbers are so that
// shouldn't be a discrepancy."* Projected Revenue IS those months now, so nothing is left for
// the three to explain and they came off with the gap.
//
// What survives is the single fact a schedule genuinely cannot bill: a step the leases have
// scheduled for this year that the nightly sweep has not applied. It is INSIDE projected — the
// lease says it — but no invoice carries it, so a landlord reading "$3,368 short" is owed the
// sentence saying nobody has been asked to pay that. Named as a TERM for exactly that reason.
describe('rent the leases schedule but no invoice carries', () => {
  it('names an unswept step, and never calls it money someone is withholding', async () => {
    const { rows, bridge } = await bridgeFor(['prop-1', 'prop-2']);
    // The demo seeds one unswept escalation (esc-1, +3% on Bright Coffee at prop-1), so this is
    // a real figure rather than a zero that would let the whole block pass vacuously.
    expect(round2(rows.reduce((s, r) => s + r.projectedAhead, 0))).toBeGreaterThan(0);

    const revenue = bridge.measures.find((m) => m.key === 'revenue');
    const ahead = revenue.terms.find((t) => t.key === 'ahead');
    expect(ahead, 'the seed carries a scheduled step and must name it').toBeTruthy();
    // Signed the way the measure reads — it pushes live BELOW projected, so it is negative.
    expect(ahead.amount).toBeLessThan(0);
    expect(ahead.label).toMatch(/schedule for later this year/);
    expect(ahead.label).toMatch(/no tenant has been asked to pay it/);
    // The three retired terms must not come back under their old names.
    for (const gone of ['rentStep', 'partYear', 'basis']) {
      expect(revenue.terms.some((t) => t.key === gone), `${gone} was retired`).toBe(false);
    }
    expect(stated(revenue)).toBeCloseTo(revenue.live, 2);
  });

  // George's own shape, as a pure input: a full-year tenancy whose rent rises later this year.
  // The projection carries the raise; the bill cannot; the difference is stated, not implied.
  it('accounts for the step exactly, and closes without a catch-all', () => {
    const row = {
      id: 'p', name: 'Pershing Plaza',
      rentProjected: 28745.04, rentLive: 25241.04,
      projectedAhead: 3504, rentNotDue: 0,
      rentScheduled: 25241.04,
      rentPosted: 25241.04, grossCarve: 0, rentCorrections: 0, tenantCredit: 0, unbilled: 0,
      camTaxProjected: 0, camTaxLive: 0, camTaxPosted: 0, camTaxCorrections: 0, camTaxNotDue: 0,
      chargesProjected: 0, chargesLive: 0, otherLive: 0, unapplied: 0, driftTotal: 0,
      totalProjected: 28745.04, totalLive: 25241.04,
    };
    const revenue = yearBridge([row], { year: Y }).measures.find((m) => m.key === 'revenue');
    const ahead = revenue.terms.find((t) => t.key === 'ahead');
    expect(ahead).toBeTruthy();
    expect(ahead.amount).toBeCloseTo(-3504, 2);
    // The whole gap, with nothing left over and no past-due invented on top of it.
    expect(revenue.terms.some((t) => t.unexplained)).toBe(false);
    expect(revenue.terms.map((t) => t.key)).toEqual(['ahead']);
    expect(stated(revenue)).toBeCloseTo(revenue.live, 2);
  });
});

// ── The timing split ──────────────────────────────────────────────────────────────────────
//
// George, 2026-08-18: *"the projected and live should be the same exact number at the end of the
// year … one is a projected count taken from the ledgers figures of what should be charged which
// we know. the other (live) is just a running counter taken from the bank statements as the year
// goes along."* So mid-year the gap is mostly TIMING, and the panel owes it as two lines: months
// that have not come round yet, and months that are genuinely due and unpaid. The one lump this
// replaces ("rent billed and not yet in") wore an arrears sentence over September-to-December
// rent — an accusation the calendar was responsible for, not any tenant.
describe('the gap splits at today', () => {
  // A year mid-flight, as pure input: $120,000 billed across the year, $70,000 due so far,
  // $60,000 of it in. rentNotDue (the future months' bill less any prepayment) is $50,000.
  const midYear = {
    id: 'p', name: 'Pershing Plaza',
    rentProjected: 120000, rentLive: 60000, rentScheduled: 120000, projectedAhead: 0,
    rentNotDue: 50000, camTaxNotDue: 0,
    rentPosted: 120000, grossCarve: 0, rentCorrections: 0, tenantCredit: 0, unbilled: 0,
    camTaxProjected: 0, camTaxLive: 0, camTaxPosted: 0, camTaxCorrections: 0,
    chargesProjected: 0, chargesLive: 0, otherLive: 0, unapplied: 0, driftTotal: 0,
    totalProjected: 120000, totalLive: 60000,
  };

  it('names not-due-yet and past-due apart, and they close to the cent', () => {
    const revenue = yearBridge([midYear], { year: Y }).measures.find((m) => m.key === 'revenue');
    const notDue = revenue.terms.find((t) => t.key === 'notDueYet');
    const pastDue = revenue.terms.find((t) => t.key === 'pastDue');
    // The calendar's share, worded as the calendar's — not late, just not due.
    expect(notDue).toBeTruthy();
    expect(notDue.amount).toBeCloseTo(-50000, 2);
    expect(notDue.label).toMatch(/not come round yet/);
    expect(notDue.label).toMatch(/not late/);
    // The tenants' share: $70,000 due, $60,000 in.
    expect(pastDue).toBeTruthy();
    expect(pastDue.amount).toBeCloseTo(-10000, 2);
    expect(pastDue.label).toMatch(/already due/);
    // The actionable half is the one with somewhere to go.
    expect(pastDue.link).toBe('ledger');
    expect(notDue.link).toBeUndefined();
    expect(revenue.terms.some((t) => t.unexplained)).toBe(false);
    expect(stated(revenue)).toBeCloseTo(revenue.live, 2);
  });

  // ⚠ THE BOUNDARY CASES ARE PINNED WITHOUT DEPENDING ON TODAY. `rentNotDue` is data here; what
  // this asserts is that the bridge never invents a "not due" line for a year with no future
  // months, and never a "past due" line for a year that has not started. The date arithmetic
  // itself is `monthsDueThrough`, pinned in portfolioBasis.test.js.
  it('a finished year is all past due, a year not started is all not-due-yet', () => {
    const done = { ...midYear, rentNotDue: 0 };
    const doneRev = yearBridge([done], { year: Y - 1 }).measures.find((m) => m.key === 'revenue');
    expect(doneRev.terms.map((t) => t.key)).toEqual(['pastDue']);
    expect(doneRev.terms[0].amount).toBeCloseTo(-60000, 2);

    const ahead = { ...midYear, rentLive: 0, rentNotDue: 120000, totalLive: 0 };
    const aheadRev = yearBridge([ahead], { year: Y + 1 }).measures.find((m) => m.key === 'revenue');
    expect(aheadRev.terms.map((t) => t.key)).toEqual(['notDueYet']);
    expect(aheadRev.terms[0].amount).toBeCloseTo(-120000, 2);
    expect(stated(aheadRev)).toBeCloseTo(0, 2);
  });

  // ⚠ THE AFTER-TERM SLICE IS CARVED OUT OF "NOT DUE YET", NEVER ADDED BESIDE IT (2026-08-18
  // (12)). The bill deliberately runs past a lease's own end date — the holdover rule — so the
  // slice is real money in the projection; what changed is its sentence: conditional on the
  // tenant staying, never the calendar's certainty. At year end it is the line that explains a
  // projection the live counter never reached because a tenant left.
  it('gives rent past a lease’s own end its own conditional line', () => {
    const withEnd = { ...midYear, rentNotDue: 38000, rentAfterTerm: 12000 };
    const revenue = yearBridge([withEnd], { year: Y }).measures.find((m) => m.key === 'revenue');
    const after = revenue.terms.find((t) => t.key === 'afterTerm');
    expect(after).toBeTruthy();
    expect(after.amount).toBeCloseTo(-12000, 2);
    // Both branches of the condition, stated in the one sentence.
    expect(after.label).toMatch(/term is up/);
    expect(after.label).toMatch(/never pays it/);
    // The tenants' share is untouched by the carve: still $70,000 due, $60,000 in.
    expect(revenue.terms.find((t) => t.key === 'pastDue').amount).toBeCloseTo(-10000, 2);
    expect(revenue.terms.some((t) => t.unexplained)).toBe(false);
    expect(stated(revenue)).toBeCloseTo(revenue.live, 2);
    // …and moving a dollar between the calendar's line and the conditional one never moves
    // the measure's own gap.
    const shifted = yearBridge([{ ...withEnd, rentNotDue: 37999, rentAfterTerm: 12001 }], { year: Y })
      .measures.find((m) => m.key === 'revenue');
    expect(shifted.delta).toBeCloseTo(revenue.delta, 2);
    expect(stated(shifted)).toBeCloseTo(shifted.live, 2);
  });

  // ⚠ pastDue IS A REMAINDER, so a wrong rentNotDue still closes and only the LABELS lie. This
  // is the assertion that catches that: the split must respond to the data, not just sum to it.
  it('moves a dollar between the two lines when the boundary moves, never out of the total', () => {
    const a = yearBridge([midYear], { year: Y }).measures.find((m) => m.key === 'revenue');
    const b = yearBridge([{ ...midYear, rentNotDue: 50001 }], { year: Y }).measures.find((m) => m.key === 'revenue');
    const get = (m, k) => m.terms.find((t) => t.key === k)?.amount || 0;
    expect(get(b, 'notDueYet') - get(a, 'notDueYet')).toBeCloseTo(-1, 2);
    expect(get(b, 'pastDue') - get(a, 'pastDue')).toBeCloseTo(1, 2);
    expect(b.delta).toBeCloseTo(a.delta, 2);
  });
});

// ⚠ A PENNY IS NOT A CAUSE. George, reading his live Overview: *"and this −$0.01 · the estimate
// is an annual figure, and the bill spreads it only across the months a tenant is in term"* —
// which is the rounding of an annual figure into twelfths, not a fact about his year. It must
// still be COUNTED (the printed lines have to sum to the live figure) but never NAMED.
describe('sub-dollar rounding is absorbed, not narrated', () => {
  const withProration = (cents) => ({
    id: 'p', name: 'Maple Plaza',
    rentProjected: 0, rentLive: 0, rentScheduled: 0, projectedAhead: 0,
    rentNotDue: 0, camTaxNotDue: 0,
    rentPosted: 0, grossCarve: 0, rentCorrections: 0, tenantCredit: 0, unbilled: 0,
    camTaxProjected: 10000, camTaxLive: 6000, camTaxPosted: round2(10000 + cents),
    camTaxCorrections: 0, chargesProjected: 0, chargesLive: 0, otherLive: 0,
    unapplied: 0, driftTotal: 0, totalProjected: 10000, totalLive: 6000,
  });

  it('folds a one-cent proration into past-due rather than giving it a sentence', () => {
    const m = yearBridge([withProration(-0.01)], { year: Y }).measures.find((x) => x.key === 'expenses');
    expect(m.terms.some((t) => t.key === 'proration')).toBe(false);
    expect(m.terms.some((t) => t.unexplained)).toBe(false);
    expect(m.terms.map((t) => t.key)).toEqual(['pastDue']);
    // Absorbed, never dropped — the measure still lands on its live figure to the cent…
    expect(stated(m)).toBeCloseTo(m.live, 2);
    // …and the property named under it still adds to the figure printed beside it, which is the
    // one thing a landlord can actually check by eye.
    const pastDue = m.terms[0];
    expect(round2(pastDue.rows.reduce((s, r) => s + r.amount, 0))).toBeCloseTo(pastDue.amount, 2);
  });

  it('still names a proration that is worth naming', () => {
    const m = yearBridge([withProration(-5833.39)], { year: Y }).measures.find((x) => x.key === 'expenses');
    const pro = m.terms.find((t) => t.key === 'proration');
    expect(pro).toBeTruthy();
    expect(pro.amount).toBeCloseTo(-5833.39, 2);
    expect(stated(m)).toBeCloseTo(m.live, 2);
  });
});


describe('the headline', () => {
  it('quotes the two figures, the gap and the cause behind most of it', async () => {
    const { bridge } = await bridgeFor(['prop-1', 'prop-2']);
    const h = bridge.headline;
    expect(h.projected).toBe(bridge.measures[2].projected);
    expect(h.live).toBe(bridge.measures[2].live);
    expect(['short', 'ahead', 'even']).toContain(h.direction);
    // A cause is only claimed when it really is most of the gap — never as decoration.
    if (h.cause) expect(Math.abs(h.cause.amount)).toBeGreaterThanOrEqual(Math.abs(h.delta) * 0.5);
  });

  // ⚠ A CAUSE MUST PULL THE GAP'S OWN WAY. A year running AHEAD (other income landed) still
  // carries big negative timing terms on Revenue, and the biggest term used to caption the
  // headline regardless of direction — "$10,000 ahead, mostly rent for months that have not
  // come round yet" is two claims contradicting each other in one sentence.
  it('never captions an ahead year with a cause pulling the other way', () => {
    const ahead = {
      id: 'p', name: 'Pershing Plaza',
      rentProjected: 120000, rentLive: 60000, rentScheduled: 120000, projectedAhead: 0,
      rentNotDue: 50000, camTaxNotDue: 0,
      rentPosted: 120000, grossCarve: 0, rentCorrections: 0, tenantCredit: 0, unbilled: 0,
      camTaxProjected: 0, camTaxLive: 0, camTaxPosted: 0, camTaxCorrections: 0,
      chargesProjected: 0, chargesLive: 0, otherLive: 70000, unapplied: 0, driftTotal: 0,
      totalProjected: 120000, totalLive: 130000,
    };
    const h = yearBridge([ahead], { year: Y }).headline;
    expect(h.direction).toBe('ahead');
    expect(h.delta).toBeCloseTo(10000, 2);
    // The only causes on the component measures pull DOWN (−$50,000 not due, −$10,000 past
    // due); neither may explain a gap that points up. Plain "$10,000 ahead" is the honest line.
    expect(h.cause).toBeNull();
  });
});
