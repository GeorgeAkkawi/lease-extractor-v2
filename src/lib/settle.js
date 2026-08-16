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
import { allocatePayments, ledgerRowSummary, monthClosedForLogging } from './ledger';
import { adjustmentTotal } from './adjustments';

const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;

/**
 * One tenant's position for the year — and it carries TWO figures, because two different
 * questions are being asked of it.
 *
 * ⚠ `closing` IS THE RECEIVABLE: `owesToDate − credit`, every month that has fallen DUE.
 * Rent falls due on the 1st, so it includes the month running now. That is right for an
 * accountant and right for a year-end statement, which is what the workbook and the
 * close-year confirm want.
 *
 * ⚠ `owes` IS WHAT CAN BE ACTED ON, and it waits for the month to END. This is the split
 * CLAUDE.md §4 already records and that Slice 4 broke:
 *
 *     `monthsBehind` WAITS FOR THE MONTH TO END; `owesToDate` DOES NOT … What waits is the
 *     accusation: the bank statement that would settle the month does not exist yet.
 *
 * Hanging "Settle up" on the receivable meant every tenant was offered a write-off on the
 * 1st of every month, for money that had simply not been logged yet (George: *"why does it
 * say every tenant owes something?"*). His own rule — *"only when their projected rent is
 * above or below what they actually paid"* — needs one more ingredient, which months can be
 * judged, and the codebase already owns that boundary: `monthClosedForLogging(y, m, today, 0)`,
 * the same call behind the `4 mo behind` badge, the gold overdue cell and both statement
 * reminders. Same function, no grace, so the three can never disagree.
 *
 * ⚠ `inCredit` DOES NOT WAIT, deliberately. Money you are already holding is not an
 * accusation — refunding it needs no month to close. Only the owing side is an assertion
 * about someone else's conduct, and only assertions have to wait for evidence.
 *
 * The two are mutually exclusive by construction: the pool fills every month's need before
 * any of it survives as credit, so exactly one of `owes` / `inCredit` is ever non-zero.
 */
export function tenantStanding({ row, year, today = new Date(), alloc = null, summary = null, dust = 0.05 } = {}) {
  const a = alloc || allocatePayments({
    owedByMonth: row?.schedule, payments: row?.payments, adjustments: row?.adjustments,
  });
  const s = summary || ledgerRowSummary({ year, owedByMonth: row?.schedule, allocation: a, today });
  const closing = round2(s.owesToDate - s.credit);

  // The months whose bank statement should exist by now, and the shortfall on them.
  let owesClosed = 0;
  let judgedThrough = 0;
  for (let m = 1; m <= 12; m++) {
    if (!monthClosedForLogging(year, m, today, 0)) continue;
    judgedThrough = m;
    const gap = round2(num(a.owed?.[m - 1]) - num(a.coverage?.[m - 1]));
    if (gap > dust) owesClosed = round2(owesClosed + gap);
  }
  const inCredit = closing < -0.005 ? round2(-closing) : 0;
  const owes = owesClosed > 0.005 ? owesClosed : 0;

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
    owes,
    inCredit,
    // What is owed on months that have NOT closed yet — the running month, almost always.
    // Reported so the difference between the two figures is stated rather than mysterious,
    // and never acted on.
    provisional: round2(Math.max(0, round2(s.owesToDate) - owesClosed)),
    // The owing side of `closing` — the receivable, including the month still running. Paired
    // with `inCredit` (which is already closing-based) so the year-end totals add up from two
    // fields measured the same way. `owes` deliberately is not that field.
    receivable: closing > 0.005 ? closing : 0,
    judgedThrough,
    // ⚠ TWO PREDICATES, TWO QUESTIONS, AND THE NAMES SAY WHICH.
    //   `settled`     — nothing to ACT on. What the Ledger's Settle up control reads.
    //   `openBalance` — a receivable exists. What the workbook and the close-year confirm
    //                   read, because a year-end statement must not hide a balance merely
    //                   because this month's statement has not arrived.
    // They coincide on any past year, which is when a settlement normally happens.
    settled: owes <= 0.005 && inCredit <= 0.005,
    openBalance: Math.abs(closing) > 0.005,
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
      owed: round2(t.owed + r.receivable),
      inCredit: round2(t.inCredit + r.inCredit),
    }),
    { billed: 0, received: 0, charges: 0, owed: 0, inCredit: 0 }
  );
  // ⚠ `openBalance`, NOT `settled`. This list is what the close-year confirm names and what
  // the workbook highlights — both are year-end statements, so they must report a receivable
  // that exists even when this month's bank statement has not arrived to prove it.
  return { rows, totals, open: rows.filter((r) => r.openBalance) };
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
 * ⚠ `basis` DECIDES WHICH MONTHS ARE ELIGIBLE, and the two answers are asking different
 * questions rather than being a strict/loose pair:
 *
 *   'ended'  — only months whose bank statement should exist by now
 *              (`monthClosedForLogging(y, m, today, 0)`, the same call `tenantStanding` uses
 *              for `owes`). This is a settlement OF THE PAST: forgiving a month you cannot
 *              yet know went unpaid is forgiving money nobody has failed to pay. It also
 *              keeps the capacity and the amount measured the same way — spread a figure
 *              built from ended months across months chosen by any other rule and the two
 *              disagree at the edges.
 *   'billed' — any month carrying an outstanding bill, whether or not it has closed. This is
 *              a credit AGAINST THE FUTURE: a balance carried into next year lands on months
 *              that have not happened, which is the whole point of carrying it.
 */
export function monthCapacity({ alloc, direction = 'credit', basis = 'ended', year, today = new Date() } = {}) {
  const owed = alloc?.owed || Array(12).fill(0);
  const coverage = alloc?.coverage || Array(12).fill(0);
  return Array.from({ length: 12 }, (_, i) => {
    if (direction === 'charge') return Infinity;
    if (basis === 'ended' && !monthClosedForLogging(year, i + 1, today, 0)) return 0;
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
