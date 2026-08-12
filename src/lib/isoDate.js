// One calendar-date validator, in a module with no dependencies so anything can import it.
//
// It lived in api.js, which meant a pure lib that needed it (newLeaseTerms.js) could not have
// it without an import cycle — and the alternative, a local copy, is how a rule quietly grows
// a third implementation. api.js still exports it, so every existing importer is unchanged.
//
// An AI-extracted date can be prose ("180 days prior to expiration of the Original Term"), a
// blank, or malformed — all of which must become null rather than reach a Postgres `date`
// column and fail the whole save. It also rejects a date that PARSES but doesn't exist:
// `new Date('2033-04-31T12:00:00')` is not NaN — V8 quietly rolls it to May 1 — so a shape
// regex plus an isNaN check lets an impossible date straight through, and Postgres fails with
// `date/time field value out of range`. Riders really do print those (Denny's Third Addendum
// says "April 31, 2033"), so round-trip the parse and reject anything that comes back as a
// different day.
//
// ⚠ Twin of realIsoDate() in supabase/functions/_shared/rentSchedule.js, which guards the edge
// functions. Duplicated across that boundary because the app build can't import into
// supabase/; the two must change together.
export function isoDateOrNull(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00`);
  if (isNaN(d.getTime())) return null;
  const [yy, mm, dd] = s.split('-').map(Number);
  if (d.getFullYear() !== yy || d.getMonth() + 1 !== mm || d.getDate() !== dd) return null;
  return s;
}

/**
 * Which month of `year` a stored date falls in — 0-11, or **null** when the money cannot
 * honestly be placed in one.
 *
 * ⚠ NULL IS A REAL ANSWER HERE, not a failure. `cam_line_items.paid_date` and
 * `other_income.txn_date` are both nullable on purpose (0074: "an expense typed by hand
 * legitimately has no date, and inventing one — Dec 31, say — would be a lie"), and whole
 * classes of row never carry one: a contract's derived CAM line, a kind entered as a single
 * flat total. Every caller that spreads figures across months must therefore keep an
 * "undated" bucket and SAY what landed in it. Folding those dollars into a month, or
 * dropping them, are both ways of reporting a year that didn't happen.
 *
 * A date outside `year` also answers null rather than its own month number: `year` is a
 * stored column and the date is a separate one, so a row filed under 2026 carrying a
 * December-2025 date must not be printed as this year's December. Pass no `year` to take
 * the month whatever the date's own year.
 */
export function monthOfYearIndex(v, year = null) {
  const iso = isoDateOrNull(typeof v === 'string' ? v.slice(0, 10) : v);
  if (!iso) return null;
  const [yy, mm] = iso.split('-').map(Number);
  if (year != null && yy !== Number(year)) return null;
  return mm - 1;
}

export default isoDateOrNull;
