// Token-free tests for corporation annual-report filing reminders: the dashboard
// alert only appears within a month of the deadline, turns red (and stays) once past
// due, keys distinctly per corporation, and rolls the deadline forward exactly one
// year (with a Feb-29 clamp). Pure alerts.js + annualReports.js — no backend.

import { buildAlerts, alertKey } from '../alerts';
import { advanceDueDate } from '../annualReports';

const NOW = new Date('2026-01-15T12:00:00');

// Minimal data shell — buildAlerts internally guards every collection with `|| []`,
// so we only supply the corporations + annualReports the annual-report section reads.
const base = {
  leases: [], escalations: [], renewals: [], properties: [],
  insurance: [], contracts: [], invoices: [], abatements: [], insuranceRequests: [],
};
const run = (corporations, annualReports) =>
  buildAlerts({ ...base, corporations, annualReports }, undefined, NOW);

const ACME = { id: 'corp1', name: 'Acme Holdings' };
const NORTHWIND = { id: 'corp2', name: 'Northwind Group' };

describe('annual-report dashboard alerts', () => {
  test('a deadline 45 days out is beyond the 1-month window → no alert', () => {
    const out = run([ACME], [{ corporation_id: 'corp1', due_date: '2026-03-01' }]); // +45d
    expect(out.filter((a) => a.focus === 'annual_report')).toHaveLength(0);
  });

  test('a deadline ~20 days out → a warn alert labelled "Within 1 month", named for the corp', () => {
    const out = run([ACME], [{ corporation_id: 'corp1', due_date: '2026-02-04' }]); // +20d
    const ar = out.find((a) => a.focus === 'annual_report');
    expect(ar).toBeTruthy();
    expect(ar.tone).toBe('warn');
    expect(ar.overdue).toBe(false);
    expect(ar.bucketLabel).toBe('Within 1 month');
    expect(ar.title).toBe('Annual report due — Acme Holdings');
    expect(ar.detail).toMatch(/File by/);
    expect(alertKey(ar)).toBe('annual_report:corp1:2026-02-04');
  });

  test('a past-due deadline → a red "Overdue" alert that is still shown', () => {
    const out = run([ACME], [{ corporation_id: 'corp1', due_date: '2026-01-05' }]); // -10d
    const ar = out.find((a) => a.focus === 'annual_report');
    expect(ar).toBeTruthy();
    expect(ar.tone).toBe('danger');
    expect(ar.overdue).toBe(true);
    expect(ar.bucketLabel).toBe('Overdue');
    expect(ar.title).toBe('Annual report overdue — Acme Holdings');
  });

  test('two corporations due the same day get distinct alert keys (keyed by corp)', () => {
    const out = run(
      [ACME, NORTHWIND],
      [
        { corporation_id: 'corp1', due_date: '2026-02-04' },
        { corporation_id: 'corp2', due_date: '2026-02-04' },
      ],
    );
    const ars = out.filter((a) => a.focus === 'annual_report');
    expect(ars).toHaveLength(2);
    const keys = ars.map(alertKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain('annual_report:corp1:2026-02-04');
    expect(keys).toContain('annual_report:corp2:2026-02-04');
  });

  test('a record with no due date on file raises nothing', () => {
    const out = run([ACME], [{ corporation_id: 'corp1', due_date: null }]);
    expect(out.filter((a) => a.focus === 'annual_report')).toHaveLength(0);
  });
});

describe('advanceDueDate (roll-forward on "Mark filed")', () => {
  test('advances exactly one year', () => {
    expect(advanceDueDate('2026-04-01')).toBe('2027-04-01');
    expect(advanceDueDate('2026-12-31')).toBe('2027-12-31');
  });

  test('clamps Feb 29 → Feb 28 when the next year is not a leap year', () => {
    expect(advanceDueDate('2028-02-29')).toBe('2029-02-28');
  });

  test('a leap→leap roll keeps the day intact', () => {
    expect(advanceDueDate('2023-02-28')).toBe('2024-02-28');
  });

  test('returns null for missing / malformed input', () => {
    expect(advanceDueDate(null)).toBe(null);
    expect(advanceDueDate('')).toBe(null);
    expect(advanceDueDate('not-a-date')).toBe(null);
  });
});
