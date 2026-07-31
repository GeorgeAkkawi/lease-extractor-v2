// More space leased than the building holds — the state a property passes through while
// a change is half-entered.
//
// George, 2026-07-30: "lets say that there are two leases changing its okay if for the
// time being the total square footage is over the total for the building because that
// will be temporary and once the other lease is inputed or removed it will be fixed let
// me know if that logic is in there."
//
// The answer is yes, and this is what makes it a guarantee rather than a claim. Nothing
// here clamps a tenant's own share, nothing goes negative, nothing invents a vacancy —
// and every figure returns to normal the moment the other lease lands. The one thing
// that DOES look odd (shares adding past 100%) is the truth about the state, not a bug,
// and the breakdown's own footnote says so.
import { describe, it, expect } from 'vitest';
import { createCorporation, createProperty, createLease, updateLease, deleteLease, getTenantShares, upsertExpenseRecord, getPropertyTotals, listLeases } from '../api';
import { tenantMix, occupancyByProperty } from '../portfolioCharts';

const YEAR = new Date().getFullYear();
const BUILDING = 10000;

// A fully-let building: 6,000 + 4,000 of 10,000, with $60,000 of CAM + tax to split.
async function fullyLet() {
  const corp = await createCorporation('Over-let Holdings');
  const prop = await createProperty({ corporation_id: corp.id, name: 'Over-let Plaza', address: '1 Over St', building_sf: BUILDING });
  const a = await createLease({
    property_id: prop.id, tenant_name: 'Tenant A', square_footage: 6000,
    base_rent: 180000, lease_start: `${YEAR - 1}-01-01`, lease_termination_date: `${YEAR + 3}-12-31`,
  });
  const b = await createLease({
    property_id: prop.id, tenant_name: 'Tenant B', square_footage: 4000,
    base_rent: 120000, lease_start: `${YEAR - 1}-01-01`, lease_termination_date: `${YEAR + 3}-12-31`,
  });
  await upsertExpenseRecord({ property_id: prop.id, year: YEAR, taxes_total: 40000, cam_total: 20000, roof_total: 0 });
  return { prop, a, b };
}

const leasesOf = (propId) => listLeases(propId);

describe('While a change is only half entered', () => {
  it('lets the leased total run past the building without breaking anything', async () => {
    // The replacement tenant is entered before the outgoing one is taken off:
    // 6,000 + 4,000 + 3,000 = 13,000 of a 10,000 SF building.
    const { prop } = await fullyLet();
    await createLease({
      property_id: prop.id, tenant_name: 'Tenant C (incoming)', square_footage: 3000,
      base_rent: 90000, lease_start: `${YEAR}-01-01`, lease_termination_date: `${YEAR + 5}-12-31`,
    });

    const shares = await getTenantShares(prop.id, YEAR);
    expect(shares).toHaveLength(3);
    // Each tenant is still charged its OWN square footage over the building — nobody is
    // on the wrong rate while the other lease is outstanding.
    const byName = Object.fromEntries(shares.map((s) => [s.tenant_name, s]));
    expect(byName['Tenant A'].share_pct).toBeCloseTo(6000 / BUILDING, 6);
    expect(byName['Tenant B'].share_pct).toBeCloseTo(4000 / BUILDING, 6);
    expect(byName['Tenant C (incoming)'].share_pct).toBeCloseTo(3000 / BUILDING, 6);
    // Which means the shares add past 100% — the honest arithmetic of the state.
    expect(shares.reduce((s, r) => s + r.share_pct, 0)).toBeCloseTo(1.3, 6);
    // Nothing is negative, and no share is clamped down to make the total behave.
    shares.forEach((s) => expect(s.cam_amount).toBeGreaterThan(0));
  });

  it('never invents a negative vacancy — the vacant slice just disappears', async () => {
    const { prop } = await fullyLet();
    await createLease({
      property_id: prop.id, tenant_name: 'Tenant C (incoming)', square_footage: 3000,
      base_rent: 90000, lease_start: `${YEAR}-01-01`, lease_termination_date: `${YEAR + 5}-12-31`,
    });

    const totals = await getPropertyTotals(prop.id, YEAR);
    expect(Number(totals.total_sf)).toBe(13000);
    expect(Number(totals.vacant_sf)).toBe(0);          // clamped at zero, never below

    // The donut: three tenant slices and no "Vacant space" one — there is no empty space
    // to draw, and a negative slice would render as nonsense.
    const mix = tenantMix({ building_sf: BUILDING }, await leasesOf(prop.id));
    expect(mix.filter((r) => r.kind === 'vacant')).toHaveLength(0);
    expect(mix.every((r) => r.sf > 0 && r.pct > 0)).toBe(true);

    // The Overview's leased-space bar caps at 100% rather than overflowing its track.
    const [occ] = occupancyByProperty([{ id: prop.id, name: 'Over-let Plaza', building_sf: BUILDING }], { [prop.id]: totals });
    expect(occ.pct).toBe(100);
    expect(occ.vacant).toBe(0);
  });

  it('settles itself the moment the other lease is entered or taken off', async () => {
    const { prop, a } = await fullyLet();
    const c = await createLease({
      property_id: prop.id, tenant_name: 'Tenant C (incoming)', square_footage: 3000,
      base_rent: 90000, lease_start: `${YEAR}-01-01`, lease_termination_date: `${YEAR + 5}-12-31`,
    });

    // Path 1 — the outgoing tenant hands back the space it's giving up (6,000 → 3,000).
    await updateLease(a.id, { square_footage: 3000 });
    let totals = await getPropertyTotals(prop.id, YEAR);
    expect(Number(totals.total_sf)).toBe(BUILDING);
    let shares = await getTenantShares(prop.id, YEAR);
    expect(shares.reduce((s, r) => s + r.share_pct, 0)).toBeCloseTo(1, 6);

    // Path 2 — or the incoming lease is removed instead. Either way it comes back level.
    await updateLease(a.id, { square_footage: 6000 });
    await deleteLease(c.id);
    totals = await getPropertyTotals(prop.id, YEAR);
    expect(Number(totals.total_sf)).toBe(BUILDING);
    expect(Number(totals.vacant_sf)).toBe(0);
    shares = await getTenantShares(prop.id, YEAR);
    expect(shares).toHaveLength(2);
    expect(shares.reduce((s, r) => s + r.share_pct, 0)).toBeCloseTo(1, 6);
  });

  it('and a property with room to spare still shows its vacancy normally', async () => {
    // The regression guard on the other side: none of the above weakened the ordinary
    // under-let case, which is what the vacant slice and the Vacant space row exist for.
    const { prop, a } = await fullyLet();
    await updateLease(a.id, { square_footage: 4000 });   // 8,000 of 10,000 let

    const totals = await getPropertyTotals(prop.id, YEAR);
    expect(Number(totals.vacant_sf)).toBe(2000);
    const mix = tenantMix({ building_sf: BUILDING }, await leasesOf(prop.id));
    const vacant = mix.find((r) => r.kind === 'vacant');
    expect(vacant.sf).toBe(2000);
    expect(vacant.pct).toBeCloseTo(0.2, 6);
  });
});
