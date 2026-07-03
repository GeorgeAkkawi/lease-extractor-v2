// Cross-check between the Sonnet analyst brief's VERDICTS line and what the Haiku
// form-fillers captured. This is the universal safety net for hard-to-read leases:
// a term the strong reader saw but the rigid form dropped must raise a flag; the common
// healthy case (they agree) and the ambiguous case (unclear) must NEVER flag.
import { parseAnalystVerdicts, extractionMismatches, MISMATCH_LABELS } from '../../../supabase/functions/_shared/analystVerdicts.js';

describe('parseAnalystVerdicts', () => {
  test('parses a well-formed closing VERDICTS line', () => {
    const brief =
      '## BRIEF\n- some notes\n\n' +
      'VERDICTS: escalation=yes; renewal_options=no; abatement=unclear; start_date=not_stated';
    expect(parseAnalystVerdicts(brief)).toEqual({
      escalation: 'yes',
      renewal_options: 'no',
      abatement: 'unclear',
      start_date: 'not_stated',
    });
  });

  test('tolerates markdown bold, extra spaces, and picks the LAST occurrence', () => {
    const brief =
      'Intro mentioning the word VERDICTS: nothing here\n' +
      '**VERDICTS:**  escalation = YES ;  renewal_options=NO ; abatement=no ; start_date=stated ';
    expect(parseAnalystVerdicts(brief)).toEqual({
      escalation: 'yes',
      renewal_options: 'no',
      abatement: 'no',
      start_date: 'stated',
    });
  });

  test('returns {} when there is no VERDICTS line, or on junk input', () => {
    expect(parseAnalystVerdicts('a brief with no verdict line')).toEqual({});
    expect(parseAnalystVerdicts('')).toEqual({});
    expect(parseAnalystVerdicts(null)).toEqual({});
    expect(parseAnalystVerdicts(undefined)).toEqual({});
  });
});

describe('extractionMismatches', () => {
  test('escalation=yes but no steps and no % → flags escalation (the New Hong Kong failure mode)', () => {
    const out = extractionMismatches({
      verdicts: { escalation: 'yes' },
      escalations: [],
      renewalOptions: [],
      abatements: [],
      escalationPct: null,
    });
    expect(out).toEqual(['escalation']);
  });

  test('escalation=yes but a prose % WAS captured → no flag', () => {
    const out = extractionMismatches({
      verdicts: { escalation: 'yes' },
      escalations: [],
      escalationPct: 2,
    });
    expect(out).toEqual([]);
  });

  test('escalation=yes but dated steps WERE captured → no flag', () => {
    const out = extractionMismatches({
      verdicts: { escalation: 'yes' },
      escalations: [{ effective_date: '2019-06-01', new_base_rent: 23304.96 }],
    });
    expect(out).toEqual([]);
  });

  test('escalation=yes but relative (months_from_start) steps captured → no flag', () => {
    const out = extractionMismatches({
      verdicts: { escalation: 'yes' },
      escalations: [{ effective_date: null, months_from_start: 12, new_base_rent: 23304.96 }],
    });
    expect(out).toEqual([]);
  });

  test('escalation=no + empty form → no flag (correct read of a no-escalation lease)', () => {
    const out = extractionMismatches({ verdicts: { escalation: 'no' }, escalations: [] });
    expect(out).toEqual([]);
  });

  test('escalation=unclear → never flags (no crying wolf)', () => {
    const out = extractionMismatches({ verdicts: { escalation: 'unclear' }, escalations: [] });
    expect(out).toEqual([]);
  });

  test('missing VERDICTS line → no verdicts → no flags at all', () => {
    const out = extractionMismatches({
      verdicts: parseAnalystVerdicts('brief with no verdicts line'),
      escalations: [],
      renewalOptions: [],
      abatements: [],
    });
    expect(out).toEqual([]);
  });

  test('renewal_options=yes but none captured → flags; captured → no flag', () => {
    expect(
      extractionMismatches({ verdicts: { renewal_options: 'yes' }, renewalOptions: [] })
    ).toEqual(['renewal_options']);
    expect(
      extractionMismatches({ verdicts: { renewal_options: 'yes' }, renewalOptions: [{ term_months: 60 }] })
    ).toEqual([]);
  });

  test('abatement=yes but none captured → flags; captured → no flag', () => {
    expect(
      extractionMismatches({ verdicts: { abatement: 'yes' }, abatements: [] })
    ).toEqual(['abatement']);
    expect(
      extractionMismatches({ verdicts: { abatement: 'yes' }, abatements: [{ kind: 'free', months: 8 }] })
    ).toEqual([]);
  });

  test('multiple affirmed-but-missing terms all flag together', () => {
    const out = extractionMismatches({
      verdicts: { escalation: 'yes', renewal_options: 'yes', abatement: 'yes' },
      escalations: [],
      renewalOptions: [],
      abatements: [],
    });
    expect(out.sort()).toEqual(['abatement', 'escalation', 'renewal_options']);
  });

  test('every mismatch code has a human label', () => {
    for (const code of ['escalation', 'renewal_options', 'abatement']) {
      expect(typeof MISMATCH_LABELS[code]).toBe('string');
      expect(MISMATCH_LABELS[code].length).toBeGreaterThan(0);
    }
  });

  test('end-to-end: the July-2 New Hong Kong copy (has the 2% clause) → escalation=yes + % captured → no flag', () => {
    const brief =
      '### BASE RENT & ESCALATIONS\n- "Base rent will increase annually by 2%..."\n\n' +
      'VERDICTS: escalation=yes; renewal_options=no; abatement=no; start_date=not_stated';
    const out = extractionMismatches({
      verdicts: parseAnalystVerdicts(brief),
      escalations: [],
      escalationPct: 2,
      renewalOptions: [],
      abatements: [],
    });
    expect(out).toEqual([]);
  });

  test("end-to-end: today's New Hong Kong copy (no clause) → escalation=no + empty → no flag", () => {
    const brief =
      '### BASE RENT & ESCALATIONS\n- No base-rent escalation is stated.\n\n' +
      'VERDICTS: escalation=no; renewal_options=no; abatement=no; start_date=not_stated';
    const out = extractionMismatches({
      verdicts: parseAnalystVerdicts(brief),
      escalations: [],
      escalationPct: null,
      renewalOptions: [],
      abatements: [],
    });
    expect(out).toEqual([]);
  });
});
