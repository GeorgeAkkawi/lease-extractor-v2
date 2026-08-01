// Slice 7a — the package you hand your accountant.
//
// The expensive failures here are not formatting. They are:
//   ① NETTING. Slice 3's table subtracts what tenants paid back, because "what did this
//      cost me" is a landlord's question. A RETURN must not: the reimbursement is income
//      and the expense is deducted in full. Netting understates both sides by the same
//      figure and is not permitted on either form.
//   ② DROPPING. A cost deliberately not billed to tenants never reaches cam_total, so it
//      never reaches NOI — and it is still perfectly deductible.
//   ③ GUESSING. Uncategorized money filed as "Other", or an undated expense given a date
//      so a cash basis looks tidy.
//
// These tests pin all three, in both directions.
import { describe, it, expect } from 'vitest';
import {
  FORM_LINES, formLine, RETURN_BASES, splitByBasis,
  shapePropertyReturn, consolidate, excludedFromReturn,
} from '../cpaPackage';
import { EXPENSE_CATEGORIES } from '../expenseCategories';

const Y = 2026;

// A property whose figures make every trap visible at once:
//   • taxes are itemized and dated       → a cash basis can place them
//   • CAM is itemized, one line UNDATED  → a cash basis must exclude and report it
//   • one CAM line is NOT billed back    → deductible, but absent from cam_total
//   • the roof is a flat un-itemized sum → no date exists at all
const ITEMS = [
  { kind: 'tax', label: 'County taxes — 1st instalment', amount: 6000, paid_date: '2026-03-11', billable: true },
  { kind: 'tax', label: 'County taxes — 2nd instalment', amount: 4000, paid_date: '2026-09-08', billable: true },
  { kind: 'cam', label: 'Landscaping', amount: 3000, paid_date: '2026-05-02', billable: true },
  { kind: 'cam', label: 'Snow removal', amount: 2000, paid_date: null, billable: true },
  { kind: 'cam', label: 'Liana', amount: 5000, paid_date: '2026-07-01', billable: false },
];
const EXPENSE = { taxes_total: 10000, cam_total: 5000, roof_total: 1200 };
//                                     ^ 3,000 + 2,000 — the absorbed 5,000 is NOT in it.
const SHARES = [
  { tax_amount: 9000, cam_amount: 4000, roof_amt: 600 },
];
const INVOICES = [
  { id: 'i-26', year: 2026, status: 'sent', total_amount: 120000 },
  { id: 'i-25', year: 2025, status: 'sent', total_amount: 4000 },
];
const PAYMENTS = [
  { invoice_id: 'i-26', amount: 90000, paid_date: '2026-06-30' },
  { invoice_id: 'i-25', amount: 4000, paid_date: '2026-02-14' }, // last year's true-up
  { invoice_id: 'i-26', amount: 30000, paid_date: '2027-01-05' }, // banked next year
];
const PROPERTY = { id: 'p1', name: 'Pershing Plaza', address: '1 Main St' };

const shape = (over = {}) => shapePropertyReturn({
  property: PROPERTY, expense: EXPENSE, items: ITEMS, shares: SHARES,
  invoices: INVOICES, payments: PAYMENTS, year: Y, ...over,
});

describe('the return is gross on both sides', () => {
  // ⚠ THE HEADLINE. Tenants reimburse 13,600 of the 21,200 spent. The deductible figure
  // is 21,200 — the whole spend — and the reimbursement is already inside rental income.
  // Reporting 7,600 (the net cost) would understate income and expenses by 13,600 each.
  it('deducts what was spent, never what was carried after tenants paid back', () => {
    const r = shape();
    expect(r.spent).toBe(21200);
    expect(r.deductible).toBe(21200);
    expect(r.recovered).toBeGreaterThan(0);
    expect(r.deductible).not.toBe(r.spent - r.recovered);
  });

  it('carries the reimbursement as context, not as a subtraction', () => {
    const r = shape();
    // 9,000 of tax + 4,000 of CAM (the absorbed line reimburses nothing) + 600 of roof.
    expect(r.recovered).toBeCloseTo(13600, 2);
  });
});

