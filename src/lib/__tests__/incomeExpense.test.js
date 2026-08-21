// The Income-and-expenses workbook's builder, laid out month by month (2026-08-12).
//
// Three properties carry this suite, and they are the three ways a monthly sheet lies:
//
//  1. IT MUST ADD UP BOTH WAYS. Jan…Dec + No date === the Total column, for every row,
//     every bucket under it, and the totals line. A grid whose columns don't reconcile
//     with its own totals is worse than no grid.
//
//  2. UNDATED MONEY MUST STAY UNDATED. `paid_date` is nullable and never backfilled
//     (0074), and on the demo seed alone that is $31,000 of $49,950 — a flat tax figure
//     nobody itemized plus a hand-typed Security line. Spreading it across months would
//     invent a year that didn't happen; dropping it would lose money off a sheet headed
//     "income and expenses".
//
//  3. THE RENT MUST STILL TIE TO THE SCREEN. Laying rent across months means deriving it
//     from each lease's SCHEDULE, where before this sheet quoted `v_property_totals.
//     total_revenue` — one annual figure from SQL. Those are the two halves of a JS↔SQL
//     twin (CLAUDE.md §3) and are meant to agree; if they ever stop, the workbook says so
//     in dollars rather than disagreeing quietly with the Performance card beside it.
import { describe, it, expect } from 'vitest';
import { buildIncomeExpense, billedRowsFromRoll, consolidateCategories, consolidateDistributions, flags, shapeProperty, noiBridge } from '../incomeExpense';
import { getPropertyMonthlyRoll, createEscalation, deleteEscalation } from '../api';
import { allocatePayments, overpayKey } from '../ledger';
import { currentYear } from '../format';

const Y = currentYear();
const sum12 = (a) => Math.round(a.reduce((s, n) => s + n, 0) * 100) / 100;

// ── Against the demo mock ─────────────────────────────────────────────────────
//
// Maple Plaza, the one property of Acme Holdings: two leases at $60k and $84k, expenses
// spread over five months with a flat tax total and one undated CAM line, three receipts
// of other income, and a $24,000 owner distribution that is none of the above.

