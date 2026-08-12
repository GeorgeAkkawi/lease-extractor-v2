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
  defaultCategoryFor, isOwnerCategory, categoryFor,
  isCustomCategory, customCategoryKey, allCategories, filingCategory,
} from '../expenseCategories';
import { recoverabilityRows } from '../recoverability';
import {
  createCustomCategory, listCustomCategories, renameCustomCategory,
  saveExpenseBucket, listExpenseBuckets,
} from '../api';
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

  // The owner-capital rule, 2026-08-12: a distribution is a category like any other to
  // every picker, and NOT an expense to any subtotal. One predicate carries that, so the
  // screen and the workbook cannot disagree about it.
  it('marks the owner-capital category, and nothing else', () => {
    expect(isOwnerCategory('distribution')).toBe(true);
    expect(isOwnerCategory('repairs')).toBe(false);
    expect(isOwnerCategory('other')).toBe(false);
    expect(isOwnerCategory(null)).toBe(false);
    // A landlord's write-in files under Other and can never become owner capital —
    // otherwise naming a bucket "Distributions" would silently pull it out of expenses.
    expect(isOwnerCategory('custom:distributions')).toBe(false);
    // Exactly one, so a second would be a deliberate decision rather than a slip.
    expect(EXPENSE_CATEGORIES.filter((c) => c.ownerCapital)).toHaveLength(1);
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

// The roll-up moved to recoverability.test.js — Slice 3's recoverabilityRows subsumes
// summarizeByCategory (same grouping, same uncategorized refusal, plus the recovered
// column), so its invariants are now pinned against the function that actually ships.

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

// ── 0099 — a category the landlord names ─────────────────────────────────────
//
// THE CONSTRAINT this is all shaped by: EXPENSE_CATEGORIES is a fixed vocabulary that the
// roll-ups iterate, so a name the landlord invents has to file under one of its members or
// its money leaves the report. It files under "Other" and supplies the description.
describe('a category the landlord names', () => {
  const customs = [{ key: 'custom:security', label: 'Security' }];

  it('slugs a name into a key that cannot collide with a form line', () => {
    expect(customCategoryKey('Security patrol')).toBe('custom:security_patrol');
    expect(customCategoryKey('  Bank & wire fees!  ')).toBe('custom:bank_wire_fees');
    // No built-in key contains a colon, which is what makes the prefix collision-proof.
    expect(EXPENSE_CATEGORIES.every((c) => !c.key.includes(':'))).toBe(true);
  });

  it('refuses a name that slugs to nothing rather than storing an unreachable key', () => {
    expect(customCategoryKey('---')).toBe(null);
    expect(customCategoryKey('')).toBe(null);
  });

  it('is valid by SHAPE, so no call site has to be handed the list to accept one', () => {
    // This is the property that keeps saveExpenseBucket and the import's category
    // resolution from silently discarding a custom choice.
    expect(isValidCategory('custom:security')).toBe(true);
    expect(isCustomCategory('custom:security')).toBe(true);
    expect(isValidCategory('custom:Not Valid')).toBe(false); // not a slug
    expect(isValidCategory('legal')).toBe(true);
    expect(isCustomCategory('legal')).toBe(false);
  });

  it('reads as words even when nobody handed us the list', () => {
    expect(categoryLabel('custom:security', customs)).toBe('Security');
    // The degraded path: de-slugged from the key, never a blank chip over a category
    // that IS set, and never a stale name after the row was renamed away.
    expect(categoryLabel('custom:bank_wire_fees')).toBe('Bank wire fees');
    expect(categoryLabel('nonsense')).toBe(null);
  });

  it('files under Other — as a write-in, not a missing line', () => {
    expect(filingCategory('custom:security')).toBe('other');
    expect(filingCategory('repairs')).toBe('repairs');
  });

  it('offers the built-ins first, then the landlord’s own, flagged as custom', () => {
    const all = allCategories(customs);
    expect(all.slice(0, EXPENSE_CATEGORIES.length)).toEqual(EXPENSE_CATEGORIES);
    expect(all[all.length - 1]).toEqual({ key: 'custom:security', label: 'Security', custom: true });
    expect(allCategories()).toEqual(EXPENSE_CATEGORIES); // no list → unchanged
  });

  it('KEEPS ITS MONEY IN THE ROLL-UP — the failure that would matter most', () => {
    // A roll-up that iterates EXPENSE_CATEGORIES alone drops a custom key out of both the
    // rows AND the total: money silently missing from a report the landlord hands someone.
    // recoverabilityRows groups from the DATA rather than from the list, which is what
    // makes that impossible; pinned here because the guarantee belongs to the category
    // file even though the grouping lives next door.
    const out = recoverabilityRows({
      items: [
        { kind: 'cam', label: 'Plumbing', amount: 1000, billable: true },
        { kind: 'cam', label: 'Guard hut', amount: 400, billable: true },
      ],
      shares: [],
      expense: { cam_total: 1400 },
      buckets: [
        { label: 'Plumbing', category: 'repairs' },
        { label: 'Guard hut', category: 'custom:security' },
      ],
    });
    const row = out.rows.find((r) => r.key === 'custom:security');
    expect(row).toBeTruthy();
    expect(row.label).toBe('Security'); // de-slugged, never a blank
    expect(row.spent).toBe(400);
    expect(out.totals.spent).toBe(1400); // its dollars are inside the total
  });
});

// The whole journey against the mock: name it, use it on a bucket, rename it. The load-
// bearing link is the middle one — saveExpenseBucket validates with isValidCategory, so a
// version of that guard which needed the custom LIST would refuse the landlord's own
// category here and there would be nothing on screen to explain why.
describe('naming a category and putting it to work', () => {
  it('creates it, the bucket save accepts it, and it reads back by name', async () => {
    const cat = await createCustomCategory('Security patrol');
    expect(cat.key).toBe('custom:security_patrol');

    await saveExpenseBucket({ label: 'Night guard', category: cat.key });
    expect(categoryFor('Night guard', await listExpenseBuckets()))
      .toEqual({ category: 'custom:security_patrol', source: 'saved' });
    expect(categoryLabel(cat.key, await listCustomCategories())).toBe('Security patrol');

    // Rename changes the LABEL only — the key is stored on every row that chose it, so
    // re-slugging would orphan them all.
    await renameCustomCategory(cat.id, 'Site security');
    expect((await listCustomCategories()).find((c) => c.key === cat.key).label).toBe('Site security');
    expect(categoryFor('Night guard', await listExpenseBuckets()).category).toBe('custom:security_patrol');
  });

  it('hands back the existing one rather than failing when the name is typed twice', async () => {
    const a = await createCustomCategory('Bank fees');
    const b = await createCustomCategory('  bank fees ');
    expect(b.key).toBe(a.key);
  });

  // Minting "Utilities" as a write-in would put money on the Other line that belongs on
  // line 12 — a wrong return, quietly.
  it('refuses a name that is already a line on the return', async () => {
    await expect(createCustomCategory('Utilities')).rejects.toThrow(/already a line/i);
  });
});
