// A kind of other income the six built-ins don't cover (George, 2026-08-13: "there should be
// an option in record as to create a category of other income if they want to").
//
// THE ONE THING THAT WOULD MAKE THIS USELESS, and what this file mostly pins: before today
// `isIncomeCategory` was a Map lookup and `summarizeOtherIncome` coerced anything it didn't
// recognize to `other` — so a landlord could type a name, it would be stored faithfully on
// the row, and every screen would file it under "Other income" as if he had never bothered.
// A write-in has to survive all the way to the workbook or it isn't a category.
import { describe, it, expect } from 'vitest';
import {
  customCategoryKey, isCustomCategory, isIncomeCategory,
  incomeCategoryLabel, incomeCategoriesInUse, summarizeOtherIncome, INCOME_CATEGORIES,
} from '../otherIncome';
import { isCustomCategory as isCustomExpense } from '../expenseCategories';

describe('a write-in income category', () => {
  it('is the SAME shape CAM buckets and tax categories use — one implementation, not two', () => {
    const key = customCategoryKey('Signage rent');
    expect(key).toBe('custom:signage_rent');
    expect(isCustomCategory(key)).toBe(true);
    // The predicate is literally expenseCategories', re-exported. A second copy would be
    // free to disagree about what a valid key is (CLAUDE.md §3).
    expect(isCustomExpense(key)).toBe(true);
  });

  it('is accepted as a category and labelled from its own key', () => {
    const key = customCategoryKey('Signage rent');
    expect(isIncomeCategory(key)).toBe(true);
    expect(incomeCategoryLabel(key)).toBe('Signage rent');
    // The built-ins are untouched.
    expect(isIncomeCategory('late_fee')).toBe(true);
    expect(incomeCategoryLabel('late_fee')).toBe('Late fees');
  });

  it('groups on its own instead of being swallowed into Other income', () => {
    const key = customCategoryKey('Signage rent');
    const sum = summarizeOtherIncome([
      { category: key, amount: 400, txn_date: '2026-03-04' },
      { category: key, amount: 400, txn_date: '2026-04-04' },
      { category: 'late_fee', amount: 75, txn_date: '2026-03-12' },
    ], 2026);
    const own = sum.groups.find((g) => g.key === key);
    expect(own).toBeTruthy();
    expect(own.label).toBe('Signage rent');
    expect(own.total).toBe(800);
    expect(sum.groups.find((g) => g.key === 'other')).toBeUndefined();
    // …and it carries the per-month grid the Income-and-expenses workbook reads, so it
    // reaches the sheet with no further change there.
    expect(own.byMonth[2]).toBe(400);
    expect(own.byMonth[3]).toBe(400);
    expect(own.undated).toBe(0);
    expect(sum.total).toBe(875);
  });

  it('a genuinely unknown key still falls to Other income, unchanged', () => {
    // Not the same thing as a write-in: this is a key from nowhere, and swallowing it is
    // the safe answer because it names nothing a landlord chose.
    const sum = summarizeOtherIncome([{ category: 'nonsense', amount: 50 }]);
    expect(sum.groups[0].key).toBe('other');
  });

  it('the picker offers the built-ins plus every write-in actually in use', () => {
    const key = customCategoryKey('Signage rent');
    const offered = incomeCategoriesInUse([
      { category: key }, { category: 'late_fee' }, { category: key },
    ]);
    expect(offered).toHaveLength(INCOME_CATEGORIES.length + 1); // deduped
    expect(offered.at(-1).key).toBe(key);
    // Nothing in use → exactly the six built-ins, so an untouched account looks as before.
    expect(incomeCategoriesInUse([])).toEqual(INCOME_CATEGORIES);
    expect(incomeCategoriesInUse()).toEqual(INCOME_CATEGORIES);
  });

  it('an unusable name yields no key rather than an unlabelable one', () => {
    expect(customCategoryKey('   ')).toBeNull();
    expect(customCategoryKey('!!!')).toBeNull();
    expect(customCategoryKey('')).toBeNull();
  });
});
