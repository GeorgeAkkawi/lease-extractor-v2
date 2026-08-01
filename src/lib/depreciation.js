// Slice 5a — an asset with a life, instead of one year that looks catastrophic.
//
// THE GAP THIS CLOSES. An $18,000 roof is entered as an $18,000 expense in the year it
// was paid, so that year reads as a disaster and every other year reads better than it
// was. Nothing in Amlak has ever held the idea that a thing can be bought once and used
// for thirty-nine years. The building itself — the largest asset a landlord owns —
// cannot be described at all: `properties` has had exactly ONE column added since
// 0001 (`building_sf`, 0005).
//
// ⚠ NOTHING HERE MOVES A DOLLAR ANYWHERE, and that is structural rather than careful.
// Depreciation is a NON-CASH figure: no money leaves the bank, no expense total
// changes, no tenant is billed. Every number in this file is DERIVED from a
// `fixed_assets` row, and that table is read by no view, no invoice and no share
// calculation — the same safety `entity_ledger` has, for the same reason.
//
// ⚠ AND IT IS DELIBERATELY ABSENT FROM "WHAT ACTUALLY STAYED." That strip answers what
// is in the account; depreciation never crossed the account. Adding it there would be
// the tidiest possible lie — a cash figure with a non-cash number subtracted from it.
//
// STRAIGHT-LINE, BOOK ONLY. MACRS, bonus depreciation and §179 are refused: being
// subtly wrong about an election is worse than being absent, and those are the CPA's to
// make. The split that matters is not book-vs-tax, it is BASIS CAPTURE vs BASIS
// APPLICATION — and capture is the half Amlak can do better than anyone, because it is
// already standing at the bank statement on the day the money moved.
//
// A JS registry for the same reason ENTITY_KINDS, DISPOSITIONS and EXPENSE_CATEGORIES
// are: the list will grow, and a DB CHECK would mean a migration per member.

// The defaults assume NONRESIDENTIAL real property, which is what Amlak is for. A
// residential landlord would use 27.5 years for the structure — so the life is
// pre-filled from the kind and always editable, never asserted.
export const DEFAULT_LIFE_NOTE =
  'Default lives assume commercial (nonresidential) property. Change any of them — the schedule follows what you type.';

export const ASSET_KINDS = [
  {
    key: 'building',
    label: 'Building',
    life: 39,
    // ⚠ THE ONE KIND WHOSE COST IS NOT ALL DEPRECIABLE. Land never wears out, so it
    // never depreciates — and the split between them is an ALLOCATION DECISION, not a
    // fact printed on the settlement statement. It is the most consequential number in
    // depreciation and Amlak cannot know it, so it refuses to guess (see the `blocked`
    // path below). An 80/20 default is one line of code and silently wrong on most
    // properties.
    landSplit: true,
    hint: 'The structure itself. Land never wears out, so its value has to come out before anything depreciates.',
  },
  {
    key: 'improvement',
    label: 'Building improvement',
    life: 39,
    hint: 'Roof, HVAC, plumbing, electrical, windows — part of the structure, so it takes the structure’s life.',
  },
  {
    key: 'land_improvement',
    label: 'Land improvement',
    life: 15,
    hint: 'Parking lot, fencing, exterior lighting, landscaping — outside the building, and a shorter life.',
  },
  {
    key: 'equipment',
    label: 'Equipment and fixtures',
    life: 7,
    hint: 'Signage, security systems, machinery — anything that is not part of the structure.',
  },
  {
    key: 'appliances',
    label: 'Appliances and floor coverings',
    life: 5,
    hint: 'Appliances, carpet and removable fittings.',
  },
  {
    key: 'acquisition_costs',
    label: 'Acquisition costs',
    life: 39,
    hint: 'Title, legal and survey fees capitalized into the purchase rather than expensed.',
  },
  {
    key: 'loan_costs',
    label: 'Loan costs',
    // No default, on purpose: points amortize over the TERM OF THE LOAN, which varies
    // and which Amlak does not know until Slice 6 exists. A wrong default here would
    // produce a confident schedule off a number nobody chose.
    life: null,
    hint: 'Points and origination fees, amortized over the term of the loan — so there is no default life to offer.',
  },
];

