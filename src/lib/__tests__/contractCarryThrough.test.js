// The contract → CAM → invoice carry-through, and the ONE thing it must never touch.
//
// George, 2026-08-05, twice over:
//   *"like before follow the spine"* — a contract's fee reaches a stored invoice through
//   cam_line_items → expense_records.cam_total → v_tenant_shares → invoices, and the
//   invoice is a FROZEN COPY that does not rebuild itself (CLAUDE.md §1).
//   *"this only affects the ACTUAL CAM and Tax not estimated."*
//
// The second constraint holds because of something that already existed rather than
// something added: billedComponents PREFERS a tenant's estimate and falls back to the
// actual share. Write no estimate and a tenant on one keeps paying it (settling at
// ⚖ Reconcile) while a tenant without one is billed the new actual now. These tests pin
// BOTH halves, because a single well-meaning estimate write on the contract path would
// break them together and nothing on screen would say so.
//
// Demo seed (store.js), year Y = the current year. OAK CENTER (prop-2):
//   svc-1 Snow removal, annual, dated steps → $8,000 in Y
//   svc-2 Landscaping, monthly $1,000 +3%/yr from Y-1 → $12,360 in Y
//   cam_line_items: those two + a hand-typed Janitorial $9,640 = cam_total 30,000
//   lease-3 Northwind Books — share_override 40%, NO estimate
//   lease-4 Sunrise Yoga — mid-year start (Jul 1), no invoice in the seed
import { describe, it, expect, beforeAll } from 'vitest';
import {
  applyNewContractTerms, getServiceContract, updateServiceContract, deleteServiceContract,
  listCamLineItems, getExpenseRecord, getTenantShares, getYearInvoice, ensureInvoice,
  listLeaseEstimates, updateLease, getLease, closeYear, listServiceContracts,
  listContractEscalations, syncContractCamItems,
} from '../api';
import { DEMO_MODE } from '../supabaseClient';
import { currentYear } from '../format';

const Y = currentYear();
const PROP = 'prop-2';
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// The shape ContractDocs hands applyNewContractTerms: exactly the rows the review screen
// rendered, never a second derivation.
const feeChange = (to) => ({
  fields: [{ key: 'amount', label: 'Fee', kind: 'money', billed: true, from: null, to }],
  touchesBilling: true,
});

// est_* on every lease + the whole dated-estimate ledger, as one comparable blob.
async function estimateSnapshot(leaseIds) {
  const out = {};
  for (const id of leaseIds) {
    const l = await getLease(id);
    out[id] = {
      est_cam_annual: l.est_cam_annual ?? null,
      est_tax_annual: l.est_tax_annual ?? null,
      est_roof_annual: l.est_roof_annual ?? null,
      est_confirmed_year: l.est_confirmed_year ?? null,
      rows: (await listLeaseEstimates(id)).length,
    };
  }
  return out;
}

beforeAll(() => { expect(DEMO_MODE).toBe(true); });

describe('the demo seed prices contracts into CAM without moving a penny', () => {
  // The seed exists to be worked from, so its own consistency is the first assertion: the
  // auto CAM rows already equal contractAnnualCost, so the FIRST sync writes nothing.
  it('syncing the seeded year is a no-op — cam_total stays 30,000', async () => {
    const before = await getExpenseRecord(PROP, Y);
    expect(Number(before.cam_total)).toBe(30000);
    const res = await syncContractCamItems(PROP, Y);
    expect(res.changed).toBe(false);
    const after = await getExpenseRecord(PROP, Y);
    expect(Number(after.cam_total)).toBe(30000);
  });

  it('the snow contract is priced by its DATED STEP, not its scalar', async () => {
    const steps = await listContractEscalations('svc-1');
    expect(steps.length).toBe(2);
    const row = (await listCamLineItems(PROP, Y)).find((i) => i.contract_id === 'svc-1');
    expect(Number(row.amount)).toBe(8000);
  });
});

