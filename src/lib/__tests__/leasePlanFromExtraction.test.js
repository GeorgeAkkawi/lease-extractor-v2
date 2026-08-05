// buildScheduleFromExtraction — the ONE place a lease document's money-over-time becomes
// rows, now shared by the new-tenant import (LeaseNewPage), its review preview,
// anchorLeaseSchedule and the upload-a-new-lease path (applyNewLeaseTerms).
//
// George, 2026-08-04: *"the lease extractor needs to be as good as the original one we made
// for the new tenants."* It wasn't, because this logic existed four times and the copy on
// the replacement path was the thin one — it dated steps from the lease start instead of
// rent commencement, dropped undated free-rent windows, and never built the option-priced
// steps at all. These tests are about the COMPOSITION: that one call does everything the
// intake path did. The individual rules have their own suites (rentCommencementShift,
// renewalOptionSchedule, relativeRentSchedule).
//
// Pure — no AI, no Supabase.

import { buildScheduleFromExtraction } from '../api';

// A lease shaped the way the awkward ones really are: three months free at the front, a rent
// table printed BY LEASE YEAR with no dates on it, and a renewal option priced year by year
// in an exhibit.
const EX = {
  abatements: [{ kind: 'free', months: 3, start_date: null, note: 'First three months free' }],
  escalations: [
    { effective_date: null, months_from_start: 12, escalation_type: 'percent', escalation_value: 3 },
    { effective_date: null, months_from_start: 24, escalation_type: 'percent', escalation_value: 3 },
  ],
  renewal_options: [{
    option_label: 'Option 1', term_months: 60, notice_by_date: '2029-09-30',
    rent_schedule: [
      { months_from_option_start: 0, annual: 120000 },
      { months_from_option_start: 12, annual: 123600 },
    ],
  }],
};
const AT = { baseRent: 100000, leaseStart: '2025-01-01', termEnd: '2029-12-31', today: new Date('2026-08-04T12:00:00') };

test('the free-rent window is saved even though the document never dated it', () => {
  const plan = buildScheduleFromExtraction(EX, AT);
  // Without the fallback to the lease start, buildAbatements drops it and three months of
  // free rent quietly never happen.
  expect(plan.abatements.length).toBe(1);
  expect(plan.abatements[0].start_date).toBe('2025-01-01');
  expect(plan.abatements[0].end_date).toBe('2025-03-31');
  expect(plan.freeMonths).toBe(3);
});

test('rent steps are dated from RENT COMMENCEMENT, not the term start', () => {
  const plan = buildScheduleFromExtraction(EX, AT);
  // Rent commences 2025-04-01 (start + 3 free months), so year 2 begins 2026-04-01. Dating
  // these from the term start would bill each step-up three months before it is owed.
  expect(plan.rentStart).toBe('2025-04-01');
  expect(plan.escalations.map((e) => e.effective_date)).toEqual(['2026-04-01', '2027-04-01']);
  expect(plan.escalations.map((e) => e.new_base_rent)).toEqual([103000, 106090]);
});

test('a renewal option priced year by year becomes dated steps past the term end', () => {
  const plan = buildScheduleFromExtraction(EX, AT);
  expect(plan.renewals.length).toBe(1);
  // The option window opens the day after the committed term ends.
  expect(plan.optionSteps.map((e) => e.effective_date)).toEqual(['2030-01-01', '2031-01-01']);
  expect(plan.optionSteps.map((e) => e.new_base_rent)).toEqual([120000, 123600]);
  // They are projections: nothing here belongs to the committed term.
  expect(plan.optionSteps.every((e) => e.effective_date > AT.termEnd)).toBe(true);
});

test('a step that cannot be dated is reported, not silently dropped', () => {
  // No lease start → nothing to anchor a lease-year table to. Both steps are unplaceable.
  const plan = buildScheduleFromExtraction(EX, { ...AT, leaseStart: null });
  expect(plan.escalations).toEqual([]);
  expect(plan.undated).toBe(2);
  // `undated` is measured as stated-minus-built, so it can never claim more or fewer than
  // the rows that actually failed to land.
  const dated = buildScheduleFromExtraction(EX, AT);
  expect(dated.undated).toBe(0);
});

test('an empty read produces empty rows rather than throwing', () => {
  for (const ex of [null, {}, { escalations: null, renewal_options: null, abatements: null }]) {
    const plan = buildScheduleFromExtraction(ex, AT);
    expect(plan.escalations).toEqual([]);
    expect(plan.optionSteps).toEqual([]);
    expect(plan.renewals).toEqual([]);
    expect(plan.abatements).toEqual([]);
    expect(plan.freeMonths).toBe(0);
    expect(plan.undated).toBe(0);
  }
});
