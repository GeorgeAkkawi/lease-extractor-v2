// Where each tenant stands at the end of a year, and the four ways to close it out.
//
// George, 2026-08-16: *"How do we convey credits or debits at the end of the year? when those
// debits are conveyed how do we dismiss them/reconcile them. the user has to have autonomy
// over these things."*
//
// ⚠ BEFORE THIS, A YEAR-END BALANCE HAD NO EXIT. `statementRows` computed one, on screen,
// current year only. There was no write-off, no forgiveness and no carry-forward anywhere in
// the codebase — and the only instrument that existed, a `credit` adjustment, is capped at
// ONE month's bill (`addAdjustment`), so a year's arrears could not be expressed at all.
//
// ⚠ THE PER-MONTH CAP STAYS, AND THAT IS THE WHOLE REASON THIS FILE EXISTS. A credit larger
// than a month's bill makes `owed` negative, which reads as "unbilled" everywhere downstream,
// breaks `componentizeSchedule`'s `base + camTax + roof + adj === owed` invariant and silently
// drops the excess out of the year total. So a settlement SPREADS — earliest month first,
// against each month's own remaining capacity — which is the mirror image of how
// `allocatePayments` fills months from a pool. One helper, both directions, no guard weakened.
//
// ⚠ AND THE ARITHMETIC IS NOT RE-DERIVED. Everything here is read off `allocatePayments` and
// `ledgerRowSummary` — the §2 choke points the Ledger grid itself is painted from — so the
// balance a landlord settles is the same balance the grid shows them. A second definition of
// "what does this tenant owe" is precisely the drift that puts two figures in front of one
// person on one afternoon.
import { allocatePayments, ledgerRowSummary } from './ledger';
import { adjustmentTotal } from './adjustments';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/**
 * One tenant's position for the year.
 *
 * ⚠ THE CLOSING BALANCE IS `owesToDate − credit`, NOT `billed − received`, and the difference
 * is the whole of the current year. `billed` counts all twelve months including ones that have
 * not fallen due, so on a year in progress `billed − received` would offer to write off rent
 * the tenant has every right not to have paid yet. `owesToDate` is the figure that already
 * ties to `arStatus.amountBehind` to the cent (CLAUDE.md §4), and `credit` is the untagged
 * money no month needed. The two are mutually exclusive by construction — the pool fills every
 * month's need before any of it survives as credit — so exactly one of them is ever non-zero.
 *
 * Positive = the tenant owes. Negative = the tenant is in credit.
 */
export function tenantStanding({ row, year, today = new Date(), alloc = null, summary = null } = {}) {
  const a = alloc || allocatePayments({
    owedByMonth: row?.schedule, payments: row?.payments, adjustments: row?.adjustments,
  });
  const s = summary || ledgerRowSummary({ year, owedByMonth: row?.schedule, allocation: a, today });
  const closing = round2(s.owesToDate - s.credit);
  return {
    lease_id: row?.lease_id || null,
    label: String(row?.tenant_name || '').trim() || 'Tenant',
    billed: round2(s.billed),
    received: round2(s.collected),
    // Every charge and credit already on the tenant's months, signed. Stated beside the
    // balance because a landlord looking at "owes $4,150" needs to know whether a late fee
    // is inside it.
    charges: adjustmentTotal(row?.adjustmentRows),
    closing,
    owes: closing > 0.005 ? closing : 0,
    inCredit: closing < -0.005 ? round2(-closing) : 0,
    settled: Math.abs(closing) <= 0.005,
    alloc: a,
    summary: s,
  };
}

/** Every tenant on a property, biggest balance first — the "Where each tenant stands" block. */
export function propertyStandings({ roll = [], year, today = new Date() } = {}) {
  const rows = (roll || []).map((row) => tenantStanding({ row, year, today }));
  rows.sort((a, b) => Math.abs(b.closing) - Math.abs(a.closing) || a.label.localeCompare(b.label));
  const totals = rows.reduce(
    (t, r) => ({
      billed: round2(t.billed + r.billed),
      received: round2(t.received + r.received),
      charges: round2(t.charges + r.charges),
      owed: round2(t.owed + r.owes),
      inCredit: round2(t.inCredit + r.inCredit),
    }),
    { billed: 0, received: 0, charges: 0, owed: 0, inCredit: 0 }
  );
  return { rows, totals, open: rows.filter((r) => !r.settled) };
}

/**
 * How much each month can absorb, for a settlement in one direction.
 *
 *   'credit' — what is still UNPAID on the month (`owed − coverage`). Crediting more than
 *              that would push the month negative, so this is the guard restated as a
 *              capacity rather than as a refusal.
 *   'charge' — unbounded. A charge only ever increases what a month owes, so there is
 *              nothing to protect; the array is returned anyway so both directions read the
 *              same at the call site.
 *
 * ⚠ MONTHS THAT HAVE NOT COME DUE ARE EXCLUDED from a credit's capacity when `dueThrough` is
 * given. Writing off December's rent in March forgives money nobody has failed to pay.
 */
