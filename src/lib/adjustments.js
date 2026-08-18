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
// ⚠ SIGNED AMOUNTS, DELIBERATELY. An expense line stores a magnitude and takes its sign
// from what it is, because money out is always out. Here the sign is genuinely per-row —
// a CAM correction goes either way — so it lives on the row and the kind is only the
// category. Positive = a CHARGE (debit the tenant), negative = a CREDIT.
//
// A JS registry rather than a DB CHECK, for the reason 0075/0076 give:
// a CHECK means a migration every time the list is refined and would reject a row the app
// considers valid.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ⚠ `pnlRow` — WHICH LINE OF THE INCOME-AND-EXPENSES SHEET THIS LANDS ON, and it is a
// judgement about accounting, not layout. That workbook counts rent when it FALLS DUE, so a
// tenant who never pays is already inside its revenue. Three consequences follow, and only
// the first is obvious:
//
//   'rent' / 'camtax' — a correction to a figure the sheet already prints, so it rides that
//       same row. `componentizeSchedule` computes base and camTax off the SCHEDULED owed
//       (owed − adj), so adding the correction back on that row restores the month to the
//       owed figure exactly — which is why Total billed still equals the Ledger to the cent.
//   'charges' — earned (a fee) or forgiven (a concession, a write-off) THIS year. A
//       write-off must reduce revenue: the sheet already counted that rent as income, so
//       leaving it in would overstate what the property earned by exactly what was forgiven.
//       ⚠ And it must NEVER be an expense — expense categories feed `recoveryFractions`, so
//       a forgiven rent booked as a cost would be recovered from the OTHER tenants.
//   null — real money that is not this year's income. A balance brought forward was last
//       year's income and counting it again double-counts; a refund returns an overpayment
//       that was never income, so giving it back is not a cost. Both still move the tenant's
//       balance — they are simply invisible to the P&L, and appear in the bank tie-out.
//
// ⚠ AN UNKNOWN KIND FILES UNDER 'charges', never null. Money that a later round invented
// must land in a visible total rather than disappear from a sheet an accountant is reading.
export const ADJUSTMENT_KINDS = [
  {
    key: 'base',
    label: 'Base rent correction',
    short: 'Base',
    pnlRow: 'rent',
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
    pnlRow: 'camtax',
    dir: 'both',
    grossOk: false,
    offsetsCamTax: true,
    hint: 'The CAM & tax billed this month was different from the yearly estimate ÷ 12. Counted at year end, so ⚖ Reconcile does not charge it twice.',
  },
  {
    key: 'fee',
    label: 'Late fee / other charge',
    short: 'Fee',
    pnlRow: 'charges',
    dir: 'charge',
    grossOk: true,
    offsetsCamTax: false,
    hint: 'A charge the tenant owes under the lease — a late fee, a utility rebill, a repair they are responsible for.',
  },
  {
    key: 'credit',
    // ⚠ "write-off" left this label when `writeoff` became its own kind (Slice 4). Two
    // entries competing for one word is how a landlord ends up filing the same thing two
    // ways and the sheet itemizes it twice.
    label: 'Concession / credit',
    short: 'Credit',
    pnlRow: 'charges',
    dir: 'credit',
    grossOk: true,
    offsetsCamTax: false,
    hint: 'Money you have agreed not to collect — a concession, a goodwill credit.',
  },
  // ── Moving a month's bill onto another month (2026-08-17) ───────────────────────────
  //
  // George: *"also should be an option to send shortages to overcharge the next month."*
  // Written only in pairs by `carryMonthShortfall` — a credit on the short month and a charge
  // on the target — which is why it is `manual: false`. Offered in the month picker, a
  // landlord could write the half that clears March and never the half that bills April, and
  // the money would simply be gone.
  //
  // ⚠ `pnlRow: 'rent'` AND NOT null, WHICH IS THE WHOLE ACCOUNTING DECISION. `opening` is null
  // because a balance crossing a YEAR boundary was another year's income. This crosses a month
  // inside one year: the year earned exactly the same money either way, so the pair must cancel
  // in the annual total and move only the month the revenue is billed in. Give it a null
  // `pnlRow` and every carry would quietly delete its own revenue from the workbook.
  {
    key: 'carry',
    label: 'Moved to another month',
    short: 'Moved',
    pnlRow: 'rent',
    dir: 'both',
    grossOk: true,
    offsetsCamTax: false,
    manual: false,
    hint: 'Part of one month’s bill moved onto another month — a credit on the month it left, a charge on the month it landed on.',
  },
  // ── Slice 4: the three kinds a SETTLEMENT writes ────────────────────────────────────
  //
  // ⚠ `manual: false` keeps all three off the month panel's picker. They are not things to
  // type on a month — each one is half of a two-sided settlement that has to be spread
  // across months, or paired with a row in another year, to be correct. Offering them as a
  // free-text charge would let a landlord write the half that clears this year and never
  // the half that carries it forward, which loses the money outright.
  {
    key: 'writeoff',
    label: 'Written off',
    short: 'Written off',
    // ⚠ 'charges', and it MUST reduce revenue. This sheet counts rent when it falls due, so
    // the forgiven rent is already inside the year's income; leaving it there overstates
    // what the property earned by exactly what was forgiven. And it must NEVER be an
    // expense — expense categories feed `recoveryFractions`, so a forgiven rent booked as a
    // cost would be recovered from the OTHER tenants.
    pnlRow: 'charges',
    dir: 'credit',
    grossOk: true,
    offsetsCamTax: false,
    manual: false,
    hint: 'Rent you have decided you will not collect. It comes off the year’s income, because the year already counted it.',
  },
  {
    key: 'opening',
    label: 'Balance brought forward',
    short: 'Brought fwd',
    // ⚠ null — real money that is NOT this year's income. It was last year's, and counting
    // it again double-counts. It still moves what the tenant owes, so it reaches `owed`,
    // the Ledger and the invoice; the sheet states it and then takes it back out before
    // "Total earned" (see `carried` in incomeExpense.js).
    pnlRow: null,
    dir: 'both',
    grossOk: true,
    offsetsCamTax: false,
    manual: false,
    hint: 'A balance carried over from another year — a charge if they owed you, a credit if they were ahead.',
  },
  {
    key: 'refund',
    label: 'Refunded to the tenant',
    short: 'Refund',
    // null for the mirror-image reason: an overpayment was never income, so handing it back
    // is not a cost. It consumes the credit sitting on the tenant's ledger and nothing else.
    pnlRow: null,
    dir: 'charge',
    grossOk: true,
    offsetsCamTax: false,
    manual: false,
    hint: 'Money you have given back. It was never income, so returning it is not a cost — it just clears the credit.',
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
      // Visible, in a total — see the note above ADJUSTMENT_KINDS. Withholding
      // `offsetsCamTax` keeps an unrecognized row out of the year-end netting; giving it a
      // null `pnlRow` would instead delete it from a workbook, which is the opposite trade.
      pnlRow: 'charges',
      dir: 'both',
      grossOk: true,
      offsetsCamTax: false,
      hint: '',
      unknown: true,
    }
  );
}

