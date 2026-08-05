// The dated fee schedule (contract_escalations, 0091) and the year-of rule that reads it.
//
// Two guarantees, and the second is as important as the first:
//   1. THE RULE — the step in effect for a fiscal year is the LAST step whose
//      effective_date falls in that year or earlier.
//   2. NO STEPS IS BYTE-IDENTICAL — a contract with an empty schedule is priced exactly as
//      it was before this table existed. An empty table reproducing the old behaviour is
//      what makes 0091 shippable with no back-fill, so it is pinned rather than assumed.
import { describe, it, expect } from 'vitest';
import {
  contractAnnualCost, contractCoversYear, contractStepFor, nextContractStep, stepsByContract,
} from '../contracts';

const step = (date, amount) => ({ effective_date: date, new_amount: amount });

describe('contractStepFor — the year-of rule', () => {
  const steps = [
    step('2024-11-01', 7000),
    step('2026-11-01', 8000),
    step('2028-01-01', 9000),
  ];

  it('takes the LAST step dated in that calendar year or earlier', () => {
    expect(contractStepFor(steps, 2023)).toBe(null);          // nothing yet
    expect(contractStepFor(steps, 2024).new_amount).toBe(7000);
    expect(contractStepFor(steps, 2025).new_amount).toBe(7000); // carries forward
    expect(contractStepFor(steps, 2026).new_amount).toBe(8000);
    expect(contractStepFor(steps, 2027).new_amount).toBe(8000);
    expect(contractStepFor(steps, 2028).new_amount).toBe(9000);
  });

  // The whole reason it is year-of and not "on or before January 1": a snow contract whose
  // season fee steps every 1 November would otherwise bill the OLD figure for the entire
  // year it rose in, and only catch up twelve months late.
  it('a November step prices the WHOLE of its own year, not the next one', () => {
    expect(contractStepFor([step('2026-11-01', 8000)], 2026).new_amount).toBe(8000);
    expect(contractStepFor([step('2026-11-01', 8000)], 2025)).toBe(null);
  });

  it('an empty or absent schedule is simply no step', () => {
    expect(contractStepFor([], 2026)).toBe(null);
    expect(contractStepFor(null, 2026)).toBe(null);
    expect(contractStepFor(undefined, 2026)).toBe(null);
  });

  it('ignores rows with no usable date rather than throwing', () => {
    expect(contractStepFor([{ effective_date: null, new_amount: 5 }], 2026)).toBe(null);
  });
});

describe('contractAnnualCost with steps', () => {
  it('a step in effect wins over the scalar amount', () => {
    const c = { amount: 5000, frequency: 'annual', start_date: '2024-01-01' };
    expect(contractAnnualCost(c, 2026, [step('2026-01-01', 8000)])).toBe(8000);
  });

  // A dated schedule IS the escalation. Compounding the percent on top of it would apply
  // the increase twice — the contract would quietly cost more than the document says.
  it('does NOT compound escalation_pct on top of a dated step', () => {
    const c = { amount: 5000, frequency: 'annual', escalation_pct: 10, start_date: '2020-01-01' };
    expect(contractAnnualCost(c, 2026, [step('2026-01-01', 8000)])).toBe(8000);
  });

  // new_amount is in the CONTRACT'S OWN frequency, mirroring service_contracts.amount.
  // Getting this backwards multiplies a monthly contract by twelve.
  it('annualizes a monthly contract’s step ×12', () => {
    const c = { amount: 1000, frequency: 'monthly', start_date: '2024-01-01' };
    expect(contractAnnualCost(c, 2026, [step('2026-01-01', 1500)])).toBe(18000);
  });

  it('falls back to the scalar path for a year BEFORE the first step', () => {
    const c = { amount: 5000, frequency: 'annual', escalation_pct: 10, start_date: '2024-01-01' };
    // 2025 is one year past the start and has no step → 5000 × 1.1 = 5500.
    expect(contractAnnualCost(c, 2025, [step('2027-01-01', 9000)])).toBe(5500);
  });

  it('still returns 0 when the term doesn’t cover the year, steps or not', () => {
    const c = { amount: 5000, frequency: 'annual', start_date: '2024-01-01', end_date: '2025-12-31' };
    expect(contractCoversYear(c, 2026)).toBe(false);
    expect(contractAnnualCost(c, 2026, [step('2026-01-01', 8000)])).toBe(0);
  });

  // A one-time fee with a schedule is still one-time: it lands in its start year only.
  // This is what keeps a $40,000 roof repair out of every later year's CAM.
  it('a one-time contract never recurs, even with a dated step', () => {
    const c = { amount: 40000, frequency: 'one-time', start_date: '2026-06-01' };
    expect(contractAnnualCost(c, 2026, [step('2026-06-01', 40000)])).toBe(40000);
    expect(contractAnnualCost(c, 2027, [step('2026-06-01', 40000)])).toBe(0);
  });
});

