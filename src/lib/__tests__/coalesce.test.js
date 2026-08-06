import { describe, it, expect, beforeEach } from 'vitest';
import { coalesce, resetCoalesce } from '../coalesce';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('coalesce', () => {
  beforeEach(() => resetCoalesce());

  it('runs straight through when nothing else is in flight', async () => {
    let runs = 0;
    const out = await coalesce('k', async () => { runs += 1; return 'done'; });
    expect(out).toBe('done');
    expect(runs).toBe(1);
  });

  it('folds every request that arrives during a run into ONE re-run', async () => {
    // The shape of five ✕ clicks in a row: the first rebuild is already going, and the
    // four behind it want the same property-year rebuilt from the final state.
    const first = deferred();
    let runs = 0;
    const job = () => { runs += 1; return runs === 1 ? first.promise : Promise.resolve(runs); };

    const a = coalesce('prop:2026', job);
    const b = coalesce('prop:2026', job);
    const c = coalesce('prop:2026', job);
    const d = coalesce('prop:2026', job);
    await Promise.resolve(); // the job starts on a microtask, not synchronously
    expect(runs).toBe(1); // nothing has been started twice

    first.resolve('first');
    await Promise.all([a, b, c, d]);
    expect(runs).toBe(2); // the one in flight, plus one covering all three behind it
  });

  it('always runs again after the last request — the carry-through is never skipped', async () => {
    const first = deferred();
    const seen = [];
    const a = coalesce('k', () => first.promise.then(() => seen.push('first')));
    const b = coalesce('k', () => { seen.push('second'); return 'b'; });

    first.resolve();
    await Promise.all([a, b]);
    // The second request's own job ran, after the first finished — not folded away.
    expect(seen).toEqual(['first', 'second']);
  });

  it('carries the NEWEST job, not the first one folded behind the run', async () => {
    const first = deferred();
    const ran = [];
    const a = coalesce('k', () => first.promise);
    coalesce('k', () => { ran.push(2026); });
    const c = coalesce('k', () => { ran.push(2027); });

    first.resolve();
    await Promise.all([a, c]);
    expect(ran).toEqual([2027]);
  });

  it('a failed run does not swallow the request queued behind it', async () => {
    const first = deferred();
    let second = false;
    const a = coalesce('k', () => first.promise);
    const b = coalesce('k', () => { second = true; return 'ok'; });

    first.reject(new Error('the rebuild failed'));
    await expect(a).rejects.toThrow('the rebuild failed');
    await expect(b).resolves.toBe('ok');
    expect(second).toBe(true);
  });

  it('reports the failure to its own caller rather than resolving quietly', async () => {
    await expect(coalesce('k', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    // …and the key is free again, so the next change still carries through.
    await expect(coalesce('k', async () => 'fine')).resolves.toBe('fine');
  });

  it('keeps separate keys separate — two properties rebuild in parallel', async () => {
    const one = deferred();
    let bRan = false;
    const a = coalesce('prop-a:2026', () => one.promise);
    const b = coalesce('prop-b:2026', async () => { bRan = true; return 'b'; });

    await expect(b).resolves.toBe('b');
    expect(bRan).toBe(true); // did not wait behind prop-a
    one.resolve('a');
    await expect(a).resolves.toBe('a');
  });

  it('starts fresh once a run has settled', async () => {
    let runs = 0;
    const job = async () => { runs += 1; };
    await coalesce('k', job);
    await coalesce('k', job);
    expect(runs).toBe(2); // sequential calls are not folded — nothing was in flight
  });
});
