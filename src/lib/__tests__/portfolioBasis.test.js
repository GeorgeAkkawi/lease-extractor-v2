// The Overview band's figures, read end to end against the demo mock.
//
// ⚠ WHY THIS FILE EXISTS, and it is one assertion more than "the numbers are numbers".
//
// The first version of this band put an ALL-IN projected revenue on screen — base rent plus
// the CAM & tax estimate, prorated to term — and the donut directly beneath it showed base
// rent at the annual rate. On George's portfolio that was $1,155,141 against $1,032,564 for
// the same year, and his first question was the right one: *"why is the projected 800k (where
// is this coming from) and the ovreview pie chart says its only like 700k."* Two headline
// figures on one screen, neither labelled, nothing reconciling them.
//
// So Revenue is now `total_revenue` — the donut's own source — and the first test below pins
// that identity. Everything else here pins the two figures that can be quietly wrong: an
// unanswered over-payment (in no column until the landlord says so) and other income (in
// Total live and in no projection, which is George's own follow-up question answered).
import { describe, it, expect, afterEach } from 'vitest';
import { listBasisByProperty } from '../portfolioBasis';
import { buildIncomeExpense } from '../incomeExpense';
import { billedComponents } from '../reconciliation';
import {
  getPropertyTotals, getTenantShares, ensureInvoice, recordPayment, deletePayment,
  upsertAlertState, getPropertyMonthlyRoll, addOtherIncomeEntry, deleteOtherIncomeEntry,
} from '../api';
import { overpayKey } from '../ledger';
import { currentYear } from '../format';

const Y = currentYear();
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

describe('listBasisByProperty — the bill, read twice', () => {
  // ⚠ INVERTED ON 2026-08-18 (3), AND THE REASON IS THE WHOLE CHANGE. This test used to assert
  // that the loader derived NO rent projection — that `basisRows` took it straight from
  // `v_property_totals`, which made the band-vs-donut identity structural. George's answer to
  // being shown the resulting difference was to remove the difference instead:
  // *"we should make rent projections part of the projected rent because we know what those
  // numbers are so that shouldn't be a discrepancy."* `sum(effective_rent)` is one annual RATE
  // per lease across all twelve months, so it dated no applied raise and could not see a
  // scheduled one. The loader now derives the year from the leases' own schedules, and the
  // identity survives because THE DONUT READS THIS SAME FIGURE — see `portfolioCharts.test.js`.
  it('derives the year from the leases’ own months, not the view’s annual rate', async () => {
    const basis = await listBasisByProperty(['prop-1'], Y);
    const totals = await getPropertyTotals('prop-1', Y);
    expect(Number(totals.total_revenue), 'the seed must bill rent, or this proves nothing').toBeGreaterThan(0);
    expect(basis['prop-1'].rentProjected).toBeGreaterThan(0);
    // The two halves, both stated: the contracted year plus the months a scheduled step will
    // re-price. The demo seeds one unswept step (esc-1, +3% on Bright Coffee), so the second
    // half is real here rather than a zero that would let the addition go untested.
    expect(basis['prop-1'].projectedAhead).toBeGreaterThan(0);
    expect(basis['prop-1'].rentProjected)
      .toBe(round2(basis['prop-1'].rentScheduled + basis['prop-1'].projectedAhead));
    // …and it is genuinely NOT the view. If these ever coincide the assertion above stops
    // distinguishing anything, which is the failure mode that matters.
    expect(basis['prop-1'].rentProjected).not.toBe(round2(Number(totals.total_revenue)));
    // Total is still assembled by `basisRows`, not here.
    expect(basis['prop-1'].totalProjected).toBeUndefined();
  });

  // ⚠ `billedComponents` IS THE SINGLE RULE for "estimate where one is set, actual share where
  // it isn't" — the same function the invoice, the Ledger and the workbook price from. A second
  // copy here is exactly how the band would come to quote a different bill from the bill.
  it('bills CAM, tax and roof at the estimate, through the invoice’s own function', async () => {
    const shares = await getTenantShares('prop-1', Y);
    const expected = round2(shares.reduce((s, sh) => {
      const b = billedComponents(sh);
      return s + Number(b.camTax) + Number(b.roof);
    }, 0));
    expect(expected, 'the seed must bill something, or this proves nothing').toBeGreaterThan(0);

    const basis = await listBasisByProperty(['prop-1'], Y);
    expect(basis['prop-1'].camTaxProjected).toBe(expected);
  });

  // The live side still comes off the workbook's own collected pass, so the band and the
  // Income-and-expenses sheet cannot report different cash for one year.
  it('reads live cash through the same pass the live workbook uses', async () => {
    const wb = await buildIncomeExpense('corp-1', Y, { basis: 'live' });
    const p = wb.properties.find((x) => x.id === 'prop-1');
    const basis = await listBasisByProperty(['prop-1'], Y);
    expect(basis['prop-1'].rentLive).toBe(round2(p.rent));
    expect(basis['prop-1'].camTaxLive).toBe(round2(p.camTaxBilled + p.roofBilled));
    expect(basis['prop-1'].rentLive).toBeGreaterThan(0);
  });

  it('is empty rather than fabricated when asked for nothing', async () => {
    expect(await listBasisByProperty([], Y)).toEqual({});
    expect(await listBasisByProperty(null, Y)).toEqual({});
  });
});

