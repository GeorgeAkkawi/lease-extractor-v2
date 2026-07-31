// Slice 2 — a bucket's tax category, and the transcript-gap rule the live sweep exposed.
//
// The load-bearing property of this slice is a REFUSAL: an uncategorized bucket must
// surface as its own dollar figure and must never be folded into "Other". Buildium warns
// that a miscellaneous account becomes "a catch-all for transactions you just don't want
// to deal with", and that has already happened in George's real data — his January import
// learned nine buckets and one of them is literally named "Other". A default of 'other'
// would hide exactly what this slice exists to show, so the tests below pin the absence.
import { describe, it, expect } from 'vitest';
import {
  EXPENSE_CATEGORIES, categoryLabel, isValidCategory, bucketKey,
  defaultCategoryFor, isCapitalProne, categoryFor, summarizeByCategory,
} from '../expenseCategories';
import { transcriptGaps } from '../leaseRisks';

describe('the category registry', () => {
  it('has unique keys and a label for each', () => {
    const keys = EXPENSE_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(EXPENSE_CATEGORIES.every((c) => c.label && categoryLabel(c.key) === c.label)).toBe(true);
  });

  // The union of Form 8825 and Schedule E, because the filing form is the CPA's call.
  // 8825 carries Wages and has no Management fees line; Schedule E is the reverse and
  // adds Supplies. Dropping either side would force a re-categorization the day the
  // entity's filing changes.
  it('spans both forms rather than committing to one', () => {
    const labels = EXPENSE_CATEGORIES.map((c) => c.label);
    expect(labels).toContain('Wages');           // 8825 only
    expect(labels).toContain('Management fees'); // Schedule E only
    expect(labels).toContain('Supplies');        // Schedule E only
  });

  it('rejects a category it does not define', () => {
    expect(isValidCategory('repairs')).toBe(true);
    expect(isValidCategory('landscaping')).toBe(false); // a BUCKET, not a category
    expect(isValidCategory('')).toBe(false);
  });

  // One identity rule shared with the unique index (lower(btrim(label))), so a bucket
  // can never end up holding two different categories under two spellings.
  it('treats a label as one bucket regardless of case and padding', () => {
    expect(bucketKey('  Snow Removal ')).toBe('snow removal');
    expect(bucketKey('SNOW REMOVAL')).toBe(bucketKey('snow removal'));
    expect(bucketKey(null)).toBe('');
  });
});

describe('defaults cover what the app proposes, and nothing else', () => {
  it('pre-categorizes the built-in keyword buckets', () => {
    expect(defaultCategoryFor('Landscaping')).toBe('cleaning');
    expect(defaultCategoryFor('HVAC service')).toBe('repairs');
    expect(defaultCategoryFor('Water')).toBe('utilities');
    expect(defaultCategoryFor('Management fee')).toBe('management');
  });

  // A label a HUMAN invented has no default and must be asked about — that asymmetry is
  // the forcing function. "Other", "IL DPT REV" and "Liana" are real buckets from
  // George's own import and none of them can be guessed at.
  it('leaves a human-invented bucket uncategorized rather than guessing', () => {
    expect(defaultCategoryFor('Other')).toBe(null);
    expect(defaultCategoryFor('IL DPT REV')).toBe(null);
    expect(defaultCategoryFor('Liana')).toBe(null);
  });

  // Security lands on Cleaning or Other depending on the CPA — a real judgement call, so
  // it is deliberately NOT defaulted. Pinned so a later tidy-up doesn't quietly add it.
  it('refuses to default a genuinely ambiguous bucket', () => {
    expect(defaultCategoryFor('Security')).toBe(null);
  });

  it('marks the buckets where a big spend is plausibly capital', () => {
    expect(isCapitalProne('Roof')).toBe(true);
    expect(isCapitalProne('Paving')).toBe(true);
    expect(isCapitalProne('Landscaping')).toBe(false);
  });
});

describe('a saved choice outranks a default, and says which it is', () => {
  it('reports the source so a derived answer never poses as a decision', () => {
    const saved = [{ label: 'Landscaping', category: 'repairs' }];
    expect(categoryFor('Landscaping', saved)).toEqual({ category: 'repairs', source: 'saved' });
    expect(categoryFor('Landscaping', [])).toEqual({ category: 'cleaning', source: 'default' });
    expect(categoryFor('Liana', [])).toEqual({ category: null, source: null });
  });

  it('matches a saved bucket across case and padding', () => {
    const saved = [{ label: '  snow removal ', category: 'repairs' }];
    expect(categoryFor('Snow Removal', saved).category).toBe('repairs');
  });

  it('ignores a stored category the registry no longer defines', () => {
    const saved = [{ label: 'Landscaping', category: 'made_up' }];
    // Falls back to the default rather than rendering a category that doesn't exist.
    expect(categoryFor('Landscaping', saved)).toEqual({ category: 'cleaning', source: 'default' });
  });
});