describe('a cost you absorbed is still deductible', () => {
  // ⚠ syncCamTotal sums only billable !== false, so the 5,000 Liana line is absent from
  // cam_total → total_expenses → NOI. It is an ordinary expense of the property all the
  // same, so it IS on the return — which is exactly why the package's expense figure is
  // legitimately higher than the app's, and why the tie-out reconciles them.
  it('includes a not-billed cost the app’s NOI leaves out', () => {
    const r = shape();
    expect(r.absorbed.total).toBe(5000);
    expect(r.appExpenses).toBe(16200); // taxes 10,000 + cam 5,000 + roof 1,200
    expect(r.deductible - r.appExpenses).toBe(5000);
  });

  it('reimburses nothing on it — it was never billed', () => {
    const r = shape();
    const cat = [...r.categories, r.uncategorized].find((c) => c && c.buckets.includes('Liana'));
    expect(cat.recovered).toBe(0);
  });
});

describe('nothing is filed as “Other” because nobody decided', () => {
  // "Liana" has no default and no saved bucket; "Landscaping" has a registry default.
  it('keeps uncategorized money on its own row, out of the Other category', () => {
    const r = shape();
    expect(r.uncategorized.spent).toBe(5000);
    expect(r.uncategorized.buckets).toContain('Liana');
    expect(r.categories.some((c) => c.key === 'other')).toBe(false);
  });

  it('files it under the category once a bucket answers', () => {
    const r = shape({ buckets: [{ label: 'Liana', category: 'legal' }] });
    expect(r.uncategorized).toBeNull();
    expect(r.categories.find((c) => c.key === 'legal').spent).toBe(5000);
  });
});

describe('the form mapping', () => {
  it('names each category’s own line on each form', () => {
    expect(formLine('repairs', 'f8825')).toMatchObject({ line: 10, label: 'Repairs', viaOther: false });
    expect(formLine('taxes', 'schedE')).toMatchObject({ label: 'Taxes', viaOther: false });
  });

  // The registry is the UNION of the two forms, so three categories exist on one and not
  // the other. Saying which "Other" they roll into is the useful half of the mapping.
  it('says when a category has no line of its own and rolls into Other', () => {
    expect(formLine('management', 'f8825')).toMatchObject({ viaOther: true });
    expect(formLine('management', 'schedE')).toMatchObject({ line: 11, viaOther: false });
    expect(formLine('supplies', 'f8825').viaOther).toBe(true);
    expect(formLine('wages', 'schedE').viaOther).toBe(true);
    expect(formLine('wages', 'f8825').viaOther).toBe(false);
  });

  // Same refusal treatmentInfo / assetKindInfo / entityKindInfo make: a category written
  // by a later round must not be guessed onto a line by an older bundle.
  it('refuses to place a category it does not know', () => {
    expect(formLine('round_19_invention', 'f8825')).toBeNull();
  });

  it('maps every category in the registry', () => {
    for (const c of EXPENSE_CATEGORIES) expect(FORM_LINES[c.key]).toBeTruthy();
  });
});

