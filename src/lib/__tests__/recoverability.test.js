// Slice 3 — the recoverability table.
//
// Two properties carry this suite:
//
//  1. EVERY ROW TIES. spent = recovered + net, to the cent, as displayed — and the
//     totals line is the sum of the rows above it, not a separate derivation. A table
//     whose columns don't add up is worse than no table.
//
//  2. THE ROOF ROW MATCHES THE SQL. v_property_totals has computed roof_recovered /
//     roof_unrecovered since migration 0005, for the one bucket that had a per-lease
//     responsibility flag. This slice generalizes that idea in JS, so the roof row is a
//     free cross-check against code that predates it by seventy migrations. If they ever
//     disagree, one of them is wrong and this test says so.
//
// Plus the invariants inherited from Slice 2's roll-up, which this function subsumes —
// including THE refusal: uncategorized money is its own visible figure and is never
// folded into the "Other" category.
import { describe, it, expect } from 'vitest';
import { recoverabilityRows, recoveryFractions } from '../recoverability';
import { getTenantShares, getExpenseRecord, getPropertyTotals, listCamLineItems, listTaxLineItems, listRoofLineItems } from '../api';
import { currentYear } from '../format';

const Y = currentYear();

// ── The arithmetic ────────────────────────────────────────────────────────────

describe('recovery fractions', () => {
  it('reads each kind\'s share straight out of the per-tenant view', () => {
    const shares = [
      { tax_amount: 6000, cam_amount: 4000, roof_amt: 1000 },
      { tax_amount: 3000, cam_amount: 2000, roof_amt: 0 },
    ];
    const fr = recoveryFractions({ shares, expense: { taxes_total: 10000, cam_total: 8000, roof_total: 2000 } });
    expect(fr.tax).toBeCloseTo(0.9, 10);   // 9,000 of 10,000 — the rest is vacant space
    expect(fr.cam).toBeCloseTo(0.75, 10);
    expect(fr.roof).toBeCloseTo(0.5, 10);  // only one tenant is roof-responsible
  });

  // null, not 0. "Nothing was spent" and "nothing came back" are different claims, and
  // a 0 here would multiply into a recovered column that looks like a real finding.
  it('reports no fraction at all for a kind with no spend', () => {
    const fr = recoveryFractions({ shares: [{ tax_amount: 5 }], expense: { taxes_total: 0, cam_total: 0, roof_total: 0 } });
    expect(fr).toEqual({ tax: null, cam: null, roof: null });
  });

  it('survives an empty property', () => {
    expect(recoveryFractions({})).toEqual({ tax: null, cam: null, roof: null });
  });
});

