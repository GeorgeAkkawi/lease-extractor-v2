// Per-month charges and credits on ONE tenant — the tenant sub-ledger (0082).
//
// THE GAP THIS CLOSES. A month's `owed` is derived, never stored: annual base ÷ 12 plus
// annual CAM&tax/roof ÷ 12 (leaseSchedule.js + ledger.js). So when a month genuinely
// differs — the CAM was higher that month, a late fee applies, a concession was agreed —
// there was nowhere to record it. The Ledger could SHOW the month came in short and offer
// nothing to do about it.
//
// ⚠ THE ONE RULE EVERYTHING HERE FOLLOWS FROM:
//
//     An adjustment changes what is OWED. It never changes what was RECEIVED,
//     and it never counts itself as covered.
//
// Two silent-corruption paths follow from getting that wrong, and both are guarded at
// their own call site rather than here: `resyncYearBillingToEstimate` re-stamps system
// marks to the SCHEDULED owed (never the adjusted owed, or it would assert money that
// never arrived), and `allocatePayments` caps a settled month's coverage at the SCHEDULED
// owed (or a charge posted on an already-paid month would be invisible — George's most
// common case). With no adjustments both are byte-identical to before.
//
// ⚠ SIGNED AMOUNTS, DELIBERATELY. `entity_ledger` stores a magnitude and takes its sign
// from the kind (entityLedger.js:59), because a draw is always out. Here the sign is
// genuinely per-row — a CAM correction goes either way — so it lives on the row and the
// kind is only the category. Positive = a CHARGE (debit the tenant), negative = a CREDIT.
//
// A JS registry rather than a DB CHECK, for the reason 0075/0076/0077/0079/0080 all give:
// a CHECK means a migration every time the list is refined and would reject a row the app
// considers valid.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const ADJUSTMENT_KINDS = [
  {
    key: 'base',
    label: 'Base rent correction',
    short: 'Base',
    // 'both' = the landlord picks charge or credit; 'charge'/'credit' = locked one way.
    dir: 'both',
    // ⚠ A GROSS lease has no separate CAM to correct — the flat rent already CONTAINS
    // taxes & CAM and the tenant's share is carved OUT of it, never billed on top
    // (reconciliation.js:38, migration 0073). A CAM correction there would re-add on
    // top of a rent that already includes it: the exact hole 0073 exists to close.
    grossOk: true,
    // Does ⚖ Reconcile have to know about it? Only a CAM & tax correction changes what
    // the tenant was billed for CAM & tax, so only that kind offsets the estimate side
    // at year end — otherwise the true-up charges the same dollars twice.
    offsetsCamTax: false,
    hint: 'The rent for this month was different from the schedule — a proration, a missed step, a correction agreed with the tenant.',
  },
  {
    key: 'camtax',
    label: 'CAM & tax correction',
    short: 'CAM & tax',
    dir: 'both',
    grossOk: false,
    offsetsCamTax: true,
    hint: 'The CAM & tax billed this month was different from the yearly estimate ÷ 12. Counted at year end, so ⚖ Reconcile does not charge it twice.',
  },
  {
    key: 'fee',
    label: 'Late fee / other charge',
    short: 'Fee',
    dir: 'charge',
    grossOk: true,
    offsetsCamTax: false,
    hint: 'A charge the tenant owes under the lease — a late fee, a utility rebill, a repair they are responsible for.',
  },
  {
    key: 'credit',
    label: 'Concession / credit / write-off',
    short: 'Credit',
    dir: 'credit',
    grossOk: true,
    offsetsCamTax: false,
    hint: 'Money you have agreed not to collect — a concession, a goodwill credit, a write-off.',
  },
];

const BY_KIND = new Map(ADJUSTMENT_KINDS.map((k) => [k.key, k]));

// The same refusal entityKindInfo and dispositionInfo make: a kind written by a later
// round and read by an older cached bundle reports itself as unknown rather than
// inheriting another kind's meaning. Note what it does NOT refuse — the row's AMOUNT
// still counts toward the month (a signed dollar figure on a month is kind-independent,
// and dropping it would break `base + camTax + roof + adj === owed` between two bundles).
// What it withholds is `offsetsCamTax`, so an unrecognized row is never silently netted
// out of the year-end true-up.
export function adjustmentKindInfo(key) {
  return (
    BY_KIND.get(key) || {
      key: key || 'unknown',
      label: 'Adjustment',
      short: '—',
      dir: 'both',
      grossOk: true,
      offsetsCamTax: false,
      hint: '',
      unknown: true,
    }
  );
}

export const isAdjustmentKind = (key) => BY_KIND.has(key);

// The kinds offered for a lease. A gross tenant is refused the CAM & tax correction for
// the reason on that entry above — matching reconcileCamTax's throw (api.js) and
// deriveEstimateFromDeposit's refusal (statementMatch.js).
export function adjustmentKindsFor({ gross = false } = {}) {
  return ADJUSTMENT_KINDS.filter((k) => k.grossOk || !gross);
}

