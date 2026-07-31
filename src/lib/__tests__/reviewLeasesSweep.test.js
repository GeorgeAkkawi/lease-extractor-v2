// The "Review leases" sweep. Its whole reason to exist is that the ten-check review only
// runs automatically on NEW imports, so a portfolio imported earlier has a null ai_review
// on every row — 15 of 15 on George's. One click has to fix all of them.
//
// What's pinned here is the behaviour that makes a batch of PAID reads safe to run
// unattended: it reads a lease's document first when the text is missing, one bad lease
// never abandons the rest, and a rate limit is waited out rather than recorded as a
// failure. That last one matters because the AI rate counter is shared per user across
// every function (ai_rate_check, 0018 — keyed on user_id alone), so a sweep is exactly
// the thing that trips it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Only invokeFunction is faked — everything else (updateLease, the demo store) stays real,
// so the sweep is exercised against the same client the app uses.
vi.mock('../supabaseClient', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, invokeFunction: vi.fn() };
});

const { invokeFunction } = await import('../supabaseClient');
const { reviewLeases, leaseNeedsText, MIN_USABLE_TEXT } = await import('../api');

const lease = (id, name, text) => ({ id, tenant_name: name, lease_text: text });
const LONG = 'x'.repeat(MIN_USABLE_TEXT);

beforeEach(() => {
  invokeFunction.mockReset();
});

describe('leaseNeedsText', () => {
  it('is true for a lease with no text, and for a stub too short to be a document', () => {
    expect(leaseNeedsText({ lease_text: null })).toBe(true);
    expect(leaseNeedsText({ lease_text: '' })).toBe(true);
    expect(leaseNeedsText({ lease_text: '   ' })).toBe(true);
    expect(leaseNeedsText({ lease_text: 'x'.repeat(MIN_USABLE_TEXT - 1) })).toBe(true);
    expect(leaseNeedsText({})).toBe(true);
  });

  it('is false once a real transcript is stored — the sweep must not re-read it', () => {
    expect(leaseNeedsText({ lease_text: LONG })).toBe(false);
  });

  // The client and the edge function make the same judgement; if they disagree the sweep
  // would send a lease for caching that the function then declines to touch.
  it('agrees with the edge function on the threshold', () => {
    expect(MIN_USABLE_TEXT).toBe(500);
  });
});

describe('the sweep', () => {
  it('reviews every lease and reports each one', async () => {
    invokeFunction.mockResolvedValue({ flags: [{ key: 'no_late_fee' }], model: 'haiku' });
    const res = await reviewLeases([lease('a', 'Alpha', LONG), lease('b', 'Beta', LONG)]);

    expect(res).toHaveLength(2);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(res.map((r) => r.tenant_name)).toEqual(['Alpha', 'Beta']);
    expect(res[0].flags).toBe(1);
    // Text was already cached on both, so review-lease is the ONLY function called.
    expect(invokeFunction.mock.calls.every(([name]) => name === 'review-lease')).toBe(true);
    expect(invokeFunction).toHaveBeenCalledTimes(2);
  });

  it('reads the document first when a lease has no text, and only then reviews it', async () => {
    invokeFunction.mockImplementation((name) =>
      name === 'cache-lease-text'
        ? Promise.resolve({ length: 40000, source: 'transcription' })
        : Promise.resolve({ flags: [], model: 'haiku' }));

    const res = await reviewLeases([lease('a', 'Alpha', ''), lease('b', 'Beta', LONG)]);

    // Order is load-bearing: reviewing before caching would review an empty document and
    // report "no text on file" for a lease whose text we were about to fetch.
    expect(invokeFunction.mock.calls.map(([n]) => n)).toEqual([
      'cache-lease-text', 'review-lease', 'review-lease',
    ]);
    expect(res[0].cached).toBe(true);
    expect(res[1].cached).toBe(false);
  });

  it('does not count an already-cached skip as a document read', async () => {
    invokeFunction.mockImplementation((name) =>
      name === 'cache-lease-text'
        ? Promise.resolve({ skipped: 'already_cached', length: 900 })
        : Promise.resolve({ flags: [], model: 'haiku' }));

    const res = await reviewLeases([lease('a', 'Alpha', '')]);
    expect(res[0].ok).toBe(true);
    expect(res[0].cached).toBe(false);
  });

  it('carries on past a lease that fails, and names the one that did', async () => {
    invokeFunction.mockImplementation((_name, body) =>
      body.lease_id === 'b'
        ? Promise.reject(new Error('No document is on file for this lease.'))
        : Promise.resolve({ flags: [], model: 'haiku' }));

    const res = await reviewLeases([
      lease('a', 'Alpha', LONG), lease('b', 'Beta', LONG), lease('c', 'Gamma', LONG),
    ]);

    expect(res).toHaveLength(3);
    expect(res.map((r) => r.ok)).toEqual([true, false, true]);
    expect(res[1].error).toMatch(/No document is on file/);
  });

  it('reports progress as it goes, and finishes at the total', async () => {
    invokeFunction.mockResolvedValue({ flags: [], model: 'haiku' });
    const seen = [];
    await reviewLeases([lease('a', 'Alpha', LONG), lease('b', 'Beta', LONG)], {
      onProgress: (p) => seen.push(p),
    });
    expect(seen[0]).toEqual({ done: 0, total: 2, current: 'Alpha' });
    expect(seen[1]).toEqual({ done: 1, total: 2, current: 'Beta' });
    expect(seen.at(-1)).toEqual({ done: 2, total: 2, current: null });
  });
});

describe('a rate limit is waited out, not treated as a failure', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retries the SAME lease after a 429 and still succeeds', async () => {
    let calls = 0;
    invokeFunction.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        const e = new Error('Rate limit reached — too many AI requests.');
        e.status = 429; // set by invokeFunction from error.context.status
        return Promise.reject(e);
      }
      return Promise.resolve({ flags: [], model: 'haiku' });
    });

    const p = reviewLeases([lease('a', 'Alpha', LONG)]);
    await vi.runAllTimersAsync();
    const res = await p;

    expect(calls).toBe(2);
    expect(res[0].ok).toBe(true); // a rate limit means "too fast", never "unreviewable"
  });

  it('gives up on a lease the limiter never lets through, without stopping the sweep', async () => {
    invokeFunction.mockImplementation((_name, body) => {
      if (body.lease_id === 'a') {
        const e = new Error('Rate limit reached — too many AI requests.');
        e.status = 429;
        return Promise.reject(e);
      }
      return Promise.resolve({ flags: [], model: 'haiku' });
    });

    const p = reviewLeases([lease('a', 'Alpha', LONG), lease('b', 'Beta', LONG)]);
    await vi.runAllTimersAsync();
    const res = await p;

    expect(res[0].ok).toBe(false);
    expect(res[1].ok).toBe(true); // the next lease still gets its turn
  });

  it('does not retry an ordinary failure — only a 429 is worth waiting on', async () => {
    let calls = 0;
    invokeFunction.mockImplementation(() => {
      calls++;
      return Promise.reject(new Error('lease not found'));
    });

    const p = reviewLeases([lease('a', 'Alpha', LONG)]);
    await vi.runAllTimersAsync();
    const res = await p;

    expect(calls).toBe(1);
    expect(res[0].ok).toBe(false);
  });
});