describe('a corporation’s year, month by month', () => {
  const build = () => buildIncomeExpense('corp-1', Y);

  // ⚠ THE TIE-OUT IS MEASURED ON THE CONTRACTED SCHEDULE, NOT THE ROW (2026-08-17). The default
  // basis is now `projected`, so the Rent ROW counts the seed's scheduled +3% step on Bright
  // Coffee — while `total_revenue` is `sum(effective_rent)`, which counts applied steps only.
  // Comparing the projection against it would report drift on every lease with a future step
  // and turn this check into noise; the step gets its own flag instead.
  //
  // The seed's step is dated ~3 weeks from whenever the suite runs, so how many months it
  // touches MOVES. Everything here is asserted as a relationship for that reason — a hardcoded
  // $144,450 would be right today and wrong in a fortnight.
  it('ties the rent it lays out to the Revenue figure the page already shows', async () => {
    const [p] = (await build()).properties;
    expect(p.rentScheduled).toBe(144000);  // contract rates, applied steps only
    expect(p.rentQuoted).toBe(144000);     // v_property_totals.total_revenue
    expect(p.rentDrift).toBe(0);
    expect(p.projectedAhead).toBeGreaterThan(0);
    expect(p.rent).toBeCloseTo(144000 + p.projectedAhead, 2);
    expect(p.rentRows.map((r) => r.label)).toEqual(['City Dental', 'Bright Coffee Co.']);
    expect(p.rentRows[0].total).toBe(84000);
    expect(p.rentRows[1].total).toBeCloseTo(60000 + p.projectedAhead, 2);
    // Every month before the step is still the flat rate, which is the other half of "a step
    // applies from its own month, not the whole year".
    expect(p.rentByMonth[0]).toBe(12000);
  });

  it('every row of the grid reads the same across as down', async () => {
    const pkg = await build();
    const ties = (row) => expect(sum12(row.byMonth) + row.undated).toBeCloseTo(row.total ?? row.spent, 2);
    for (const p of pkg.properties) {
      for (const r of p.rentRows) ties(r);
      for (const r of p.camTaxRows) ties(r);
      for (const r of p.roofRows) ties(r);
      for (const r of p.chargeRows) ties(r);
      for (const g of p.incomeGroups) ties(g);
      for (const r of p.expenseRows) { ties(r); for (const it of r.items) ties(it); }
      for (const r of p.distributions) ties(r);
      // ⚠ THE GRID TIES TO `billedTotal`, NOT TO `revenue`/`earned` — and that is the point
      // of the year-end reconciliation line rather than a fault in it. Every month here is
      // what the tenant was billed that month; the true-up is settled ONCE at year end and
      // genuinely has no month, so it sits on its own line below the grid's total with
      // twelve dashes against it. It is deliberately NOT folded into the "No date" column:
      // that column means "this had a date and we don't know it" (0074), which is a
      // different claim from "this event belongs to the year, not to a month".
      expect(sum12(p.inByMonth) + p.inUndated).toBeCloseTo(p.billedTotal, 2);
      expect(p.billedTotal + p.trueUp).toBeCloseTo(p.earned, 2);
      expect(sum12(p.outByMonth) + p.outUndated).toBeCloseTo(p.expenseTotals.spent, 2);
      expect(sum12(p.netByMonth) + p.netUndated).toBeCloseTo(p.grossNet, 2);
    }
    // …and the Summary sheet's grid is the sum of the property sheets', not a re-derivation.
    expect(sum12(pkg.totals.outByMonth) + pkg.totals.outUndated).toBeCloseTo(pkg.totals.spent, 2);
  });

  it('puts each expense in the month it was paid and the rest in "No date"', async () => {
    const [p] = (await build()).properties;
    // Jan snow removal 4,000 · Feb legal 1,200 + franchise 1,750 · Apr landscaping 8,000 ·
    // May roof repair 1,500 · Aug roof replacement 2,500.
    expect(p.outByMonth).toEqual([4000, 2950, 0, 8000, 1500, 0, 0, 2500, 0, 0, 0, 0]);
    // The $25,000 of taxes nobody itemized plus the $6,000 Security line typed with no
    // date. Two thirds of the year's spend, and the reason the column exists.
    expect(p.outUndated).toBe(31000);
    const taxes = p.expenseRows.find((r) => r.key === 'taxes');
    expect(taxes.byMonth).toEqual(Array(12).fill(0));
    expect(taxes.items[0]).toMatchObject({ label: 'Property taxes', flat: true, undated: 25000 });
  });

  it('itemizes each category by bucket, biggest first', async () => {
    const [p] = (await build()).properties;
    const cleaning = p.expenseRows.find((r) => r.key === 'cleaning');
    expect(cleaning.items.map((i) => [i.label, i.total])).toEqual([['Landscaping', 8000], ['Snow removal', 4000]]);
    expect(cleaning.items[0].byMonth[3]).toBe(8000);   // April
    expect(cleaning.items[1].byMonth[0]).toBe(4000);   // January
  });

  it('lays other income out by bucket and by month', async () => {
    const [p] = (await build()).properties;
    expect(p.otherIncome).toBe(2690);
    expect(p.incomeByMonth).toEqual([0, 0, 250, 1800, 640, 0, 0, 0, 0, 0, 0, 0]);
    expect(p.incomeGroups.map((g) => g.key)).toEqual(['parking', 'utility', 'late_fee']);
  });

  // ⚠ THE ONE THE RETIREMENT RESTS ON, now with a month attached. The distribution is a
  // `billable: false` cam_line_items row exactly like the two absorbed costs; only the
  // `distribution` category on its bucket separates them. It has a March date like any
  // other bank line — and March must still read $0 of expenses.
  it('gives the owner distribution its own months and puts it in none of the totals', async () => {
    const [p] = (await build()).properties;
    expect(p.distributionsTotal).toBe(24000);
    expect(p.distributions[0].byMonth[2]).toBe(24000);
    expect(p.outByMonth[2]).toBe(0);
    expect(p.expenseTotals.spent).toBe(49950);
  });

  // ⚠ THE BOTTOM LINE DOES NOT MOVE (2026-08-16). The Money-in block now states every
  // component of the bill instead of printing base rent alone, and the reimbursement stops
  // being netted silently off the cost side — but `net` lands on the identical figure,
  // because the year-end reconciliation line brings the income side to the tenants' true
  // entitlement, which is the same figure the cost side takes off. Presentation moved; the
  // answer did not. (On this seed there are no charges or credits; the test below covers
  // the one thing that IS meant to move the number.)
  it('reconciles the grid to what the year left, and the bottom line is unchanged', async () => {
    const [p] = (await build()).properties;
    // `ahead` is the seed's scheduled step, whose month moves with the calendar (see above).
    // A rent step changes the rent and nothing else: CAM & tax is a fixed annual estimate, so
    // componentizeSchedule's `min` leaves it alone, and the true-up is measured against it.
    const ahead = p.projectedAhead;
    expect(p.rent).toBeCloseTo(144000 + ahead, 2);     // base — the row that used to be all of it
    expect(p.camTaxBilled).toBe(42300);                // the reimbursement, now visible
    expect(p.roofBilled).toBe(1500);
    // 144,000 + 42,300 + 1,500 = $187,800 — exactly what the Ledger bills this property.
    expect(p.rent + p.camTaxBilled + p.roofBilled).toBeCloseTo(187800 + ahead, 2);
    expect(p.billedTotal).toBeCloseTo(190490 + ahead, 2);  // + 2,690 other income
    expect(p.trueUp).toBe(800);                        // actual share 44,600 less 43,800 billed
    expect(p.earned).toBeCloseTo(191290 + ahead, 2);
    expect(p.net).toBeCloseTo(141340 + ahead, 2);      // ⚠ THE SAME FIGURE AS BEFORE, plus the step
    expect(p.earned - p.expenseTotals.spent).toBeCloseTo(p.net, 2);
  });

  // ⚠ EVERY MONTHLY CELL IS WHAT THE LEDGER SHOWS. This is George's complaint, pinned:
  // "the monthly numbers are way off … none of the rents match because it shows base rent."
  //
  // ⚠ CITY DENTAL, NOT BRIGHT COFFEE (2026-08-17). Bright carries the seed's scheduled step,
  // whose effective date is ~3 weeks from whenever the suite runs — so on a run in early
  // February the step lands in March and a pinned March figure fails for a reason that has
  // nothing to do with what this test is about. City Dental has no step and never moves.
  it('lays each month out at what the tenant was actually billed', async () => {
    const [p] = (await build()).properties;
    // City Dental: $7,000 base + $2,150 CAM & tax = the $9,150 the Ledger bills.
    const bright = p.rentRows.find((r) => r.label.includes('City Dental'));
    const brightCam = p.camTaxRows.find((r) => r.label.includes('City Dental'));
    const brightRoof = p.roofRows.find((r) => r.label.includes('City Dental'));
    expect(bright.byMonth[2]).toBe(7000);
    expect((brightCam?.byMonth[2] || 0) + (brightRoof?.byMonth[2] || 0)).toBeCloseTo(2150, 2);
    // And the property's March cell is the sum of what every tenant was billed that month.
    expect(p.inByMonth[2]).toBeCloseTo(
      p.rentByMonth[2] + p.camTaxByMonth[2] + p.roofByMonth[2] + p.chargesByMonth[2] + p.incomeByMonth[2], 2);
  });

  // ⚠ THE TERMS THAT ARE EASY TO DROP. NOI is built from BILLED expenses only (`cam_total`
  // sums `billable is not false`), so the $2,950 of costs the landlord entered and chose
  // to eat is in this sheet's `spent` and in none of NOI. The sheet shipped on 2026-08-12
  // printing this reconciliation with that term missing, which made it wrong by exactly
  // that figure — and an accountant checking the note is the person who would find it.
  // `charges` joined it on 2026-08-16 for the same reason: total_revenue is
  // sum(effective_rent) and knows nothing about a late fee or a write-off.
  it('reconciles to NOI including the costs NOI never counted', async () => {
    const [p] = (await build()).properties;
    expect(p.absorbed).toBe(2950);
    // ⚠ AND THE RENT BASIS, which the default `projected` basis made non-zero on this seed:
    // NOI reads `total_revenue` (applied steps only) while the Rent row counts the scheduled
    // one. Written by hand, this identity only ever proves the terms somebody remembered —
    // which is exactly why `noiBridge` builds them and the test below checks what it printed.
    expect(p.noi + p.recovered + p.otherIncome - p.absorbed + p.charges + (p.rent - p.rentQuoted))
      .toBeCloseTo(p.net, 2);
  });

  // ⚠ THE NOTE PRINTS AN EQUATION, SO THE EQUATION IS WHAT GETS TESTED — the terms the
  // sheet actually renders, summed the way a reader sums them. Asserting the identity by
  // hand (above) only ever proved the identity I remembered to write; it passed all
  // morning on 2026-08-16 while the sheet printed a sum out by $17,999.94 on the one demo
  // property with a part-year tenancy, under the word "exactly".
  it('prints a bridge from NOI that adds up, on every property', async () => {
    for (const corp of ['corp-1', 'corp-2']) {
      for (const p of (await buildIncomeExpense(corp, Y)).properties) {
        const b = p.noiBridge;
        expect(b.terms.reduce((s, t) => s + t.amount, b.noi)).toBeCloseTo(b.total, 2);
        expect(b.total).toBeCloseTo(p.net, 2);
        // And nothing is left over: the catch-all term is the fail-safe, not the norm.
        expect(b.terms.some((t) => t.unexplained)).toBe(false);
      }
    }
  });

  // Oak Center is the case that broke it: Sunrise Yoga starts 1 July, so the schedule
  // counts six months of its rent and `effective_rent` counts twelve.
  it('names the rent basis as a term when a lease ran only part of the year', async () => {
    const [p] = (await buildIncomeExpense('corp-2', Y)).properties;
    const basis = p.noiBridge.terms.find((t) => t.key === 'rentBasis');
    expect(basis.amount).toBeCloseTo(p.rent - p.rentQuoted, 2);
    expect(basis.amount).toBeCloseTo(-17999.94, 2);
  });

  // ⚠ THE BILL YOU SENT vs THE SHEET YOU HAND SOMEONE. Every row of this workbook is built
  // UP from each lease's current terms; an issued invoice is a frozen copy. Importing a
  // bank statement moves a property's CAM or tax total and calls no resync at all, so the
  // two part company on the ordinary path — found by driving the app end to end on
  // 2026-08-16, where one imported tax payment put City Dental's sheet $2,718 ahead of its
  // invoice while the workbook said nothing.
  it('names a lease whose issued invoice no longer matches these rows', () => {
    const schedule = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [i + 1, { full: 1000, owed: 1000, abated: 0, credit: 0, kind: 'full', outsideTerm: false }])
    );
    const p = shapeProperty({
      property: { id: 'p', name: 'Maple Plaza' }, year: Y, totals: { total_revenue: 12000, noi: 0 },
      items: [], shares: [], expense: {}, buckets: [], income: [],
      roll: [{ lease_id: 'l1', tenant_name: 'City Dental', schedule, factor: 1, camTaxAnnual: 2400, roofAnnual: 0, drift: 2718 }],
    });
    expect(p.invoiceDriftTotal).toBe(2718);
    expect(p.invoiceDrifted).toEqual([{ lease_id: 'l1', label: 'City Dental', amount: 2718 }]);
    const [f] = flags([p]).filter((s) => s.includes('invoices you actually issued'));
    expect(f).toContain('$2,718.00 below');
    expect(f).toContain('City Dental');
    expect(f).toContain('Rebuild');
  });

  // Dust is not a finding. `invoiceDrift` already swallows anything under its own
  // threshold; this pins that a clean property says nothing at all.
  it('says nothing when every invoice still matches', async () => {
    const pkg = await build();
    expect(pkg.properties[0].invoiceDrifted).toEqual([]);
    expect(pkg.flags.some((s) => s.includes('invoices you actually issued'))).toBe(false);
  });

  it('says out loud how many dollars it could not date', async () => {
    const pkg = await build();
    expect(pkg.flags.some((f) => f.includes('$31,000.00') && f.includes('No date'))).toBe(true);
    // A tie-out difference would be its own flag; on this data there is none.
    expect(pkg.flags.some((f) => f.includes('difference of'))).toBe(false);
  });

  it('rolls the Summary categories up from the property rows, uncategorized last', async () => {
    const pkg = await build();
    const cats = pkg.categories;
    expect(cats[cats.length - 1].key).toBeNull();
    expect(cats.reduce((s, c) => s + c.spent, 0)).toBeCloseTo(pkg.totals.spent, 2);
    expect(sum12(cats.reduce((a, c) => a.map((n, i) => n + c.byMonth[i]), Array(12).fill(0))))
      .toBeCloseTo(sum12(pkg.totals.outByMonth), 2);
  });
});

