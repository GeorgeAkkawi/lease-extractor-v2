// Pure date math for corporation annual-report filing deadlines. Kept dependency-free
// and separate from api.js so the roll-forward logic is unit-testable in isolation.

// Advance an ISO date (YYYY-MM-DD) by one year, clamping Feb 29 → Feb 28 in a
// non-leap target year so the deadline never silently jumps to March 1. Returns null
// for a missing/invalid input.
export function advanceDueDate(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const year = y + 1;
  // Days in the target month/year (handles Feb in a non-leap year).
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  const p = (n) => String(n).padStart(2, '0');
  return `${year}-${p(m)}-${p(day)}`;
}
