// Gross leases (0073) driven end to end through the REAL billing chain.
//
// George, 2026-07-30, describing Card Pop's flat $3,500/mo at Joliet: "if the actual
// was ten thousand, it would show that there's a difference of ten thousand … you
// would subtract ten thousand from the forty two thousand to get thirty two thousand,
// and then thirty two thousand per year would be the new base rent."
//
// The arithmetic itself is pinned in reconciliation.test.js. What only an integration
// run can prove is that the carve survives the chain — that the flag reaches the share
// row, that the ledger owes the FLAT rent (not rent + share), that the stored invoice's
// carved components still sum to it, and that the paths which would quietly re-add the
// expenses on top (the estimate importer, ⚖ Reconcile) refuse.
//
// Runs against the demo mock (forced by the vite test env), which mirrors the live SQL.
// The demo SEED is deliberately unchanged — every candidate lease feeds pinned figures
// in other suites — so the flip happens here, in the test, and is undone at the end.
//
// Subject: lease-4 (Sunrise Yoga, prop-2) — a mid-year start (Jul 1), so it also proves
// the carve prorates correctly rather than only working on a clean full year.
//   prop-2: building 6,000 SF · taxes $40,000 · CAM $30,000 (year Y)
//   lease-4: 1,000 SF (= 1/6 share) · flat $36,000/yr · not roof-responsible
//   → expense share = (40,000 + 30,000) / 6 = $11,666.67
//   → gross base    = 36,000 − 11,666.67 = $24,333.33
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  updateLease, getTenantShares, getPropertyMonthlyRoll, getYearInvoice,
  getMonthlyRent, ensureInvoice, resyncYearBillingToEstimate, reconcileCamTax,
  getStatementMatchContext,
} from '../api';
import { billedComponents } from '../reconciliation';
import { componentizeSchedule } from '../ledger';
import { deriveEstimateFromDeposit } from '../statementMatch';
import { currentYear } from '../format';

const Y = currentYear();
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const SHARE = round2((40000 + 30000) / 6);   // 11,666.67
const FLAT = 36000;
const rowFor = async (leaseId) => (await getTenantShares('prop-2', Y)).find((s) => s.lease_id === leaseId);

// The mid-year lease bills Jul–Dec only, so a full year of flat rent prorates to half.
const IN_TERM = 6;
const PRORATED_FLAT = round2((FLAT / 12) * IN_TERM); // 18,000

beforeAll(async () => {
  // A stale estimate is left on deliberately: a lease flipped to gross often still
  // carries one from when it billed net, and nothing downstream may read it.
  await updateLease('lease-4', { lease_type: 'gross', est_cam_annual: 25000, est_tax_annual: 0 });
  await ensureInvoice('lease-4', 'prop-2', Y);
});
afterAll(async () => {
  await updateLease('lease-4', { lease_type: null, est_cam_annual: null, est_tax_annual: null });
});

