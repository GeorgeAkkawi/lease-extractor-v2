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

export default isoDateOrNull;
