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
    expect(ahead.label).toMatch(/has not taken effect yet/);
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
      projectedAhead: 3504, rentAnnualRate: 25241.04,
      rentScheduled: 25241.04,
      rentPosted: 25241.04, grossCarve: 0, rentCorrections: 0, tenantCredit: 0, unbilled: 0,
      camTaxProjected: 0, camTaxLive: 0, camTaxPosted: 0, camTaxCorrections: 0,
      chargesProjected: 0, chargesLive: 0, otherLive: 0, unapplied: 0, driftTotal: 0,
      totalProjected: 28745.04, totalLive: 25241.04,
    };
    const revenue = yearBridge([row], { year: Y }).measures.find((m) => m.key === 'revenue');
    const ahead = revenue.terms.find((t) => t.key === 'ahead');
    expect(ahead).toBeTruthy();
    expect(ahead.amount).toBeCloseTo(-3504, 2);
    // The whole gap, with nothing left over and no arrears invented on top of it.
    expect(revenue.terms.some((t) => t.unexplained)).toBe(false);
    expect(revenue.terms.map((t) => t.key)).toEqual(['ahead']);
    expect(stated(revenue)).toBeCloseTo(revenue.live, 2);
  });
});

// ── The other screen's figure, stated rather than left to be found ────────────────────────
//
// ⚠ THE VIEW WAS DELIBERATELY LEFT ALONE. `v_property_totals.total_revenue` still feeds NOI,
// every closed-year snapshot already written, History's YoY cards, the Ask facts and
// `syncRentPctCamItems` — which WRITES tenant invoices when a management fee is a % of rent. So
// the Financials page goes on quoting an annual rate while the Overview prices the months, and
// the two genuinely differ. George's standing complaint is about figures nobody explains, not
// about there being two questions, so the bridge says what the other screen will say.
describe('the annual rate the other screen quotes', () => {
  const base = {
    id: 'p', name: 'Pershing Plaza',
    rentProjected: 25241.04, rentLive: 25241.04, projectedAhead: 0, rentScheduled: 25241.04,
    rentPosted: 25241.04, grossCarve: 0, rentCorrections: 0, tenantCredit: 0, unbilled: 0,
    camTaxProjected: 0, camTaxLive: 0, camTaxPosted: 0, camTaxCorrections: 0,
    chargesProjected: 0, chargesLive: 0, otherLive: 0, unapplied: 0, driftTotal: 0,
    totalProjected: 25241.04, totalLive: 25241.04,
  };

  it('states the gap as a caveat, in no column and in no term', () => {
    const bridge = yearBridge([{ ...base, rentAnnualRate: 28745.04 }], { year: Y });
    const c = bridge.caveats.find((x) => x.key === 'annualRate');
    expect(c).toBeTruthy();
    expect(c.amount).toBeCloseTo(3504, 2);
    expect(c.label).toMatch(/all twelve months/);
    expect(c.action).toMatch(/different questions/);
    // A caveat, never a term — it explains no part of the projected-vs-live gap.
    const revenue = bridge.measures.find((m) => m.key === 'revenue');
    expect(revenue.terms.some((t) => t.key === 'annualRate')).toBe(false);
    expect(stated(revenue)).toBeCloseTo(revenue.live, 2);
  });

  // ⚠ A PENNY IS NOT A CROSS-SCREEN DISCREPANCY. Twelfths round; the same floor that keeps
  // −$0.01 out of the terms keeps it out of here.
  it('says nothing when the two agree, or differ by rounding', () => {
    expect(yearBridge([{ ...base, rentAnnualRate: 25241.04 }], { year: Y })
      .caveats.some((c) => c.key === 'annualRate')).toBe(false);
    expect(yearBridge([{ ...base, rentAnnualRate: 25241.42 }], { year: Y })
      .caveats.some((c) => c.key === 'annualRate')).toBe(false);
  });
});

// ⚠ A PENNY IS NOT A CAUSE. George, reading his live Overview: *"and this −$0.01 · the estimate
// is an annual figure, and the bill spreads it only across the months a tenant is in term"* —
// which is the rounding of an annual figure into twelfths, not a fact about his year. It must
// still be COUNTED (the printed lines have to sum to the live figure) but never NAMED.
describe('sub-dollar rounding is absorbed, not narrated', () => {
  const withProration = (cents) => ({
    id: 'p', name: 'Maple Plaza',
    rentProjected: 0, rentLive: 0, rentScheduled: 0, projectedAhead: 0, rentAnnualRate: 0,
    rentPosted: 0, grossCarve: 0, rentCorrections: 0, tenantCredit: 0, unbilled: 0,
    camTaxProjected: 10000, camTaxLive: 6000, camTaxPosted: round2(10000 + cents),
    camTaxCorrections: 0, chargesProjected: 0, chargesLive: 0, otherLive: 0,
    unapplied: 0, driftTotal: 0, totalProjected: 10000, totalLive: 6000,
  });

  it('folds a one-cent proration into arrears rather than giving it a sentence', () => {
    const m = yearBridge([withProration(-0.01)], { year: Y }).measures.find((x) => x.key === 'expenses');
    expect(m.terms.some((t) => t.key === 'proration')).toBe(false);
    expect(m.terms.some((t) => t.unexplained)).toBe(false);
    expect(m.terms.map((t) => t.key)).toEqual(['arrears']);
    // Absorbed, never dropped — the measure still lands on its live figure to the cent…
    expect(stated(m)).toBeCloseTo(m.live, 2);
    // …and the property named under it still adds to the figure printed beside it, which is the
    // one thing a landlord can actually check by eye.
    const arrears = m.terms[0];
    expect(round2(arrears.rows.reduce((s, r) => s + r.amount, 0))).toBeCloseTo(arrears.amount, 2);
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
});