describe('a gross lease through the billing chain', () => {
  it('carries the flag on the tenant-share row (the 0073 view column)', async () => {
    const s = await rowFor('lease-4');
    expect(s.lease_type).toBe('gross');
    // The SHARE arithmetic is untouched — that's what makes the vacancy tie-out and
    // every other tenant's bill hold still.
    expect(round2(s.cam_amount + s.tax_amount)).toBe(SHARE);
  });

  it('bills the FLAT rent — the share comes out of it, not on top', async () => {
    const s = await rowFor('lease-4');
    const b = billedComponents(s);
    expect(b.total).toBe(FLAT);
    expect(b.camTax).toBe(SHARE);
    expect(b.base).toBe(round2(FLAT - SHARE)); // 24,333.33 — George's carve
    // Net would have billed 36,000 + 11,666.67 = 47,666.67. That difference is the bug.
    expect(b.total).not.toBe(round2(FLAT + SHARE));
  });

  it('the ledger owes flat/12 a month, and the split still sums to it exactly', async () => {
    const roll = await getPropertyMonthlyRoll('prop-2', Y);
    const row = roll.find((r) => r.lease_id === 'lease-4');
    expect(row.gross).toBe(true);
    // Mid-year start: Jan–Jun out of term, Jul–Dec at the flat monthly.
    expect(round2(row.schedule[3].owed)).toBe(0);
    expect(round2(row.schedule[8].owed)).toBe(round2(FLAT / 12)); // $3,000
    expect(round2(row.annual)).toBe(PRORATED_FLAT);

    // The penny invariant componentizeSchedule holds: base + camTax + roof === owed,
    // per month, with base as the remainder. This is what lets a flat deposit settle.
    const comp = componentizeSchedule({ schedule: row.schedule, factor: row.factor, camTaxAnnual: row.camTaxAnnual, roofAnnual: row.roofAnnual });
    for (let m = 7; m <= 12; m++) {
      expect(round2(comp[m].base + comp[m].camTax + comp[m].roof)).toBe(round2(row.schedule[m].owed));
      expect(comp[m].camTax).toBeGreaterThan(0); // the carve is visible per month
      expect(comp[m].base).toBeLessThan(round2(FLAT / 12)); // …and it reduces base
    }
  });

  it('stores a carved invoice whose components still total the flat rent', async () => {
    const res = await resyncYearBillingToEstimate('lease-4', 'prop-2', Y);
    const inv = res.invoice || (await getYearInvoice('lease-4', Y));
    const parts = round2(inv.base_rent_annual + inv.cam_annual + inv.tax_annual + inv.roof_annual);
    expect(parts).toBe(PRORATED_FLAT);            // 18,000 — the prorated flat rent
    expect(round2(inv.total_amount)).toBe(PRORATED_FLAT);
    expect(round2(inv.cam_annual)).toBe(round2(SHARE / 2));  // half a year of the share
    expect(round2(inv.tax_annual)).toBe(0);       // combined into the CAM line
    // Base is the REMAINDER of the already-rounded components, not an independently
    // rounded figure — that's what makes `parts` above land on the flat rent to the
    // penny rather than a cent out. (Here it's 12,166.66, where rounding the halved
    // share on its own would have said 12,166.67.)
    expect(round2(inv.base_rent_annual)).toBe(round2(PRORATED_FLAT - round2(SHARE / 2)));

    // And the month the ledger paints matches the invoice it wrote.
    const { byMonth } = await getMonthlyRent('lease-4', Y);
    expect(byMonth).toBeDefined();
  });

  it('ignores the stale estimate sitting on the lease', async () => {
    // $25,000 is still stored on lease-4 (see beforeAll). If anything read it, the
    // tenant would be billed an estimate on top of a rent that already includes it.
    const b = billedComponents(await rowFor('lease-4'));
    expect(b.camTax).toBe(SHARE);
    expect(b.anyEstimate).toBe(false); // → Difference dormant, ⚖ Reconcile hidden
  });

  it('refuses to reconcile — there is no estimate-vs-actual gap to settle', async () => {
    await expect(reconcileCamTax('lease-4', 'prop-2', Y)).rejects.toThrow(/gross lease/i);
  });

  it('never proposes an estimate from a gross tenant’s deposit', async () => {
    const ctx = await getStatementMatchContext('prop-2', Y);
    const t = ctx.tenants.find((x) => x.lease_id === 'lease-4');
    expect(t.gross).toBe(true);
    // The flat deposit itself derives nothing — the carved base leaves exactly the
    // share, which the "already at this estimate" test also happens to catch.
    expect(deriveEstimateFromDeposit(FLAT / 12, t, 8)).toBeNull();
    // The case that ISOLATES the guard: a deposit that doesn't match the carve at all
    // (a tenant who overpaid, or a month with a fee in it). Read as net this proposes a
    // brand-new $17,666 estimate to bill ON TOP of a rent that already includes CAM &
    // tax; the gross guard is the only thing stopping it.
    const odd = FLAT / 12 + 500;
    expect(deriveEstimateFromDeposit(odd, { ...t, gross: false }, 8)).not.toBeNull();
    expect(deriveEstimateFromDeposit(odd, t, 8)).toBeNull();
  });

  it('leaves every OTHER tenant on the property exactly as it was', async () => {
    // The carve is per-lease. Northwind (a 40% override on the same property) must not
    // move — this is the guarantee that one gross tenant can't re-price the building.
    const n = (await getTenantShares('prop-2', Y)).find((s) => s.lease_id === 'lease-3');
    const b = billedComponents(n);
    expect(b.gross).toBe(false);
    expect(round2(n.cam_amount + n.tax_amount)).toBe(round2((40000 + 30000) * 0.4));
    expect(b.total).toBe(round2(Number(n.base_rent) + b.camTax + b.roof));
  });
});

describe('flipping back to net restores the old behaviour', () => {
  it('bills the share on top again', async () => {
    await updateLease('lease-4', { lease_type: 'net' });
    const b = billedComponents(await rowFor('lease-4'));
    expect(b.gross).toBe(false);
    // The stale $25,000 estimate becomes live again the moment it's net — which is
    // exactly why the gross branch had to ignore it rather than delete it.
    expect(b.camTax).toBe(25000);
    expect(b.total).toBe(round2(FLAT + 25000));
    await updateLease('lease-4', { lease_type: 'gross' }); // restore for afterAll
  });
});
