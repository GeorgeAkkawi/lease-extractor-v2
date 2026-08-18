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
  // over-determine `rentPosted` — the JS schedule, the SQL view, the gross flag and the
  // adjustments are four separate sources — so corrupting one has to surface as a dollar figure
  // rather than being absorbed into arrears.
  it('prints the whole gap when a cause goes missing, instead of swallowing it', async () => {
    const { rows } = await bridgeFor(['prop-1']);
    const hurt = rows.map((r) => ({ ...r, rentScheduled: round2(r.rentScheduled - 5000) }));
    const bridge = yearBridge(hurt, { year: Y });
    const revenue = bridge.measures.find((m) => m.key === 'revenue');
    const un = revenue.terms.find((t) => t.unexplained);
    expect(un).toBeTruthy();
    expect(un.amount).toBeCloseTo(5000, 2);
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
