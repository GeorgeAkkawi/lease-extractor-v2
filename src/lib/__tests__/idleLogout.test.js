// Pure timing math for the auto sign-out feature.
import {
  idlePhase,
  secondsUntilLogout,
  resolveMinutes,
  initialActivityStamp,
  DEFAULT_MINUTES,
  WARN_SECONDS,
} from '../idleLogout';

const MIN = 60 * 1000;

describe('resolveMinutes', () => {
  test('null/undefined → the default; a number passes through', () => {
    expect(resolveMinutes(null)).toBe(DEFAULT_MINUTES);
    expect(resolveMinutes(undefined)).toBe(DEFAULT_MINUTES);
    expect(resolveMinutes(0)).toBe(0);
    expect(resolveMinutes(15)).toBe(15);
  });
});

describe('idlePhase — boundaries', () => {
  test('30-minute window: active → warn at (cutoff − 60s) → expired at cutoff', () => {
    const last = 0;
    const cutoff = 30 * MIN;
    expect(idlePhase(last, 0, 30)).toBe('active');
    expect(idlePhase(last, cutoff - WARN_SECONDS * 1000 - 1, 30)).toBe('active');
    expect(idlePhase(last, cutoff - WARN_SECONDS * 1000, 30)).toBe('warn');   // warning begins
    expect(idlePhase(last, cutoff - 1, 30)).toBe('warn');
    expect(idlePhase(last, cutoff, 30)).toBe('expired');                       // cutoff reached
    expect(idlePhase(last, cutoff + 5 * MIN, 30)).toBe('expired');
  });

  test('15-minute window scales the same way', () => {
    const cutoff = 15 * MIN;
    expect(idlePhase(0, cutoff - WARN_SECONDS * 1000 - 1, 15)).toBe('active');
    expect(idlePhase(0, cutoff - WARN_SECONDS * 1000, 15)).toBe('warn');
    expect(idlePhase(0, cutoff, 15)).toBe('expired');
  });

  test('0 minutes = off → always active, even after a long idle', () => {
    expect(idlePhase(0, 0, 0)).toBe('active');
    expect(idlePhase(0, 10 * 60 * MIN, 0)).toBe('active');
  });

  test('null minutes falls back to the 30-minute default', () => {
    expect(idlePhase(0, 30 * MIN, null)).toBe('expired');
    expect(idlePhase(0, 30 * MIN - MIN, null)).toBe('warn');
  });
});

describe('initialActivityStamp — never inherit a stale prior-session stamp', () => {
  const now = 100 * MIN; // arbitrary "now"

  test('a STALE leftover (older than the window) → reset to now (the sign-in-lockout fix)', () => {
    // The bug: a returning user carried a stamp from 40 min ago; on sign-in the first idle
    // check read it as long-expired and signed them straight back out. Now → reset to now.
    expect(initialActivityStamp(now - 40 * MIN, now, 30)).toBe(now);
    // exactly at the cutoff counts as stale too
    expect(initialActivityStamp(now - 30 * MIN, now, 30)).toBe(now);
  });

  test('a RECENT stamp is kept, so genuine cross-tab activity still counts', () => {
    expect(initialActivityStamp(now - 5 * MIN, now, 30)).toBe(now - 5 * MIN);
  });

  test('missing / invalid / future stamps → now', () => {
    expect(initialActivityStamp(NaN, now, 30)).toBe(now);
    expect(initialActivityStamp(0, now, 30)).toBe(now);
    expect(initialActivityStamp(-1, now, 30)).toBe(now);
    expect(initialActivityStamp(now + 5 * MIN, now, 30)).toBe(now); // clock skew
  });

  test('a tighter window makes a middling stamp stale (the pref-loads-late edge)', () => {
    // 20-min-old stamp: fine under the 30-min default, but stale once a 15-min pref loads.
    expect(initialActivityStamp(now - 20 * MIN, now, 30)).toBe(now - 20 * MIN);
    expect(initialActivityStamp(now - 20 * MIN, now, 15)).toBe(now);
  });

  test('null minutes uses the 30-min default; off (0) never treats a stamp as stale', () => {
    expect(initialActivityStamp(now - 40 * MIN, now, null)).toBe(now);       // default 30 → stale
    expect(initialActivityStamp(now - 40 * MIN, now, 0)).toBe(now - 40 * MIN); // off → keep (unused anyway)
  });
});

describe('secondsUntilLogout — the warning countdown', () => {
  test('counts down within the final minute and clamps to [0, 60]', () => {
    const last = 0;
    expect(secondsUntilLogout(last, 30 * MIN - 30 * 1000, 30)).toBe(30);
    expect(secondsUntilLogout(last, 30 * MIN - 1 * 1000, 30)).toBe(1);
    expect(secondsUntilLogout(last, 30 * MIN, 30)).toBe(0);
    // far from the cutoff → clamped to the warning length, never larger
    expect(secondsUntilLogout(last, 0, 30)).toBe(WARN_SECONDS);
    // past the cutoff → 0, never negative
    expect(secondsUntilLogout(last, 40 * MIN, 30)).toBe(0);
  });
});
