// The Overview's projected-vs-live figures, read end to end against the demo mock.
//
// ⚠ WHY THIS FILE EXISTS, and it is one assertion more than "the numbers are numbers".
// The panel this feeds replaced one whose two bars measured DIFFERENT MONEY — base-rent-only
// Revenue beside all-in Collected — and had to print a paragraph apologising for it. The
// repair is that both halves of each pair now come out of the same functions the
// Income-and-expenses workbook is built from. That only stays true if something checks: a
// second implementation drifts silently, because nothing compares them (CLAUDE.md §3).
//
// So the first two tests below are the pin. If someone ever "optimises" this loader into a
// cheaper query, they go red, and the Overview and the workbook cannot quietly start naming
// two different figures for one year.
import { describe, it, expect, afterEach } from 'vitest';
import { listBasisByProperty } from '../portfolioBasis';
import { buildIncomeExpense, billedRowsFromRoll, contractedRoll } from '../incomeExpense';
import {
  getPropertyTotals, ensureInvoice, recordPayment, deletePayment, addCamLineItem,
  deleteCamLineItem, upsertAlertState, getPropertyMonthlyRoll, addAdjustment, deleteAdjustment,
} from '../api';
import { overpayKey } from '../ledger';
import { currentYear } from '../format';

const Y = currentYear();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

/** The workbook's own figure for one property, on one basis. */
async function workbook(corpId, propId, basis) {
  const wb = await buildIncomeExpense(corpId, Y, { basis });
  return wb.properties.find((p) => p.id === propId);
}

/** What this loader sums — the five components of the bill, no other income. */
const billFrom = (p) => round2(p.rent + p.camTaxBilled + p.roofBilled + p.charges + p.carried);

describe('listBasisByProperty — one measure, read twice', () => {
  it('projects exactly what the projected workbook bills, to the cent', async () => {
    const [basis, wb] = await Promise.all([
      listBasisByProperty(['prop-1'], Y),
      workbook('corp-1', 'prop-1', 'projected'),
    ]);
    expect(basis['prop-1'].projectedRevenue).toBe(billFrom(wb));
    // Not vacuously equal to zero, and not vacuously equal to the view's own figure either —
    // this is all-in, and `total_revenue` is base rent only.
    expect(basis['prop-1'].projectedRevenue).toBeGreaterThan(0);
    const totals = await getPropertyTotals('prop-1', Y);
    expect(basis['prop-1'].projectedRevenue).toBeGreaterThan(Number(totals.total_revenue));
  });

  it('reads live exactly what the live workbook collects, to the cent', async () => {
    const [basis, wb] = await Promise.all([
      listBasisByProperty(['prop-1'], Y),
      workbook('corp-1', 'prop-1', 'live'),
    ]);
    expect(basis['prop-1'].liveRevenue).toBe(billFrom(wb));
    expect(basis['prop-1'].liveRevenue).toBeGreaterThan(0);
  });

  // ⚠ THE WHOLE REASON THE PROJECTED SIDE COSTS A ROLL READ. George, on the workbook:
  // *"there should be a projected at the beginning of the year, which shows any
  // escalations."* `effective_rent` — and so `total_revenue`, and so every figure the
  // Overview used to draw — knows only APPLIED steps (0054), so a raise dated later this
  // year is invisible to it. The demo's esc-1 is exactly that: +3% on Bright Coffee,
  // scheduled, not yet swept.
  it('counts a rent step that has not taken effect yet, which the view cannot', async () => {
    const roll = await getPropertyMonthlyRoll('prop-1', Y, { includeScheduled: true });
    const ahead = round2(roll.reduce((s, r) => s + (Number(r.projectedAhead) || 0), 0));
    expect(ahead, 'the demo seeds a scheduled step — without one this test proves nothing').toBeGreaterThan(0);

    // The projected figure is ahead of what the leases bill TODAY by exactly that step —
    // measured against the same roll with the projection stripped back off, so the only
    // difference between the two sides is the thing being tested.
    const projected = billedRowsFromRoll(roll);
    const asBilled = billedRowsFromRoll(contractedRoll(roll));
    const total = (r) => round2(['rent', 'camTax', 'roof', 'charges', 'carried']
      .reduce((s, k) => s + r[k].reduce((t, x) => t + x.total, 0), 0));
    expect(round2(total(projected) - total(asBilled))).toBe(ahead);

    const basis = await listBasisByProperty(['prop-1'], Y);
    expect(basis['prop-1'].projectedRevenue).toBe(total(projected));
  });

  // ⚠ THE PIN ABOVE ONLY COVERS THE COMPONENTS THE SEED HAPPENS TO USE, and two of the five
  // are $0 on it: a fee or concession (`charges`) and a balance brought forward or refunded
  // (`carried`). Drop either from the loader's sum and every test in this file still passes —
  // measured, not assumed. So both are posted here, and the workbook equality is re-asserted
  // with all five carrying a figure. `carried` is the one that matters most: it is real money
  // the tenant owes that is NOT this year's income, and a sum that quietly skipped it would
  // put the Overview and the workbook a whole adjustment apart.
  it('counts a fee and a carried balance too, not just the components the seed uses', async () => {
    const fee = await addAdjustment({
      leaseId: 'lease-3', propertyId: 'prop-2', year: Y, month: 3,
      kind: 'fee', amount: 275, memo: 'Late fee',
    });
    expect(fee.refused, fee.message).toBeFalsy();
    cleanup.push(() => deleteAdjustment(fee.row?.id ?? fee.id));
    const carried = await addAdjustment({
      leaseId: 'lease-3', propertyId: 'prop-2', year: Y, month: 1,
      kind: 'opening', amount: 640, memo: 'Brought forward',
    });
    expect(carried.refused, carried.message).toBeFalsy();
    cleanup.push(() => deleteAdjustment(carried.row?.id ?? carried.id));

    const [basis, wb] = await Promise.all([
      listBasisByProperty(['prop-2'], Y),
      workbook('corp-2', 'prop-2', 'projected'),
    ]);
    // Both are genuinely on the sheet, so the equality below is testing all five components.
    expect(wb.charges).not.toBe(0);
    expect(wb.carried).not.toBe(0);
    expect(basis['prop-2'].projectedRevenue).toBe(billFrom(wb));
  });

  it('is empty rather than fabricated when asked for nothing', async () => {
    expect(await listBasisByProperty([], Y)).toEqual({});
    expect(await listBasisByProperty(null, Y)).toEqual({});
  });
});