// WHERE THIS LANDS ON THE INCOME-AND-EXPENSES SHEET, in the sheet's own words.
//
// George, 2026-08-17: *"the settle up button should say — this money is now going to revenue
// and then when they accept that number should change the respective categories as noted in
// the .md."* The categories already moved correctly (that is what `pnlRow` above is for);
// what was missing was the app ever SAYING so before the landlord agreed to it.
//
// ⚠ The row names are quoted from `incomeExpenseExcel.js`, not paraphrased, so a dialog can
// never describe a line the workbook does not print. One string table, two readers — a second
// set of names would let the confirm and the sheet disagree about where a dollar went, and the
// landlord would only find out in front of an accountant.
//
// `earned` is the fact that actually matters and the one a landlord cannot work out alone:
// does the YEAR'S INCOME move? A fee or a write-off does; a balance brought forward and a
// refund do not (they are stated in Total billed and taken back out before Total earned).
const PNL_ROWS = {
  rent: { section: 'Money in', row: 'Rent', earned: true },
  camtax: { section: 'Money in', row: 'CAM & tax billed to tenants', earned: true },
  charges: { section: 'Money in', row: 'Charges & credits', earned: true },
};
const PNL_CARRIED = { section: 'Money in', row: 'Brought forward and refunds — not this year’s income', earned: false };

export function pnlDestination(kind) {
  const info = adjustmentKindInfo(kind);
  const base = PNL_ROWS[info.pnlRow] || PNL_CARRIED;
  return { ...base, label: info.label, kind: info.key };
}

