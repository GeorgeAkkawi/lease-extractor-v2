// Rent abatement (free / reduced rent) math — the ONE source of truth shared by the
// monthly rent tracker, the property rent roll, the "Currently in" phase header, the
// invoice credit line, and the unit tests. It MIRRORS the SQL function
// abatement_credit() in migration 0041 so the frontend and the database agree to the
// cent (same relationship effective_rent has with leaseTerm.js).
//
// An abatement is a window [start_date, end_date] during which the tenant's BASE rent
// is fully or partially abated. `kind`:
//   'free'    → the base rent is $0 for those months
//   'percent' → `value`% of the base rent is abated (value 50 → half off)
//   'amount'  → the tenant pays a reduced FIXED monthly base of `value` dollars
// Other charges (CAM / tax / roof) are NOT abated — the standard reading of a "rent
// abatement" is base-rent-only; CAM/taxes continue to accrue.
import { addMonths } from './renewals';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const noon = (d) => {
  if (!d) return null;
  if (d instanceof Date) return d;
  const s = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00` : d;
  const t = new Date(s);
  return isNaN(t) ? null : t;
};
const monthStart = (year, m) => new Date(year, m - 1, 1, 12);
const monthEnd = (year, m) => new Date(year, m, 0, 12); // day 0 of next month = last day of this one

// Does an abatement window overlap calendar month (year, m 1-12)? A month counts as
// abated if the window touches ANY part of it (same rule as the SQL) — so a full-month
// tracker box lights up whenever the abatement covers it.
export function abatementCoversMonth(ab, year, m) {
  const s = noon(ab?.start_date);
  const e = noon(ab?.end_date);
  if (!s && !e) return false;
  const ms = monthStart(year, m);
  const me = monthEnd(year, m);
  if (s && s > me) return false; // window starts after this month
  if (e && e < ms) return false; // window ended before this month
  return true;
}

// The base rent still OWED for one covered month, given the full monthly base.
export function reducedMonthlyBase(fullMonthlyBase, ab) {
  const full = Number(fullMonthlyBase) || 0;
  switch (ab?.kind) {
    case 'percent': {
      const p = Math.min(100, Math.max(0, Number(ab.value) || 0));
      return round2(full * (1 - p / 100));
    }
    case 'amount': {
      const owed = Math.max(0, Number(ab.value) || 0);
      return round2(Math.min(full, owed));
    }
    case 'free':
    default:
      return 0;
  }
}

// The base $ abated for one covered month (full − reduced).
function monthlyCredit(fullMonthlyBase, ab) {
  const full = Number(fullMonthlyBase) || 0;
  return round2(full - reducedMonthlyBase(full, ab));
}

// The strongest abatement covering a given month (if several overlap, the one that
// abates the MOST wins — deterministic, and "free" beats a partial reduction).
export function abatementForMonth(abatements, year, m, fullMonthlyBase) {
  let best = null;
  let bestCredit = -1;
  for (const ab of abatements || []) {
    if (!abatementCoversMonth(ab, year, m)) continue;
    const c = monthlyCredit(fullMonthlyBase, ab);
    if (c > bestCredit) { bestCredit = c; best = ab; }
  }
  return best;
}

// Total base $ abated across a calendar YEAR given that year's annual base rent.
// Mirrors abatement_credit(lease, year) in SQL. Capped at the annual base — you can
// never abate more rent than there is.
export function annualAbatementCredit(abatements, year, annualBaseRent) {
  const fullMonthly = (Number(annualBaseRent) || 0) / 12;
  let credit = 0;
  for (let m = 1; m <= 12; m++) {
    const ab = abatementForMonth(abatements, year, m, fullMonthly);
    if (ab) credit += monthlyCredit(fullMonthly, ab);
  }
  return round2(Math.min(credit, Number(annualBaseRent) || 0));
}

// Per-month owed schedule for a year: full charges minus any base abatement.
// otherAnnual = cam + tax + roof for the year (never abated). Returns a map
// { [m]: { full, owed, abated, credit, kind } } for m = 1..12, where `owed` is what the
// tenant actually pays that month and `full` is what it would be with no abatement.
export function monthlyScheduleForYear({ year, annualBaseRent, otherAnnual = 0, abatements = [] }) {
  const fullMonthlyBase = (Number(annualBaseRent) || 0) / 12;
  const otherMonthly = (Number(otherAnnual) || 0) / 12;
  const out = {};
  let totalCredit = 0;
  for (let m = 1; m <= 12; m++) {
    const ab = abatementForMonth(abatements, year, m, fullMonthlyBase);
    const reducedBase = ab ? reducedMonthlyBase(fullMonthlyBase, ab) : fullMonthlyBase;
    const credit = ab ? monthlyCredit(fullMonthlyBase, ab) : 0;
    totalCredit += credit;
    out[m] = {
      full: round2(fullMonthlyBase + otherMonthly),
      owed: round2(reducedBase + otherMonthly),
      abated: !!ab,
      credit,
      kind: ab?.kind || null,
    };
  }
  // Penny-true: rounding each month to cents can lose a few cents across the year
  // ($98,500/12 → $8,208.33 ×12 = $98,499.96), which left a fully-paid year showing a
  // phantom 4¢ balance forever. Fold the remainder into the LAST month that still owes
  // anything so the 12 figures sum exactly to the year's net total. Only rounding-sized
  // drift is folded — a larger gap would be a real logic error and must stay visible.
  const target = round2((Number(annualBaseRent) || 0) + (Number(otherAnnual) || 0) - totalCredit);
  const sum = round2(Object.values(out).reduce((s, c) => s + c.owed, 0));
  const diff = round2(target - sum);
  if (diff !== 0 && Math.abs(diff) <= 0.12) {
    for (let m = 12; m >= 1; m--) {
      if (out[m].owed > 0) {
        out[m].owed = round2(out[m].owed + diff);
        if (!out[m].abated) out[m].full = out[m].owed; // a normal month's "full" stays equal to owed
        break;
      }
    }
  }
  return out;
}

// The abatement in effect on a given day (for the "Currently in" header), or null.
export function activeAbatement(abatements, today) {
  const t = today instanceof Date ? today : (noon(today) || new Date());
  const year = t.getFullYear();
  const m = t.getMonth() + 1;
  const full = 1; // any positive base — we only need the strongest-covering window here
  return abatementForMonth(abatements, year, m, full) || null;
}

// Compute an abatement's inclusive end date from a start + N months: the last day
// before the (start + N months) boundary. e.g. start 2026-01-01 + 8 → 2026-08-31.
export function abatementEnd(startIso, months) {
  if (!startIso || !months) return null;
  const next = addMonths(startIso, Number(months));
  if (!next) return null;
  const d = new Date(`${next}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Whole calendar months an abatement window spans (for display: "8 months free").
export function abatementMonthCount(ab) {
  const s = noon(ab?.start_date);
  const e = noon(ab?.end_date);
  if (!s || !e || e < s) return null;
  return (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + 1;
}

// How many months of FULLY FREE rent sit at the very START of the term (a "leading"
// abatement). When rent is abated from day one, paid rent doesn't COMMENCE until that free
// period ends — so a rent table dated only by lease year ("Year 1 … Year 5" with no printed
// dates) is anchored to that rent-commencement point, NOT the lease start. A reduced-but-not-
// free leading period doesn't count (the tenant is paying from day one). Returns 0 when no
// free window is anchored at the start. Each `abatements` row may carry a raw `months`
// (fresh extraction) or a start/end pair (saved rows); `leaseStart` is the ISO start or null.
export function leadingFreeMonths(leaseStart, abatements) {
  if (!Array.isArray(abatements) || !abatements.length) return 0;
  let months = 0;
  for (const a of abatements) {
    if (a?.kind && a.kind !== 'free') continue;                 // reduced ≠ deferred commencement
    const n = Number(a?.months) || abatementMonthCount(a) || 0;
    if (!(n > 0)) continue;
    const s = a?.start_date || null;                            // leading = begins at/before the
    if (!s || !leaseStart || s <= leaseStart) months = Math.max(months, n); // start (or undated yet)
  }
  return months;
}

// A short human label for one abatement window ("Free rent", "50% off", "$2,000/mo").
export function abatementKindLabel(ab) {
  switch (ab?.kind) {
    case 'percent': return `${Math.round(Number(ab.value) || 0)}% off base rent`;
    case 'amount': return `reduced base rent`;
    case 'free':
    default: return 'Free base rent';
  }
}