// ⚠ THE HOLD-BACK, MEASURED THROUGH THIS LOADER. George, 2026-08-18: *"any over or
// undercharges only counts towards live count."* The under side needs nothing — a short
// month is simply short. The OVER side does: money arriving beyond what a month billed is
// not that month's revenue until the landlord says it is (2026-08-17), and the Overview's
// live counter has to honour that or the decision it asks for means nothing.
describe('an unanswered over-payment reaches the live counter only once answered', () => {
  it('holds the surplus out, names it, and lets it in when confirmed', async () => {
    const inv = await ensureInvoice('lease-3', 'prop-2', Y);
    const roll = await getPropertyMonthlyRoll('prop-2', Y);
    const row = roll.find((r) => r.lease_id === 'lease-3');
    const owed = round2(Number(row.schedule[6].owed) || 0);
    expect(owed, 'the month must bill something, or the whole cheque is surplus').toBeGreaterThan(0);

    const before = (await listBasisByProperty(['prop-2'], Y))['prop-2'];

    const pay = await recordPayment({
      invoice_id: inv.id, lease_id: 'lease-3', amount: round2(owed + 2500),
      paid_date: `${Y}-06-05`, method: 'check', period_month: 6, source: 'manual',
    });
    cleanup.push(() => deletePayment(pay.id));

    const held = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    // The month's own bill is in. The $2,500 on top is in NOTHING — that is the point.
    expect(held.liveRevenue).toBe(round2(before.liveRevenue + owed));
    expect(held.unapplied).toBe(round2(before.unapplied + 2500));

    // …and answering it on the Ledger moves exactly that figure, no more.
    const key = overpayKey('lease-3', Y, 6, 2500);
    await upsertAlertState({ alert_key: key, dismissed: true });
    cleanup.push(() => upsertAlertState({ alert_key: key, dismissed: false }));

    const answered = (await listBasisByProperty(['prop-2'], Y, {
      confirmed: new Set([key]),
    }))['prop-2'];
    expect(answered.liveRevenue).toBe(round2(held.liveRevenue + 2500));
    expect(answered.unapplied).toBe(before.unapplied);
  });

  // ⚠ THE PROBE THE TEST ABOVE CANNOT RUN, and the reason this one exists on prop-1 rather
  // than beside it. The loader reads ONE roll — WITH the projection, which the projected
  // figure needs — and hands the live pass `contractedRoll` to strip it off. Drop that and
  // `monthExcess` starts measuring "more arrived than was billed" against a rent step NOBODY
  // HAS BEEN BILLED FOR, so a real surplus shrinks or disappears and the hold-back silently
  // stops holding anything back. It shows up only on a lease with an unswept step — the demo
  // seeds exactly one (esc-1, +3% on Bright Coffee) — which is why prop-2 above goes green
  // either way and proves nothing about it.
  it('measures the surplus against what was BILLED, not against the projection', async () => {
    const contracted = await getPropertyMonthlyRoll('prop-1', Y);
    const projected = await getPropertyMonthlyRoll('prop-1', Y, { includeScheduled: true });
    const cRow = contracted.find((r) => r.lease_id === 'lease-1');
    const pRow = projected.find((r) => r.lease_id === 'lease-1');
    // A month AFTER the step, where the two schedules genuinely disagree — without that gap
    // this test is measuring nothing.
    const M = 11;
    const asBilled = round2(Number(cRow.schedule[M].owed) || 0);
    const asProjected = round2(Number(pRow.schedule[M].owed) || 0);
    expect(asProjected).toBeGreaterThan(asBilled);
    // The surplus is deliberately SMALLER than the step, so it is a real over-payment
    // against the bill and reads as an UNDER-payment against the projection.
    const surplus = round2((asProjected - asBilled) / 2);
    expect(surplus).toBeGreaterThan(0);

    const inv = await ensureInvoice('lease-1', 'prop-1', Y);
    const before = (await listBasisByProperty(['prop-1'], Y))['prop-1'];
    const pay = await recordPayment({
      invoice_id: inv.id, lease_id: 'lease-1', amount: round2(asBilled + surplus),
      paid_date: `${Y}-11-04`, method: 'check', period_month: M, source: 'manual',
    });
    cleanup.push(() => deletePayment(pay.id));

    const after = (await listBasisByProperty(['prop-1'], Y))['prop-1'];
    expect(after.unapplied).toBe(round2(before.unapplied + surplus));
  });
});