export const adjustmentAllowed = (key, { gross = false } = {}) =>
  isAdjustmentKind(key) && (adjustmentKindInfo(key).grossOk || !gross);

// Turn what the panel collected (a kind, a magnitude, and a charge/credit pick) into the
// one signed number that gets stored. A kind locked to one direction wins over the pick,
// so a "late fee" can never be stored as a credit by a stray toggle.
export function signedAmount({ kind, amount, direction = 'charge' } = {}) {
  const info = adjustmentKindInfo(kind);
  const mag = Math.abs(Number(amount) || 0);
  if (!(mag > 0)) return 0;
  const dir = info.dir === 'charge' || info.dir === 'credit' ? info.dir : direction;
  return dir === 'credit' ? round2(-mag) : round2(mag);
}

// Σ of every adjustment on each month, as a length-12 signed array [Jan..Dec]. This is
// what gets ADDED to the derived owed — every row counts, whatever its kind.
export function monthlyAdjustments(rows = []) {
  const out = Array(12).fill(0);
  for (const r of rows || []) {
    const m = Number(r?.month);
    if (!(m >= 1 && m <= 12)) continue;
    out[m - 1] = round2(out[m - 1] + (Number(r?.amount) || 0));
  }
  return out;
}

// The rows on one month, newest first (the panel's list).
export function adjustmentsForMonth(rows = [], month) {
  const m = Number(month);
  return (rows || [])
    .filter((r) => Number(r?.month) === m)
    .sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')));
}

// Σ signed amount for the year — what the invoice total moves by.
export function adjustmentTotal(rows = []) {
  return round2((rows || []).reduce((s, r) => s + (Number(r?.amount) || 0), 0));
}

// ⚠ Σ of only the CAM & TAX corrections for the year. `reconcileFigures` compares the
// annual ESTIMATE to the ACTUAL share; a +$400 CAM correction means the tenant has
// already been billed $400 more CAM, so the estimate side must include it or ⚖ Reconcile
// trues up as if they hadn't — charging the same dollars twice.
export function camTaxAdjustmentTotal(rows = []) {
  return round2(
    (rows || []).reduce(
      (s, r) => (adjustmentKindInfo(r?.kind).offsetsCamTax ? s + (Number(r?.amount) || 0) : s),
      0,
    ),
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (m) => MONTHS[Number(m) - 1] || '';

const iso = (y, m, d = 1) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// The tenant statement: one dated list of charges, credits and payments with a running
// balance — George's "debits and credits per tenant", read as a document.
//
// A positive `amount` increases what the tenant owes; a negative one decreases it. The
// running `balance` is therefore what they owe as of that line (positive = they owe you).
//
// ⚠ Only charges that have COME DUE are listed. Rent is charged on the 1st, so listing
// December's rent in March would report a balance the tenant does not owe yet. For a past
// fiscal year every month has come due, so the whole year shows. Payments are listed on
// the day they were received whatever month they settle, because that is when the money
// moved.
export function statementRows({
  year,
  scheduled = {},
  payments = [],
  adjustments = [],
  today = new Date(),
  dust = 0.005,
} = {}) {
  const y = Number(year);
  const rows = [];
  const due = (m) => new Date(y, m - 1, 1, 12) <= today;

  for (let m = 1; m <= 12; m++) {
    if (!due(m)) continue;
    const owed = round2(Number(scheduled?.[m]?.owed ?? scheduled?.[m - 1]) || 0);
    if (owed > dust) {
      rows.push({
        key: `rent-${m}`,
        date: iso(y, m),
        sort: `${iso(y, m)}#0`,
        type: 'charge',
        label: `Rent — ${monthName(m)}`,
        month: m,
        amount: owed,
      });
    }
    for (const a of adjustmentsForMonth(adjustments, m).slice().reverse()) {
      const amt = round2(Number(a?.amount) || 0);
      if (!(Math.abs(amt) > dust)) continue;
      const info = adjustmentKindInfo(a?.kind);
      rows.push({
        key: `adj-${a.id}`,
        date: iso(y, m),
        sort: `${iso(y, m)}#1${String(a?.created_at || '')}`,
        type: amt < 0 ? 'credit' : 'adjustment',
        label: `${info.label} — ${monthName(m)}`,
        memo: a?.memo || '',
        month: m,
        id: a?.id,
        amount: amt,
      });
    }
  }

  for (const p of payments || []) {
    const amt = round2(Number(p?.amount) || 0);
    if (!(amt > dust)) continue;
    const d = String(p?.paid_date || '') || iso(y, 1);
    const pm = Number(p?.period_month);
    rows.push({
      key: `pay-${p.id || d + amt}`,
      date: d,
      sort: `${d}#2`,
      type: 'payment',
      label: pm >= 1 && pm <= 12 ? `Payment received — for ${monthName(pm)}` : 'Payment received',
      memo: p?.note || '',
      amount: round2(-amt),
    });
  }

  rows.sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
  let balance = 0;
  for (const r of rows) {
    balance = round2(balance + r.amount);
    r.balance = balance;
  }
  return { rows, balance };
}