describe('the table', () => {
  const expense = { taxes_total: 10000, cam_total: 8000, roof_total: 2000 };
  const shares = [
    { tax_amount: 6000, cam_amount: 4800, roof_amt: 1000 },
    { tax_amount: 3000, cam_amount: 2400, roof_amt: 0 },
  ];
  const items = [
    { kind: 'tax', label: 'Cook County — 1st instalment', amount: 10000 },
    { kind: 'cam', label: 'Landscaping', amount: 5000 },
    { kind: 'cam', label: 'Snow removal', amount: 3000 },
    { kind: 'cam', label: 'Owner legal fees', amount: 1200, billable: false },
    { kind: 'roof', label: 'Apex Roofing — leak repair', amount: 2000 },
  ];

  it('every row ties: spent = recovered + net', () => {
    const { rows, totals } = recoverabilityRows({ items, shares, expense });
    for (const r of rows) expect(r.spent).toBeCloseTo(r.recovered + r.net, 10);
    expect(totals.spent).toBeCloseTo(totals.recovered + totals.net, 10);
  });

  it('the totals line is the sum of the rows shown, not a second derivation', () => {
    const { rows, totals } = recoverabilityRows({ items, shares, expense });
    const sum = (f) => rows.reduce((s, r) => s + r[f], 0);
    expect(totals.spent).toBeCloseTo(sum('spent'), 10);
    expect(totals.recovered).toBeCloseTo(sum('recovered'), 10);
    expect(totals.net).toBeCloseTo(sum('net'), 10);
    // …and it accounts for every dollar entered, including the non-billable line that
    // never reaches cam_total.
    expect(totals.spent).toBe(21200);
  });

  it('a line marked "not billed to tenants" recovers nothing and is carried in full', () => {
    const { rows } = recoverabilityRows({ items, shares, expense });
    const legal = rows.find((r) => r.buckets.includes('Owner legal fees'));
    expect(legal.recovered).toBe(0);
    expect(legal.net).toBe(1200);
  });

  it('a taxed line rolls to Real estate taxes and recovers the pro-rata share', () => {
    const { rows } = recoverabilityRows({ items, shares, expense });
    const tax = rows.find((r) => r.key === 'taxes');
    expect(tax.spent).toBe(10000);
    expect(tax.recovered).toBe(9000);   // the 1,000 gap is vacant space
    expect(tax.net).toBe(1000);
  });

  // The section a line was entered in IS information: a row in the property-taxes list
  // is a real-estate-tax line, and a roof line is roof work. Only CAM is genuinely
  // ambiguous, which is where the uncategorized nag belongs.
  it('falls back to what the section means before giving up on a category', () => {
    const { rows } = recoverabilityRows({
      items: [{ kind: 'tax', label: 'IL DPT REV', amount: 500 }, { kind: 'roof', label: 'Ace Roofers', amount: 800 }],
      shares: [], expense: { taxes_total: 500, roof_total: 800 },
    });
    expect(rows.find((r) => r.key === 'taxes').spent).toBe(500);
    expect(rows.find((r) => r.key === 'repairs').spent).toBe(800);
    expect(rows.some((r) => r.key === null)).toBe(false);
  });

  it('ranks by what it cost you, so a fully-absorbed expense outranks a bigger recovered one', () => {
    const { rows } = recoverabilityRows({
      items: [
        { kind: 'tax', label: 'County tax', amount: 100000 },
        { kind: 'cam', label: 'Owner legal fees', amount: 9000, billable: false },
      ],
      // Taxes come back almost whole; the legal fee is absorbed entirely.
      shares: [{ tax_amount: 98000 }], expense: { taxes_total: 100000, cam_total: 0 },
      buckets: [{ label: 'Owner legal fees', category: 'legal' }],
    });
    expect(rows[0].key).toBe('legal');   // net 9,000
    expect(rows[1].key).toBe('taxes');   // net 2,000 on a 100k spend
  });

  // …but the uncategorized nag is pinned last whatever it cost, so the sort can never
  // bury it at the bottom of a long table OR promote it above real categories.
  it('pins uncategorized last even when it is the biggest thing you carried', () => {
    const { rows } = recoverabilityRows({
      items: [
        { kind: 'tax', label: 'County tax', amount: 1000 },
        { kind: 'cam', label: 'Security', amount: 50000 },
      ],
      shares: [], expense: { taxes_total: 1000, cam_total: 50000 },
    });
    expect(rows[rows.length - 1].key).toBe(null);
    expect(rows[rows.length - 1].spent).toBe(50000);
  });
});

// ── An un-itemized kind is still money ────────────────────────────────────────

describe('a kind entered as one flat figure', () => {
  it('appears as its own row rather than vanishing from the table', () => {
    const { rows, totals } = recoverabilityRows({
      items: [{ kind: 'cam', label: 'Landscaping', amount: 8000 }],
      shares: [{ tax_amount: 120000, cam_amount: 7600 }],
      expense: { taxes_total: 127000, cam_total: 8000, roof_total: 0 },
    });
    const tax = rows.find((r) => r.key === 'taxes');
    expect(tax.spent).toBe(127000);
    expect(tax.anyFlat).toBe(true);
    expect(tax.buckets).toEqual(['Property taxes']);
    expect(totals.spent).toBe(135000);
  });

  it('an itemized kind is never double-counted against its own total', () => {
    const { rows } = recoverabilityRows({
      items: [{ kind: 'tax', label: 'Instalment 1', amount: 3000 }, { kind: 'tax', label: 'Instalment 2', amount: 4000 }],
      shares: [], expense: { taxes_total: 7000 },
    });
    expect(rows.find((r) => r.key === 'taxes').spent).toBe(7000);
    expect(rows.every((r) => !r.anyFlat)).toBe(true);
  });
});

// ── Inherited from Slice 2's roll-up, which this subsumes ─────────────────────

