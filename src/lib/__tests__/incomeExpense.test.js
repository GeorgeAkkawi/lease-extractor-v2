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
import { buildIncomeExpense, billedRowsFromRoll, consolidateCategories, flags, shapeProperty, noiBridge } from '../incomeExpense';
import { getPropertyMonthlyRoll } from '../api';
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

  it('ties the rent it lays out to the Revenue figure the page already shows', async () => {
    const [p] = (await build()).properties;
    expect(p.rent).toBe(144000);
    expect(p.rentQuoted).toBe(144000);   // v_property_totals.total_revenue
    expect(p.rentDrift).toBe(0);
    expect(p.rentByMonth).toEqual(Array(12).fill(12000));
    expect(p.rentRows.map((r) => [r.label, r.total])).toEqual([
      ['City Dental', 84000], ['Bright Coffee Co.', 60000],
    ]);
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
    expect(p.rent).toBe(144000);                       // base — the row that used to be all of it
    expect(p.camTaxBilled).toBe(42300);                // the reimbursement, now visible
    expect(p.roofBilled).toBe(1500);
    // 144,000 + 42,300 + 1,500 = $187,800 — exactly what the Ledger bills this property.
    expect(p.rent + p.camTaxBilled + p.roofBilled).toBe(187800);
    expect(p.billedTotal).toBe(190490);                // + 2,690 other income
    expect(p.trueUp).toBe(800);                        // actual share 44,600 less 43,800 billed
    expect(p.earned).toBe(191290);
    expect(p.net).toBe(141340);                        // ⚠ THE SAME FIGURE AS BEFORE
    expect(p.earned - p.expenseTotals.spent).toBeCloseTo(p.net, 2);
  });

  // ⚠ EVERY MONTHLY CELL IS WHAT THE LEDGER SHOWS. This is George's complaint, pinned:
  // "the monthly numbers are way off … none of the rents match because it shows base rent."
  it('lays each month out at what the tenant was actually billed', async () => {
    const [p] = (await build()).properties;
    // Bright Coffee: $5,000 base + $1,375 CAM & tax + $125 roof = the $6,500 the Ledger bills.
    const bright = p.rentRows.find((r) => r.label.includes('Bright'));
    const brightCam = p.camTaxRows.find((r) => r.label.includes('Bright'));
    const brightRoof = p.roofRows.find((r) => r.label.includes('Bright'));
    expect(bright.byMonth[2]).toBe(5000);
    expect(brightCam.byMonth[2] + brightRoof.byMonth[2]).toBeCloseTo(1500, 2);
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
    expect(p.noi + p.recovered + p.otherIncome - p.absorbed + p.charges).toBeCloseTo(p.net, 2);
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
    const owedBy = { 1: 1400, 2: 1150, 3: 950 };
    const sched = Object.fromEntries(Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      return [m, { full: 1000, owed: owedBy[m] ?? 1000, abated: 0, credit: 0, kind: 'full', outsideTerm: false }];
    }));
    const g = billedRowsFromRoll([{
      lease_id: 'l1', tenant_name: 'T', schedule: sched, factor: 1, camTaxAnnual: 2400, roofAnnual: 0, gross: false,
      adjustments: [400, 150, -50, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      adjustmentRows: [
        { id: 'a1', kind: 'base', month: 1, amount: 400 },
        { id: 'a2', kind: 'fee', month: 2, amount: 150 },
        { id: 'a3', kind: 'camtax', month: 3, amount: -50 },
      ],
    }]);
    expect(g.rent[0].byMonth[0]).toBe(1200);     // 800 base + the 400 correction
    expect(g.camTax[0].byMonth[2]).toBe(150);    // 200 − the 50 correction
    expect(g.charges[0].byMonth[1]).toBe(150);   // the fee, on its own row
    expect(g.charges[0].total).toBe(150);        // and nothing else lands there
    // THE INVARIANT AGAIN, this time with corrections in play: the components still add up
    // to the month's owed, so Total billed cannot drift from the Ledger by an adjustment.
    for (const m of [1, 2, 3]) {
      const i = m - 1;
      expect(g.rent[0].byMonth[i] + g.camTax[0].byMonth[i] + g.roof[0].byMonth[i] + g.charges[0].byMonth[i])
        .toBeCloseTo(owedBy[m], 2);
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
// paints that month as owed. It holds only while EVERY adjustment kind has a `pnlRow` —
// a kind whose pnlRow is null still moves `owed` (buildLeaseSchedule adds it) but reaches
// none of the four rows, so Total billed would part company with the Ledger by exactly
// that amount. Slice 4 proposes two such kinds (`opening`, `refund`); this is the test
// that will fail when they arrive, which is the whole reason it is here.

describe('the four Money-in rows against the roll they came from', () => {
  it('adds up to each month’s owed, tenant by tenant, on the demo seed', async () => {
    for (const [leases, propId] of [[2, 'prop-1'], [2, 'prop-2']]) {
      const roll = await getPropertyMonthlyRoll(propId, Y);
      expect(roll.length).toBe(leases);   // never let this test pass by finding nothing
      const b = billedRowsFromRoll(roll);
      const by = (group, id) => group.find((r) => r.lease_id === id);
      for (const r of roll) {
        for (let m = 1; m <= 12; m++) {
          const owed = Math.round((Number(r.schedule?.[m]?.owed) || 0) * 100) / 100;
          const parts = ['rent', 'camTax', 'roof', 'charges']
            .reduce((s, g) => s + (by(b[g], r.lease_id)?.byMonth[m - 1] || 0), 0);
          expect(parts).toBeCloseTo(owed, 2);
        }
      }
    }
  });
});

// ── The Summary roll-up ───────────────────────────────────────────────────────

describe('consolidateCategories', () => {
  it('is empty for a corporation with no properties, and adds nothing of its own', () => {
    expect(consolidateCategories()).toEqual([]);
    expect(consolidateCategories([])).toEqual([]);
  });
});
