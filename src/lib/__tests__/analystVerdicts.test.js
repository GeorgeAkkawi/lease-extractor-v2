// Cross-check between the Sonnet analyst brief's VERDICTS line and what the Haiku
// form-fillers captured. This is the universal safety net for hard-to-read leases:
// a term the strong reader saw but the rigid form dropped must raise a flag; the common
// healthy case (they agree) and the ambiguous case (unclear) must NEVER flag.
import { parseAnalystVerdicts, extractionMismatches, riderMismatches, MISMATCH_LABELS } from '../../../supabase/functions/_shared/analystVerdicts.js';

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

  test('captures numeric verdict values (escalation_pct, escalation_stop_months) for the fallback', () => {
    const brief =
      '### BASE RENT & ESCALATIONS\n- "Base rent will increase annually by 2% ... renegotiated in the 8th year."\n\n' +
      'VERDICTS: escalation=yes; escalation_pct=2; escalation_stop_months=84; renewal_options=no; abatement=no; start_date=not_stated';
    const v = parseAnalystVerdicts(brief);
    expect(v.escalation).toBe('yes');
    expect(Number(v.escalation_pct)).toBe(2);
    expect(Number(v.escalation_stop_months)).toBe(84);
  });

  test('"none" numeric verdicts parse as non-numbers (so the fallback stays off)', () => {
    const brief =
      'VERDICTS: escalation=no; escalation_pct=none; escalation_stop_months=none; renewal_options=no; abatement=no; start_date=stated';
    const v = parseAnalystVerdicts(brief);
    expect(v.escalation_pct).toBe('none');
    expect(Number.isFinite(Number(v.escalation_pct))).toBe(false);
  });

  // 0073 — net vs gross rides the verdicts line rather than the form schema, which is
  // AT Anthropic's 16-union ceiling. The parser is generic key=value, so this needed no
  // parser change; the test is what pins that the key survives it.
  test('captures expense_recovery (net | gross | unclear) for the lease-type flag', () => {
    const line = (v) =>
      `VERDICTS: escalation=no; escalation_pct=none; escalation_stop_months=none; renewal_options=no; abatement=no; start_date=stated; expense_recovery=${v}`;
    expect(parseAnalystVerdicts(line('gross')).expense_recovery).toBe('gross');
    expect(parseAnalystVerdicts(line('net')).expense_recovery).toBe('net');
    expect(parseAnalystVerdicts(line('unclear')).expense_recovery).toBe('unclear');
    // An older brief (before the key existed) simply has no value — the extractor
    // leaves lease_type null, which the app reads as net: today's behavior.
    const old = 'VERDICTS: escalation=no; renewal_options=no; abatement=no; start_date=stated';
    expect(parseAnalystVerdicts(old).expense_recovery).toBeUndefined();
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

// ── Riders / addendums ──────────────────────────────────────────────────────────
// A rider's VERDICTS line carries different keys (an amendment can extend the term or
// assign the lease; a lease can't), and "the rent was captured" means something else:
// a rider usually sets ONE new rent on new_base_rent, not an escalations array. Hence
// riderMismatches rather than a reuse of extractionMismatches.
describe('rider VERDICTS + riderMismatches', () => {
  const RIDER_BRIEF = [
    '• WHAT THIS DOCUMENT CHANGES vs WHAT IT MERELY QUOTES — Number 4 is recited, then replaced.',
    '• TERM — extended by an additional five (5) years; the printed date "April 31, 2033" is malformed.',
    '',
    'VERDICTS: rent_change=yes; superseded_quote=yes; term_extension=yes; extension_months=60; ' +
      'new_end_date=none; renewal_options=no; assignment=no; abatement=no; expense_estimate=no',
  ].join('\n');

  test('parses the rider keys, including a numeric extension_months', () => {
    const v = parseAnalystVerdicts(RIDER_BRIEF);
    expect(v.rent_change).toBe('yes');
    expect(v.superseded_quote).toBe('yes');
    expect(v.term_extension).toBe('yes');
    expect(v.extension_months).toBe('60');
    expect(Number(v.extension_months)).toBe(60);
    expect(v.new_end_date).toBe('none');
    expect(v.assignment).toBe('no');
  });

  test('parses a printed new_end_date', () => {
    const v = parseAnalystVerdicts('VERDICTS: term_extension=yes; extension_months=none; new_end_date=2033-04-30');
    expect(v.new_end_date).toBe('2033-04-30');
  });

  test('the healthy Denny\'s case: rent + term captured → no flags', () => {
    const out = riderMismatches({
      verdicts: parseAnalystVerdicts(RIDER_BRIEF),
      newBaseRent: 151140,
      escalations: [],
      newTerminationDate: '2033-04-30',
      renewalOptions: [],
      assignment: null,
      abatements: [],
      expenseEstimate: null,
    });
    expect(out).toEqual([]);
  });

  test('a rent change the form dropped is flagged — even with an empty escalations array', () => {
    // The exact failure mode a lease's escalations-only check would MISS.
    const out = riderMismatches({
      verdicts: parseAnalystVerdicts(RIDER_BRIEF),
      newBaseRent: null,
      escalations: [],
      newTerminationDate: '2033-04-30',
    });
    expect(out).toEqual(['rent_change']);
  });

  test('a rider whose rent lands only as steps still counts as captured', () => {
    const out = riderMismatches({
      verdicts: { rent_change: 'yes' },
      newBaseRent: null,
      escalations: [{ effective_date: '2026-01-01', new_base_rent: 60000 }],
    });
    expect(out).toEqual([]);
  });

  test('a percent-only step counts as a captured rent change', () => {
    const out = riderMismatches({
      verdicts: { rent_change: 'yes' },
      newBaseRent: null,
      escalations: [{ effective_date: '2028-01-01', escalation_type: 'percent', escalation_value: 3, new_base_rent: null }],
    });
    expect(out).toEqual([]);
  });

  test('a dropped extension, option, assignment and estimate all flag', () => {
    const out = riderMismatches({
      verdicts: {
        rent_change: 'no', term_extension: 'yes', renewal_options: 'yes',
        assignment: 'yes', abatement: 'yes', expense_estimate: 'yes',
      },
      newBaseRent: null,
      escalations: [],
      newTerminationDate: null,
      renewalOptions: [],
      assignment: null,
      abatements: [],
      expenseEstimate: null,
    });
    expect(out).toEqual(['term_extension', 'renewal_options', 'assignment', 'abatement', 'expense_estimate']);
  });

  test('an assignment read that returned a tenant is NOT flagged', () => {
    const out = riderMismatches({
      verdicts: { assignment: 'yes' },
      assignment: { is_assignment: true, new_tenant_name: 'D & D Dental, LLC' },
    });
    expect(out).toEqual([]);
  });

  test('never cries wolf: unclear / no / a missing VERDICTS line all stay silent', () => {
    const empty = { newBaseRent: null, escalations: [], newTerminationDate: null, renewalOptions: [], assignment: null, abatements: [], expenseEstimate: null };
    expect(riderMismatches({ verdicts: { rent_change: 'unclear', term_extension: 'unclear', assignment: 'unclear' }, ...empty })).toEqual([]);
    expect(riderMismatches({ verdicts: { rent_change: 'no', term_extension: 'no' }, ...empty })).toEqual([]);
    expect(riderMismatches({ verdicts: parseAnalystVerdicts('a brief with no verdicts line'), ...empty })).toEqual([]);
    expect(riderMismatches({ verdicts: {}, ...empty })).toEqual([]);
  });

  test('every rider code has a human label', () => {
    for (const code of ['rent_change', 'term_extension', 'assignment', 'expense_estimate']) {
      expect(typeof MISMATCH_LABELS[code]).toBe('string');
      expect(MISMATCH_LABELS[code].length).toBeGreaterThan(0);
    }
  });
});
