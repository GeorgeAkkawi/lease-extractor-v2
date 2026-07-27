// fetchAlertData → buildAlerts, end to end: the statement reminder must survive the
// real query + aggregation, not just the pure month math (unloggedMonths.test.js).
//
// Runs against the demo mock (forced by the vite test env), whose seed mirrors the live
// shape: prop-1 carries inv-1 (Bright Coffee, one UNTAGGED $78,000 lump that FIFO-fills
// all twelve months) and inv-2 (City Dental, Jan/Feb tagged + a $4,000 March partial).
// Because Bright's lump puts money on every month, prop-1 starts fully logged — which is
// itself worth pinning: a property with nothing outstanding must raise NOTHING.
//
// Written to be date-independent. The exact months change as the calendar moves, so the
// assertions are the invariants George asked for: never the month still running, and one
// alert per property rather than one per tenant.
import { describe, it, expect } from 'vitest';
import { fetchAlertData, listPayments } from '../api';
import { buildAlerts } from '../alerts';
import { supabase } from '../supabaseClient';
import { currentYear } from '../format';

const Y = currentYear();
const thisMonth = new Date().getMonth() + 1; // 1-12, local

const remindersIn = (data) =>
  buildAlerts(data, undefined, new Date()).filter((a) => a.focus === 'statement_reminder');

describe('statement reminder, against the demo mock', () => {
  it('a fully-logged property raises nothing at all', async () => {
    const data = await fetchAlertData({ ledgerOn: true });
    expect(data.unloggedMonths.find((u) => u.property_id === 'prop-1')).toBeUndefined();
    expect(remindersIn(data)).toHaveLength(0);
  });

  it('with the lump removed, ONE reminder covers the property — never one per tenant', async () => {
    // Drop Bright Coffee's untagged lump so prop-1's earlier months lose their cover.
    // City Dental still has Jan/Feb tagged + a March partial, so the surviving months
    // prove the alert reads real allocation rather than "no payments at all".
    const before = await listPayments('inv-1');
    await supabase.from('payments').delete().eq('invoice_id', 'inv-1');
    try {
      const data = await fetchAlertData({ ledgerOn: true });
      const alerts = remindersIn(data);

      // prop-1 has two tenants billing every month. The old alert raised one per tenant.
      expect(alerts.filter((a) => a.property_id === 'prop-1')).toHaveLength(1);

      const a = alerts.find((x) => x.property_id === 'prop-1');
      expect(a.months.length).toBeGreaterThan(0);
      expect(a.year).toBe(Y);
      // The month still in progress can't have a statement yet — the whole point.
      expect(a.months).not.toContain(thisMonth);
      expect(a.months.every((m) => m < thisMonth)).toBe(true);
      // Jan and Feb are settled by City Dental's tagged cheques, so they're logged.
      expect(a.months).not.toContain(1);
      expect(a.months).not.toContain(2);
      // It reads as the landlord's to-do, never as an accusation.
      expect(`${a.title} ${a.detail}`).not.toMatch(/behind|late|overdue|unpaid/i);
      expect(a.detail).toContain('log payments and expenses');
      expect(a.corporation_id).toBe('corp-1');
    } finally {
      for (const p of before) {
        await supabase.from('payments').insert({
          id: p.id, owner_id: p.owner_id, invoice_id: p.invoice_id, amount: p.amount,
          paid_date: p.paid_date, method: p.method, note: p.note, period_month: p.period_month,
        });
      }
    }
  });

  it('Rent Ledger module off → the data is never even fetched', async () => {
    const data = await fetchAlertData({ ledgerOn: false });
    expect(data.unloggedMonths).toEqual([]);
  });
});
