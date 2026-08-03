// listCollectedByProperty — the rent that has actually ARRIVED, read end to end against
// the demo mock rather than from a hand-built fixture.
//
// ⚠ WHY THIS FILE EXISTS. `collected` has a twin: the Ledger tab's Collected column. A test
// that only asserted "the bar got a number" would pass while the two drifted, and the
// Overview and the Ledger would then name two different figures for the same property on
// the same day — the one thing this panel's whole design refuses. So the filter is pinned
// from both sides: what it counts, and what it deliberately does not.
import { describe, it, expect, afterEach } from 'vitest';
import {
  listCollectedByProperty, createInvoice, recordPayment, deletePayment, deleteInvoice,
} from '../api';
import { currentYear } from '../format';

const Y = currentYear();
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

describe('listCollectedByProperty — rent that has actually arrived', () => {
  it('sums what came in, and what it was billed against, per property', async () => {
    const out = await listCollectedByProperty(['prop-1', 'prop-2'], Y);
    // Bright Coffee's $78,000 lump + City Dental's 9,150 + 9,150 + 4,000.
    expect(out['prop-1'].collected).toBe(100300);
    expect(out['prop-1'].billed).toBe(187800);
    // Oak Center has no invoices at all — absent rather than fabricated as zeros.
    expect(out['prop-2']).toBeUndefined();
  });

  // ⚠ A reconciliation true-up is real money, but it is NOT on the Ledger's Collected
  // column — that column reads the ANNUAL invoice. Counting it here would make the
  // Overview and the Ledger tab disagree, which is exactly what this filter exists to
  // prevent.
  it('counts the annual invoice only — a reconciliation payment does not move it', async () => {
    const base = (await listCollectedByProperty(['prop-1'], Y))['prop-1'].collected;
    const inv = await createInvoice({
      lease_id: 'lease-2', property_id: 'prop-1', year: Y, kind: 'reconciliation',
      issue_date: `${Y}-06-01`, due_date: `${Y}-07-01`, status: 'sent', total_amount: 700,
    });
    cleanup.push(() => deleteInvoice(inv.id));
    const pay = await recordPayment({ invoice_id: inv.id, lease_id: 'lease-2', amount: 700, paid_date: `${Y}-06-15` });
    cleanup.push(() => deletePayment(pay.id));

    const after = (await listCollectedByProperty(['prop-1'], Y))['prop-1'].collected;
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
    expect((await listCollectedByProperty(['prop-1'], Y))['prop-1'].collected).toBe(100300);
  });

  // A payment recorded today has to reach the bar today — the invalidation set that makes
  // that happen is only worth having if the read itself is live.
  it('picks up a payment the moment it is recorded', async () => {
    const before = (await listCollectedByProperty(['prop-1'], Y))['prop-1'].collected;
    const pay = await recordPayment({ invoice_id: 'inv-2', lease_id: 'lease-2', amount: 1500, paid_date: `${Y}-07-01` });
    cleanup.push(() => deletePayment(pay.id));
    const after = (await listCollectedByProperty(['prop-1'], Y))['prop-1'].collected;
    expect(after - before).toBe(1500);
  });

  it('reads another year without borrowing this one’s figures', async () => {
    expect((await listCollectedByProperty(['prop-1'], Y - 3))['prop-1']).toBeUndefined();
  });

  it('returns an empty map rather than querying for nothing', async () => {
    expect(await listCollectedByProperty([], Y)).toEqual({});
    expect(await listCollectedByProperty(null, Y)).toEqual({});
  });
});
