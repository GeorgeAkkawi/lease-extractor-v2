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
    expect(isoDateOrNull('2026-13-40')).toBeNull(); // impossible calendar date
    expect(isoDateOrNull(null)).toBeNull();
    expect(isoDateOrNull(undefined)).toBeNull();
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
