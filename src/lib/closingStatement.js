// Slice 5c — reading a closing statement without capitalizing the wrong half of it.
//
// THE GAP. Amlak captures FLOW well — what crossed the bank — because a statement
// importer is standing at the account. It captures almost no STOCK: what you own, what
// it cost, when you bought it. No amount of statement-reading produces that; a bank
// statement cannot tell you what you paid for a building in 2014. The ALTA Settlement
// Statement (formerly HUD-1) is the one document that carries it, and it is read ONCE
// per property, forever.
//
// ⚠ THE REFUSAL THE WHOLE ROUND TURNS ON, and it is not the land split this time.
// A closing statement is ~40 lines and only three or four of them are basis. The rest
// are prorated taxes, prepaid insurance, transferred security deposits, escrow funding
// and rent prorations — every one of which is a real dollar that belongs SOMEWHERE
// ELSE. Summing "total settlement charges" into basis is the obvious implementation and
// it is wrong in the expensive direction: it capitalizes an expense over 39 years, so
// the year reads better than it was AND the basis is overstated for as long as the
// building is owned. So every line is classified, and the ones that are NOT basis are
// listed on screen with where they actually belong — the round-6 rule (a dollar is
// either recorded somewhere or explicitly excluded with a reason) applied to a document
// instead of a bank statement.
//
// The model reads and classifies; CODE does every sum. That split is the house rule and
// it is what stops a plausible-looking total from being arithmetic nobody checked.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => (n == null || n === '' || !isFinite(Number(n)) ? null : Number(n));
const isIso = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Where a settlement charge actually goes. A registry rather than a CHECK, for the same
// reason ASSET_KINDS, ENTITY_KINDS and DISPOSITIONS are: the list will grow (Slice 6
// splits escrow properly), and a DB constraint would mean a migration per member.
//
// `basis` marks the two that become an asset. Everything else is reported and NOT
// written — see `notCapitalized` for why that refusal is deliberate rather than lazy.
export const COST_TREATMENTS = [
  {
    key: 'acquisition',
    label: 'Added to the building’s cost',
    basis: 'acquisition_costs',
    why: 'Title, legal, survey, recording and transfer taxes are capitalized into what the property cost you.',
  },
  {
    key: 'loan',
    // Points are NOT part of the building. They buy the loan, and they amortize over
    // the loan's term — which is why round 9 gave `loan_costs` no default life.
    label: 'Cost of the loan, not the building',
    basis: 'loan_costs',
    why: 'Points and origination fees amortize over the term of the loan, not the life of the building.',
  },
  {
    key: 'expense',
    label: 'An expense for that year',
    basis: null,
    why: 'Prorated property taxes and prepaid insurance are operating costs of the year you bought, not part of what the building cost.',
  },
  {
    key: 'not_basis',
    label: 'Neither a cost nor an expense',
    basis: null,
    why: 'Transferred security deposits, escrow funding, rent prorations and credits move money without buying anything.',
  },
];

const BY_TREATMENT = new Map(COST_TREATMENTS.map((t) => [t.key, t]));

// Same refusal assetKindInfo and dispositionInfo make: a treatment written by a later
// round and read by an older cached bundle reports itself as unknown rather than
// quietly inheriting another one's destination. An unknown treatment is never basis.
export function treatmentInfo(key) {
  return (
    BY_TREATMENT.get(key) || {
      key: key || 'unknown',
      label: 'Not classified',
      basis: null,
      why: 'Amlak could not tell what this charge was, so it is left out of the building’s cost.',
    }
  );
}

// Group the read's cost lines by treatment and total each group — IN CODE. A line with
// no usable amount is dropped rather than counted as zero, and the count of what was
// dropped rides along so the screen can say so instead of quietly showing less.
export function classifyCosts(costs = []) {
  const groups = new Map(COST_TREATMENTS.map((t) => [t.key, { ...t, lines: [], total: 0 }]));
  let unreadable = 0;

  for (const c of costs || []) {
    const amount = num(c?.amount);
    if (amount == null || !(Math.abs(amount) > 0)) {
      unreadable += 1;
      continue;
    }
    const info = treatmentInfo(c?.treatment);
    if (!groups.has(info.key)) groups.set(info.key, { ...info, lines: [], total: 0 });
    const g = groups.get(info.key);
    g.lines.push({ label: String(c?.label || '').trim() || 'Unnamed charge', amount: round2(Math.abs(amount)) });
    g.total = round2(g.total + Math.abs(amount));
  }

  return { groups: [...groups.values()].filter((g) => g.lines.length), unreadable };
}