// ── The rent row itself ───────────────────────────────────────────────────────

// ── Whose money left the account (George, 2026-08-20) ─────────────────────────────────
//
// *"for 401 south main yaz and liana are not shown on the live excel sheet."* They were on
// the property's own sheet; the SUMMARY — the sheet the workbook opens on — carried one
// "Distributions — money you took out $30,000.00" and nobody's name. A landlord reading his
// own draws needs exactly the part that was missing.
//
// ⚠ The bucket IS the person (CLAUDE.md §1): a distribution has no table of its own, so the
// payee is the `cam_line_items` label. Merging by label is therefore merging by person —
// which is also why two properties that both paid one person must collapse to a single row.
describe('distributions, named rather than lumped', () => {
  const shapeWith = (name, lines) => shapeProperty({
    property: { id: `p-${name}`, name, address: '' },
    year: Y,
    totals: { total_revenue: 0, total_expenses: 0, noi: 0, cam_total: 0, taxes_total: 0, roof_total: 0, building_sf: 1000, total_sf: 1000, occupancy: 1 },
    items: lines,
    shares: [], expense: { cam_total: 0, taxes_total: 0, roof_total: 0 },
    buckets: [
      { label: 'Yaz', billable: false, category: 'distribution' },
      { label: 'Liana', billable: false, category: 'distribution' },
      { label: 'Absorbed repair', billable: false, category: 'repairs' },
    ],
    income: [], roll: [], escByLease: {}, basis: 'live', confirmed: new Set(),
  });

  it('names each payee, carries the month, and merges one person across properties', () => {
    const a = shapeWith('401 S Main', [
      { kind: 'cam', label: 'Liana', amount: 20000, billable: false, paid_date: `${Y}-01-06` },
      { kind: 'cam', label: 'Yaz', amount: 10000, billable: false, paid_date: `${Y}-01-06` },
      // A cost the landlord ATE is not a draw — it belongs to the expense side, and letting
      // it in here would report an absorbed repair as money he took out.
      { kind: 'cam', label: 'Absorbed repair', amount: 500, billable: false, paid_date: `${Y}-03-02` },
    ]);
    const b = shapeWith('Second building', [
      { kind: 'cam', label: 'Yaz', amount: 2500, billable: false, paid_date: `${Y}-07-11` },
    ]);

    const rows = consolidateDistributions([a, b]);
    // Biggest first: Liana's 20,000 outranks Yaz's 12,500 once both buildings are in.
    expect(rows.map((r) => r.label)).toEqual(['Liana', 'Yaz']);
    // One Yaz row, not two — 10,000 at 401 S Main plus 2,500 at the other building.
    expect(rows.find((r) => r.label === 'Yaz').total).toBe(12500);
    expect(rows.find((r) => r.label === 'Liana').total).toBe(20000);
    expect(rows.some((r) => r.label === 'Absorbed repair')).toBe(false);

    // The month it left the account rides along, so the Summary grid can place it.
    const yaz = rows.find((r) => r.label === 'Yaz');
    expect(yaz.byMonth[0]).toBe(10000);   // January, 401 S Main
    expect(yaz.byMonth[6]).toBe(2500);    // July, the other building

    // …and the named rows tie to the scalar the total line prints.
    const total = rows.reduce((t, r) => t + r.total, 0);
    expect(total).toBe(a.distributionsTotal + b.distributionsTotal);
  });

  it('is empty, not undefined, when nothing was taken out', () => {
    const clean = shapeWith('No draws', [{ kind: 'cam', label: 'Absorbed repair', amount: 500, billable: false, paid_date: `${Y}-03-02` }]);
    expect(consolidateDistributions([clean])).toEqual([]);
    expect(consolidateDistributions()).toEqual([]);
  });
});

