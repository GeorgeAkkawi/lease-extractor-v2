// Token-free guard for the date sanitization that stops a relative/prose deadline (e.g.
// a renewal "180 days prior to expiration of Original Term") from reaching a Postgres
// `date` column and crashing the whole lease save. Pure functions — no backend.
import { isoDateOrNull, buildRenewals, buildEscalations } from '../api';

describe('isoDateOrNull', () => {
  test('accepts a real YYYY-MM-DD date', () => {
    expect(isoDateOrNull('2026-09-30')).toBe('2026-09-30');
    expect(isoDateOrNull(' 2026-09-30 ')).toBe('2026-09-30');
  });
  test('rejects prose, blanks, and malformed dates', () => {
    expect(isoDateOrNull('180 days prior to expiration of Original Term')).toBeNull();
    expect(isoDateOrNull('')).toBeNull();
    expect(isoDateOrNull('2026-13-40')).toBeNull(); // month 13 → the parser itself gives up
    expect(isoDateOrNull(null)).toBeNull();
    expect(isoDateOrNull(undefined)).toBeNull();
  });
  test('rejects a date that PARSES but does not exist', () => {
    // The one that got through: the shape is right and `new Date` is happy — it silently
    // rolls "2033-04-31" to May 1 — so only a round-trip catches it. Denny's Third
    // Addendum prints exactly this, and Postgres answers with
    // `date/time field value out of range: "2033-04-31"`, failing the entire save.
    expect(isoDateOrNull('2033-04-31')).toBeNull();
    expect(isoDateOrNull('2025-02-30')).toBeNull();
    expect(isoDateOrNull('2025-02-29')).toBeNull(); // not a leap year
    expect(isoDateOrNull('2024-02-29')).toBe('2024-02-29'); // but this one is
    expect(isoDateOrNull('2026-04-30')).toBe('2026-04-30'); // the last real day of a 30-day month
  });
});

describe('buildRenewals — notice_by_date sanitization', () => {
  test('a prose deadline becomes null and is preserved in notes', () => {
    const [r] = buildRenewals([{
      option_label: 'Option 1', term_months: 60, annual_escalation_pct: 5,
      notice_by_date: '180 days prior to expiration of Original Term', notes: null,
    }]);
    expect(r.notice_by_date).toBeNull(); // no longer crashes the date column
    expect(r.notes).toBe('Notice: 180 days prior to expiration of Original Term');
  });
  test('a real date passes through and existing notes are kept', () => {
    const [r] = buildRenewals([{ option_label: 'Option 1', notice_by_date: '2026-03-15', notes: 'from Section 16' }]);
    expect(r.notice_by_date).toBe('2026-03-15');
    expect(r.notes).toBe('from Section 16');
  });
});

describe('buildEscalations — effective_date sanitization', () => {
  test('a step with a prose date is dropped (cannot be scheduled)', () => {
    const rows = buildEscalations(20000, [
      { effective_date: '2021-01-01', new_base_rent: 22000 },
      { effective_date: 'the third lease year', new_base_rent: 24000 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].effective_date).toBe('2021-01-01');
  });
});