// The asset rows a reading proposes — nothing is written until the landlord confirms.
//
// Returns [{ kind, description, cost, land_cost, placed_in_service, useful_life_years,
//            note, blocked, blockedReason }]
//
// ⚠ TWO THINGS IT REFUSES TO INVENT.
//   1. The LAND SPLIT. A settlement statement almost never states it — it is an
//      allocation DECISION, not a fact printed on the page — so `land_cost` comes back
//      null and round 9's gold "Set the land value" chip does its job. Deriving it from
//      an assessor ratio here would be the silently-wrong number that whole refusal
//      exists to prevent.
//   2. The IN-SERVICE DATE. With no closing date on the document there is no date to
//      place the building in service, and inventing one produces a schedule that is
//      confidently wrong for thirty-nine years. It comes back blocked and asks.
export function proposedAssets(read, opts = {}) {
  const price = num(read?.purchase_price);
  const closing = isIso(read?.closing_date) ? String(read.closing_date) : null;
  const land = num(read?.land_value);
  const { groups } = classifyCosts(read?.costs);
  const totalOf = (key) => groups.find((g) => g.key === key)?.total || 0;
  const out = [];

  if (price != null && price > 0) {
    out.push({
      kind: 'building',
      description: opts.propertyName ? `${opts.propertyName} — structure` : 'Building — structure',
      cost: round2(price),
      // null, never 0. A ground lease legitimately answers 0; a building nobody has
      // split answers null, and the two must not look alike.
      land_cost: land != null && land >= 0 ? round2(land) : null,
      placed_in_service: closing,
      useful_life_years: null,
      note: 'From the closing statement',
      blocked: !closing,
      blockedReason: closing ? null : 'the closing date was not read — set it before this can depreciate',
    });
  }

  const acq = totalOf('acquisition');
  if (acq > 0) {
    out.push({
      kind: 'acquisition_costs',
      description: 'Closing costs capitalized into the purchase',
      cost: acq,
      land_cost: null,
      placed_in_service: closing,
      useful_life_years: null,
      note: 'From the closing statement',
      blocked: !closing,
      blockedReason: closing ? null : 'the closing date was not read — set it before this can depreciate',
    });
  }

  const loan = totalOf('loan');
  if (loan > 0) {
    out.push({
      kind: 'loan_costs',
      description: 'Loan points and origination fees',
      cost: loan,
      land_cost: null,
      placed_in_service: closing,
      // ⚠ Deliberately none. Points amortize over the TERM OF THE LOAN, which Amlak
      // does not know until Slice 6 exists, so this asset arrives blocked and says why
      // rather than borrowing the building's 39 years and producing a confident
      // schedule off a number nobody chose.
      useful_life_years: null,
      note: 'From the closing statement — amortizes over the loan term',
      blocked: true,
      blockedReason: 'points amortize over the term of your loan, which Amlak does not know yet — type the number of years',
    });
  }

  return out;
}

// Every charge that does NOT become an asset, with where it actually belongs.
//
// ⚠ AND NONE OF IT IS WRITTEN ANYWHERE, which is the deliberate part. The prorated
// property tax on a closing statement is a real expense of the year you bought — but
// writing it into that year's `taxes_total` would re-sum the kind, re-split every
// tenant's share and move bills on a historical year that is very likely CLOSED. A
// document read is not a reason to move somebody's rent. So it is reported precisely,
// with the figure and the destination, and the landlord types it in if they want it.
export function notCapitalized(read) {
  const { groups, unreadable } = classifyCosts(read?.costs);
  const excluded = groups.filter((g) => !g.basis);
  return {
    groups: excluded,
    total: round2(excluded.reduce((s, g) => s + g.total, 0)),
    lineCount: excluded.reduce((s, g) => s + g.lines.length, 0),
    unreadable,
  };
}

// The one-line tie-out: what the document showed, and what became basis. Deliberately
// NOT a claim that the two should match — they never should, and a screen implying
// otherwise would teach the landlord to distrust a correct read. It answers "was every
// line looked at", which is the round-6 completeness guarantee in one sentence.
export function readSummary(read) {
  const assets = proposedAssets(read);
  const left = notCapitalized(read);
  const basis = round2(assets.reduce((s, a) => s + (a.cost || 0), 0));
  const lines = (read?.costs || []).length;

  return {
    basis,
    assetCount: assets.length,
    excludedTotal: left.total,
    excludedCount: left.lineCount,
    unreadable: left.unreadable,
    lineCount: lines,
    // Every charge line is either in an asset or in the excluded list — there is no
    // third place for one to go, and nothing is silently dropped.
    placed: lines - left.unreadable,
  };
}
