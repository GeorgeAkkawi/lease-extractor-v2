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
import { buildIncomeExpense, rentRowsFromRoll, consolidateCategories, flags, shapeProperty } from '../incomeExpense';
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
      for (const g of p.incomeGroups) ties(g);
      for (const r of p.expenseRows) { ties(r); for (const it of r.items) ties(it); }
      for (const r of p.distributions) ties(r);
      expect(sum12(p.inByMonth) + p.inUndated).toBeCloseTo(p.revenue, 2);
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

  // The headline figures are unchanged by the monthly rewrite — the sheet says the same
  // thing it did, in more detail.
  it('reconciles the grid to what the year left, and to NOI', async () => {
    const [p] = (await build()).properties;
    expect(p.revenue).toBe(146690);                    // 144,000 rent + 2,690 other income
    expect(p.grossNet).toBe(96740);                    // less the 49,950 gross spend
    expect(p.net).toBe(141340);                        // plus the 44,600 tenants paid back
    expect(p.grossNet + p.expenseTotals.recovered).toBeCloseTo(p.net, 2);
  });

  // ⚠ THE TERM THAT IS EASY TO DROP. NOI is built from BILLED expenses only (`cam_total`
  // sums `billable is not false`), so the $2,950 of costs the landlord entered and chose
  // to eat is in this sheet's `spent` and in none of NOI. The sheet shipped on 2026-08-12
  // printing this reconciliation with that term missing, which made it wrong by exactly
  // that figure — and an accountant checking the note is the person who would find it.
  it('reconciles to NOI including the costs NOI never counted', async () => {
    const [p] = (await build()).properties;
    expect(p.absorbed).toBe(2950);
    expect(p.noi + p.recovered + p.otherIncome - p.absorbed).toBeCloseTo(p.net, 2);
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

  // ⚠ THE BRANCH THAT KEEPS A YEAR FROM BEING COUNTED TWICE. On a NET lease the CAM/tax
  // component of a month is the reimbursement, which this workbook takes off the COST
  // side — putting it in rent as well would report the same dollars twice. On a GROSS
  // lease (0073) it is carved OUT of a flat rent the tenant pays regardless, and
  // total_revenue counts the whole flat figure, so leaving it out would under-report.
  it('excludes a net tenant’s reimbursement and includes a gross tenant’s carve', () => {
    const [net] = rentRowsFromRoll([row(false)]);
    const [gross] = rentRowsFromRoll([row(true)]);
    expect(net.total).toBe(9600);         // base only
    expect(gross.total).toBe(12000);      // base + the carve
    expect(gross.total - net.total).toBe(2400);
    expect(net.byMonth).toEqual(Array(12).fill(800));
  });

  it('reads a lease with no schedule as no rent rather than throwing', () => {
    expect(rentRowsFromRoll([{ lease_id: 'l1', tenant_name: 'T' }])[0].total).toBe(0);
    expect(rentRowsFromRoll()).toEqual([]);
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
});

// ── The Summary roll-up ───────────────────────────────────────────────────────

describe('consolidateCategories', () => {
  it('is empty for a corporation with no properties, and adds nothing of its own', () => {
    expect(consolidateCategories()).toEqual([]);
    expect(consolidateCategories([])).toEqual([]);
  });
});