export function monthCapacity({ alloc, direction = 'credit', dueThrough = 12 } = {}) {
  const owed = alloc?.owed || Array(12).fill(0);
  const coverage = alloc?.coverage || Array(12).fill(0);
  return Array.from({ length: 12 }, (_, i) => {
    if (direction === 'charge') return Infinity;
    if (i + 1 > Number(dueThrough || 12)) return 0;
    return Math.max(0, round2(num(owed[i]) - num(coverage[i])));
  });
}

/**
 * Lay `amount` across the months, earliest first, never more than a month can take.
 *
 * Returns `{ rows, placed, shortfall }`. ⚠ A SHORTFALL IS RETURNED, NEVER SWALLOWED — if the
 * months cannot absorb the whole settlement the caller has to say so, because the alternative
 * is a landlord clicking "write it off", seeing the balance move partway, and being told
 * nothing about the rest.
 */
export function spreadAcrossMonths({ capacity = [], amount = 0, dust = 0.005 } = {}) {
  let left = round2(Math.abs(num(amount)));
  const rows = [];
  for (let i = 0; i < 12 && left > dust; i++) {
    const cap = capacity[i];
    if (!(cap > dust)) continue;
    const take = round2(Math.min(left, cap === Infinity ? left : cap));
    if (!(take > dust)) continue;
    rows.push({ month: i + 1, amount: take });
    left = round2(left - take);
  }
  return {
    rows,
    placed: round2(rows.reduce((s, r) => s + r.amount, 0)),
    shortfall: left > dust ? left : 0,
  };
}

/**
 * Which month a refund lands on.
 *
 * ⚠ THE MONTH THAT HOLDS THE MONEY, not December by default. A refund charge is settled by
 * the credit already sitting on the tenant's ledger, and `allocatePayments` fills months from
 * January forward — so putting the charge on a month the tenant never paid into opens a false
 * gap on that month while leaving the credit untouched. The last month that actually received
 * money is where the overpayment demonstrably is; December is the fallback for a tenant whose
 * money is all pooled and unallocated.
 */
export function refundMonth(alloc) {
  const received = alloc?.received || [];
  for (let i = 11; i >= 0; i--) if (num(received[i]) > 0.005) return i + 1;
  return 12;
}

// The four choices, in the order they are offered. `movesIncome` is the single fact a
// landlord has to be told before clicking, and it is a property of the choice rather than
// something the dialog re-decides.
export const SETTLE_CHOICES = [
  {
    key: 'leave',
    label: 'Leave it open',
    movesIncome: false,
    hint: 'Nothing is written. The balance keeps showing until you settle it or it is paid.',
  },
  {
    key: 'writeoff',
    label: 'Write it off',
    movesIncome: true,
    hint: 'You have decided not to collect it. It comes OFF this year’s income, because this year already counted it as earned.',
  },
  {
    key: 'carry',
    label: 'Carry it forward',
    movesIncome: false,
    hint: 'Moves the balance into next January — a charge if they owe you, a credit if they are ahead. It was last year’s income and stays there.',
  },
  {
    key: 'refund',
    label: 'Record a refund',
    movesIncome: false,
    hint: 'You have given the money back. An overpayment was never income, so returning it is not a cost.',
  },
];

/**
 * Which of the four apply to a given standing, and why the others do not — the refusals are
 * returned rather than hidden, so a greyed-out choice can say what would make it available.
 */
export function settleChoicesFor(standing) {
  const owes = (standing?.owes || 0) > 0.005;
  const credit = (standing?.inCredit || 0) > 0.005;
  return SETTLE_CHOICES.map((c) => {
    if (c.key === 'leave') return { ...c, ok: true };
    if (c.key === 'writeoff') {
      return owes ? { ...c, ok: true } : { ...c, ok: false, why: 'There is nothing owed to write off — a credit is money you hold, not money you are forgiving.' };
    }
    if (c.key === 'refund') {
      return credit ? { ...c, ok: true } : { ...c, ok: false, why: 'There is no credit to refund — this tenant owes you money rather than the other way round.' };
    }
    return (owes || credit) ? { ...c, ok: true } : { ...c, ok: false, why: 'The year is settled — there is nothing to carry.' };
  });
}

/** One sentence describing what a settlement did, for the confirm and the history log. */
export function settleSentence({ choice, amount, months = [], year, nextYear = null }) {
  const money = (n) => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const span = months.length
    ? ` across ${months.length === 1 ? monthShort(months[0]) : `${monthShort(months[0])}–${monthShort(months[months.length - 1])}`}`
    : '';
  if (choice === 'writeoff') return `written off — ${money(amount)}${span}`;
  if (choice === 'carry') return `carried forward to ${nextYear || Number(year) + 1} — ${money(amount)}`;
  if (choice === 'refund') return `refunded — ${money(amount)}${span}`;
  return 'left open';
}

const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthShort = (m) => SHORT[Number(m) - 1] || '';
