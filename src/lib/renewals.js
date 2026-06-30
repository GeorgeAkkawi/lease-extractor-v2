// Renewal date math. (The tenant-email drafts live in ./emailTemplates.js.)

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
