// Renewal date math + the two rules that decide whether an option is still a live
// choice and what rent confirming it books. (The tenant-email drafts live in
// ./emailTemplates.js.)
import { fmtDate } from './format';

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

function addDays(iso, n) {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// The period each option covers — as dates, chained, because options run back to back.
//
// George, 2026-07-30: "The renewal options need to be dated from when they start to
// when they end." A lease states a LENGTH ("sixty (60) months"), never dates; the dates
// come from where the committed term ends. That is exactly the arithmetic
// rollLeaseIntoRenewal already books — newEnd = addMonths(termEnd, term_months) — so a
// window runs from the day AFTER the current term end through that new end, and the
// next option picks up from there. Deriving it here rather than in the table means the
// row, the confirm dialog and the AI assistant all quote the same period.
//
// APPLIED options run the other way, and this is the part that's easy to get wrong.
// Confirming one has ALREADY moved lease_termination_date, so the committed end
// includes it — chaining it forward would date a period the tenant has been occupying
// for years as if it were still ahead. Applied options are walked BACKWARDS from the
// committed end instead, most recent first: the same arithmetic in reverse.
//
// Two deliberate silences. A DECLINED option gets no window: nothing will ever cover
// it, and dating a period that won't happen is worse than saying nothing. And an option
// with no stated length stops its chain — everything after it is unknowable, so we
// return what we know and no more rather than guessing a boundary.
//
// @param ordered  the options in the order they'd be exercised (sort with cmpRenewal —
//                 imported here it would close a cycle through leaseTerm → abatement).
// @param termEnd  the lease's committed termination date.
// @returns { [optionId]: { start, end } } — ISO dates, inclusive.
export function optionWindows(ordered = [], termEnd) {
  const out = {};
  if (!termEnd) return out;
  const end0 = String(termEnd);

  const applied = ordered.filter((r) => r?.status === 'applied');
  let back = end0;
  for (let i = applied.length - 1; i >= 0; i--) {
    const months = Number(applied[i].term_months) || 0;
    if (!months) break;
    const prevEnd = addMonths(back, -months);
    if (!prevEnd) break;
    out[applied[i].id] = { start: addDays(prevEnd, 1), end: back };
    back = prevEnd;
  }

  let fwd = end0;
  for (const r of ordered) {
    if (r?.status !== 'pending') continue;
    const months = Number(r.term_months) || 0;
    if (!months) break;
    const to = addMonths(fwd, months);
    if (!to) break;
    out[r.id] = { start: addDays(fwd, 1), end: to };
    fwd = to;
  }
  return out;
}

// "Jun 1, 2030 → May 31, 2035". The same arrow form a rider's period uses
// (coversLabel, ./riders.js), so a period on this page reads the same wherever it is.
export const windowLabel = (w) => (w?.start && w?.end ? `${fmtDate(w.start)} → ${fmtDate(w.end)}` : null);
