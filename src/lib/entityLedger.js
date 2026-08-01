// Slice 4b — money that crossed the bank and belongs to the ENTITY or its OWNER
// rather than to the building's operations.
//
// Three things live here, and the difference between them is the whole point:
//
//   draw         the owner took money out          — EQUITY, never an expense
//   contribution the owner put money in            — EQUITY, never income
//   cost         an LLC-level expense              — a real expense, just not this
//                                                    building's (registered agent,
//                                                    franchise tax, corporate legal)
//
// ⚠ A DRAW IS NOT AN EXPENSE, and getting that wrong is not cosmetic. A distribution
// reduces equity; it is not deductible and never appears on a P&L. Filing one as an
// expense understates income by exactly the amount the CPA taxes. 401 S Main is
// already carrying two of them ("Liana", "Yazin") as not-billed expense lines, which
// is what makes this round urgent rather than tidy.
//
// A JS registry for the same reason DISPOSITIONS and EXPENSE_CATEGORIES are: the list
// will grow (debt, capital), and a DB CHECK would mean a migration per member.
import { EXPENSE_CATEGORIES, categoryLabel } from './expenseCategories';

export const ENTITY_KINDS = [
  {
    key: 'draw',
    label: 'Owner draw',
    short: 'Draw',
    dir: 'out',
    // Does it belong on a profit-and-loss statement at all?
    isExpense: false,
    // Which way it moves "what actually stayed in the account".
    sign: -1,
    hint: 'Money you took out of the business. Reduces your equity — never an expense, and never billed to a tenant.',
  },
  {
    key: 'contribution',
    label: 'Owner contribution',
    short: 'Contribution',
    dir: 'in',
    isExpense: false,
    sign: 1,
    hint: 'Money you put into the business. Increases your equity — never income.',
  },
  {
    key: 'cost',
    label: 'Entity cost',
    short: 'Entity',
    dir: 'out',
    isExpense: true,
    sign: -1,
    hint: 'A cost of the LLC itself rather than of this building — registered agent, franchise tax, corporate legal.',
  },
];

const BY_KIND = new Map(ENTITY_KINDS.map((k) => [k.key, k]));

// Same refusal as dispositionInfo: an unknown kind (written by a later round, read by
// an older bundle) must not be silently treated as one of the known ones. It reports
// itself as unknown, counts toward nothing, and moves no figure.
export function entityKindInfo(key) {
  return BY_KIND.get(key) || { key: key || 'unknown', label: 'Unrecorded', short: '—', dir: 'out', isExpense: false, sign: 0, hint: '' };
}

export const isEntityKind = (key) => BY_KIND.has(key);

// The kinds offered for a line of each direction. A transfer is NOT here: it produces
// no ledger row at all (see below), it is a disposition and nothing more.
export const entityKindsFor = (dir) => ENTITY_KINDS.filter((k) => k.dir === dir);

// Only an entity COST files on a line of the return. A draw does not appear on any
// tax form, so offering it a category would be inviting a wrong answer.
export const entityCostCategories = () => EXPENSE_CATEGORIES;
export const entityCategoryLabel = categoryLabel;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Totals by kind, plus the two figures the reconciliation strip actually reads.
// Rows of an unknown kind are counted in `unknown` rather than folded into a total —
// the same refusal the vocabulary above makes, carried into the arithmetic.
export function summarizeEntityLedger(rows = []) {
  const out = { draws: 0, contributions: 0, costs: 0, unknown: 0, count: 0, byKind: {} };
  for (const r of rows || []) {
    const amt = Math.abs(Number(r?.amount) || 0);
    const info = entityKindInfo(r?.kind);
    out.count += 1;
    out.byKind[info.key] = round2((out.byKind[info.key] || 0) + amt);
    if (info.key === 'draw') out.draws = round2(out.draws + amt);
    else if (info.key === 'contribution') out.contributions = round2(out.contributions + amt);
    else if (info.key === 'cost') out.costs = round2(out.costs + amt);
    else out.unknown = round2(out.unknown + amt);
  }
  return out;
}

// The costs the landlord entered and deliberately did NOT bill back.
//
// ⚠ This figure is *visible* on the Expense entry today and reaches NO total. It was
// built that way on purpose (2026-07-21: "folding them into NOI = v2"), and the
// consequence is that NOI is currently overstated by exactly the amount the landlord
// ate. This round counts it — BESIDE NOI, never inside it. Folding it into `cam_total`
// would bill tenants for costs deliberately absorbed, which is the exact thing
// `billable=false` exists to prevent; redefining `v_property_totals.noi` would
// silently re-value every historical chart point and every `financial_snapshots` row
// already written.
export function absorbedFromItems(items = []) {
  let total = 0;
  let count = 0;
  for (const it of items || []) {
    if (it?.billable === false) {
      total = round2(total + Math.abs(Number(it.amount) || 0));
      count += 1;
    }
  }
  return { total, count };
}

// The reconciliation strip: NOI as billed, then every real movement it doesn't know
// about, ending at what actually stayed in the account.
//
// Returns ordered lines so the UI renders a subtraction anyone can follow rather than
// a table of unrelated figures. A line whose figure is zero is omitted — a strip full
// of "$0.00 distributions" reads as noise and hides the ones that matter. `noi` always
// shows, even at zero, because it is what the subtraction starts from.
//
// otherIncome is round 8's (non-rent money in); it is accepted here so the strip's
// arithmetic doesn't have to change when that round lands.
export function whatStayed({ noi = 0, absorbed = 0, otherIncome = 0, draws = 0, contributions = 0, entityCosts = 0 } = {}) {
  const lines = [
    { key: 'noi', label: 'Net operating income', sub: 'as billed', amount: round2(noi), sign: 1, always: true },
    { key: 'otherIncome', label: 'Other income', sub: 'not tenant rent', amount: round2(otherIncome), sign: 1 },
    { key: 'contributions', label: 'Owner contributions', sub: 'money you put in', amount: round2(contributions), sign: 1 },
    { key: 'absorbed', label: 'Costs you absorbed', sub: 'entered, not billed to tenants', amount: round2(absorbed), sign: -1 },
    { key: 'entityCosts', label: 'Entity costs', sub: 'the LLC’s, not this building’s', amount: round2(entityCosts), sign: -1 },
    { key: 'draws', label: 'Owner draws', sub: 'money you took out', amount: round2(draws), sign: -1 },
  ];
  const shown = lines.filter((l) => l.always || Math.abs(l.amount) > 0.005);
  // Summed from the lines SHOWN, never from the inputs — a strip whose figures don't
  // add up to its own total is worse than no strip. (Omitted lines are exactly zero,
  // so this is the same number either way; it stays tied by construction.)
  const stayed = round2(shown.reduce((n, l) => n + l.sign * l.amount, 0));
  return { lines: shown, stayed };
}
