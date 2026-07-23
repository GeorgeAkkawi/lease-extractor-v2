import { describe, it, expect } from 'vitest';
import {
  NOTIFY_TYPES, DEFAULT_LEAD_DAYS, parseLeadTime, formatLeadDays, leadDaysFor, resolveLeadDays,
} from '../notifyPrefs';

describe('parseLeadTime', () => {
  it('reads bare numbers as days', () => {
    expect(parseLeadTime('90')).toBe(90);
    expect(parseLeadTime('7')).toBe(7);
  });
  it('reads days', () => {
    expect(parseLeadTime('90 days')).toBe(90);
    expect(parseLeadTime('30d')).toBe(30);
    expect(parseLeadTime('1 day')).toBe(1);
  });
  it('reads weeks', () => {
    expect(parseLeadTime('2 weeks')).toBe(14);
    expect(parseLeadTime('3w')).toBe(21);
  });
  it('reads months (~30.44 days each)', () => {
    expect(parseLeadTime('3 months')).toBe(91);
    expect(parseLeadTime('6 months')).toBe(183);
    expect(parseLeadTime('1mo')).toBe(30);
  });
  it('reads years', () => {
    expect(parseLeadTime('1 year')).toBe(365);
    expect(parseLeadTime('2yr')).toBe(730);
  });
  it('is case- and space-insensitive', () => {
    expect(parseLeadTime('  3 MONTHS ')).toBe(91);
  });
  it('rejects garbage and non-positive input', () => {
    expect(parseLeadTime('')).toBeNull();
    expect(parseLeadTime('soon')).toBeNull();
    expect(parseLeadTime('-5')).toBeNull();
    expect(parseLeadTime('0')).toBeNull();
    expect(parseLeadTime('three months')).toBeNull();
    expect(parseLeadTime(null)).toBeNull();
    expect(parseLeadTime('5 fortnights')).toBeNull();
  });
});

describe('formatLeadDays', () => {
  it('names clean units', () => {
    expect(formatLeadDays(365)).toBe('1 year');
    expect(formatLeadDays(183)).toBe('6 months');
    expect(formatLeadDays(91)).toBe('3 months');
    expect(formatLeadDays(14)).toBe('2 weeks');
    expect(formatLeadDays(7)).toBe('1 week');
    expect(formatLeadDays(30)).toBe('1 month');
    expect(formatLeadDays(31)).toBe('1 month');
    expect(formatLeadDays(5)).toBe('5 days');
  });
  it('round-trips a parsed month value to a month label', () => {
    expect(formatLeadDays(parseLeadTime('3 months'))).toBe('3 months');
  });
});

describe('leadDaysFor / resolveLeadDays / defaults', () => {
  it('defaults exactly match today’s hard-coded behavior', () => {
    expect(DEFAULT_LEAD_DAYS.lease_end).toBe(183);
    expect(DEFAULT_LEAD_DAYS.insurance).toBe(183);
    expect(DEFAULT_LEAD_DAYS.contract).toBe(183);
    expect(DEFAULT_LEAD_DAYS.annual_report).toBe(31);
    expect(DEFAULT_LEAD_DAYS.abatement).toBe(31);
    expect(DEFAULT_LEAD_DAYS.insurance_chase).toBe(21);
    expect(DEFAULT_LEAD_DAYS.unpaid_rent).toBe(7);
  });
  it('falls back to the default when unset', () => {
    expect(leadDaysFor(null, 'lease_end')).toBe(183);
    expect(leadDaysFor({}, 'annual_report')).toBe(31);
  });
  it('honors a saved value', () => {
    expect(leadDaysFor({ lease_end: 365 }, 'lease_end')).toBe(365);
  });
  it('ignores a non-positive saved value', () => {
    expect(leadDaysFor({ lease_end: 0 }, 'lease_end')).toBe(183);
    expect(leadDaysFor({ lease_end: -1 }, 'lease_end')).toBe(183);
  });
  it('resolveLeadDays returns every type', () => {
    const all = resolveLeadDays({ contract: 90 });
    expect(all.contract).toBe(90);
    expect(all.lease_end).toBe(183);
    expect(Object.keys(all).length).toBe(NOTIFY_TYPES.length);
  });
});