// ⚠ THE EXPENSE HALF, AND ITS ONE HONEST CAVEAT. `paid_date` is nullable and never
// backfilled (0074), so "not dated" is not "not spent" — it is "we don't know the day". The
// loader therefore returns BOTH sums, so the caller can name the undated remainder against
// the stored total rather than quietly reporting a cheap year.
describe('live expenses count what has actually left the bank', () => {
  const add = async (patch) => {
    const it = await addCamLineItem({ property_id: 'prop-2', year: Y, label: 'Test line', amount: 1000, ...patch });
    cleanup.push(() => deleteCamLineItem(it.id, 'prop-2', Y));
    return it;
  };

  it('counts a line dated on or before today, and not one dated ahead of it', async () => {
    const before = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    await add({ paid_date: `${Y}-01-15` });
    const withPast = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    expect(withPast.spentToDate).toBe(round2(before.spentToDate + 1000));
    expect(withPast.spentDated).toBe(round2(before.spentDated + 1000));

    // A cost dated in the future has been ENTERED, not paid. It belongs to the year's
    // projection and to no "so far" figure.
    await add({ paid_date: `${Y + 1}-01-15`, label: 'Next year’s cheque' });
    const withFuture = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    expect(withFuture.spentToDate).toBe(withPast.spentToDate);
    expect(withFuture.spentDated).toBe(round2(withPast.spentDated + 1000));
  });

  // ⚠ AND AN UNDATED ONE IS IN NEITHER — which is exactly why `spentDated` exists: the
  // caller subtracts it from the stored total to name what has no day on it.
  it('leaves an undated line out of both sums, so the gap can be stated', async () => {
    const before = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    await add({ label: 'Hand-typed, no date' });
    const after = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    expect(after.spentToDate).toBe(before.spentToDate);
    expect(after.spentDated).toBe(before.spentDated);
  });

  // ⚠ IT MUST COUNT THE SAME LINES `cam_total` DOES, or the pair is measured two ways and
  // part of the gap between projected and live is an artefact of the filter rather than a
  // fact about the year. A not-billed cost is in neither — the same rule syncCamTotal keeps.
  it('skips a not-billed CAM line, exactly as the CAM total does', async () => {
    const before = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    await add({ paid_date: `${Y}-02-02`, billable: false, label: 'Absorbed by the owner' });
    const after = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    expect(after.spentToDate).toBe(before.spentToDate);
    expect(after.spentDated).toBe(before.spentDated);
  });
});