describe('rent, month by month', () => {
  // One month's schedule repeated: the tenant owes $1,000 and $2,400/yr of it is the
  // CAM & tax component.
  const schedule = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [i + 1, { full: 1000, owed: 1000, abated: 0, credit: 0, kind: 'full', outsideTerm: false }])
  );
  const row = (gross) => ({ lease_id: 'l1', tenant_name: 'T', schedule, factor: 1, camTaxAnnual: 2400, roofAnnual: 0, gross });

  // ⚠ REWRITTEN 2026-08-16, and the old assertion is the bug George reported. This used to
  // pin `rentRowsFromRoll`, which returned $9,600 for a net tenant owing $12,000 — base rent
  // alone, 20% under every figure the Ledger, the invoice and the bank show for the same
  // months. The components are now stated separately instead of one being folded away, and
  // the thing that must hold is that they add back up to what was owed.
  it('splits the bill into its components, and they sum to what was owed', () => {
    const net = billedRowsFromRoll([row(false)]);
    expect(net.rent[0].total).toBe(9600);        // base
    expect(net.camTax[0].total).toBe(2400);      // the reimbursement, no longer invisible
    expect(net.rent[0].byMonth).toEqual(Array(12).fill(800));
    expect(net.camTax[0].byMonth).toEqual(Array(12).fill(200));
    // THE INVARIANT: every month adds up to the month's owed, so a cell on this sheet is
    // the cell on the Ledger.
    for (let i = 0; i < 12; i++) {
      expect(net.rent[0].byMonth[i] + net.camTax[0].byMonth[i] + net.roof[0].byMonth[i] + net.charges[0].byMonth[i])
        .toBeCloseTo(1000, 2);
    }
  });

  it('a gross lease splits the same way — the carve is shown, not added', () => {
    // On a GROSS lease (0073) the CAM/tax is carved OUT of a flat rent the tenant pays
    // regardless. Reporting the components separately means gross and net now READ the
    // same, which is the point: both tenants owe $1,000 a month and both sheets say so.
    const gross = billedRowsFromRoll([row(true)]);
    expect(gross.rent[0].total).toBe(9600);
    expect(gross.camTax[0].total).toBe(2400);
    // ⚠ The TIE-OUT figure keeps the old formula, because it is compared against
    // total_revenue — which is base-only for a net lease and the WHOLE flat rent for a
    // gross one. Same rows, two different questions.
    expect(billedRowsFromRoll([row(false)]).tieOut).toBe(9600);
    expect(gross.tieOut).toBe(12000);
  });

  it('a correction rides the row it corrects, so the total still equals the owed', () => {
    // componentizeSchedule derives base and camTax from the SCHEDULED owed (owed − adj), so
    // a base correction has to be added back onto rent — otherwise Total billed drifts from
    // the Ledger by exactly the adjustment.
    // A real roll carries the adjustment inside `owed` (buildLeaseSchedule adds it last), so
    // the fixture does too: Jan owes 1,400 of which 400 is a base correction, Feb owes 1,150
    // of which 150 is a fee, Mar owes 950 after a −50 CAM & tax correction.
    // Apr owes 1,600 of which 600 is a balance brought forward from last year — a kind whose
    // pnlRow is null. It reaches none of the four income rows and still has to be inside the
    // month's total, or Total billed drifts from the Ledger by exactly the settlement.
    const owedBy = { 1: 1400, 2: 1150, 3: 950, 4: 1600 };
    const sched = Object.fromEntries(Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      return [m, { full: 1000, owed: owedBy[m] ?? 1000, abated: 0, credit: 0, kind: 'full', outsideTerm: false }];
    }));
    const g = billedRowsFromRoll([{
      lease_id: 'l1', tenant_name: 'T', schedule: sched, factor: 1, camTaxAnnual: 2400, roofAnnual: 0, gross: false,
      adjustments: [400, 150, -50, 600, 0, 0, 0, 0, 0, 0, 0, 0],
      adjustmentRows: [
        { id: 'a1', kind: 'base', month: 1, amount: 400 },
        { id: 'a2', kind: 'fee', month: 2, amount: 150 },
        { id: 'a3', kind: 'camtax', month: 3, amount: -50 },
        { id: 'a4', kind: 'opening', month: 4, amount: 600 },
      ],
    }]);
    expect(g.rent[0].byMonth[0]).toBe(1200);     // 800 base + the 400 correction
    expect(g.camTax[0].byMonth[2]).toBe(150);    // 200 − the 50 correction
    expect(g.charges[0].byMonth[1]).toBe(150);   // the fee, on its own row
    expect(g.charges[0].total).toBe(150);        // and nothing else lands there
    expect(g.carried[0].byMonth[3]).toBe(600);   // the brought-forward balance, on the fifth row
    expect(g.carried[0].total).toBe(600);
    expect(g.charges[0].byMonth[3]).toBe(0);     // and NOT on charges, which feeds income
    // THE INVARIANT AGAIN, this time with corrections in play: the components still add up
    // to the month's owed, so Total billed cannot drift from the Ledger by an adjustment.
    for (const m of [1, 2, 3, 4]) {
      const i = m - 1;
      expect(
        g.rent[0].byMonth[i] + g.camTax[0].byMonth[i] + g.roof[0].byMonth[i]
        + g.charges[0].byMonth[i] + g.carried[0].byMonth[i]
      ).toBeCloseTo(owedBy[m], 2);
    }
  });

  it('reads a lease with no schedule as no rent rather than throwing', () => {
    expect(billedRowsFromRoll([{ lease_id: 'l1', tenant_name: 'T' }]).rent[0].total).toBe(0);
    expect(billedRowsFromRoll().rent).toEqual([]);
  });
});