describe('grouping (the invariants Slice 2 established)', () => {
  const items = [
    { label: 'Landscaping', amount: 1000 },
    { label: 'Snow removal', amount: 500 },
    { label: 'HVAC service', amount: 4000 },
    { label: 'Other', amount: 250 },
    { label: 'Liana', amount: 900 },
  ];
  const roll = (buckets = []) => recoverabilityRows({ items, shares: [], expense: {}, buckets }).rows;

  it('groups by category, biggest first, and sums to the input', () => {
    const out = roll();
    expect(out[0]).toMatchObject({ key: 'repairs', spent: 4000 });
    expect(out[1]).toMatchObject({ key: 'cleaning', spent: 1500 });
    expect(out.reduce((s, c) => s + c.spent, 0)).toBe(6650);
  });

  // THE refusal. Uncategorized money is its own visible figure, always last, and is
  // never added to the "Other" category — those are different things: one is a CHOICE
  // to file something as Other, the other is nobody having decided yet.
  it('keeps uncategorized money separate from the "Other" category, and puts it last', () => {
    const out = roll();
    const last = out[out.length - 1];
    expect(last.key).toBe(null);
    expect(last.spent).toBe(1150);              // Other 250 + Liana 900
    expect(last.buckets).toEqual(['Liana', 'Other']);
    expect(out.some((c) => c.key === 'other')).toBe(false); // nothing was filed AS Other
  });

  it('drops the uncategorized entry entirely once every bucket is answered', () => {
    const out = roll([{ label: 'Other', category: 'other' }, { label: 'Liana', category: 'legal' }]);
    expect(out.some((c) => c.key === null)).toBe(false);
    expect(out.find((c) => c.key === 'other').spent).toBe(250);
    expect(out.find((c) => c.key === 'legal').spent).toBe(900);
  });

  it('flags a group that is riding on defaults rather than choices', () => {
    expect(roll().find((c) => c.key === 'repairs').anyDefault).toBe(true);
    expect(roll([{ label: 'HVAC service', category: 'repairs' }]).find((c) => c.key === 'repairs').anyDefault).toBe(false);
  });

  it('is pure and handles an empty year', () => {
    const before = JSON.stringify(items);
    roll();
    expect(JSON.stringify(items)).toBe(before);
    expect(recoverabilityRows()).toEqual({
      rows: [], totals: { spent: 0, recovered: 0, net: 0, byMonth: Array(12).fill(0), undated: 0 },
      owner: [], ownerTotal: 0,
      fractions: { tax: null, cam: null, roof: null },
    });
  });
});

// (The CAM-cap caveat's suite lived here. The caveat was removed from "What it cost you"
// on 2026-08-12 and `cappedLeases` with it; the flag itself is still raised and still
// tested where it renders, in leaseReviewStrip.test.js.)

// ── The monthly grid ──────────────────────────────────────────────────────────
//
// Added 2026-08-12 so the Income-and-expenses workbook can lay a year out like a
// reconciliation. Two things carry this block: the grid must ADD UP (months + undated ===
// spent, across and down), and money with no date must stay visibly undated rather than
// being spread over months it was never in.

