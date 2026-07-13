// Pure timing math for the auto sign-out feature.
import {
  idlePhase,
  secondsUntilLogout,
  resolveMinutes,
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