describe('cash basis places only what it can date', () => {
  it('excludes an undated expense and reports it rather than dropping or dating it', () => {
    const r = shape({ basis: 'cash' });
    // Snow removal (2,000, no date) is out of the totals and named in `undated`.
    expect(r.spent).toBe(18000);
    expect(r.undated.total).toBe(2000 + 1200); // the undated line + the flat roof
    expect(r.undated.lines.map((l) => l.label)).toEqual(['Snow removal']);
    expect(r.undated.lines[0].paid_date).toBeNull();
  });

  // A flat hand-typed kind has no day at all, so a cash basis cannot place it — and it
  // must not sneak back as recoverabilityRows' synthetic "un-itemized" row.
  it('treats an un-itemized kind as undated, not as a synthetic dated row', () => {
    const r = shape({ basis: 'cash' });
    expect(r.undated.flat).toEqual([{ kind: 'roof', label: 'Roof', amount: 1200 }]);
    expect([...r.categories, r.uncategorized].some((c) => c && c.buckets.includes('Roof'))).toBe(false);
  });

  // ⚠ THE BUG THIS DESIGN AVOIDS. Cash filtering shrinks the expense figure handed to
  // recoverabilityRows; deriving the recovery rate from that would report tenants
  // reimbursing several times what was spent. The rate is the whole year's.
  it('does not distort the recovery rate by filtering the expense figure', () => {
    const accrual = shape();
    const cash = shape({ basis: 'cash' });
    const taxOf = (r) => r.categories.find((c) => c.key === 'taxes');
    // Same 10,000 of taxes are dated, so the tax row is identical under both bases…
    expect(taxOf(cash).recovered).toBeCloseTo(taxOf(accrual).recovered, 2);
    // …and never exceeds what was spent on it.
    for (const c of cash.categories) expect(c.recovered).toBeLessThanOrEqual(c.spent + 0.005);
  });

  it('leaves accrual completely untouched', () => {
    const r = shape();
    expect(r.undated.total).toBe(0);
    expect(splitByBasis({ items: ITEMS, expense: EXPENSE, year: Y, basis: 'accrual' }).kept).toBe(ITEMS);
  });
});

describe('income, and the straddle it will not silently pick', () => {
  it('separates what was billed for the year from what was banked during it', () => {
    const r = shape();
    expect(r.income.billed).toBe(120000);      // this year's invoice only
    expect(r.income.received).toBe(94000);     // 90,000 + last year's 4,000 true-up
    expect(r.income.rent).toBe(120000);        // accrual leads with billed
    expect(shape({ basis: 'cash' }).income.rent).toBe(94000);
  });

  // ⚠ A 2025 shortfall billed then and collected now is this year's cash income and last
  // year's accrual expense. There is no correct silent answer, so the figure is stated.
  it('reports how much of this year’s cash settled a prior year’s invoice', () => {
    expect(shape().income.receivedPriorYear).toBe(4000);
  });

  it('ignores a payment banked in another year', () => {
    // The 30,000 landed 2027-01-05 — it is next year's cash, not this year's.
    expect(shape().income.received).toBe(94000);
  });

  it('ignores a voided invoice', () => {
    const r = shape({ invoices: [...INVOICES, { id: 'v', year: 2026, status: 'void', total_amount: 999999 }] });
    expect(r.income.billed).toBe(120000);
  });
});

describe('what the return deliberately leaves off', () => {
  // ⚠ A distribution reduces EQUITY. Filing one as an expense understates income by
  // exactly the amount the accountant taxes.
  it('lists a draw with its reason and keeps it out of every expense figure', () => {
    const ex = excludedFromReturn({ entity: { draws: 24000, contributions: 5000, costs: 1750 }, deposits: 12000, unplaced: { count: 2, total: 800 } });
    const draw = ex.groups.find((g) => g.key === 'draws');
    expect(draw.amount).toBe(24000);
    expect(draw.why).toMatch(/not an expense/);
    expect(shape().deductible).toBe(21200); // unchanged by any of it
  });

  it('names deposits held as a liability, never income', () => {
    const ex = excludedFromReturn({ deposits: 5000 });
    expect(ex.groups.find((g) => g.key === 'deposits').why).toMatch(/liability/);
  });

  it('shows an unplaced line even when its amount nets to nothing', () => {
    const ex = excludedFromReturn({ unplaced: { count: 3, total: 0 } });
    expect(ex.groups.find((g) => g.key === 'unplaced').count).toBe(3);
  });

  it('says nothing when there is nothing to leave off', () => {
    expect(excludedFromReturn({}).groups).toEqual([]);
  });
});

