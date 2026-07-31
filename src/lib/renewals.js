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

// The rent steps an option carries INSIDE its own period, normalized.
//
// George, 2026-07-30: "if the rent goes up yearly or within a certain term amount the
// user should have to option to update that like 'add rent escalation as part of this
// option' and that should be hidden but be remembered so that when the renewal is
// applied the escalations save."
//
// Stored on the option (renewal_options.rent_schedule, migration 0071) and turned into
// real dated rent_escalations ONLY when the option is applied — so nothing shows on the
// ledger for a renewal the tenant hasn't exercised, and declining or deleting the option
// takes its schedule with it instead of stranding steps.
//
// The shape matches what buildRenewalScheduleSteps already consumes from the AI read, so
// the hand-entered and extracted paths speak one vocabulary. Offsets are months from the
// option's OWN start (year 1 = 0, year 2 = 12 …); rows without a usable amount are
// dropped rather than booked as $0.
export function optionScheduleSteps(schedule) {
  const seen = new Set();
  return (Array.isArray(schedule) ? schedule : [])
    .map((r) => ({ off: Math.trunc(Number(r?.months_from_option_start) || 0), annual: Number(r?.annual) }))
    .filter((r) => r.off >= 0 && Number.isFinite(r.annual) && r.annual > 0)
    .sort((a, b) => a.off - b.off)
    .filter((r) => (seen.has(r.off) ? false : seen.add(r.off)));
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

// ─── The notice deadline, as the lease actually states it ────────────────────────────
//
// George, 2026-07-30: "make sure i can click into notice by and change the duration to
// something specific like how many months before".
//
// A lease prints a DURATION, never a date: "180 days prior to the expiration of the
// then-current term", "twelve (12) months prior". The date falls out of when that term
// runs out. So the landlord enters the rule and the app does the arithmetic — the same
// division of labour as the rent schedule, where the model reads raw figures and code
// multiplies.
//
// The resolved date is still what gets stored in notice_by_date and what every consumer
// reads (the lapse rule above, the bell prompt, apply_due_renewals(), the reminder
// trigger). The lead is remembered alongside it (migration 0072) so the row can say the
// rule back and re-date itself when the period it counts from moves.

// The day notice is measured back FROM: the day the term this option would extend runs
// out — i.e. the day before the option's own period starts. For the first pending option
// that is exactly the lease's committed term end, which is what reconcileRenewalOptions
// already counts back from when it reads "N days prior" out of an imported clause. For a
// later option it is the end of the option before it, which is what "expiration of the
// then-current term" means once one has been exercised.
export const noticeAnchor = (win) => (win?.start ? addDays(win.start, -1) : null);

// Resolve a lead against an option's period. Null when there's nothing to count back
// from (no term stated, or an option whose chain stopped) — better no date than one
// measured from a boundary we're guessing at.
export function noticeDateFrom(win, n, unit) {
  const anchor = noticeAnchor(win);
  const k = Math.trunc(Number(n) || 0);
  if (!anchor || !(k > 0)) return null;
  return unit === 'days' ? addDays(anchor, -k) : addMonths(anchor, -k);
}

// "6 months before" / "180 days before" — the phrase the lease uses, singularized.
export function noticeLeadLabel(n, unit) {
  const k = Math.trunc(Number(n) || 0);
  if (!(k > 0)) return null;
  return `${k} ${unit === 'days' ? 'day' : 'month'}${k === 1 ? '' : 's'} before`;
}

// The draft the editor holds while you're typing: a mode plus whichever value that mode
// takes. Kept as plain data (rather than component state) so the resolved date recomputes
// from the CURRENT window on every render — type a term in the add dialog and the
// deadline follows it, with no effect to keep in sync.
export const noticeDraftFrom = (ren) => (
  Number(ren?.notice_lead_n) > 0
    ? { mode: ren.notice_lead_unit === 'days' ? 'days' : 'months', n: String(ren.notice_lead_n), date: ren.notice_by_date || '' }
    : { mode: 'date', n: '', date: ren?.notice_by_date || '' }
);

// A draft + the option's period → the three columns to write. Exactly one shape is
// stored: an explicit date carries no lead (nothing would re-date it, and nothing
// should), and a lead that can't be resolved yet writes nothing at all rather than a
// rule with no answer.
export function resolveNotice(draft, win) {
  const blank = { notice_by_date: null, notice_lead_n: null, notice_lead_unit: null };
  if (!draft || draft.mode === 'date') return { ...blank, notice_by_date: draft?.date || null };
  const n = Math.trunc(Number(draft.n) || 0);
  const date = noticeDateFrom(win, n, draft.mode);
  return n > 0 && date ? { notice_by_date: date, notice_lead_n: n, notice_lead_unit: draft.mode } : blank;
}

// The stored deadline no longer matches the rule it was written from — the option's
// period has moved since (an earlier option was exercised, an addendum extended the
// term, the term-end date was corrected). Returns the date the rule now gives, or null
// when it already agrees or there's no rule to check against.
//
// Deliberately reported rather than applied: re-dating is a write, and a write that
// happens because a screen rendered is exactly the kind of silent movement this codebase
// keeps out of its money paths. The row shows it; one click in the editor settles it.
export function noticeDrift(ren, win) {
  if (!ren || ren.status !== 'pending') return null;
  const n = Math.trunc(Number(ren.notice_lead_n) || 0);
  if (!(n > 0) || !ren.notice_by_date) return null;
  const should = noticeDateFrom(win, n, ren.notice_lead_unit);
  return should && should !== String(ren.notice_by_date) ? should : null;
}
