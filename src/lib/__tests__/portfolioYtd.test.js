// listLedgerYtdByProperty — the CASH side of the Overview's performance panel, read
// end to end against the demo mock rather than from a hand-built fixture.
//
// ⚠ WHY THIS FILE EXISTS. Every figure here has a twin somewhere else in the app, and a
// test that only asserted "the bars got some numbers" would pass while each twin drifted:
//   • `collected` must BE the Ledger tab's Collected column — same invoices, same filter.
//   • `paidToDate` must count exactly the lines that feed the stored expense totals, or
//     the "Paid" bar could climb ABOVE the "Expenses" bar it sits beside.
//   • an UNDATED line must be counted as neither, so the caller can state it out loud
//     instead of letting "Kept" quietly read as profit.
// Each is pinned as its own case, and every assertion is date-independent (todayIso is
// passed explicitly) so the suite doesn't change answer in January.
import { describe, it, expect, afterEach } from 'vitest';
import {
  listLedgerYtdByProperty, createInvoice, recordPayment, deletePayment, deleteInvoice,
  addCamLineItem, deleteCamLineItem, getExpenseRecord,
} from '../api';
import { revenueExpensesNoi } from '../portfolioCharts';
import { currentYear } from '../format';

const Y = currentYear();
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

describe('listLedgerYtdByProperty — money that has actually moved', () => {
  it('sums what came in against the year, per property', async () => {
    const out = await listLedgerYtdByProperty(['prop-1', 'prop-2'], Y, `${Y}-06-01`);
    // Bright Coffee's $78,000 lump + City Dental's 9,150 + 9,150 + 4,000.
    expect(out['prop-1'].collected).toBe(100300);
    expect(out['prop-1'].billed).toBe(187800);
    // Oak Center has no invoices at all — absent rather than fabricated as zeros.
    expect(out['prop-2']).toBeUndefined();
  });

  it('splits dated expense lines around TODAY and leaves undated ones out of both', async () => {
    // Maple's seeded lines: CAM Jan 22 ($4,000) + Apr 18 ($8,000), roof May 14 ($1,500)
    // + Aug 27 ($2,500), and an undated "Security" ($6,000).
    const mid = (await listLedgerYtdByProperty(['prop-1'], Y, `${Y}-06-01`))['prop-1'];
    expect(mid.paidToDate).toBe(13500);
    expect(mid.datedLater).toBe(2500);

    // Same rows, read on January 1st: nothing has been paid yet, and not a cent has
    // moved between the two buckets by accident.
    const jan = (await listLedgerYtdByProperty(['prop-1'], Y, `${Y}-01-01`))['prop-1'];
    expect(jan.paidToDate).toBe(0);
    expect(jan.datedLater).toBe(16000);
    expect(jan.paidToDate + jan.datedLater).toBe(mid.paidToDate + mid.datedLater);
  });

  // ⚠ The "Paid" bar must never be able to climb above the "Expenses" bar beside it, so it
  // counts EXACTLY the lines the stored totals were summed from — syncCamTotal drops
  // billable === false ("not billed to tenants" buckets are tracked but never roll into
  // cam_total), so this drops them too. The demo seeds a $1,200 non-billable line, dated,
  // precisely so a naive sum would read $17,200 here.
  it('ignores a non-billable CAM line, exactly as the stored CAM total does', async () => {
    const ytd = (await listLedgerYtdByProperty(['prop-1'], Y, `${Y}-12-31`))['prop-1'];
    expect(ytd.paidToDate).toBe(16000);
    const rec = await getExpenseRecord('prop-1', Y);
    const fullYear = Number(rec.taxes_total) + Number(rec.cam_total) + Number(rec.roof_total);
    expect(ytd.paidToDate).toBeLessThanOrEqual(fullYear);
  });

  // A brand-new dated line moves "Paid" and shrinks the undated remainder by the same
  // amount — the two always account for the whole stored total between them.
  it('a newly dated line moves out of "undated" and into "paid", to the cent', async () => {
    const before = revenueExpensesNoi(
      [{ id: 'prop-1', name: 'Maple Plaza' }],
      { 'prop-1': await totalsRow() },
      await listLedgerYtdByProperty(['prop-1'], Y, `${Y}-06-01`)
    )[0];

    const line = await addCamLineItem({ property_id: 'prop-1', year: Y, label: 'Window cleaning', amount: 900, paid_date: `${Y}-03-05` });
    cleanup.push(() => deleteCamLineItem(line.id, 'prop-1', Y));

    const after = revenueExpensesNoi(
      [{ id: 'prop-1', name: 'Maple Plaza' }],
      { 'prop-1': await totalsRow() },
      await listLedgerYtdByProperty(['prop-1'], Y, `${Y}-06-01`)
    )[0];

    expect(after.Paid - before.Paid).toBe(900);
    // The stored total grew by the same $900, so the undated remainder is untouched —
    // this line was never in it.
    expect(after.Expenses - before.Expenses).toBe(900);
    expect(after.expensesUndated).toBe(before.expensesUndated);
    expect(after.Paid + after.expensesLater + after.expensesUndated).toBe(after.Expenses);
  });

  // ⚠ A reconciliation true-up is real money, but it is NOT on the Ledger's Collected
  // column — that column reads the ANNUAL invoice. Counting it here would make the
  // Overview and the Ledger tab disagree about the same property on the same day, which
  // is the one thing this chart's whole design refuses.
  it('counts the annual invoice only — a reconciliation payment does not move it', async () => {
    const base = (await listLedgerYtdByProperty(['prop-1'], Y, `${Y}-06-01`))['prop-1'].collected;
    const inv = await createInvoice({
      lease_id: 'lease-2', property_id: 'prop-1', year: Y, kind: 'reconciliation',
      issue_date: `${Y}-06-01`, due_date: `${Y}-07-01`, status: 'sent', total_amount: 700,
    });
    cleanup.push(() => deleteInvoice(inv.id));
    const pay = await recordPayment({ invoice_id: inv.id, lease_id: 'lease-2', amount: 700, paid_date: `${Y}-06-15` });
    cleanup.push(() => deletePayment(pay.id));

    const after = (await listLedgerYtdByProperty(['prop-1'], Y, `${Y}-06-01`))['prop-1'].collected;
    expect(after).toBe(base);
  });

  it('a voided annual invoice stops counting, like everywhere else in the app', async () => {
    const inv = await createInvoice({
      lease_id: 'lease-1', property_id: 'prop-1', year: Y, kind: 'annual',
      issue_date: `${Y}-01-01`, status: 'void', total_amount: 50000,
    });
    cleanup.push(() => deleteInvoice(inv.id));
    const pay = await recordPayment({ invoice_id: inv.id, lease_id: 'lease-1', amount: 5000, paid_date: `${Y}-02-01` });
    cleanup.push(() => deletePayment(pay.id));
    expect((await listLedgerYtdByProperty(['prop-1'], Y, `${Y}-06-01`))['prop-1'].collected).toBe(100300);
  });

  it('returns an empty map rather than querying for nothing', async () => {
    expect(await listLedgerYtdByProperty([], Y)).toEqual({});
    expect(await listLedgerYtdByProperty(null, Y)).toEqual({});
  });
});

async function totalsRow() {
  const r = await getExpenseRecord('prop-1', Y);
  return {
    total_revenue: 0, noi: 0,
    taxes_total: r?.taxes_total || 0, cam_total: r?.cam_total || 0, roof_total: r?.roof_total || 0,
  };
}