describe('the roll-up', () => {
  const items = [
    { label: 'Landscaping', amount: 1000 },
    { label: 'Snow removal', amount: 500 },
    { label: 'HVAC service', amount: 4000 },
    { label: 'Other', amount: 250 },
    { label: 'Liana', amount: 900 },
  ];

  it('groups by category, biggest first, and sums to the input', () => {
    const out = summarizeByCategory(items, []);
    expect(out[0]).toMatchObject({ key: 'repairs', total: 4000 });
    expect(out[1]).toMatchObject({ key: 'cleaning', total: 1500 });
    expect(out.reduce((s, c) => s + c.total, 0)).toBe(6650);
  });

  // THE refusal. Uncategorized money is its own visible figure, always last, and is
  // never added to the "Other" category — those are different things: one is a CHOICE
  // to file something as Other, the other is nobody having decided yet.
  it('keeps uncategorized money separate from the "Other" category, and puts it last', () => {
    const out = summarizeByCategory(items, []);
    const last = out[out.length - 1];
    expect(last.key).toBe(null);
    expect(last.total).toBe(1150);              // Other 250 + Liana 900
    expect(last.buckets).toEqual(['Liana', 'Other']);
    expect(out.some((c) => c.key === 'other')).toBe(false); // nothing was filed AS Other
  });

  it('drops the uncategorized entry entirely once every bucket is answered', () => {
    const saved = [{ label: 'Other', category: 'other' }, { label: 'Liana', category: 'legal' }];
    const out = summarizeByCategory(items, saved);
    expect(out.some((c) => c.key === null)).toBe(false);
    expect(out.find((c) => c.key === 'other').total).toBe(250);
    expect(out.find((c) => c.key === 'legal').total).toBe(900);
  });

  it('flags a group that is riding on defaults rather than choices', () => {
    expect(summarizeByCategory(items, []).find((c) => c.key === 'repairs').anyDefault).toBe(true);
    const saved = [{ label: 'HVAC service', category: 'repairs' }];
    expect(summarizeByCategory(items, saved).find((c) => c.key === 'repairs').anyDefault).toBe(false);
  });

  it('is pure and handles an empty year', () => {
    const before = JSON.stringify(items);
    summarizeByCategory(items, []);
    expect(JSON.stringify(items)).toBe(before);
    expect(summarizeByCategory([], [])).toEqual([]);
  });
});

// ── The transcript-gap rule ───────────────────────────────────────────────────
// Found by running the review sweep on live data: a review's most valuable findings say
// a lease is SILENT on something, and an unread page is indistinguishable from silence.
describe('a partial transcript is detectable, so a review built on one can say so', () => {
  it('reads the gap markers the transcription pipeline leaves behind', () => {
    const t = '[Pages 1-10 could not be read for search. Re-upload this lease to try again.] LEASE AGREEMENT…';
    const g = transcriptGaps(t);
    expect(g.partial).toBe(true);
    expect(g.pages).toEqual(['1-10']);
  });

  // Ricki's-Lyons, live: a 36-page scan that transcribed only pages 21-36, so its single
  // finding rests on a third of the document.
  it('names every missing range (Ricki\'s: pages 1-20 of 36)', () => {
    const t = '[Pages 1-10 could not be read for search.] [Pages 11-20 could not be read for search.] # TRANSCRIPTION OF DOCUMENT a separate action against any one or more Guarantors…';
    const g = transcriptGaps(t);
    expect(g.pages).toEqual(['1-10', '11-20']);
    expect(g.partial).toBe(true);
  });

  // Hair Salon, live: the "lease" transcribed as a driver's licence, and the review
  // returned FIVE confident "the lease doesn't say" findings from it. The markers are
  // most of the stored text, so the readable remainder is what has to be judged — a raw
  // length() would have called 317 characters a document.
  it('measures what is readable, not the markers padding it out', () => {
    const t = '[Pages 1-10 could not be read for search. Re-upload this lease to try again.] RUIZ SALDIVAR VICTOR CLASS: D';
    const g = transcriptGaps(t);
    expect(g.partial).toBe(true);
    expect(g.readableLength).toBeLessThan(500); // → "almost nothing usable came through"
    expect(g.readableLength).toBe('RUIZ SALDIVAR VICTOR CLASS: D'.length);
  });

  it('says nothing about a complete transcript', () => {
    const g = transcriptGaps('LEASE AGREEMENT between Landlord and Tenant…');
    expect(g).toEqual({ partial: false, pages: [], readableLength: 44 });
  });

  it('handles no text at all without throwing', () => {
    expect(transcriptGaps(null).partial).toBe(false);
    expect(transcriptGaps('').readableLength).toBe(0);
  });
});