// "Money in › Charges & credits › Late fee / other charge  +$150.00" — the one line a dialog
// or a form prints. `amount` is signed, exactly as it is stored.
export function pnlDestinationLine(kind, amount, { year = null } = {}) {
  const d = pnlDestination(kind);
  const n = round2(Number(amount) || 0);
  const sign = n < 0 ? '−' : '+';
  const fig = `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `${d.section} › ${d.row}${year ? ` (FY ${year})` : ''} › ${d.label}   ${fig}`;
}

// Σ of the adjustments landing on one row of the Income-and-expenses sheet, as a length-12
// signed array [Jan..Dec] plus the annual total. `row` is a `pnlRow` value ('rent' |
// 'camtax' | 'charges'); a kind whose pnlRow is null reaches no row and no total here.
//
// ⚠ THE TOTAL IS THE MONTHS AND NOTHING ELSE. `lease_adjustments.month` is `int not null
// check (month between 1 and 12)` (0082), so a row outside that range cannot exist — but
// counting one in `total` while leaving it out of `byMonth` would give the sheet a row
// whose cells do not add across to its own figure, which `workbookValidity.test.js`
// rejects out of the real file bytes. If that CHECK is ever relaxed, the fix is to carry
// an `undated` field through the parent rows the way `summarizeOtherIncome` does — NOT to
// put the money back in the total on its own.
export function adjustmentsForPnlRow(rows = [], row) {
  const byMonth = Array(12).fill(0);
  let total = 0;
  for (const r of rows || []) {
    if (adjustmentKindInfo(r?.kind).pnlRow !== row) continue;
    const m = Number(r?.month);
    if (!(m >= 1 && m <= 12)) continue;
    const amt = Number(r?.amount) || 0;
    total = round2(total + amt);
    byMonth[m - 1] = round2(byMonth[m - 1] + amt);
  }
  return { byMonth, total };
}

// WHICH MONTHS OF ONE PNL ROW CARRY A DECISION, and what it was — a length-12 array of
// `null | { total, items: [{ kind, label, amount, memo }] }`.
//
// ⚠ THE CONDITION IS GEORGE'S AND IT RULES OUT THE OBVIOUS VERSION (2026-08-17): *"make sure
// that that change only happens when a charge is actually confirmed as carried trhough or
// written off or a credit was paid. if nothing has changed we dont want the revenue to not
// match the true money being exchanged."* Marking every month where the CASH came in under
// the bill would paint the sheet for months that are simply waiting on a bank statement —
// nothing decided, nothing changed — and a reader would take the colour for a revenue
// difference that does not exist. It would also mix bases: this grid is what tenants were
// BILLED, and cash-vs-bill is the question the bank tie-out answers.
//
// So a mark means exactly one thing: a charge or a credit was POSTED on that month and is
// inside the figure printed. Every kind here is a confirmed decision by the time its row
// exists — a late fee, a CAM correction, a concession, a write-off, a balance carried
// forward, a refund. Accrual stays accrual and the figure never moves.
export function adjustmentMarks(rows = [], row) {
  const out = Array(12).fill(null);
  for (const r of rows || []) {
    const info = adjustmentKindInfo(r?.kind);
    if (info.pnlRow !== row) continue;
    const m = Number(r?.month);
    if (!(m >= 1 && m <= 12)) continue;
    const amt = round2(Number(r?.amount) || 0);
    if (!(Math.abs(amt) > 0.005)) continue;
    const e = out[m - 1] || { total: 0, items: [] };
    e.total = round2(e.total + amt);
    e.items.push({ kind: info.key, label: info.label, amount: amt, memo: r?.memo || '' });
    out[m - 1] = e;
  }
  return out.some(Boolean) ? out : null;
}

// The same, split one row per KIND — what the sheet's "Charges & credits" block itemizes,
// so a late fee and a write-off never merge into one unexplained figure. Ordered by the
// registry so the layout is stable across properties and years.
export function adjustmentKindRows(rows = [], row = 'charges') {
  const byKey = new Map();
  for (const r of rows || []) {
    const info = adjustmentKindInfo(r?.kind);
    if (info.pnlRow !== row) continue;
    const m = Number(r?.month);
    // Same rule as `adjustmentsForPnlRow` above, and it must STAY the same rule: these two
    // print as a parent row and its children, so a month one of them counts and the other
    // does not is a parent that no longer equals the sum beneath it.
    if (!(m >= 1 && m <= 12)) continue;
    const key = info.key;
    let e = byKey.get(key);
    if (!e) { e = { key, label: info.label, byMonth: Array(12).fill(0), total: 0, undated: 0, marks: Array(12).fill(null) }; byKey.set(key, e); }
    const amt = Number(r?.amount) || 0;
    e.total = round2(e.total + amt);
    e.byMonth[m - 1] = round2(e.byMonth[m - 1] + amt);
    // ⚠ These rows carry `marks` too, and they are where the commonest case actually PRINTS.
    // A late fee reaches the sheet through this per-kind block, not through the per-tenant
    // rows — mark only those and the one charge a landlord posts most often is the one the
    // workbook never flags.
    if (Math.abs(round2(amt)) > 0.005) {
      const mk = e.marks[m - 1] || { total: 0, items: [] };
      mk.total = round2(mk.total + amt);
      mk.items.push({ kind: info.key, label: info.label, amount: round2(amt), memo: r?.memo || '' });
      e.marks[m - 1] = mk;
    }
  }
  // A kind with nothing to mark carries `marks: null`, the same signal the per-tenant rows
  // use, so a reader of either never has to test for an array of twelve nulls.
  for (const e of byKey.values()) if (!e.marks.some(Boolean)) e.marks = null;
  const order = ADJUSTMENT_KINDS.map((k) => k.key);
  return [...byKey.values()].sort(
    (a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99) || a.label.localeCompare(b.label)
  );
}

export const isAdjustmentKind = (key) => BY_KIND.has(key);

// The kinds offered for a lease TO TYPE ON A MONTH. A gross tenant is refused the CAM & tax
// correction for the reason on that entry above — matching reconcileCamTax's throw (api.js)
// and deriveEstimateFromDeposit's refusal (statementMatch.js).
//
// ⚠ `manual: false` kinds are excluded: each is half of a two-sided settlement (Slice 4)
// that only `settleTenantBalance` knows how to write whole. They are still perfectly valid
// rows — `adjustmentAllowed` accepts them, because that is what the API validates against.
export function adjustmentKindsFor({ gross = false } = {}) {
  return ADJUSTMENT_KINDS.filter((k) => k.manual !== false && (k.grossOk || !gross));
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