const BY_KIND = new Map(ASSET_KINDS.map((k) => [k.key, k]));

// Same refusal as entityKindInfo and dispositionInfo: a kind written by a later round
// and read by an older cached bundle reports itself as unknown rather than quietly
// borrowing another kind's life. It carries no default life, so it blocks rather than
// depreciating on a guess.
export function assetKindInfo(key) {
  return BY_KIND.get(key) || { key: key || 'unknown', label: 'Unrecorded', life: null, landSplit: false, hint: '' };
}

export const isAssetKind = (key) => BY_KIND.has(key);
export const assetKindLabel = (key) => assetKindInfo(key).label;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const money = (n) => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n) => (n == null || n === '' || !isFinite(Number(n)) ? null : Number(n));

// The depreciable basis: cost less whatever the cost bought that does not wear out.
// Returns null when the asset cannot be depreciated at all — never 0, because "nothing
// to depreciate" and "the figure is zero" are different claims.
export function depreciableBasis(asset) {
  const s = depreciationSchedule(asset);
  return s.blocked ? null : s.basis;
}

// The whole schedule, year by year, from a `fixed_assets` row. Pure — nothing here
// reads or writes anything.
//
//   → { rows: [{ year, months, expense, accumulated, bookValue }], basis, life,
//       cost, land, blocked, reason }
//
// `bookValue` is COST less accumulated depreciation, not basis less it: for a building
// the land sits at full value forever, which is exactly why a fully-depreciated
// building's book value equals its land. That is the arithmetic doing the teaching.
export function depreciationSchedule(asset) {
  const kind = assetKindInfo(asset?.kind);
  const cost = num(asset?.cost);
  const life = num(asset?.useful_life_years) ?? kind.life;
  const iso = String(asset?.placed_in_service || '');
  const stop = (reason) => ({ rows: [], basis: null, life, cost, land: null, blocked: true, reason });

  if (!(cost > 0)) return stop('no cost is recorded');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return stop('no in-service date is recorded');
  // ⚠ null IS NOT ZERO, and the distinction is the forcing function. "Nobody has
  // decided how much of this was land" and "the land is worth nothing" are different
  // answers; a ground lease or a condo unit legitimately has land_cost 0, and a
  // building nobody has split has null. Defaulting the first to the second — or to any
  // ratio — is precisely the silently-wrong number this refuses.
  if (kind.landSplit && asset?.land_cost == null) return stop('the land value has not been set');
  if (!(life > 0)) return stop('no useful life is set');

  const land = Math.max(0, num(asset?.land_cost) || 0);
  const basis = round2(Math.max(0, cost - land));
  if (!(basis > 0)) {
    return { rows: [], basis: 0, life, cost, land, blocked: true, reason: 'the land allocation is the whole cost — there is nothing to depreciate' };
  }

  const startYear = Number(iso.slice(0, 4));
  const startMonth = Number(iso.slice(5, 7));
  const totalMonths = Math.round(life * 12);
  const perMonth = basis / totalMonths;

  const rows = [];
  let taken = 0;
  let done = 0;
  for (let y = startYear; done < totalMonths; y++) {
    // Whole-month proration, first year and last. NOT the mid-month convention — that
    // is MACRS, which this file refuses to compute.
    const room = y === startYear ? 13 - startMonth : 12;
    const months = Math.min(room, totalMonths - done);
    done += months;
    // Each year's figure is the difference between two ROUNDED cumulative totals, so
    // the rounding cannot drift across thirty-nine rows; the final year is the exact
    // remainder, which is what makes Σ expense === basis to the cent. The same
    // penny-fold discipline componentizeSchedule uses.
    const expense = done >= totalMonths ? round2(basis - taken) : round2(round2(perMonth * done) - taken);
    taken = round2(taken + expense);
    rows.push({ year: y, months, expense, accumulated: taken, bookValue: round2(cost - taken) });
  }
  return { rows, basis, life, cost, land, blocked: false, reason: null };
}

