// A renewal option that is no longer a live choice must say so — and confirming one
// must never quietly book a rent below the rent in effect today.
//
// The bug (George, 2026-07-28): "there's an outdated renewal on the beauty and barber
// shop — if I click that will it force the renewal on the current lease terms, or does
// the software recognize the past due date?" It did NOT. Staleness was judged on the
// committed term end alone, so this real lease —
//
//   lease_start 2004-01-01 · term end 2030-05-31 (carried there by addendums)
//   base rent $31,800.96
//   option "First Option to Renew" · notice by 2008-09-01 · 60 mo · $19,386 · pending
//
// — read as a normal FUTURE option: the lease page offered Renew, and the nightly cron
// raised "Is beauty and barber shop renewing?" every morning. Confirming would have
// extended the term to 2035 and booked a $19,386 step — a $12,414.96/yr DECREASE — from
// an option whose notice deadline expired eighteen years ago.
import { describe, it, expect } from 'vitest';
import {
  optionLapseReason, optionLapsed, renewalFirstYearRent, STALE_NOTICE_MONTHS,
} from '../renewals';
import { confirmRenewal, listRenewals, updateRenewal, getLease } from '../api';

// The live row that prompted this, verbatim.
const BARBER = { status: 'pending', notice_by_date: '2008-09-01', term_months: 60, new_rent: 19386 };
const BARBER_TERM_END = '2030-05-31';
const TODAY = '2026-07-28';

describe('optionLapseReason', () => {
  it('the beauty-and-barber option is lapsed — its notice window belongs to an earlier term', () => {
    expect(optionLapseReason(BARBER, BARBER_TERM_END, TODAY)).toBe('notice_passed');
    expect(optionLapsed(BARBER, BARBER_TERM_END, TODAY)).toBe(true);
  });

  it('a term that has already ended still lapses (the original rule, unchanged)', () => {
    expect(optionLapseReason({ status: 'pending', notice_by_date: '2025-06-01' }, '2026-05-31', TODAY))
      .toBe('term_ended');
    // term_ended wins even when the notice date would also qualify
    expect(optionLapseReason(BARBER, '2020-01-01', TODAY)).toBe('term_ended');
  });

  it('a normal option whose notice deadline just passed is NOT lapsed', () => {
    // "180 days prior to expiration" — the deadline is behind us but the option is very
    // much live and the landlord may still be exercising it. This is the case the rule
    // must never swallow.
    expect(optionLapseReason({ status: 'pending', notice_by_date: '2026-07-01' }, '2026-12-31', TODAY))
      .toBeNull();
    // "twelve (12) months prior" — a full year of lead, still live.
    expect(optionLapseReason({ status: 'pending', notice_by_date: '2026-06-01' }, '2027-05-31', TODAY))
      .toBeNull();
  });

  it('a notice deadline still in the future is never lapsed, however far out', () => {
    expect(optionLapseReason({ status: 'pending', notice_by_date: '2030-11-02' }, '2031-05-01', TODAY))
      .toBeNull();
    expect(optionLapseReason({ status: 'pending', notice_by_date: '2029-01-01' }, '2035-01-01', TODAY))
      .toBeNull();
  });

  it('the cutoff is day-exact, matching the SQL cron to the day', () => {
    // The rule must compute the same boundary as apply_due_renewals()'s
    // `notice_by_date < least(app_today(), term_end - interval '18 months')`. A
    // whole-month count would judge both of these "exactly 18 months" and call them
    // live, while the SQL called the first lapsed — so the cron would re-raise a prompt
    // the app had just cleared, every morning, for a month around the boundary.
    expect(optionLapseReason({ status: 'pending', notice_by_date: '2026-06-29' }, '2027-12-31', TODAY))
      .toBe('notice_passed');
    expect(optionLapseReason({ status: 'pending', notice_by_date: '2026-06-30' }, '2027-12-31', TODAY))
      .toBeNull();
  });

  it('the cutoff is strictly MORE than 18 months of lead', () => {
    // Both cases use a past notice date and a FUTURE term end, so only the notice rule
    // is in play: exactly 18 months of lead → live; nineteen → lapsed.
    expect(STALE_NOTICE_MONTHS).toBe(18);
    expect(optionLapseReason({ status: 'pending', notice_by_date: '2026-01-31' }, '2027-07-31', TODAY))
      .toBeNull();
    expect(optionLapseReason({ status: 'pending', notice_by_date: '2026-01-31' }, '2027-08-31', TODAY))
      .toBe('notice_passed');
  });

  it('only PENDING options lapse — applied and declined stay a closed record', () => {
    expect(optionLapseReason({ ...BARBER, status: 'applied' }, BARBER_TERM_END, TODAY)).toBeNull();
    expect(optionLapseReason({ ...BARBER, status: 'declined' }, BARBER_TERM_END, TODAY)).toBeNull();
  });

  it('degrades safely on missing data — never invents a lapse', () => {
    expect(optionLapseReason(null, BARBER_TERM_END, TODAY)).toBeNull();
    expect(optionLapseReason({ status: 'pending', notice_by_date: null }, BARBER_TERM_END, TODAY)).toBeNull();
    expect(optionLapseReason(BARBER, null, TODAY)).toBeNull();      // no term end to measure against
    expect(optionLapseReason(BARBER, BARBER_TERM_END, null)).toBeNull();
  });
});