// ── The tie-out ───────────────────────────────────────────────────────────────

describe('the rent tie-out', () => {
  const property = { id: 'p', name: 'Maple Plaza' };
  const base = { property, year: Y, items: [], shares: [], expense: {}, buckets: [], income: [], roll: [] };

  it('flags a schedule that disagrees with the view, in dollars, naming both', () => {
    // The view says 144,000; the leases lay out nothing. That is the exact shape of the
    // failure this flag exists to surface — a workbook quietly disagreeing with the
    // Performance card on the same screen.
    const p = shapeProperty({ ...base, totals: { total_revenue: 144000, noi: 0 } });
    expect(p.rent).toBe(0);
    expect(p.rentDrift).toBe(-144000);
    const [f] = flags([p]).filter((s) => s.includes('difference of'));
    expect(f).toContain('Maple Plaza');
    expect(f).toContain('$144,000.00');
  });

  // A dollar either way is rounding, not a finding, and a flag that fires on every
  // property is a flag nobody reads.
  it('says nothing when the two agree', () => {
    const p = shapeProperty({ ...base, totals: { total_revenue: 0, noi: 0 } });
    expect(flags([p]).some((s) => s.includes('difference of'))).toBe(false);
  });

  // ⚠ THE FLAG QUOTES THE FIGURE IT SUBTRACTED. `rentDrift` measures `rentScheduled` —
  // base rent at contract rates, plus a gross lease's carve, no adjustments — because that
  // is the like-for-like comparable to `sum(effective_rent)`. The sheet's Rent ROW is a
  // different figure the moment a gross lease or a base-rent correction is in play, and
  // quoting it there (as this did until the 2026-08-16 audit) printed three numbers where
  // the third was not the difference of the first two.
  // ⚠ IT NAMES THE CAUSE THAT IS PRESENT, AND ONLY THAT ONE (George, 2026-08-17, on the
  // redundancy). Three things can make the Rent row differ from `rentScheduled`; reciting all
  // three whatever the property looks like sends a reader hunting for a gross lease that isn't
  // there. Each is measured on the shape now.
  it('explains the Rent row only by the causes actually in play', () => {
    const schedule = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [i + 1, { full: 1000, owed: 1000, abated: 0, credit: 0, kind: 'full', outsideTerm: false }])
    );
    // A gross lease and nothing else: the view counts the whole flat rent, the Rent row counts
    // base alone, and `total_revenue` is deliberately wrong here so the flag fires at all.
    const p = shapeProperty({
      ...base,
      totals: { total_revenue: 1, noi: 0 },
      roll: [{ lease_id: 'l1', tenant_name: 'T', schedule, factor: 1, camTaxAnnual: 2400, roofAnnual: 0, gross: true }],
    });
    const [f] = flags([p]).filter((s) => s.includes('The Rent row above reads'));
    expect(f).toContain('a gross lease');
    expect(f).not.toContain('rent step');            // there is no scheduled step here
    expect(f).not.toContain('base-rent correction');  // and no correction either
  });

  it('quotes the scheduled rent, not the Rent row, when a gross lease makes them differ', () => {
    const schedule = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [i + 1, { full: 1000, owed: 1000, abated: 0, credit: 0, kind: 'full', outsideTerm: false }])
    );
    const p = shapeProperty({
      ...base,
      totals: { total_revenue: 12000, noi: 0 },
      roll: [{ lease_id: 'l1', tenant_name: 'T', schedule, factor: 1, camTaxAnnual: 2400, roofAnnual: 0, gross: true }],
    });
    expect(p.rent).toBe(9600);            // the Rent row: base only, the carve on its own row
    expect(p.rentScheduled).toBe(12000);  // the whole flat rent, which is what the view counts
    expect(p.rentDrift).toBe(0);          // so there is no drift at all, and no flag
    expect(flags([p]).some((s) => s.includes('difference of'))).toBe(false);
  });
});