// What one asset looks like in one fiscal year.
//   → the schedule fields, plus { thisYear, accumulated, bookValue, annual }
// Before the schedule starts nothing has happened; after it ends the asset is fully
// depreciated, so the expense is 0 and the accumulated figure holds.
export function depreciationForYear(asset, year) {
  const s = depreciationSchedule(asset);
  if (s.blocked) return { ...s, thisYear: null, accumulated: null, bookValue: null, annual: null };

  const y = Number(year);
  const row = s.rows.find((r) => r.year === y) || null;
  const prior = [...s.rows].reverse().find((r) => r.year <= y) || null;
  // A representative full year — what the asset costs in a year it is held throughout.
  const full = s.rows.find((r) => r.months === 12) || s.rows[0];

  return {
    ...s,
    thisYear: row ? row.expense : 0,
    accumulated: prior ? prior.accumulated : 0,
    bookValue: prior ? prior.bookValue : s.cost,
    annual: full ? full.expense : null,
  };
}

// Every asset on a property, for one year, plus the totals.
// Sorted by cost, biggest first — so the building leads and the carpet doesn't.
export function summarizeAssets(assets = [], year) {
  const rows = (assets || [])
    .map((a) => ({ asset: a, calc: depreciationForYear(a, year) }))
    .sort((x, y2) => (Number(y2.asset?.cost) || 0) - (Number(x.asset?.cost) || 0));

  let cost = 0;
  let land = 0;
  let thisYear = 0;
  let accumulated = 0;
  let blocked = 0;

  for (const r of rows) {
    cost = round2(cost + (Number(r.asset?.cost) || 0));
    land = round2(land + (Number(r.asset?.land_cost) || 0));
    if (r.calc.blocked) { blocked += 1; continue; }
    thisYear = round2(thisYear + (r.calc.thisYear || 0));
    accumulated = round2(accumulated + (r.calc.accumulated || 0));
  }

  return {
    rows,
    count: rows.length,
    cost,
    land,
    thisYear,
    accumulated,
    // Totalled from the ROWS SHOWN rather than derived a second way, so the table can
    // never disagree with its own arithmetic.
    bookValue: round2(cost - accumulated),
    blocked,
  };
}

// The cross-check, and the reason it reads as a fact rather than an alarm.
//
// A landlord who has owned a building for ten years has a depreciation figure already:
// the CPA's last Form 4562. Amlak's schedule is computed independently from the basis
// and the life, so the two are two SOURCES for one number — the same shape as the
// deposit cross-check in Slice 4c.
//
// ⚠ THEY WILL ALMOST NEVER MATCH EXACTLY, AND THAT IS NOT A FINDING. A CPA applies the
// mid-month convention in the first year; this file prorates by whole months and says
// so. That difference is bounded by roughly half a month's depreciation and is
// structurally expected — so a gap smaller than one year's depreciation is reported
// with an explanation and NO warning tone. Only a gap larger than that means the two
// are working from a different cost or a different life, which is worth flagging.
export function priorCheck(asset, opts = {}) {
  const stated = num(asset?.prior_accumulated);
  const through = num(asset?.prior_accumulated_year);
  const none = { state: 'none', tone: null, sentence: '', stated, through, computed: null, difference: 0 };
  if (stated == null || !(through > 0)) return none;

  const calc = depreciationForYear(asset, through);
  if (calc.blocked) return none;

  const computed = calc.accumulated;
  const difference = round2(stated - computed);
  const yardstick = Math.max(1, Number(calc.annual) || 0);
  const base = { stated, through, computed, difference };

  if (Math.abs(difference) <= (opts.dust ?? 1)) {
    return { ...base, state: 'matched', tone: 'good', sentence: `Matches your accountant’s figure through ${through}.` };
  }
  if (Math.abs(difference) <= yardstick) {
    return {
      ...base,
      state: 'close',
      tone: null,
      sentence: `Through ${through} this schedule has taken ${money(computed)}; your accountant’s says ${money(stated)} — ${money(Math.abs(difference))} apart. A gap this size is normal: an accountant applies first-year conventions Amlak deliberately doesn’t compute.`,
    };
  }
  return {
    ...base,
    state: 'differs',
    tone: 'warn',
    sentence: `Through ${through} this schedule has taken ${money(computed)}; your accountant’s says ${money(stated)} — ${money(Math.abs(difference))} apart, more than a full year’s depreciation. The two are probably working from a different cost or a different life.`,
  };
}
