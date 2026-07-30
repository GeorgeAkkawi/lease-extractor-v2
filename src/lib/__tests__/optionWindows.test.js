// George, 2026-07-30: "The renewal options need to be dated from when they start to
// when they end."
//
// A lease states a LENGTH, never dates. The dates come from where the committed term
// ends — which is exactly what rollLeaseIntoRenewal books — so the windows have to
// agree with that write, and with each other when options chain.
//
// The shape below is Ricki's-Lyons (live): a 2016 lease with three five-year options,
// the first two exercised (so the committed term already includes them) and the third
// still open.
import { describe, it, expect } from 'vitest';
import { optionWindows, windowLabel, addMonths } from '../renewals';
import { cmpRenewal } from '../leaseTerm';

const opt = (id, label, notice, months, status = 'pending') => ({
  id, option_label: label, notice_by_date: notice, term_months: months, status,
});

const sorted = (list) => [...list].sort(cmpRenewal);

describe('optionWindows — pending options chain forward from the committed term end', () => {
  const termEnd = '2031-05-01';
  const options = [
    opt('o1', 'Option 1', '2030-11-02', 60),
    opt('o2', 'Option 2', '2035-11-02', 60),
  ];

  it('starts the day AFTER the term ends and runs the stated length', () => {
    const w = optionWindows(sorted(options), termEnd);
    expect(w.o1).toEqual({ start: '2031-05-02', end: '2036-05-01' });
  });

  it('picks the next option up where the previous one leaves off', () => {
    const w = optionWindows(sorted(options), termEnd);
    expect(w.o2).toEqual({ start: '2036-05-02', end: '2041-05-01' });
  });

  it("ends exactly where confirming it would move the term — the dialog can't disagree", () => {
    // rollLeaseIntoRenewal: newEnd = addMonths(termEnd, term_months).
    const w = optionWindows(sorted(options), termEnd);
    expect(w.o1.end).toBe(addMonths(termEnd, 60));
  });
});

describe('optionWindows — applied options are already inside the term, so they run backwards', () => {
  // Confirming an option has ALREADY moved lease_termination_date. Chaining an applied
  // option forward would date a period the tenant has been occupying for years as if it
  // were still ahead — the one way this goes badly wrong.
  const termEnd = '2031-05-01'; // = 2016-05-01 + 60 (initial) + 60 (opt 1) + 60 (opt 2)
  const options = [
    opt('o1', 'Option 1', '2019-11-02', 60, 'applied'),
    opt('o2', 'Option 2', '2024-11-02', 60, 'applied'),
    opt('o3', 'Option 3', '2030-11-02', 60),
  ];
  const w = optionWindows(sorted(options), termEnd);

  it('dates the most recent applied option as ending at the committed term end', () => {
    expect(w.o2).toEqual({ start: '2026-05-02', end: '2031-05-01' });
  });

  it('dates the one before it as the period ending where that one starts', () => {
    expect(w.o1).toEqual({ start: '2021-05-02', end: '2026-05-01' });
  });

  it('still chains the remaining open option forward from the committed end', () => {
    expect(w.o3).toEqual({ start: '2031-05-02', end: '2036-05-01' });
  });

  it('leaves no gap and no overlap between one window and the next', () => {
    expect(addMonths(w.o1.end, 0)).toBe('2026-05-01');
    expect(w.o2.start).toBe('2026-05-02'); // the day after o1 ends
    expect(w.o3.start).toBe('2031-05-02'); // the day after o2 ends
  });
});

describe('optionWindows — what it deliberately refuses to date', () => {
  it('gives a DECLINED option no window at all — nothing will ever cover it', () => {
    const w = optionWindows(sorted([opt('o1', 'Option 1', '2030-11-02', 60, 'declined')]), '2031-05-01');
    expect(w.o1).toBeUndefined();
  });

  it('returns nothing when the lease has no committed term end to chain from', () => {
    expect(optionWindows(sorted([opt('o1', 'Option 1', null, 60)]), null)).toEqual({});
  });

  it('stops the chain at an option with no stated length rather than guessing', () => {
    // Everything after an unknown length is unknowable; dating it would invent a boundary.
    const w = optionWindows(sorted([
      opt('o1', 'Option 1', '2030-11-02', null),
      opt('o2', 'Option 2', '2035-11-02', 60),
    ]), '2031-05-01');
    expect(w.o1).toBeUndefined();
    expect(w.o2).toBeUndefined();
  });

  it('handles no options and a bad list without throwing', () => {
    expect(optionWindows([], '2031-05-01')).toEqual({});
    expect(optionWindows(undefined, '2031-05-01')).toEqual({});
  });
});

describe('windowLabel', () => {
  it('reads as a period, in the same arrow form a rider uses', () => {
    expect(windowLabel({ start: '2031-05-02', end: '2036-05-01' })).toBe('May 2, 2031 → May 1, 2036');
  });

  it('is null when there is no window, so the row can fall back to the length', () => {
    expect(windowLabel(null)).toBeNull();
    expect(windowLabel({ start: '2031-05-02' })).toBeNull();
  });
});