// ── The bridge to NOI ─────────────────────────────────────────────────────────
//
// It prints as one sentence claiming a sum, so the sum is the contract. Written by hand it
// was wrong twice — `absorbed` missing when it shipped (2026-08-12) and the rent basis
// missing until the 2026-08-16 audit.

describe('noiBridge', () => {
  it('drops the terms that are zero rather than printing "+ $0.00" four times', () => {
    const b = noiBridge({ noi: 100, net: 150, recovered: 50 });
    expect(b.terms.map((t) => t.key)).toEqual(['recovered']);
    expect(b.terms.reduce((s, t) => s + t.amount, b.noi)).toBeCloseTo(b.total, 2);
  });

  it('subtracts what the landlord absorbed and adds what was charged', () => {
    const b = noiBridge({ noi: 100, net: 120, recovered: 50, otherIncome: 10, absorbed: 45, charges: 5 });
    expect(Object.fromEntries(b.terms.map((t) => [t.key, t.amount])))
      .toEqual({ recovered: 50, otherIncome: 10, absorbed: -45, charges: 5 });
    expect(b.terms.some((t) => t.unexplained)).toBe(false);
  });

  // ⚠ THE FAIL-SAFE, AND THE POINT OF BUILDING THE TERMS RATHER THAN WRITING THEM. A
  // figure nobody thought to name here shows up as a visible difference on the sheet
  // instead of turning the printed equation into a wrong sum.
  it('states whatever is left over rather than printing a sum that does not add up', () => {
    const b = noiBridge({ noi: 100, net: 175, recovered: 50 });
    const last = b.terms[b.terms.length - 1];
    expect(last.unexplained).toBe(true);
    expect(last.amount).toBe(25);
    expect(b.terms.reduce((s, t) => s + t.amount, b.noi)).toBeCloseTo(b.total, 2);
  });

  it('is a balanced sum even with nothing at all in it', () => {
    const b = noiBridge();
    expect(b.terms).toEqual([]);
    expect(b.noi).toBe(0);
    expect(b.total).toBe(0);
  });
});

// ── Every monthly cell is the Ledger's ────────────────────────────────────────
//
// The promise George's complaint bought: `Money in` for a month equals what the Ledger
// paints that month as owed.
//
// ⚠ IT IS FIVE ROWS SINCE SLICE 4, NOT FOUR, and that is exactly what this test was written
// to catch. `opening` and `refund` file at `pnlRow: null` — real money the tenant owes that
// is not this year's income — and `buildLeaseSchedule` adds every adjustment to `owed`
// regardless. Left at four rows, Total billed would have parted company with the Ledger by
// exactly the settled amount, silently, on the one figure this sheet promises ties. The
// fifth group (`carried`) is what keeps the promise; the sheet then subtracts it again
// before Total earned, which is where the "not this year's income" half is honoured.

describe('the five Money-in rows against the roll they came from', () => {
  it('adds up to each month’s owed, tenant by tenant, on the demo seed', async () => {
    for (const [leases, propId] of [[2, 'prop-1'], [2, 'prop-2']]) {
      const roll = await getPropertyMonthlyRoll(propId, Y);
      expect(roll.length).toBe(leases);   // never let this test pass by finding nothing
      const b = billedRowsFromRoll(roll);
      const by = (group, id) => group.find((r) => r.lease_id === id);
      for (const r of roll) {
        for (let m = 1; m <= 12; m++) {
          const owed = Math.round((Number(r.schedule?.[m]?.owed) || 0) * 100) / 100;
          const parts = ['rent', 'camTax', 'roof', 'charges', 'carried']
            .reduce((s, g) => s + (by(b[g], r.lease_id)?.byMonth[m - 1] || 0), 0);
          expect(parts).toBeCloseTo(owed, 2);
        }
      }
    }
  });
});

// ── The two bases ─────────────────────────────────────────────────────────────
//
// George, 2026-08-17: *"there needs to be a button for the income and expenses to say, hey. I
// need a live look, which uses the real numbers on the ledger and the actual cam and tax … let's
// say somebody has been paying more than they should have or less than they should have, that
// should reflect live on the money in … there should be a projected at the beginning of the
// year, which shows any escalations … right now, it doesn't show escalations if there is one on
// the Excel sheet."*
//
// ⚠ THESE RUN IN FILE ORDER AND MUTATE THE SHARED DEMO STORE. The block below marks a month
// paid, which is the only way to produce a real underpayment; it is last in the file for that
// reason, and anything added after it inherits that state.

