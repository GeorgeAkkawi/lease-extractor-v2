// Slice 4a — what happened to a bank line. The vocabulary, and the arithmetic that
// proves nothing went missing.
//
// George's rule: a dollar that crossed the bank is either recorded somewhere or
// explicitly left out with a reason. Never dropped. Before this, a line nothing
// recognized arrived unticked and saving produced no write and no record — so the
// money didn't just go unrecorded, it went untraceable.
//
// A JS registry, not a DB enum, matching FEATURES / NOTIFY_TYPES / EXPENSE_CATEGORIES:
// rounds 7 and 8 add members (owner · entity · transfer · debt · capital ·
// other_income · deposit_held) and a CHECK constraint would mean a migration per
// member and would reject a row the app considers valid.

// `placed` is the load-bearing bit: a line is accounted for when SOMEBODY decided
// about it — recorded or deliberately left out. Only 'unclassified' is unplaced, and
// it is a real counted state rather than a silent null.
export const DISPOSITIONS = [
  {
    key: 'rent',
    label: 'Tenant rent',
    short: 'Rent',
    dir: 'in',
    placed: true,
    hint: 'Booked against a tenant’s invoice.',
  },
  {
    key: 'expense',
    label: 'Property expense',
    short: 'Expense',
    dir: 'out',
    placed: true,
    hint: 'Recorded as a CAM, tax or roof line on this property.',
  },
  // Slice 4b — the three homes that did not exist before round 7. All PLACED: a draw
  // recorded is accounted for even though it appears in no expense total, and a
  // transfer between the owner's own accounts is real money movement that is neither
  // income nor expense. "Accounted for" means somebody decided, not "counted as a cost".
  {
    key: 'owner',
    label: 'Owner draw or contribution',
    short: 'Owner',
    dir: 'both',
    placed: true,
    hint: 'Equity — money you took out or put in. Never income, never an expense.',
  },
  {
    key: 'entity',
    label: 'Entity cost',
    short: 'Entity',
    dir: 'out',
    placed: true,
    hint: 'A cost of the LLC itself rather than of this building.',
  },
  {
    key: 'transfer',
    label: 'Transfer between your accounts',
    short: 'Transfer',
    dir: 'both',
    placed: true,
    hint: 'Real money movement, but neither income nor expense — it never left your hands.',
  },
  // Slice 4c — money IN that is not rent. Both are PLACED, and they sit on opposite
  // sides of the one line that matters: other income IS the property's income and
  // belongs in what actually stayed; a security deposit is the TENANT's money held,
  // and belongs in no income figure anywhere. Booking either against a lease as rent —
  // their only possible home before round 8 — credits that tenant's invoice and makes
  // the Ledger read the month over-paid.
  {
    key: 'other_income',
    label: 'Other income',
    short: 'Income',
    dir: 'in',
    placed: true,
    hint: 'Real income the property received that isn’t rent — a late fee, parking, a utility reimbursement.',
  },
  {
    key: 'deposit_held',
    label: 'Security deposit held',
    short: 'Deposit',
    dir: 'in',
    placed: true,
    hint: 'The tenant’s money, held. A liability — never income, and never credited against their rent.',
  },
  // Slice 5b — money out that buys something lasting. PLACED, and deliberately NOT
  // 'expense': the whole point is that a thing bought once and used for years is not a
  // cost of this year. It reaches no expense total and moves no tenant's bill on the way
  // in; only switching its amortization on does that, later and on purpose.
  {
    key: 'capital',
    label: 'Capitalized as an asset',
    short: 'Asset',
    dir: 'out',
    placed: true,
    hint: 'Bought once and used for years — recorded in the asset register and depreciated, not expensed in one year.',
  },
  {
    key: 'ignored',
    label: 'Deliberately left out',
    short: 'Left out',
    dir: 'both',
    placed: true,
    hint: 'You decided this line doesn’t belong in the ledger.',
  },
  {
    key: 'unclassified',
    label: 'Not yet placed',
    short: 'Unplaced',
    dir: 'both',
    placed: false,
    hint: 'Nothing has been decided about this line yet.',
  },
];

const BY_KEY = new Map(DISPOSITIONS.map((d) => [d.key, d]));

// An unknown disposition (a row written by a LATER round, read by an older bundle)
// must never read as placed — that would let money vanish from the count in exactly
// the direction that hides a problem. Falls back to unplaced and says so.
export function dispositionInfo(key) {
  return BY_KEY.get(key) || { key: key || 'unclassified', label: 'Not yet placed', short: 'Unplaced', dir: 'both', placed: false, hint: '' };
}

export const isPlaced = (key) => dispositionInfo(key).placed;

// Why a line was deliberately left out. Offered AFTER the decision, never as a
// required field — forcing a reason on the way out just teaches people to pick the
// first one, and an unexplained exclusion is still an exclusion (it was chosen).
export const IGNORE_REASONS = [
  { key: 'transfer', label: 'Transfer between my own accounts' },
  { key: 'duplicate', label: 'Already recorded another way' },
  { key: 'other_property', label: 'Belongs to a different property' },
  { key: 'personal', label: 'Personal, not the business' },
  { key: 'other', label: 'Something else' },
];

