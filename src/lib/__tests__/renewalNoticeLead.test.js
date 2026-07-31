// The notice deadline as a DURATION — the way a lease actually states it.
//
// George, 2026-07-30: "make sure i can click into notice by and change the duration to
// something specific like how many months before"
//
// What has to hold: the duration counts back from the end of the term the option
// extends (not from the option's start, and not from today), the stored date stays the
// single answer everything downstream reads, and when the period moves the app says so
// instead of quietly leaving a date that no longer means what the lease says.
import { describe, it, expect } from 'vitest';
import {
  optionWindows, noticeAnchor, noticeDateFrom, noticeLeadLabel,
  noticeDraftFrom, resolveNotice, noticeDrift,
} from '../renewals';

const TERM_END = '2027-12-31';
const opt = (over = {}) => ({ id: 'o1', status: 'pending', term_months: 60, ...over });
const winFor = (options, termEnd = TERM_END) => optionWindows(options, termEnd);

describe('What the duration counts back from', () => {
  it('is the day the term this option extends runs out — the committed end, for the first option', () => {
    const w = winFor([opt()]);
    expect(w.o1.start).toBe('2028-01-01');           // the option period opens the day after
    expect(noticeAnchor(w.o1)).toBe(TERM_END);        // …and notice counts back from the day it closes
  });

  it('is the END OF THE OPTION BEFORE IT for a later option — "the then-current term"', () => {
    const w = winFor([opt({ id: 'o1' }), opt({ id: 'o2', option_label: 'Option 2' })]);
    expect(w.o2.start).toBe('2033-01-01');
    expect(noticeAnchor(w.o2)).toBe('2032-12-31');    // when option 1's period runs out
    expect(noticeDateFrom(w.o2, 6, 'months')).toBe('2032-06-30');
  });

  it('resolves months and days off the same anchor', () => {
    const w = winFor([opt()]);
    expect(noticeDateFrom(w.o1, 6, 'months')).toBe('2027-06-30');
    expect(noticeDateFrom(w.o1, 180, 'days')).toBe('2027-07-04');
    expect(noticeDateFrom(w.o1, 12, 'months')).toBe('2026-12-31');
  });

  it('clamps end-of-month exactly as addMonths does — a term ending May 31 gives Nov 30', () => {
    // The demo lease's real shape, and the reason its seeded date needs no change.
    const w = winFor([opt()], '2026-05-31');
    expect(noticeDateFrom(w.o1, 6, 'months')).toBe('2025-11-30');
  });

  it('gives no date when there is nothing to count back from', () => {
    expect(noticeDateFrom(winFor([opt({ term_months: null })]).o1, 6, 'months')).toBeNull();
    expect(noticeDateFrom(undefined, 6, 'months')).toBeNull();
    expect(noticeDateFrom(winFor([opt()]).o1, 0, 'months')).toBeNull();
    expect(noticeDateFrom(winFor([opt()]).o1, -3, 'months')).toBeNull();
  });
});

describe('Saying the rule back', () => {
  it('reads as the lease phrases it, singularized', () => {
    expect(noticeLeadLabel(6, 'months')).toBe('6 months before');
    expect(noticeLeadLabel(180, 'days')).toBe('180 days before');
    expect(noticeLeadLabel(1, 'month')).toBe('1 month before');
    expect(noticeLeadLabel(1, 'days')).toBe('1 day before');
    expect(noticeLeadLabel(0, 'months')).toBeNull();
    expect(noticeLeadLabel(null, 'months')).toBeNull();
  });

  it('re-opens the editor on whatever was entered — a rule as a rule, a date as a date', () => {
    expect(noticeDraftFrom({ notice_lead_n: 180, notice_lead_unit: 'days', notice_by_date: '2027-07-04' }))
      .toEqual({ mode: 'days', n: '180', date: '2027-07-04' });
    expect(noticeDraftFrom({ notice_by_date: '2027-07-04' }))
      .toEqual({ mode: 'date', n: '', date: '2027-07-04' });
    expect(noticeDraftFrom(null)).toEqual({ mode: 'date', n: '', date: '' });
  });
});

describe('What gets written', () => {
  const w = () => winFor([opt()]).o1;

  it('stores the resolved date AND the rule that produced it', () => {
    expect(resolveNotice({ mode: 'months', n: '6' }, w()))
      .toEqual({ notice_by_date: '2027-06-30', notice_lead_n: 6, notice_lead_unit: 'months' });
  });

  it('stores a plain date with NO rule — nothing should ever re-date it', () => {
    expect(resolveNotice({ mode: 'date', date: '2027-03-01' }, w()))
      .toEqual({ notice_by_date: '2027-03-01', notice_lead_n: null, notice_lead_unit: null });
  });

  it('writes nothing at all rather than a rule with no answer', () => {
    // Duration typed, but the option has no term to count back from yet.
    expect(resolveNotice({ mode: 'months', n: '6' }, undefined))
      .toEqual({ notice_by_date: null, notice_lead_n: null, notice_lead_unit: null });
    expect(resolveNotice({ mode: 'months', n: '' }, w()))
      .toEqual({ notice_by_date: null, notice_lead_n: null, notice_lead_unit: null });
    expect(resolveNotice({ mode: 'date', date: '' }, w()))
      .toEqual({ notice_by_date: null, notice_lead_n: null, notice_lead_unit: null });
  });

  it('round-trips: what was written re-opens as the same rule and resolves the same way', () => {
    const written = resolveNotice({ mode: 'days', n: '180' }, w());
    expect(resolveNotice(noticeDraftFrom(written), w())).toEqual(written);
  });
});

describe('When the period moves under a stored rule', () => {
  it('reports the date the rule now gives instead of silently leaving a stale one', () => {
    // The lease was extended three years — so "6 months before" means three years later.
    const stored = { ...opt(), notice_lead_n: 6, notice_lead_unit: 'months', notice_by_date: '2027-06-30' };
    expect(noticeDrift(stored, winFor([stored]).o1)).toBeNull();          // agrees today
    expect(noticeDrift(stored, winFor([stored], '2030-12-31').o1)).toBe('2030-06-30');
  });

  it('reports nothing for a deadline entered as a plain date', () => {
    const stored = { ...opt(), notice_by_date: '2027-06-30' };
    expect(noticeDrift(stored, winFor([stored], '2030-12-31').o1)).toBeNull();
  });

  it('reports nothing once the option is settled — the date is a record by then', () => {
    const base = { notice_lead_n: 6, notice_lead_unit: 'months', notice_by_date: '2027-06-30', term_months: 60 };
    for (const status of ['applied', 'declined']) {
      const stored = { ...opt(), ...base, status };
      expect(noticeDrift(stored, winFor([stored], '2030-12-31')[stored.id])).toBeNull();
    }
  });

  it('reports nothing when the period is unknowable — no guessing at a boundary', () => {
    const stored = { ...opt(), term_months: null, notice_lead_n: 6, notice_lead_unit: 'months', notice_by_date: '2027-06-30' };
    expect(noticeDrift(stored, winFor([stored]).o1)).toBeNull();
  });
});
