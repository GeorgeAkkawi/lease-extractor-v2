// Integration: the term-aware monthly tracker end-to-end against the demo mock (DEMO mode
// forced by the vite test env), for the mid-year-start seed lease-4 (Sunrise Yoga, prop-2,
// occupancy July 1 of the current year). Its own file so its markMonthPaid mutations don't
// leak into sibling suites. Proves the calendar-aware behavior the audit added:
//   • Jan–Jun read "—" (outside the tenancy) and cannot be billed;
//   • the year's owed is a prorated half; marking July records a payment;
//   • bulk "mark everyone" skips the pre-occupancy months.
import { describe, it, expect } from 'vitest';
import { getMonthlyRent, markMonthPaid, listPayments, getYearInvoice, markMonthPaidAllTenants } from '../api';
import { currentYear } from '../format';

const Y = currentYear();

describe('mid-year-start lease (Sunrise Yoga, July 1) — calendar-aware tracker', () => {
  it('Jan–Jun are outside the term (owed $0); Jul–Dec are owed; owedMonths = 6', async () => {
    const data = await getMonthlyRent('lease-4', Y);
    for (let m = 1; m <= 6; m++) {
      expect(data.schedule[m].outsideTerm).toBe(true);
      expect(data.schedule[m].owed).toBe(0);
    }
    for (let m = 7; m <= 12; m++) {
      expect(data.schedule[m].outsideTerm).toBe(false);
      expect(data.schedule[m].owed).toBeGreaterThan(0);
    }
    expect(data.owedMonths).toBe(6);
    expect(data.occupancyStartIso).toBe(`${Y}-07-01`);
    // The year owed is a half-year (base 36,000 + prorated CAM/tax share), not a full year.
    expect(data.annual).toBeLessThan(30000);
    expect(data.annual).toBeGreaterThan(20000);
  });

  it('marking a pre-occupancy month (January) is a no-op — nothing is billed', async () => {
    const inv = await markMonthPaid('lease-4', 'prop-2', Y, 1);
    // The invoice is created on demand, but January records no payment (owed $0).
    const jan = (await listPayments(inv.id)).filter((p) => Number(p.period_month) === 1);
    expect(jan.length).toBe(0);
  });

  it('marking July records its (prorated) monthly rent', async () => {
    await markMonthPaid('lease-4', 'prop-2', Y, 7);
    const inv = await getYearInvoice('lease-4', Y);
    const jul = (await listPayments(inv.id)).filter((p) => Number(p.period_month) === 7);
    expect(jul.length).toBe(1);
    expect(Number(jul[0].amount)).toBeGreaterThan(0);
  });

  it('bulk "mark everyone paid" for January skips the not-yet-started tenant', async () => {
    const res = await markMonthPaidAllTenants('prop-2', Y, 1);
    // lease-4 owes nothing in January → it is not among the tenants paid.
    const inv = await getYearInvoice('lease-4', Y);
    const jan = (await listPayments(inv.id)).filter((p) => Number(p.period_month) === 1);
    expect(jan.length).toBe(0);
  });
});
