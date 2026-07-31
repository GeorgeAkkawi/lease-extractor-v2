// A rider that changes the SIZE of the premises.
//
// George, 2026-07-30: "is there a way for the rider ai extraction to notice when the
// squarefootage of a property increaes or decreases and apply it to the lease terms?"
//
// square_footage is the numerator of the CAM / tax / roof split — v_tenant_shares divides
// it by coalesce(nullif(building_sf,0), Σ leased SF) — so the load-bearing question is not
// "does the number change" but "what else moves when it does". These pin both answers:
// the write itself, and the carry-through, which is property-wide exactly when the
// denominator is the leased sum rather than an entered building size.
import { describe, it, expect } from 'vitest';
import {
  createCorporation, createProperty, createLease, createAddendum, applyAddendum,
  getLease, getTenantShares, upsertExpenseRecord, ensureInvoice, getYearInvoice,
  listHistoryEvents,
} from '../api';

const YEAR = new Date().getFullYear();

// Two tenants so a re-split is visible on the OTHER one, which is the whole point of the
// property-wide branch. 6,000 SF let, in a building whose size the caller decides.
async function makeProperty({ buildingSf }) {
  const corp = await createCorporation('Resize Holdings');
  const prop = await createProperty({ corporation_id: corp.id, name: 'Resize Plaza', address: '1 Resize St', building_sf: buildingSf });
  const a = await createLease({
    property_id: prop.id, tenant_name: 'Tenant A', square_footage: 2000,
    base_rent: 60000, lease_start: `${YEAR - 1}-01-01`, lease_termination_date: `${YEAR + 3}-12-31`,
  });
  const b = await createLease({
    property_id: prop.id, tenant_name: 'Tenant B', square_footage: 4000,
    base_rent: 120000, lease_start: `${YEAR - 1}-01-01`, lease_termination_date: `${YEAR + 3}-12-31`,
  });
  // Something to split: $60,000 of CAM + tax for the year.
  await upsertExpenseRecord({ property_id: prop.id, year: YEAR, taxes_total: 40000, cam_total: 20000, roof_total: 0 });
  return { prop, a, b };
}

const rider = (leaseId, over = {}) =>
  createAddendum({ lease_id: leaseId, label: 'First Amendment', amendment_date: `${YEAR}-01-01`, effective_from: `${YEAR}-01-01`, kind: 'other', ...over });

const shareFor = async (propId, leaseId) =>
  (await getTenantShares(propId, YEAR)).find((s) => s.lease_id === leaseId);

describe('The size on the lease follows the rider', () => {
  it('writes the new area and records what it was before', async () => {
    const { prop, a } = await makeProperty({ buildingSf: 10000 });
    await applyAddendum(await rider(a.id), { squareFootage: 2600 });

    expect(Number((await getLease(a.id)).square_footage)).toBe(2600);

    const [ev] = (await listHistoryEvents(prop.id)).filter((e) => e.type === 'premises_resized');
    expect(ev).toBeTruthy();
    expect(ev.description).toMatch(/expanded to 2,600 SF/);
    expect(ev.description).toMatch(/was 2,000 SF/);
    expect(ev.meta.prior_sqft).toBe(2000);
    expect(ev.meta.new_sqft).toBe(2600);
    // Dated by the period the rider GOVERNS, not the day it was signed.
    expect(ev.event_date).toBe(`${YEAR}-01-01`);
  });

  it('reads a contraction as a contraction', async () => {
    const { prop, a } = await makeProperty({ buildingSf: 10000 });
    await applyAddendum(await rider(a.id), { squareFootage: 1500 });

    expect(Number((await getLease(a.id)).square_footage)).toBe(1500);
    const [ev] = (await listHistoryEvents(prop.id)).filter((e) => e.type === 'premises_resized');
    expect(ev.description).toMatch(/reduced to 1,500 SF/);
  });

  it('does nothing at all when the rider merely restates the size on file', async () => {
    const { prop, a } = await makeProperty({ buildingSf: 10000 });
    await applyAddendum(await rider(a.id), { squareFootage: 2000 });   // the size it already is

    expect(Number((await getLease(a.id)).square_footage)).toBe(2000);
    // No event, because nothing happened — a recital is not a change.
    expect((await listHistoryEvents(prop.id)).filter((e) => e.type === 'premises_resized')).toHaveLength(0);
  });

  it('refuses a figure that would split the year by zero', async () => {
    const { a } = await makeProperty({ buildingSf: 10000 });
    for (const bad of [0, -400, null, undefined, NaN]) {
      await applyAddendum(await rider(a.id), { squareFootage: bad });
      expect(Number((await getLease(a.id)).square_footage)).toBe(2000);
    }
  });
});