describe('the monthly breakdown', () => {
  const Y2 = 2026;
  const items = [
    { kind: 'cam', label: 'Landscaping', amount: 400, paid_date: `${Y2}-01-15` },
    { kind: 'cam', label: 'Landscaping', amount: 400, paid_date: `${Y2}-02-15` },
    { kind: 'cam', label: 'Snow removal', amount: 900, paid_date: `${Y2}-01-20` },
    // No paid_date at all — a hand-typed figure. 0074 refuses to invent one.
    { kind: 'cam', label: 'Security', amount: 6000 },
    // A date in the WRONG year on a row filed under this one.
    { kind: 'cam', label: 'Landscaping', amount: 100, paid_date: `${Y2 - 1}-12-31` },
  ];
  const expense = { cam_total: 7800 };
  const buckets = [{ label: 'Landscaping', category: 'cleaning' }, { label: 'Snow removal', category: 'cleaning' }];
  const roll = () => recoverabilityRows({ items, shares: [], expense, buckets, year: Y2 });

  it('places each dated line in its own month and totals across to spent', () => {
    const cleaning = roll().rows.find((r) => r.key === 'cleaning');
    expect(cleaning.byMonth[0]).toBe(1300);  // 400 landscaping + 900 snow
    expect(cleaning.byMonth[1]).toBe(400);
    expect(cleaning.byMonth.slice(2)).toEqual(Array(10).fill(0));
    expect(cleaning.undated).toBe(100);      // the December-of-last-year row
    // ⚠ The invariant the whole grid rests on: the row reads the same across as down.
    expect(cleaning.byMonth.reduce((a, b) => a + b, 0) + cleaning.undated).toBe(cleaning.spent);
  });

  it('holds that invariant for every row and for the totals line', () => {
    const { rows, totals } = roll();
    for (const r of rows) {
      expect(r.byMonth.reduce((a, b) => a + b, 0) + r.undated).toBeCloseTo(r.spent, 10);
      for (const it of r.items) {
        expect(it.byMonth.reduce((a, b) => a + b, 0) + it.undated).toBeCloseTo(it.total, 10);
      }
      expect(r.items.reduce((s, it) => s + it.total, 0)).toBeCloseTo(r.spent, 10);
    }
    expect(totals.byMonth.reduce((a, b) => a + b, 0) + totals.undated).toBeCloseTo(totals.spent, 10);
  });

  // The point of the undated column: it is not a rounding remainder, it is real money —
  // and on live data it is large (a flat tax total alone can be six figures).
  it('keeps undated money out of every month rather than spreading or dropping it', () => {
    const none = roll().rows.find((r) => r.key === null);
    expect(none.undated).toBe(6000);
    expect(none.byMonth).toEqual(Array(12).fill(0));
  });

  // A kind entered as one flat figure for the year has no day by definition.
  it('treats an un-itemized flat total as undated, never as a month', () => {
    const { rows } = recoverabilityRows({ items: [], shares: [], expense: { taxes_total: 127000 }, year: Y2 });
    const tax = rows.find((r) => r.key === 'taxes');
    expect(tax.undated).toBe(127000);
    expect(tax.byMonth).toEqual(Array(12).fill(0));
    expect(tax.items[0]).toMatchObject({ label: 'Property taxes', flat: true, undated: 127000 });
  });

  // The bucket rows under a category — "the main buckets and items", biggest first.
  it('itemizes each category by bucket, merging a bucket entered several times', () => {
    const cleaning = roll().rows.find((r) => r.key === 'cleaning');
    expect(cleaning.items.map((i) => i.label)).toEqual(['Landscaping', 'Snow removal']);
    expect(cleaning.items[0].total).toBe(900);   // 400 + 400 + the undated 100
    expect(cleaning.items[0].byMonth[0]).toBe(400);
  });

  // Omitting `year` is the looser read — a date is taken at face value. This is what
  // makes the function usable on rows that were never year-filtered.
  it('takes a date at face value when no year is given', () => {
    const { rows } = recoverabilityRows({ items, shares: [], expense, buckets });
    const cleaning = rows.find((r) => r.key === 'cleaning');
    expect(cleaning.byMonth[11]).toBe(100);
    expect(cleaning.undated).toBe(0);
  });

  // The owner rows get the same grid — a draw crossed the bank on a day too.
  it('gives an owner distribution its own months, still outside every total', () => {
    const { owner, totals } = recoverabilityRows({
      items: [{ kind: 'cam', label: 'Dana Whitfield', amount: 24000, billable: false, paid_date: `${Y2}-06-01` }],
      shares: [], expense: {}, buckets: [{ label: 'Dana Whitfield', category: 'distribution' }], year: Y2,
    });
    expect(owner[0].byMonth[5]).toBe(24000);
    expect(totals.byMonth).toEqual(Array(12).fill(0));
    expect(totals.spent).toBe(0);
  });
});

// ── Against the demo mock: the roof cross-check ───────────────────────────────

describe('the roof row against the SQL that has computed it since 0005', () => {
  it('matches v_property_totals.roof_recovered / roof_unrecovered exactly', async () => {
    const [shares, expense, totals, cam, tax, roof] = await Promise.all([
      getTenantShares('prop-1', Y), getExpenseRecord('prop-1', Y), getPropertyTotals('prop-1', Y),
      listCamLineItems('prop-1', Y), listTaxLineItems('prop-1', Y), listRoofLineItems('prop-1', Y),
    ]);
    const { rows } = recoverabilityRows({ items: [...tax, ...cam, ...roof], shares, expense });
    const roofRow = rows.find((r) => r.buckets.some((b) => /roof/i.test(b)));

    // The whole point: two independent derivations of the same figure, one in SQL since
    // 0005 and one in JS today, landing on the same number.
    expect(roofRow.recovered).toBeCloseTo(Number(totals.roof_recovered), 2);
    expect(roofRow.net).toBeCloseTo(Number(totals.roof_unrecovered), 2);
    expect(roofRow.spent).toBeCloseTo(Number(expense.roof_total), 2);
  });

  it('the property\'s recovered total equals what every tenant is actually charged', async () => {
    const [shares, expense, cam, tax, roof] = await Promise.all([
      getTenantShares('prop-1', Y), getExpenseRecord('prop-1', Y),
      listCamLineItems('prop-1', Y), listTaxLineItems('prop-1', Y), listRoofLineItems('prop-1', Y),
    ]);
    const { totals } = recoverabilityRows({ items: [...tax, ...cam, ...roof], shares, expense });
    const charged = shares.reduce((s, r) => s + Number(r.tax_amount || 0) + Number(r.cam_amount || 0) + Number(r.roof_amt || 0), 0);
    expect(totals.recovered).toBeCloseTo(charged, 2);
  });
});
