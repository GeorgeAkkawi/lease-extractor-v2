// The red-flag checklist is shared by two readers — the Sonnet analyst that answers it
// during the import read, and the Haiku review-lease function that answers it on demand —
// so a flag must mean exactly the same thing whichever produced it. That's what this
// module guarantees, and these are its edges.
//
// Imported straight out of supabase/functions/_shared (the analystVerdicts precedent):
// the module is pure and dependency-free precisely so Deno and Vitest can share it.
import { describe, it, expect } from 'vitest';
import {
  LEASE_FLAG_DEFS, LEASE_FLAG_INSTRUCTION, LEASE_FLAG_LINE_SPEC,
  parseAnalystFlags, flagsFromVerdicts, normalizeReviewFlags, buildReviewRecord,
} from '../../../supabase/functions/_shared/leaseFlags.js';

const KEYS = LEASE_FLAG_DEFS.map((d) => d.key);

describe('the checklist itself', () => {
  it('every key is unique and every entry is fully specified', () => {
    expect(new Set(KEYS).size).toBe(KEYS.length);
    for (const d of LEASE_FLAG_DEFS) {
      expect(['high', 'medium', 'info']).toContain(d.severity);
      expect(d.title.length).toBeGreaterThan(3);
      // The note has to say what the risk IS — a bare title is not enough to act on.
      expect(d.note.length).toBeGreaterThan(40);
    }
  });

  it('the prompt names every key, so no check can silently go unasked', () => {
    for (const k of KEYS) {
      expect(LEASE_FLAG_INSTRUCTION, k).toContain(k);
      expect(LEASE_FLAG_LINE_SPEC, k).toContain(`${k}=`);
    }
  });

  it('states the yes-means-the-concern-applies convention explicitly', () => {
    // Everything downstream reads "yes" as "flag this". If the prompt ever stops saying
    // so, a model could reasonably answer the opposite and every flag would invert.
    expect(LEASE_FLAG_INSTRUCTION.toLowerCase()).toContain('yes means the concern applies');
  });
});

describe('parseAnalystFlags', () => {
  const brief = [
    '• PARTIES & PREMISES — Tenant: City Dental PC.',
    '• RED FLAGS / MISSING PROTECTIONS — no guaranty appears anywhere in the lease.',
    '',
    'VERDICTS: escalation=yes; renewal_options=no; abatement=no; start_date=stated',
    'FLAGS: no_personal_guarantee=yes; no_security_deposit=no; cam_capped=unclear; no_late_fee=yes',
  ].join('\n');

  it('reads the FLAGS line without disturbing the VERDICTS line beside it', () => {
    expect(parseAnalystFlags(brief)).toMatchObject({
      no_personal_guarantee: 'yes', no_security_deposit: 'no', cam_capped: 'unclear', no_late_fee: 'yes',
    });
  });

  it('tolerates markdown, stray whitespace and a trailing period', () => {
    expect(parseAnalystFlags('**FLAGS:** no_late_fee = yes ;  cam_capped=no.').no_late_fee).toBe('yes');
    expect(parseAnalystFlags('   FLAGS:no_late_fee=YES').no_late_fee).toBe('yes');
  });

  it('takes the LAST occurrence — the closing line, not one quoted mid-brief', () => {
    const doubled = 'FLAGS: no_late_fee=no\n…more notes…\nFLAGS: no_late_fee=yes';
    expect(parseAnalystFlags(doubled).no_late_fee).toBe('yes');
  });

  it('returns {} for an older brief, a null, or a model that ignored the instruction', () => {
    // The graceful-degradation contract: no line → no flags → the lease saves exactly as
    // it did before the checklist existed.
    expect(parseAnalystFlags('• TERM — five years.\nVERDICTS: escalation=no')).toEqual({});
    expect(parseAnalystFlags(null)).toEqual({});
    expect(parseAnalystFlags(undefined)).toEqual({});
    expect(parseAnalystFlags(42)).toEqual({});
  });
});

describe('flagsFromVerdicts', () => {
  it('raises only the yes answers', () => {
    const out = flagsFromVerdicts({
      no_personal_guarantee: 'yes', no_late_fee: 'no', cam_capped: 'unclear', no_security_deposit: 'yes',
    });
    expect(out.map((f) => f.key).sort()).toEqual(['no_personal_guarantee', 'no_security_deposit']);
  });

  it('never cries wolf on unclear, missing, or an unknown key', () => {
    expect(flagsFromVerdicts({ cam_capped: 'unclear', made_up_key: 'yes' })).toEqual([]);
    expect(flagsFromVerdicts({})).toEqual([]);
    expect(flagsFromVerdicts(null)).toEqual([]);
  });

  it('takes wording and severity from the definitions, never from the model', () => {
    const [f] = flagsFromVerdicts({ no_personal_guarantee: 'yes' });
    const def = LEASE_FLAG_DEFS.find((d) => d.key === 'no_personal_guarantee');
    expect(f).toMatchObject({ title: def.title, note: def.note, severity: def.severity, quote: null });
  });
});

describe('normalizeReviewFlags', () => {
  it('drops a hallucinated key rather than storing it — this blob renders directly', () => {
    const out = normalizeReviewFlags([
      { key: 'no_late_fee', severity: 'medium' },
      { key: 'tenant_smells_bad', severity: 'high', quote: 'invented' },
    ]);
    expect(out.map((f) => f.key)).toEqual(['no_late_fee']);
  });

  it('de-duplicates and sorts most severe first', () => {
    const out = normalizeReviewFlags([
      { key: 'exclusive_use' },            // info
      { key: 'no_late_fee' },              // medium
      { key: 'no_personal_guarantee' },    // high
      { key: 'no_late_fee' },              // repeat
    ]);
    expect(out.map((f) => f.severity)).toEqual(['high', 'medium', 'info']);
  });

  it('keeps a supporting quote, clamped, and tolerates none', () => {
    const long = 'x'.repeat(900);
    const [a, b] = normalizeReviewFlags([
      { key: 'no_late_fee', quote: long },
      { key: 'exclusive_use' },
    ]);
    expect(a.quote.length).toBe(400);
    expect(b.quote).toBeNull();
  });

  it('accepts a downgrade to info but ignores an invented severity', () => {
    const [soft] = normalizeReviewFlags([{ key: 'no_personal_guarantee', severity: 'info' }]);
    expect(soft.severity).toBe('info');
    const [bogus] = normalizeReviewFlags([{ key: 'no_personal_guarantee', severity: 'catastrophic' }]);
    expect(bogus.severity).toBe('high');   // falls back to the definition
  });

  it('survives junk without throwing', () => {
    expect(normalizeReviewFlags(null)).toEqual([]);
    expect(normalizeReviewFlags('nope')).toEqual([]);
    expect(normalizeReviewFlags([null, 7, {}, { key: '' }])).toEqual([]);
  });
});

describe('buildReviewRecord', () => {
  it('produces the exact shape both writers store on leases.ai_review', () => {
    const rec = buildReviewRecord({
      flags: [{ key: 'no_late_fee' }],
      model: 'claude-sonnet-4-6',
      source: 'extract_lease',
      reviewedAt: '2026-07-29T10:00:00.000Z',
    });
    expect(rec).toEqual({
      flags: [expect.objectContaining({ key: 'no_late_fee', severity: 'medium' })],
      model: 'claude-sonnet-4-6',
      source: 'extract_lease',
      reviewed_at: '2026-07-29T10:00:00.000Z',
    });
  });
});
