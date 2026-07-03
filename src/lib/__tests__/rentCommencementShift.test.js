// Token-free proof of the Wingstop rent-commencement fix: when a lease opens with a FREE
// rent period, its paid rent schedule (a lease-year table with no printed dates) is dated
// from RENT COMMENCEMENT — the lease start plus the free months — not the lease start
// itself. buildEscalations + leadingFreeMonths are pure, so no AI / Supabase calls.

import { leadingFreeMonths } from '../abatement';
import { buildEscalations } from '../api';
import { addMonths } from '../renewals';

// Wingstop's real shape: signing / commencement May 4 2012, 8 months free, then a lease-year
// rent table ($30,525 base + four undated step-ups for Year 2 … Year 5, offsets 12/24/36/48).
const START = '2012-05-04';
const ABATEMENTS = [{ kind: 'free', months: 8, start_date: null, note: '8 months free' }];
const ESCALATIONS = [
  { effective_date: null, months_from_start: 12, new_base_rent: 31450, escalation_type: 'manual' },
  { effective_date: null, months_from_start: 24, new_base_rent: 32375, escalation_type: 'manual' },
  { effective_date: null, months_from_start: 36, new_base_rent: 33300, escalation_type: 'manual' },
  { effective_date: null, months_from_start: 48, new_base_rent: 34225, escalation_type: 'manual' },
];

test('leadingFreeMonths reads the 8-month free period at the start', () => {
  expect(leadingFreeMonths(START, ABATEMENTS)).toBe(8);
  // Same when the window carries its own start date equal to the lease start.
  expect(leadingFreeMonths(START, [{ kind: 'free', months: 8, start_date: START }])).toBe(8);
});

test('a reduced (not free) or mid-term free period does NOT defer rent commencement', () => {
  expect(leadingFreeMonths(START, [{ kind: 'percent', months: 8, value: 50, start_date: null }])).toBe(0);
  expect(leadingFreeMonths(START, [{ kind: 'free', months: 6, start_date: '2015-01-01' }])).toBe(0);
  expect(leadingFreeMonths(START, [])).toBe(0);
  expect(leadingFreeMonths(START, null)).toBe(0);
});

test('step-ups are dated from rent commencement (start + 8 free months), not the lease start', () => {
  const freeMo = leadingFreeMonths(START, ABATEMENTS);
  const rentStart = addMonths(START, freeMo); // rent commences after the free period
  expect(rentStart).toBe('2013-01-04');

  const steps = buildEscalations(30525, ESCALATIONS, rentStart);
  expect(steps.map((s) => s.effective_date)).toEqual([
    '2014-01-04', // Year 2 → 12 mo after rent commencement (was landing on 2013-05-04)
    '2015-01-04',
    '2016-01-04',
    '2017-01-04',
  ]);
  expect(steps.map((s) => Math.round(s.new_base_rent))).toEqual([31450, 32375, 33300, 34225]);
});

test('with no free period the schedule is dated from the lease start (regression)', () => {
  const freeMo = leadingFreeMonths(START, []);
  const rentStart = freeMo > 0 ? addMonths(START, freeMo) : START;
  const steps = buildEscalations(30525, ESCALATIONS, rentStart);
  expect(steps.map((s) => s.effective_date)).toEqual([
    '2013-05-04', '2014-05-04', '2015-05-04', '2016-05-04',
  ]);
});
