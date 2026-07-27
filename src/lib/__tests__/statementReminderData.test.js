// fetchAlertData → buildAlerts, end to end: both ledger reminders must survive the real
// query + aggregation, not just the pure month math (unloggedMonths.test.js).
//
// Runs against the demo mock (forced by the vite test env), whose seed mirrors the live
// shape: prop-1 carries inv-1 (Bright Coffee, one UNTAGGED $78,000 lump that FIFO-fills
// all twelve months) and inv-2 (City Dental, Jan/Feb tagged + a $4,000 March partial).
// Because Bright's lump puts money on every month, prop-1 starts fully logged — which is
// itself worth pinning: a property with nothing outstanding must raise NOTHING.
//
// The clock is pinned to August 15 so "which months have closed" is deterministic; only
// Date is faked, so the mock's promises still resolve normally.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { fetchAlertData, listPayments } from '../api';
import { buildAlerts } from '../alerts';
import { supabase } from '../supabaseClient';
import { currentYear } from '../format';

const Y = currentYear();

const focus = (data, f) => buildAlerts(data, undefined, new Date()).filter((a) => a.focus === f);

beforeAll(() => {
  // Date only — faking timers would stall the mock's async query builder.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${Y}-08-15T12:00:00`)); // Jan–Jul closed, Aug still running
});
afterAll(() => vi.useRealTimers());

describe('the two ledger reminders, against the demo mock', () => {
  it('a fully-logged property raises nothing at all', async () => {
    const data = await fetchAlertData({ ledgerOn: true });
    expect(data.unloggedMonths.find((u) => u.property_id === 'prop-1')).toBeUndefined();
    expect(data.missingPayments).toEqual([]);
    expect(focus(data, 'statement_reminder')).toHaveLength(0);
    expect(focus(data, 'missing_payment')).toHaveLength(0);
  });

  it('with the lump gone, ONE statement reminder covers the property — never one per tenant', async () => {
    // Drop Bright Coffee's untagged lump so prop-1's months lose their cover. City Dental
    // still has Jan/Feb tagged + a March partial, so the surviving months prove the alert
    // reads real allocation rather than "no payments at all".
    const before = await listPayments('inv-1');
    await supabase.from('payments').delete().eq('invoice_id', 'inv-1');
    try {
      const data = await fetchAlertData({ ledgerOn: true });
      const alerts = focus(data, 'statement_reminder');

      // prop-1 bills two tenants every month. The old alert raised one row per tenant.
      expect(alerts.filter((a) => a.property_id === 'prop-1')).toHaveLength(1);

      const a = alerts.find((x) => x.property_id === 'prop-1');
      expect(a.year).toBe(Y);
      expect(a.months).toEqual([4, 5, 6, 7]); // Jan/Feb/Mar carry City Dental's money
      expect(a.months).not.toContain(8); // August is still running
      // It reads as the landlord's to-do, never as an accusation.
      expect(`${a.title} ${a.detail}`).not.toMatch(/behind|late|overdue|unpaid/i);
      expect(a.detail).toContain('log payments and expenses');
      expect(a.corporation_id).toBe('corp-1');
      // Nothing was imported, so no tenant is accused of missing a reconciled month.
      expect(data.missingPayments).toEqual([]);
    } finally {
      for (const p of before) {
        await supabase.from('payments').insert({
          id: p.id, owner_id: p.owner_id, invoice_id: p.invoice_id, amount: p.amount,
          paid_date: p.paid_date, method: p.method, note: p.note, period_month: p.period_month,
        });
      }
    }
  });

  it('once July IS imported, the tenant absent from it is named', async () => {
    const before = await listPayments('inv-1');
    await supabase.from('payments').delete().eq('invoice_id', 'inv-1');
    // City Dental's July deposit, arriving via a statement import — this is what proves
    // July was reconciled against the bank rather than ticked by hand.
    await supabase.from('payments').insert({
      id: 'pay-test-import', owner_id: before[0]?.owner_id, invoice_id: 'inv-2', amount: 9150,
      paid_date: `${Y}-07-06`, method: 'ach', note: null, period_month: 7, import_id: 'imp-test',
    });
    try {
      const data = await fetchAlertData({ ledgerOn: true });

      const missing = focus(data, 'missing_payment');
      expect(missing).toHaveLength(1);
      expect(missing[0].title).toBe('No payment recorded — Bright Coffee Co.');
      expect(missing[0].months).toEqual([7]);
      expect(missing[0].detail).toContain('July is imported with no payment from this tenant');
      expect(missing[0].property_id).toBe('prop-1');

      // July is now logged, so the statement reminder drops it — the two never overlap.
      const reminder = focus(data, 'statement_reminder').find((a) => a.property_id === 'prop-1');
      expect(reminder.months).toEqual([4, 5, 6]);
    } finally {
      await supabase.from('payments').delete().eq('id', 'pay-test-import');
      for (const p of before) {
        await supabase.from('payments').insert({
          id: p.id, owner_id: p.owner_id, invoice_id: p.invoice_id, amount: p.amount,
          paid_date: p.paid_date, method: p.method, note: p.note, period_month: p.period_month,
        });
      }
    }
  });

  it('Rent Ledger module off → neither list is even fetched', async () => {
    const data = await fetchAlertData({ ledgerOn: false });
    expect(data.unloggedMonths).toEqual([]);
    expect(data.missingPayments).toEqual([]);
  });
});