// ⚠ GEORGE'S FOLLOW-UP QUESTION, ANSWERED IN CODE: *"what happens when a landlord has other
// sources of income."* `other_income` (0078) rides no invoice, and the app forecasts none of
// it — so it can only land on the live side. Total live has to equal the bank, so it goes IN
// there; the band names it separately so a Total that outgrew the two columns above it never
// reads as an unexplained figure.
describe('other income — real money that nothing projects', () => {
  it('reaches the live side and no projection', async () => {
    const before = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    const row = await addOtherIncomeEntry({
      property_id: 'prop-2', year: Y, category: 'parking', amount: 1800,
      txn_date: `${Y}-05-09`, note: 'Lot rental',
    });
    cleanup.push(() => deleteOtherIncomeEntry(row.id));

    const after = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    expect(after.otherLive).toBe(round2(before.otherLive + 1800));
    // It bills nothing, so nothing it does may touch what the leases charge.
    expect(after.camTaxProjected).toBe(before.camTaxProjected);
    expect(after.rentLive).toBe(before.rentLive);
  });

  // ⚠ AN UNDATED ROW IS STILL REAL MONEY. `listOtherIncome` treats a NULL year as belonging to
  // every year, and the bulk read has to copy that rule exactly — filtering it out in SQL would
  // drop precisely the income a landlord entered least carefully.
  it('counts a row with no year on it, exactly as the per-property read does', async () => {
    const before = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    const row = await addOtherIncomeEntry({
      property_id: 'prop-2', category: 'other', amount: 400, note: 'Undated',
    });
    cleanup.push(() => deleteOtherIncomeEntry(row.id));
    const after = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    expect(after.otherLive).toBe(round2(before.otherLive + 400));
  });
});

// ⚠ THE HOLD-BACK, unchanged from the round that introduced it and re-pinned here because the
// loader was rewritten around it. George: *"any over or undercharges only counts towards live
// count."* The under side needs nothing — a short month is simply short. The over side does:
// money beyond what a month billed is not that month's revenue until the landlord says so.
describe('an unanswered over-payment reaches the live counter only once answered', () => {
  it('holds the surplus out, names it, and lets it in when confirmed', async () => {
    const inv = await ensureInvoice('lease-3', 'prop-2', Y);
    const roll = await getPropertyMonthlyRoll('prop-2', Y);
    const row = roll.find((r) => r.lease_id === 'lease-3');
    const owed = round2(Number(row.schedule[6].owed) || 0);
    expect(owed, 'the month must bill something, or the whole cheque is surplus').toBeGreaterThan(0);

    const before = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    const beforeIn = round2(before.rentLive + before.camTaxLive + before.chargesLive);

    const pay = await recordPayment({
      invoice_id: inv.id, lease_id: 'lease-3', amount: round2(owed + 2500),
      paid_date: `${Y}-06-05`, method: 'check', period_month: 6, source: 'manual',
    });
    cleanup.push(() => deletePayment(pay.id));

    const held = (await listBasisByProperty(['prop-2'], Y))['prop-2'];
    const heldIn = round2(held.rentLive + held.camTaxLive + held.chargesLive);
    // The month's own bill is in. The $2,500 on top is in NOTHING — that is the point.
    expect(heldIn).toBe(round2(beforeIn + owed));
    expect(held.unapplied).toBe(round2(before.unapplied + 2500));

    // …and answering it on the Ledger moves exactly that figure, no more.
    const key = overpayKey('lease-3', Y, 6, 2500);
    await upsertAlertState({ alert_key: key, dismissed: true });
    cleanup.push(() => upsertAlertState({ alert_key: key, dismissed: false }));

    const answered = (await listBasisByProperty(['prop-2'], Y, { confirmed: new Set([key]) }))['prop-2'];
    const answeredIn = round2(answered.rentLive + answered.camTaxLive + answered.chargesLive);
    expect(answeredIn).toBe(round2(heldIn + 2500));
    expect(answered.unapplied).toBe(before.unapplied);
  });

  // ⚠ THE ROLL IS READ WITHOUT `includeScheduled`, and this is what would break if it weren't.
  // `monthExcess` decides "more arrived than was billed" against `alloc.owed`; priced against a
  // rent step NOBODY HAS BEEN CHARGED FOR, a real surplus shrinks or vanishes and the hold-back
  // silently stops holding anything. It only shows on a lease with an unswept step — the demo
  // seeds exactly one (esc-1, +3% on Bright Coffee), which is why this lives on prop-1.
  it('measures the surplus against what was BILLED, not against a projection', async () => {
    const contracted = await getPropertyMonthlyRoll('prop-1', Y);
    const projected = await getPropertyMonthlyRoll('prop-1', Y, { includeScheduled: true });
    const M = 11; // after the step, where the two schedules genuinely disagree
    const asBilled = round2(Number(contracted.find((r) => r.lease_id === 'lease-1').schedule[M].owed) || 0);
    const asProjected = round2(Number(projected.find((r) => r.lease_id === 'lease-1').schedule[M].owed) || 0);
    expect(asProjected).toBeGreaterThan(asBilled);
    // Smaller than the step, so it is an over-payment against the bill and would read as an
    // UNDER-payment against the projection.
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