describe('projected vs live', () => {
  it('carries the basis on the package, the properties and nothing implicit', async () => {
    const proj = await buildIncomeExpense('corp-1', Y);
    const live = await buildIncomeExpense('corp-1', Y, { basis: 'live' });
    expect(proj.basis).toBe('projected');           // the default has not moved
    expect(live.basis).toBe('live');
    expect(proj.properties.every((p) => p.basis === 'projected')).toBe(true);
    expect(live.properties.every((p) => p.basis === 'live')).toBe(true);
    // The first flag on each copy says which one it is — the two files are otherwise
    // indistinguishable on a desktop six weeks later.
    expect(proj.flags[0]).toContain('PROJECTED');
    expect(live.flags[0]).toContain('LIVE');
  });

  // ⚠ THE INVARIANT THAT MAKES THE LIVE SHEET WORTH ANYTHING: no cash invented, none lost.
  // The five money-in rows are the month's cash apportioned across the month's bill, so they
  // must add back to exactly what `allocatePayments` says the tenant paid — including the
  // credit, which has no month and rides the rent row's "No date" cell.
  it('adds up to exactly what the Ledger says arrived, tenant by tenant', async () => {
    for (const propId of ['prop-1', 'prop-2']) {
      const roll = await getPropertyMonthlyRoll(propId, Y);
      expect(roll.length).toBeGreaterThan(0);
      const c = billedRowsFromRoll(roll, { collected: true, year: Y });
      for (const r of roll) {
        const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments, adjustments: r.adjustments });
        const mine = ['rent', 'camTax', 'roof', 'charges', 'carried']
          .reduce((s, g) => s + (c[g].find((x) => x.lease_id === r.lease_id)?.total || 0), 0);
        // ⚠ THE THIRD TERM (2026-08-17). A surplus awaiting the landlord's answer is real cash
        // held out of every row, so the invariant is rows + credit + unapplied === what arrived.
        // The demo seed has no tagged over-payment, so this reads as before on it — which is
        // exactly why the held-back case is pinned on a fixture of its own below.
        const held = (c.unappliedRows || []).filter((u) => u.lease_id === r.lease_id)
          .reduce((s, u) => s + u.amount, 0);
        expect(mine + held, `${r.tenant_name} on ${propId}`).toBeCloseTo(alloc.totalPaid, 2);
      }
    }
  });

  it('still reads the same across as down on the live basis', async () => {
    const pkg = await buildIncomeExpense('corp-1', Y, { basis: 'live' });
    const ties = (row) => expect(sum12(row.byMonth) + row.undated).toBeCloseTo(row.total ?? row.spent, 2);
    for (const p of pkg.properties) {
      for (const g of ['rentRows', 'camTaxRows', 'roofRows', 'chargeRows']) for (const r of p[g]) ties(r);
      expect(sum12(p.inByMonth) + p.inUndated).toBeCloseTo(p.billedTotal, 2);
      expect(sum12(p.netByMonth) + p.netUndated).toBeCloseTo(p.grossNet, 2);
      // ⚠ AND NO NOI BRIDGE. Every term in it is accrual; against a cash bottom line the
      // year's arrears would land in the catch-all residual and print an equation whose
      // largest term is "not accounted for".
      expect(p.noiBridge).toBeNull();
    }
  });

  // ⚠ THE FLAG THAT SAYS WHAT WAS BILLED, NOT WHAT WAS COLLECTED, IS PROJECTED-ONLY. On a cash
  // sheet a gap between the schedule and the view is just a tenant who has not paid — printed
  // there it would read as a fault on a sheet working exactly as intended.
  it('keeps the billed-vs-view checks off the live sheet', async () => {
    const live = await buildIncomeExpense('corp-2', Y, { basis: 'live' });
    expect(live.flags.some((f) => f.includes('difference of'))).toBe(false);
    expect(live.flags.some((f) => f.includes('invoices you actually issued'))).toBe(false);
    // …and it still measures the drift on the shape, so nothing was thrown away.
    expect(live.properties.every((p) => typeof p.rentDrift === 'number')).toBe(true);
  });

  // The whole point of the projected basis. City Dental (lease-2) bills $84,000; a step dated
  // 1 October takes it to $96,000, and until that date arrives `monthlyBases` cannot see it.
  it('prices the months after a scheduled rent step at the new rent — and only when projecting', async () => {
    const esc = await createEscalation({
      lease_id: 'lease-2', effective_date: `${Y}-10-01`, new_base_rent: 96000,
      escalation_type: 'manual', escalation_value: 0, status: 'scheduled',
    });
    try {
      const pkg = await buildIncomeExpense('corp-1', Y);
      const proj = pkg.properties[0];
      const city = proj.rentRows.find((r) => r.label === 'City Dental');
      expect(city.byMonth[8]).toBeCloseTo(7000, 2);    // September — 84,000 / 12
      expect(city.byMonth[9]).toBeCloseTo(8000, 2);    // October — the step, from its own month
      expect(city.total).toBeCloseTo(84000 + 3000, 2); // three months at +$1,000
      // …and it is named in dollars rather than left for the reader to notice. (The seed's own
      // scheduled step on Bright Coffee is in the same figure — hence the property, not a
      // per-lease total.)
      // ⚠ Matched on the whole phrase, not on "have not taken effect yet" — the basis flag
      // above it uses those same words to explain what a projection is, and the looser matcher
      // found that one instead.
      const f = pkg.flags.find((s) => s.includes('comes from rent steps that have not taken effect yet'));
      expect(f).toContain('Maple Plaza');
      expect(f).toContain(`$${proj.projectedAhead.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
      expect(proj.projectedAhead).toBeGreaterThanOrEqual(3000);

      // The default basis of every OTHER reader is untouched: the roll the Ledger paints from
      // still prices October at the old rent.
      const roll = await getPropertyMonthlyRoll('prop-1', Y);
      const r = roll.find((x) => x.lease_id === 'lease-2');
      expect(billedRowsFromRoll([r]).rent[0].byMonth[9]).toBeCloseTo(7000, 2);

      // ⚠ AND NEITHER CHECK THAT COMPARES AGAINST A *BILLED* RECORD FIRES ON IT. An issued
      // invoice cannot contain a step that has not happened, and `total_revenue` is applied
      // steps only — measured against the projection, every lease with a future step would
      // report drift the landlord can do nothing about, under a prompt to Rebuild that would
      // be advising them to over-bill.
      expect(proj.invoiceDrifted).toEqual([]);
      expect(proj.rentDrift).toBe(0);
      expect(pkg.flags.some((s) => s.includes('difference of'))).toBe(false);
    } finally {
      await deleteEscalation(esc.id);
    }
  });

  // ⚠ THE FALSE ACCUSATION THIS ROUND NEARLY SHIPPED. `tenantStanding` reads `row.schedule` to
  // decide what a tenant was billed and how far behind they are — so a projected roll would put
  // a rent step nobody has been billed for into every tenant's arrears, and print it under "of
  // which still uncollected at year end" on a sheet the landlord may well send them.
  it('measures where each tenant stands on what was billed, never on the projection', async () => {
    const proj = (await buildIncomeExpense('corp-1', Y)).properties[0];
    const live = (await buildIncomeExpense('corp-1', Y, { basis: 'live' })).properties[0];
    expect(proj.projectedAhead).toBeGreaterThan(0);   // there IS a step to get this wrong on
    // Identical on both bases, because both are the contracted bill — the projection reaches
    // this table through nothing at all.
    expect(proj.standings.totals.billed).toBeCloseTo(live.standings.totals.billed, 2);
    expect(proj.standings.totals.owed).toBeCloseTo(live.standings.totals.owed, 2);
    // And it is genuinely less than the grid above it, by exactly the step.
    expect(proj.standings.totals.billed).toBeCloseTo(proj.rent + proj.camTaxBilled + proj.roofBilled - proj.projectedAhead, 2);
  });

  // ⚠ A TAG SETTLES ITS MONTH AT WHATEVER ARRIVED, WITH NO CAP (ledger.js). So a lump tagged to
  // a nearly-free month gives a scale factor in the thousands, and an uncapped split would print
  // an invented six-figure CAM & tax against an equally invented negative rent — a month whose
  // total is right and whose every row is nonsense.
  // ⚠ THE HOLD-BACK AND THE CAP, ON ONE MONTH. January bills $400 — $100 roof, $200 CAM & tax,
  // $100 base — and a $5,000 cheque is tagged to it. Two separate things must be true: no
  // component may exceed what was billed (uncapped, the split read CAM & tax $2,500 for a month
  // billed $200), and the $4,600 surplus must reach no row at all until it is answered for.
  const overpaidRoll = () => {
    const schedule = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, {
      full: i === 0 ? 400 : 0, owed: i === 0 ? 400 : 0, abated: 0, credit: 0, kind: 'full', outsideTerm: i !== 0,
    }]));
    return [{
      lease_id: 'l1', tenant_name: 'T', schedule, factor: 1, camTaxAnnual: 2400, roofAnnual: 1200,
      payments: [{ amount: 5000, paid_date: `${Y}-01-05`, period_month: 1 }],
    }];
  };
  const cashOf = (all) => round2(['rent', 'camTax', 'roof', 'charges', 'carried']
    .reduce((s, g) => s + (all[g][0]?.total || 0), 0));

  it('holds a surplus out of every row until it is answered for, and caps the split', () => {
    const all = billedRowsFromRoll(overpaidRoll(), { collected: true, year: Y });
    // The month counts exactly what it billed — no more, and no component above its own.
    expect(all.camTax[0].byMonth[0]).toBeCloseTo(200, 2);
    expect(all.roof[0].byMonth[0]).toBeCloseTo(100, 2);
    expect(all.rent[0].byMonth[0]).toBeCloseTo(100, 2);
    expect(cashOf(all)).toBeCloseTo(400, 2);
    // …and the $4,600 is named, not lost.
    expect(all.unapplied).toBeCloseTo(4600, 2);
    expect(all.unappliedRows).toEqual([{ lease_id: 'l1', label: 'T', month: 1, amount: 4600 }]);
    // ⚠ THE CASH INVARIANT, NOW IN THREE TERMS. Nothing invented, nothing lost.
    expect(cashOf(all) + all.creditTotal + all.unapplied).toBeCloseTo(5000, 2);
  });

  it('lets the surplus into the month once confirmed, and only for that exact figure', () => {
    const confirmed = new Set([overpayKey('l1', Y, 1, 4600)]);
    const all = billedRowsFromRoll(overpaidRoll(), { collected: true, year: Y, confirmed });
    expect(all.unapplied).toBe(0);
    expect(all.unappliedRows).toEqual([]);
    // It lands on rent — the remainder row — because no other component can claim it.
    expect(all.rent[0].byMonth[0]).toBeCloseTo(4700, 2);
    expect(cashOf(all)).toBeCloseTo(5000, 2);

    // ⚠ AND THE ANSWER IS TO A FIGURE, NOT TO A MONTH. A key for a different amount does not
    // release this one — which is what stops a decision about $850 standing for $950.
    const stale = new Set([overpayKey('l1', Y, 1, 4500)]);
    expect(billedRowsFromRoll(overpaidRoll(), { collected: true, year: Y, confirmed: stale }).unapplied)
      .toBeCloseTo(4600, 2);
  });

  // George's own case, and the demo seed already is it: City Dental bills $9,150 a month, pays
  // January and February in full, sends $4,000 against March and nothing after. No fixture is
  // written here — the underpayment is the seed's, so this test cannot pass by arranging its
  // own answer.
  it('shows the shortfall on the live basis and the full bill on the projected one', async () => {
    const proj = (await buildIncomeExpense('corp-1', Y)).properties[0];
    const live = (await buildIncomeExpense('corp-1', Y, { basis: 'live' })).properties[0];
    const at = (p, i) => {
      const pick = (rows) => rows.find((r) => r.label.includes('City Dental'))?.byMonth[i] || 0;
      return round2(pick(p.rentRows) + pick(p.camTaxRows) + pick(p.roofRows));
    };
    expect(at(proj, 0)).toBeCloseTo(9150, 2);   // January — billed and paid
    expect(at(live, 0)).toBeCloseTo(9150, 2);
    expect(at(proj, 2)).toBeCloseTo(9150, 2);   // March — billed, whatever arrived
    expect(at(live, 2)).toBeCloseTo(4000, 2);   // what actually arrived
    // ⚠ AND THE MONTH NOBODY PAID IS BLANK, not the bill. That is George's sentence in one
    // assertion: *"any months that haven't been paid and the ledger shouldn't show."*
    expect(at(proj, 3)).toBeCloseTo(9150, 2);
    expect(at(live, 3)).toBe(0);
    // The apportionment keeps the components in proportion to the bill and still sums to the
    // cash exactly — the month's whole figure is exact even though the split is an assumption.
    const liveCam = live.camTaxRows.find((r) => r.label.includes('City Dental'));
    expect(liveCam.byMonth[2]).toBeCloseTo(2150 * (4000 / 9150), 2);
  });
});

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ── The Summary roll-up ───────────────────────────────────────────────────────

describe('consolidateCategories', () => {
  it('is empty for a corporation with no properties, and adds nothing of its own', () => {
    expect(consolidateCategories()).toEqual([]);
    expect(consolidateCategories([])).toEqual([]);
  });
});