describe('the carry-through reaches a stored invoice', () => {
  it('a tenant with NO estimate: line item → cam_total → share → invoice all move', async () => {
    // Northwind has no estimate, so it is billed the ACTUAL share — 40% by override.
    const lease = await getLease('lease-3');
    expect(lease.est_cam_annual ?? null).toBe(null);

    const inv0 = await ensureInvoice('lease-3', PROP, Y);
    expect(Number(inv0.cam_annual)).toBeCloseTo(round2(30000 * 0.4), 2); // 12,000

    // Double the landscaping fee: $1,000/mo → $2,000/mo. It still carries its own +3%/yr
    // scalar from its Y-1 start, so Y prices at 24,000 × 1.03 = 24,720 and CAM goes
    // 30,000 − 12,360 + 24,720 = 42,360.
    const res = await applyNewContractTerms({
      contractId: 'svc-2', changes: feeChange(2000), plan: { steps: [] },
    });
    expect(res.propertyId).toBe(PROP);
    expect(res.synced).toBe(true);
    expect(res.resynced).toBe(true);

    const item = (await listCamLineItems(PROP, Y)).find((i) => i.contract_id === 'svc-2');
    expect(Number(item.amount)).toBe(24720);

    const exp = await getExpenseRecord(PROP, Y);
    expect(Number(exp.cam_total)).toBe(42360);

    const share = (await getTenantShares(PROP, Y)).find((s) => s.lease_id === 'lease-3');
    expect(Number(share.cam_amount)).toBeCloseTo(round2(42360 * 0.4), 2);

    // ⚠ THE POINT OF THE WHOLE TEST. The Ledger and the Financials breakdown build UP from
    // live data and would have followed on their own; the stored invoice does not.
    const inv1 = await getYearInvoice('lease-3', Y);
    expect(Number(inv1.cam_annual)).toBeCloseTo(round2(42360 * 0.4), 2);
    expect(Number(inv1.cam_annual)).toBeGreaterThan(Number(inv0.cam_annual));
  });

  // ⚠ THE ORDER IS FORCED. resyncYearBillingToEstimate reads v_tenant_shares, which reads
  // expense_records.cam_total — and syncContractCamItems is what MOVES that total. Resync
  // first and every invoice is rebuilt from the OLD CAM, then the total moves under it.
  // This assertion fails the moment anyone swaps the two calls.
  it('the invoice reflects the NEW cam_total, so the sync ran BEFORE the resync', async () => {
    await applyNewContractTerms({ contractId: 'svc-2', changes: feeChange(3000), plan: { steps: [] } });
    const exp = await getExpenseRecord(PROP, Y);
    expect(Number(exp.cam_total)).toBe(round2(30000 - 12360 + 36000 * 1.03)); // 54,720
    const inv = await getYearInvoice('lease-3', Y);
    expect(Number(inv.cam_annual)).toBeCloseTo(round2(Number(exp.cam_total) * 0.4), 2);
  });
});

describe('the ESTIMATE is never touched — George’s constraint, pinned', () => {
  it('no est_* column and no lease_estimates row moves, for either kind of tenant', async () => {
    // One tenant WITH an estimate and one WITHOUT, so both halves are covered.
    await updateLease('lease-4', { est_cam_annual: 9000, est_tax_annual: 0 });
    const before = await estimateSnapshot(['lease-3', 'lease-4']);

    await applyNewContractTerms({ contractId: 'svc-1', changes: feeChange(16000), plan: { steps: [] } });

    const after = await estimateSnapshot(['lease-3', 'lease-4']);
    expect(after).toEqual(before);
  });

  it('a tenant ON an estimate keeps their bill; one without moves', async () => {
    // Sunrise Yoga is on a $9,000 estimate (set above) and starts 1 July, so its invoice is
    // priced from the estimate, prorated — never from the property's CAM.
    await updateLease('lease-4', { est_cam_annual: 9000, est_tax_annual: 0 });
    const yogaBefore = await ensureInvoice('lease-4', PROP, Y);
    const northwindBefore = await getYearInvoice('lease-3', Y);

    // Move the CAM hard: the landscaping fee goes to $5,000/mo.
    await applyNewContractTerms({ contractId: 'svc-2', changes: feeChange(5000), plan: { steps: [] } });

    const yogaAfter = await getYearInvoice('lease-4', Y);
    const northwindAfter = await getYearInvoice('lease-3', Y);

    // The estimate tenant is untouched — they settle the difference at ⚖ Reconcile.
    expect(Number(yogaAfter.cam_annual)).toBeCloseTo(Number(yogaBefore.cam_annual), 2);
    // The actual-share tenant moves now.
    expect(Number(northwindAfter.cam_annual)).toBeGreaterThan(Number(northwindBefore.cam_annual));
  });
});