describe('renewalFirstYearRent', () => {
  it('reproduces the figure the barber option would have booked', () => {
    expect(renewalFirstYearRent(BARBER, 31800.96)).toBe(19386);   // below the current rent
  });

  it('precedence: typed figure > stated rent > annual % > carry the prior rent', () => {
    expect(renewalFirstYearRent(BARBER, 31800.96, 42000)).toBe(42000);
    expect(renewalFirstYearRent({ new_rent: 90000, annual_escalation_pct: 5 }, 84000)).toBe(90000);
    expect(renewalFirstYearRent({ new_rent: null, annual_escalation_pct: 5 }, 84000)).toBe(88200);
    expect(renewalFirstYearRent({ new_rent: null, annual_escalation_pct: null }, 84000)).toBe(84000);
  });

  it('rounds a computed step to the cent', () => {
    expect(renewalFirstYearRent({ new_rent: null, annual_escalation_pct: 3 }, 31800.96)).toBe(32754.99);
  });

  it('an override of 0 or blank falls through rather than booking nothing', () => {
    expect(renewalFirstYearRent(BARBER, 31800.96, 0)).toBe(19386);
    expect(renewalFirstYearRent(BARBER, 31800.96, null)).toBe(19386);
  });
});

// The guard lives in confirmRenewal so EVERY entry point inherits it — the lease page's
// Renew button and the dashboard bell's "Yes — apply renewal" alike.
describe('confirmRenewal refuses a below-current rent until it is acknowledged', () => {
  it('returns the sentinel with both figures and writes nothing', async () => {
    const [ren] = await listRenewals('lease-2');
    const before = await getLease('lease-2');
    const low = Math.round((Number(before.base_rent) || 0) - 10000);
    await updateRenewal(ren.id, { new_rent: low });
    try {
      const res = await confirmRenewal(ren.id, new Date());
      expect(res.needsDecreaseOk).toBe(true);
      expect(res.newRent).toBe(low);
      expect(res.currentRent).toBe(Number(before.base_rent));

      // nothing moved: term, rent, and the option's own status are untouched
      const after = await getLease('lease-2');
      expect(after.base_rent).toBe(before.base_rent);
      expect(after.lease_termination_date).toBe(before.lease_termination_date);
      const [renAfter] = await listRenewals('lease-2');
      expect(renAfter.status).toBe('pending');
    } finally {
      await updateRenewal(ren.id, { new_rent: ren.new_rent });
    }
  });

  it('a renewal that RAISES the rent is never stopped', async () => {
    const [ren] = await listRenewals('lease-2');
    const lease = await getLease('lease-2');
    expect(Number(ren.new_rent)).toBeGreaterThan(Number(lease.base_rent)); // demo seed: 90,000 vs 84,000
    const rent = renewalFirstYearRent(ren, lease.base_rent);
    expect(rent >= Number(lease.base_rent)).toBe(true);
  });
});