describe('What re-splits, and how far it reaches', () => {
  it('with a building size entered, only THIS tenant moves', async () => {
    // Denominator is the fixed 10,000, so Tenant B is arithmetically untouched.
    const { prop, a, b } = await makeProperty({ buildingSf: 10000 });
    expect((await shareFor(prop.id, a.id)).share_pct).toBeCloseTo(0.2, 6);
    const bBefore = (await shareFor(prop.id, b.id)).cam_amount;

    await applyAddendum(await rider(a.id), { squareFootage: 3000 });

    expect((await shareFor(prop.id, a.id)).share_pct).toBeCloseTo(0.3, 6);
    expect((await shareFor(prop.id, b.id)).cam_amount).toBeCloseTo(Number(bBefore), 6);
  });

  it('with NO building size, the denominator is the leased sum — so EVERY tenant re-splits', async () => {
    // This is the case that makes a lease-scoped resync wrong. 2,000 of 6,000 let → a
    // third; expand A to 3,000 and the pot is 7,000, so B falls from 4/6 to 4/7.
    const { prop, a, b } = await makeProperty({ buildingSf: null });
    expect((await shareFor(prop.id, a.id)).share_pct).toBeCloseTo(2000 / 6000, 6);
    expect((await shareFor(prop.id, b.id)).share_pct).toBeCloseTo(4000 / 6000, 6);

    await applyAddendum(await rider(a.id), { squareFootage: 3000 });

    expect((await shareFor(prop.id, a.id)).share_pct).toBeCloseTo(3000 / 7000, 6);
    expect((await shareFor(prop.id, b.id)).share_pct).toBeCloseTo(4000 / 7000, 6);
  });

  it('carries the change into the stored invoice, which does not rebuild itself', async () => {
    const { prop, a } = await makeProperty({ buildingSf: 10000 });
    const before = await ensureInvoice(a.id, prop.id, YEAR);
    // 20% of $60,000 = $12,000 on top of $60,000 of base rent.
    expect(Number(before.total_amount)).toBeCloseTo(72000, 2);

    await applyAddendum(await rider(a.id), { squareFootage: 3000 });

    // 30% of $60,000 = $18,000. The invoice is a frozen copy — if the carry-through
    // didn't run it would still read 72,000 while every screen read 78,000.
    expect(Number((await getYearInvoice(a.id, YEAR)).total_amount)).toBeCloseTo(78000, 2);
  });

  it('reaches the OTHER tenant\'s invoice too when the denominator moved', async () => {
    const { prop, a, b } = await makeProperty({ buildingSf: null });
    await ensureInvoice(a.id, prop.id, YEAR);
    const bBefore = await ensureInvoice(b.id, prop.id, YEAR);
    expect(Number(bBefore.total_amount)).toBeCloseTo(120000 + (4000 / 6000) * 60000, 2);

    await applyAddendum(await rider(a.id), { squareFootage: 3000 });

    // Tenant B's own lease never changed — only the pot it is divided into did.
    expect(Number((await getYearInvoice(b.id, YEAR)).total_amount))
      .toBeCloseTo(120000 + (4000 / 7000) * 60000, 2);
  });

  it('leaves a CLOSED year exactly as it was billed', async () => {
    const { prop, a } = await makeProperty({ buildingSf: 10000 });
    const before = await ensureInvoice(a.id, prop.id, YEAR);
    const { closeYear } = await import('../api');
    await closeYear(prop.id, YEAR);

    await applyAddendum(await rider(a.id), { squareFootage: 3000 });

    // The lease says 3,000 from now on, but the bill already sent does not move.
    expect(Number((await getLease(a.id)).square_footage)).toBe(3000);
    expect(Number((await getYearInvoice(a.id, YEAR)).total_amount)).toBeCloseTo(Number(before.total_amount), 2);
  });
});

describe('It composes with the rider\'s other effects', () => {
  it('a rider that extends the term AND re-sizes does both, and bills at the new size', async () => {
    const { prop, a } = await makeProperty({ buildingSf: 10000 });
    await ensureInvoice(a.id, prop.id, YEAR);

    await applyAddendum(await rider(a.id), {
      squareFootage: 3000,
      extensionEnd: `${YEAR + 8}-12-31`,
    });

    const lease = await getLease(a.id);
    expect(Number(lease.square_footage)).toBe(3000);
    expect(lease.lease_termination_date).toBe(`${YEAR + 8}-12-31`);
    // The resize runs before everything else, so the settled invoice uses the new share.
    expect(Number((await getYearInvoice(a.id, YEAR)).total_amount)).toBeCloseTo(78000, 2);
  });
});