describe('the fee schedule is replaced only by a document that HAS one', () => {
  // Silence is not an instruction to erase — the same rule the field diff follows. A
  // renewal letter restating the fee as one flat figure must not delete a schedule
  // (hand-added steps among them) that nothing in the document contradicts.
  it('a document with no fee table leaves the existing steps in place', async () => {
    const before = await listContractEscalations('svc-1');
    expect(before.length).toBe(2);
    const res = await applyNewContractTerms({
      contractId: 'svc-1', changes: feeChange(9999), plan: { steps: [] },
    });
    expect(res.feeSteps).toBe(0);
    expect((await listContractEscalations('svc-1')).length).toBe(2);
  });

  it('a document that prints one replaces every step, hand-added included', async () => {
    const res = await applyNewContractTerms({
      contractId: 'svc-1',
      changes: { fields: [], touchesBilling: false },
      plan: { steps: [{ effective_date: `${Y}-01-01`, new_amount: 11000, escalation_type: 'manual', escalation_value: null, source: 'contract', note: null }] },
    });
    expect(res.feeSteps).toBe(1);
    const now = await listContractEscalations('svc-1');
    expect(now.length).toBe(1);
    expect(Number(now[0].new_amount)).toBe(11000);
  });
});

describe('a closed year is left exactly as it was', () => {
  it('the bills do not move under the landlord because he edited a contract', async () => {
    const invBefore = await getYearInvoice('lease-3', Y);
    await closeYear(PROP, Y);

    // Moves the fee through the DATED schedule, so the CAM line item genuinely has to
    // change — otherwise the sync writes nothing and the test proves nothing.
    const res = await applyNewContractTerms({
      contractId: 'svc-1',
      changes: { fields: [], touchesBilling: false },
      plan: { steps: [{ effective_date: `${Y}-01-01`, new_amount: 25000, escalation_type: 'manual', escalation_value: null, source: 'contract', note: null }] },
    });
    // The CAM line item still self-heals (it is a derivation of live data)…
    expect(res.synced).toBe(true);
    // …but nothing was re-billed.
    expect(res.resynced).toBe(false);
    expect(res.closedYear).toBe(true);

    const invAfter = await getYearInvoice('lease-3', Y);
    expect(Number(invAfter.cam_annual)).toBeCloseTo(Number(invBefore.cam_annual), 2);
  });
});

describe('deleting a contract carries through too', () => {
  it('re-sums cam_total instead of leaving the fee in the property’s CAM', async () => {
    // A different, un-closed year so the delete has somewhere to land.
    const year = Y - 1;
    // Price the year first, so the comparison is against what the contracts actually carry
    // rather than against the seed figure (earlier tests in this file have moved the fees).
    await syncContractCamItems(PROP, year);
    const before = await getExpenseRecord(PROP, year);
    const landscaping = (await listCamLineItems(PROP, year)).find((i) => i.contract_id === 'svc-2');
    expect(Number(landscaping.amount)).toBeGreaterThan(0);

    const res = await deleteServiceContract('svc-2', { today: new Date(`${year}-06-15T12:00:00`) });
    expect(res.propertyId).toBe(PROP);
    expect(res.synced).toBe(true);

    // ⚠ THE POINT. The FK cascade removes the derived CAM row, but nothing re-summed
    // cam_total — so a deleted contract's fee used to stay in the property's CAM (and in
    // every tenant's share, and every stored invoice) until somebody happened to open that
    // fiscal year's Expenses page.
    const after = await getExpenseRecord(PROP, year);
    expect(Number(after.cam_total)).toBeCloseTo(Number(before.cam_total) - Number(landscaping.amount), 2);
    expect((await listCamLineItems(PROP, year)).some((i) => i.contract_id === 'svc-2')).toBe(false);
    expect((await listServiceContracts(PROP)).some((c) => c.id === 'svc-2')).toBe(false);
  });
});

describe('updateServiceContract re-arms the notice reminder', () => {
  it('derives notice_by_date from end_date − notice_days and clears the dedupe stamp', async () => {
    await updateServiceContract('svc-1', { cancel_notice_bucket: '1m' });
    await updateServiceContract('svc-1', { notice_days: 45 });
    const c = await getServiceContract('svc-1');
    // The seeded term ends Y+1-10-31; 45 days before that is Y+1-09-16.
    expect(c.notice_by_date).toBe(`${Y + 1}-09-16`);
    expect(c.cancel_notice_bucket).toBe(null);
  });

  it('a date the landlord types beats the derivation', async () => {
    await updateServiceContract('svc-1', { notice_days: 45, notice_by_date: `${Y + 1}-08-01` });
    const c = await getServiceContract('svc-1');
    expect(c.notice_by_date).toBe(`${Y + 1}-08-01`);
  });
});