const REASON_BY_KEY = new Map(IGNORE_REASONS.map((r) => [r.key, r.label]));
export const ignoreReasonLabel = (key) => REASON_BY_KEY.get(key) || null;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The completeness tie-out: does every transcribed line have a decision, and how much
// money is sitting in lines that don't?
//
// Money IN and money OUT are counted SEPARATELY and deliberately. An unplaced deposit
// is the more dangerous of the two — it may be rent that should have settled a month,
// so the Ledger reads a tenant short — whereas an unplaced withdrawal is money spent
// that no report counts. Summing them into one figure would let a $5,000 deposit and a
// $5,000 withdrawal cancel out and report "$0 unplaced", which is the exact class of
// silent loss this whole slice exists to end.
export function lineCompleteness(lines = []) {
  const out = {
    total: lines.length,
    placed: 0,
    unplaced: 0,
    unplacedIn: 0,
    unplacedOut: 0,
    ignored: 0,
    byDisposition: {},
  };
  for (const l of lines) {
    const key = l?.disposition || 'unclassified';
    out.byDisposition[key] = (out.byDisposition[key] || 0) + 1;
    if (key === 'ignored') out.ignored++;
    if (isPlaced(key)) {
      out.placed++;
    } else {
      out.unplaced++;
      const amt = Math.abs(Number(l?.amount) || 0);
      if (l?.direction === 'in') out.unplacedIn = round2(out.unplacedIn + amt);
      else out.unplacedOut = round2(out.unplacedOut + amt);
    }
  }
  return out;
}

// One line of plain English for a completeness result — the sentence a landlord reads
// to know the import held onto everything. States the placed count FIRST, because
// "38 of 38" is the answer; the exceptions follow only when there are any.
export function completenessSentence(c) {
  if (!c || !c.total) return '';
  const line = `${c.placed} of ${c.total} line${c.total === 1 ? '' : 's'} placed`;
  if (!c.unplaced) return `${line} ✓`;
  const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const parts = [];
  if (c.unplacedIn) parts.push(`${money(c.unplacedIn)} in`);
  if (c.unplacedOut) parts.push(`${money(c.unplacedOut)} out`);
  return `${line} · ${c.unplaced} not placed${parts.length ? ` (${parts.join(' · ')})` : ''}`;
}

// What a review row RESOLVES to as a disposition — the one place the review screen's
// vocabulary (tenant / expense_* / ignore) maps onto the audit vocabulary.
//
// THE JUDGEMENT THAT MATTERS: only an ignore the LANDLORD picked counts as 'ignored'.
// The matcher ignores a line by keyword too (IGNORE_KEYWORDS bins MORTGAGE / LOAN /
// TRANSFER / DRAW), and recording that as a decision would credit the landlord with a
// choice they never made. Those lines are precisely the ones with no home in Amlak
// YET — rounds 7 and 8 give them one — so they stay 'unclassified' and keep nagging
// until they do. An unplaced figure that quietly absorbed them would be a lie that
// gets quieter over time.
export function dispositionForRow({ checked, kind, picked, duplicate }) {
  if (checked && kind === 'tenant') return 'rent';
  if (checked && String(kind || '').startsWith('expense_')) return 'expense';
  // Slice 4b. A draw, a contribution and an entity cost each WRITE a row, so they
  // need the tick exactly as an expense does — money out is never booked without the
  // landlord's say-so, and a matcher suggestion left untouched stays unplaced and
  // keeps nagging (the same judgement round 6 made about keyword ignores).
  if (checked && (kind === 'owner_draw' || kind === 'owner_contribution')) return 'owner';
  if (checked && kind === 'entity_cost') return 'entity';
  // Slice 4c. Both WRITE something — other income writes a row, a deposit writes the
  // lease's held figure — so both need the tick, same rule as an expense. A deposit
  // pick carries its lease in the pick itself (`deposit:<leaseId>`), because "whose
  // deposit is it" is the entire question.
  if (checked && kind === 'other_income') return 'other_income';
  if (checked && kind === 'deposit_held') return 'deposit_held';
  // Slice 5b. Writes a fixed_assets row, so it needs the tick like every other write.
  if (checked && kind === 'capital') return 'capital';
  // A transfer is the exception, and for the same reason an ignore is: it writes
  // nothing, so the PICK is the entire decision and there is no tick to wait for.
  if (picked && kind === 'transfer') return 'transfer';
  if (picked && kind === 'ignore') return 'ignored';
  // A duplicate is the one exclusion nobody has to decide: the guard has already
  // matched this line to money recorded from an earlier import, so it IS accounted
  // for. Leaving it unplaced would nag about a dollar that is on the books twice
  // over — which would teach the landlord to ignore the nag.
  if (duplicate) return 'ignored';
  return 'unclassified';
}

// The reason a duplicate carries, so it explains itself in the register without the
// landlord ever having been asked.
export const duplicateReasonFor = (row) => (row && row.duplicate ? 'duplicate' : null);
