// Renewal date math + the two rules that decide whether an option is still a live
// choice and what rent confirming it books. (The tenant-email drafts live in
// ./emailTemplates.js.)

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Add N calendar months to an ISO date (yyyy-mm-dd), clamping end-of-month.
export function addMonths(iso, months) {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00');
  const targetDay = d.getDate();
  d.setMonth(d.getMonth() + Number(months || 0));
  if (d.getDate() < targetDay) d.setDate(0); // overflowed → last day of intended month
  return d.toISOString().slice(0, 10);
}

// Whole calendar months between two ISO dates (the inverse of addMonths for
// month-aligned dates). Used to model an addendum "extension" as a renewal term:
// term_months = monthsBetween(currentEnd, newEnd). Never returns less than 1.
export function monthsBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const a = new Date(fromIso + 'T12:00:00');
  const b = new Date(toIso + 'T12:00:00');
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m -= 1; // partial trailing month doesn't count
  return Math.max(1, m);
}

// A notice window sits close to the term it protects — "180 days prior to expiration"
// and "twelve (12) months prior" are the standard forms. A notice deadline further
// ahead of the committed term end than this can only belong to an EARLIER term the
// lease has since been extended past.
export const STALE_NOTICE_MONTHS = 18;

// Is a PENDING renewal option lapsed, and why? Two ways:
//
//   'term_ended'    — the term it would have extended has already ended.
//   'notice_passed' — its notice deadline has passed AND sits more than
//                     STALE_NOTICE_MONTHS before the committed term end, so the window
//                     belonged to a term that has since been superseded (typically by
//                     an addendum extension).
//
// The second test is what stops a leftover option from posing as a live decision.
// Real case (George, 2026-07-28): a 2004 lease's "First Option to Renew" — notice by
// 2008-09-01, rent $19,386 — sat pending on a lease whose addendums had carried the
// term to 2030-05-31. Judged on term end alone it read as a normal future option, so
// the lease page offered Renew and the nightly cron raised "Is this tenant renewing?"
// every morning — and confirming would have booked that 2008-era rent against a
// current $31,800.96.
//
// Returns null when the option is live. Only pending options can lapse; applied and
// declined ones are a closed record either way.
//
// SQL twin: the same rule inside apply_due_renewals() (migration 0068). Change both.
//
// The cutoff is deliberately day-exact — `notice < addMonths(end, -18)` — rather than a
// whole-month count, because that is precisely what the SQL's
// `notice_by_date < least(app_today(), term_end - interval '18 months')` computes.
// addMonths clamps end-of-month the same way Postgres does (2030-05-31 − 18 months is
// 2028-11-30 in both), so the two can never disagree about a boundary date and the cron
// can't re-raise a prompt the app just cleared.
export function optionLapseReason(ren, termEnd, todayIso) {
  if (!ren || ren.status !== 'pending' || !todayIso) return null;
  const end = termEnd ? String(termEnd) : null;
  if (end && end < String(todayIso)) return 'term_ended';
  const notice = ren.notice_by_date ? String(ren.notice_by_date) : null;
  if (!notice || !end) return null;
  const cutoff = addMonths(end, -STALE_NOTICE_MONTHS);
  if (notice < String(todayIso) && cutoff && notice < cutoff) return 'notice_passed';
  return null;
}

export const optionLapsed = (ren, termEnd, todayIso) => optionLapseReason(ren, termEnd, todayIso) !== null;

// The rent a confirmed option books for its FIRST renewal year, in precedence:
// a figure the landlord typed at renewal (for options the lease left open — "fair
// market value", "greater of $X or CPI") > the option's own stated new_rent > the
// prior rent stepped by the annual % > the prior rent carried unchanged.
//
// Shared by rollLeaseIntoRenewal, which books it, and the confirm dialog, which warns
// about it — so the warning can never disagree with what actually gets written.
export function renewalFirstYearRent(ren, currentRent, override = null) {
  const old = Number(currentRent) || 0;
  if (override != null && Number(override) > 0) return round2(Number(override));
  if (ren?.new_rent != null) return Number(ren.new_rent);
  const pct = Number(ren?.annual_escalation_pct) || 0;
  return pct > 0 ? round2(old * (1 + pct / 100)) : old;
}