describe('depreciation on the return', () => {
  const BUILDING = { kind: 'building', description: 'Structure', cost: 1450000, land_cost: 300000, placed_in_service: '2019-06-14', useful_life_years: 39 };
  const BLOCKED = { kind: 'building', description: 'Annex', cost: 400000, land_cost: null, placed_in_service: '2020-01-01', useful_life_years: 39 };

  it('deducts the year’s figure even though no money moved', () => {
    const r = shape({ assets: [BUILDING] });
    expect(r.depreciation.amount).toBeGreaterThan(0);
    expect(r.deductible).toBe(Math.round((r.spent + r.depreciation.amount) * 100) / 100);
  });

  // Round 9's refusal, carried onto the return: an unanswered land split blocks, and a
  // blocked asset contributes nothing rather than a confident wrong number.
  it('contributes nothing for an asset it refuses to depreciate, and counts it', () => {
    const withBoth = shape({ assets: [BUILDING, BLOCKED] });
    const onlyGood = shape({ assets: [BUILDING] });
    expect(withBoth.depreciation.amount).toBe(onlyGood.depreciation.amount);
    expect(withBoth.depreciation.blocked).toBe(1);
  });

  it('is not affected by the basis — it never crossed the account', () => {
    expect(shape({ assets: [BUILDING], basis: 'cash' }).depreciation.amount)
      .toBe(shape({ assets: [BUILDING] }).depreciation.amount);
  });
});

describe('the consolidated summary', () => {
  const other = shapePropertyReturn({
    property: { id: 'p2', name: '401 S Main' }, year: Y,
    expense: { taxes_total: 0, cam_total: 2000, roof_total: 0 },
    items: [{ kind: 'cam', label: 'Waste removal', amount: 2000, paid_date: '2026-04-01', billable: true }],
    shares: [{ cam_amount: 1500 }], invoices: [], payments: [],
  });

  it('puts one column per property and totals from the rows shown', () => {
    const s = consolidate([shape(), other]);
    for (const row of s.rows) {
      expect(row.byProperty).toHaveLength(2);
      expect(row.total).toBeCloseTo(row.byProperty.reduce((a, b) => a + b, 0), 2);
    }
    const fromRows = s.rows.reduce((n, r) => n + r.total, 0) + (s.uncategorized?.total || 0);
    expect(s.expenseTotal).toBeCloseTo(fromRows, 2);
  });

  it('keeps uncategorized out of the category rows and names its buckets', () => {
    const s = consolidate([shape(), other]);
    expect(s.rows.some((r) => r.key === null)).toBe(false);
    expect(s.uncategorized.buckets).toContain('Liana');
    expect(s.uncategorized.total).toBe(5000);
  });

  it('drops a category nothing was spent on', () => {
    const s = consolidate([other]);
    expect(s.rows.some((r) => r.key === 'wages')).toBe(false);
  });

  it('nets income against the expenses it actually reported', () => {
    const s = consolidate([shape(), other]);
    expect(s.netIncome).toBeCloseTo(s.income.total - s.expenseTotal, 2);
  });
});

describe('the shapers are pure', () => {
  it('reads twice without changing anything', () => {
    const snap = JSON.stringify({ ITEMS, EXPENSE, SHARES, INVOICES, PAYMENTS });
    shape(); shape({ basis: 'cash' }); consolidate([shape()]);
    expect(JSON.stringify({ ITEMS, EXPENSE, SHARES, INVOICES, PAYMENTS })).toBe(snap);
  });

  it('survives a property with nothing on it', () => {
    const r = shapePropertyReturn({ year: Y });
    expect(r.deductible).toBe(0);
    expect(r.income.total).toBe(0);
    expect(r.uncategorized).toBeNull();
    expect(consolidate([r]).expenseTotal).toBe(0);
  });

  it('offers exactly the two bases', () => {
    expect(RETURN_BASES.map((b) => b.key)).toEqual(['accrual', 'cash']);
  });
});