// ⚠ THE REGRESSION LOCK. Every one of these is a case that existed before 0091, asserted
// through the NEW three-argument signature with no steps. If any of them moves, a live
// contract that nobody has ever given a fee schedule has just been re-priced.
describe('no steps is byte-identical to the pre-0091 behaviour', () => {
  const cases = [
    [{ amount: 10000, frequency: 'annual', escalation_pct: 3, start_date: '2020-01-01' }, 2020, 10000],
    [{ amount: 10000, frequency: 'annual', escalation_pct: 3, start_date: '2020-01-01' }, 2021, 10300],
    [{ amount: 10000, frequency: 'annual', escalation_pct: 3, start_date: '2020-01-01' }, 2022, 10609],
    [{ amount: 1000, frequency: 'monthly', escalation_pct: 0, start_date: '2022-01-01' }, 2023, 12000],
    [{ amount: 5000, frequency: 'one-time', start_date: '2021-06-01' }, 2021, 5000],
    [{ amount: 5000, frequency: 'one-time', start_date: '2021-06-01' }, 2022, 0],
    [{ amount: 8000, frequency: 'annual', escalation_pct: 5 }, 2030, 8000], // no start_date → flat
  ];
  it.each(cases)('%o in %i → %i, with null / [] / undefined steps', (c, year, expected) => {
    expect(contractAnnualCost(c, year)).toBe(expected);
    expect(contractAnnualCost(c, year, null)).toBe(expected);
    expect(contractAnnualCost(c, year, [])).toBe(expected);
    expect(contractAnnualCost(c, year, undefined)).toBe(expected);
  });
});

describe('nextContractStep — what the dashboard alert watches', () => {
  const steps = [step('2026-01-01', 7000), step('2027-01-01', 8000), step('2028-01-01', 9000)];

  it('is the earliest step still in the future', () => {
    expect(nextContractStep(steps, '2026-06-01').effective_date).toBe('2027-01-01');
    expect(nextContractStep(steps, '2027-06-01').effective_date).toBe('2028-01-01');
  });

  it('is null once the schedule is entirely in the past', () => {
    expect(nextContractStep(steps, '2029-01-01')).toBe(null);
    expect(nextContractStep([], '2026-01-01')).toBe(null);
  });

  // A step effective TODAY has taken effect; it is not "coming".
  it('a step dated today is not upcoming', () => {
    expect(nextContractStep([step('2026-06-01', 1)], '2026-06-01')).toBe(null);
  });
});

describe('stepsByContract', () => {
  it('groups rows and drops ones with no contract', () => {
    const by = stepsByContract([
      { contract_id: 'a', effective_date: '2026-01-01', new_amount: 1 },
      { contract_id: 'a', effective_date: '2027-01-01', new_amount: 2 },
      { contract_id: 'b', effective_date: '2026-01-01', new_amount: 3 },
      { contract_id: null, effective_date: '2026-01-01', new_amount: 4 },
    ]);
    expect(by.get('a')).toHaveLength(2);
    expect(by.get('b')).toHaveLength(1);
    expect(by.size).toBe(2);
  });

  it('an empty input yields an empty map (never undefined)', () => {
    expect(stepsByContract(null).size).toBe(0);
  });
});
