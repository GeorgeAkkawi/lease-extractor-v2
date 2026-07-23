// Pure tests for the month-grouping helper that drives the statement review's
// collapsible per-month sections. Covers the chronological split (incl. a Dec→Jan
// fiscal-year boundary), duplicate exclusion, the live counts, and the full
// rowNeedsReview truth table (which decides whether a month starts open).
import { describe, it, expect } from 'vitest';
import { rowNeedsReview, buildMonthGroups } from '../statementMonths';

// A minimal resolved-row factory matching StatementReview's shape.
const R = (o = {}) => ({
  row: {
    txn: { date: o.date || '2026-07-05', direction: o.direction || 'in', amount: o.amount ?? 100, needsReview: o.needsReview || false },
    duplicate: o.duplicate || false,
    confidence: o.confidence || 'none',
  },
  kind: o.kind || 'unmatched',
  checked: o.checked || false,
  picked: o.picked || false,
  mismatch: o.mismatch || null,
});

describe('rowNeedsReview', () => {
  it('a duplicate never flags — even checked with a mismatch', () => {
    expect(rowNeedsReview(R({ duplicate: true, checked: true, mismatch: { delta: -50 } }))).toBe(false);
  });
  it('a balance-check flag always wants a look, even when checked', () => {
    expect(rowNeedsReview(R({ needsReview: true, checked: true, kind: 'tenant' }))).toBe(true);
    expect(rowNeedsReview(R({ needsReview: true, checked: false }))).toBe(true);
  });
  it('a checked, clean row is settled', () => {
    expect(rowNeedsReview(R({ checked: true, kind: 'tenant', confidence: 'high' }))).toBe(false);
    expect(rowNeedsReview(R({ checked: true, kind: 'expense_cam', confidence: 'high' }))).toBe(false);
  });
  it('a checked deposit that is ≠ projected (amber, no escalation) wants a look', () => {
    expect(rowNeedsReview(R({ checked: true, kind: 'tenant', mismatch: { delta: -1150 } }))).toBe(true);
  });
  it('a checked deposit at the pre-raise rate (escalation-explained) is settled', () => {
    expect(rowNeedsReview(R({ checked: true, kind: 'tenant', mismatch: { delta: -54, escalation: { stepMonth: 6 } } }))).toBe(false);
  });
  it('an UNCHECKED resolved ignore is fine (keyword/rule/explicit pick)', () => {
    expect(rowNeedsReview(R({ checked: false, kind: 'ignore', confidence: 'high' }))).toBe(false); // MORTGAGE keyword
    expect(rowNeedsReview(R({ checked: false, kind: 'ignore', confidence: 'rule' }))).toBe(false); // ignore rule
    expect(rowNeedsReview(R({ checked: false, kind: 'ignore', confidence: 'none', picked: true }))).toBe(false); // user picked Ignore
  });
  it('an UNCHECKED unresolved row wants a look', () => {
    expect(rowNeedsReview(R({ checked: false, kind: 'unmatched', confidence: 'none' }))).toBe(true); // unmatched deposit
    expect(rowNeedsReview(R({ checked: false, kind: 'tenant', confidence: 'low' }))).toBe(true); // weak candidate
    expect(rowNeedsReview(R({ checked: false, kind: 'expense_cam', confidence: 'none' }))).toBe(true); // unticked expense
    expect(rowNeedsReview(R({ checked: false, kind: 'ignore', confidence: 'medium' }))).toBe(true); // medium ignore (looks like a refund) — worth a look
  });
});

describe('buildMonthGroups', () => {
  it('splits by each line\'s own month, chronologically, across a Dec→Jan boundary', () => {
    const groups = buildMonthGroups([
      R({ date: '2027-01-05', amount: 10 }),
      R({ date: '2026-12-15', amount: 20 }),
      R({ date: '2026-12-28', amount: 30 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['2026-12', '2027-01']);
    expect(groups.map((g) => g.label)).toEqual(['December 2026', 'January 2027']);
    expect(groups[0].count).toBe(2);
    expect(groups[1].count).toBe(1);
  });

  it('excludes duplicates from the groups and every count', () => {
    const groups = buildMonthGroups([
      R({ date: '2026-07-01', amount: 100 }),
      R({ date: '2026-07-02', amount: 200, duplicate: true }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(1);
    expect(groups[0].inTotal).toBe(100);
  });

  it('carries live money-in / money-out totals and matched vs need-review', () => {
    const [g] = buildMonthGroups([
      R({ date: '2026-07-03', direction: 'in', amount: 9150, checked: true, kind: 'tenant', confidence: 'high' }), // matched
      R({ date: '2026-07-04', direction: 'in', amount: 8000, checked: false, kind: 'unmatched' }),                 // needs review
      R({ date: '2026-07-06', direction: 'out', amount: 450, checked: true, kind: 'expense_cam', confidence: 'high' }), // matched
    ]);
    expect(g.moneyIn).toHaveLength(2);
    expect(g.moneyOut).toHaveLength(1);
    expect(g.inTotal).toBe(17150);
    expect(g.outTotal).toBe(450);
    expect(g.count).toBe(3);
    expect(g.needsReview).toBe(1);
    expect(g.matched).toBe(2);
    expect(g.matched + g.needsReview).toBe(g.count);
  });

  it('skips rows with no date and returns [] for empty input', () => {
    expect(buildMonthGroups([])).toEqual([]);
    expect(buildMonthGroups([{ row: { txn: {}, duplicate: false } }])).toEqual([]);
  });
});
