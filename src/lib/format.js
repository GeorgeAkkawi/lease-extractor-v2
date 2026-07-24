export const money = (n) =>
  n == null || n === '' || isNaN(n)
    ? '—'
    : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

// Whole-dollar money (no cents) — for estimates/summaries where cents are noise,
// e.g. the renewal-option "New rent" column. Uses money()'s cents everywhere else.
export const money0 = (n) =>
  n == null || n === '' || isNaN(n)
    ? '—'
    : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export const psf = (n) =>
  n == null || isNaN(n) ? '—' : `$${Number(n).toFixed(2)}/SF`;

// A derived figure shown to the cent only tells the truth if you can multiply it
// back. $41,403 of base rent over 2,100 SF is $19.7157/SF, which displays as
// $19.72 — and $19.72 × 2,100 is $41,412, nine dollars above the rent it came
// from. So wherever a rounded rate sits directly under the exact annual figure it
// derives from, the display marks it approximate rather than inviting arithmetic
// that can't come out (George, 2026-07-24: "19.72 * 2100 = 41412 which is off").
// Returns true when the rounded figure still multiplies back to the original.
export const dividesEvenly = (total, parts) => {
  const n = Number(total);
  const d = Number(parts);
  if (!isFinite(n) || !isFinite(d) || d === 0) return true;
  return Math.abs(Number((n / d).toFixed(2)) * d - n) < 0.005;
};

// The "≈" that says so — empty when the rate is exact, so an even figure reads
// exactly as it always has.
export const approx = (total, parts) => (dividesEvenly(total, parts) ? '' : '≈ ');

export const sf = (n) =>
  n == null || isNaN(n) ? '—' : `${Number(n).toLocaleString('en-US')} SF`;

export const pct = (n) =>
  n == null || isNaN(n) ? '—' : `${(Number(n) * 100).toFixed(1)}%`;

// One date format everywhere: "Month Day, Year" (e.g. June 26, 2026). Parse
// plain yyyy-mm-dd at local noon so the day doesn't shift back in timezones
// behind UTC (date-only strings would otherwise parse as UTC midnight).
export const fmtDate = (d) => {
  if (!d) return '—';
  const s = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d;
  return new Date(s).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};

export const currentYear = () => new Date().getFullYear();
