import { FEATURES, FEATURE_KEYS, isFeatureOn, toggleFeature } from '../features';

describe('feature switchboard helpers', () => {
  test('null (never chosen) reads every module as on', () => {
    for (const key of FEATURE_KEYS) {
      expect(isFeatureOn(null, key)).toBe(true);
    }
  });

  test('undefined (still loading) also reads as on — nothing flash-hides', () => {
    expect(isFeatureOn(undefined, 'insurance')).toBe(true);
  });

  test('empty array = everything explicitly off', () => {
    for (const key of FEATURE_KEYS) {
      expect(isFeatureOn([], key)).toBe(false);
    }
  });

  test('an explicit subset is honored', () => {
    expect(isFeatureOn(['insurance'], 'insurance')).toBe(true);
    expect(isFeatureOn(['insurance'], 'contracts')).toBe(false);
  });

  test('first toggle-off on a null account materializes the full set minus one', () => {
    const next = toggleFeature(null, 'contracts');
    // contracts dropped, everything else still explicitly on
    expect(next).not.toContain('contracts');
    expect(next).toContain('insurance');
    for (const key of FEATURE_KEYS.filter((k) => k !== 'contracts')) {
      expect(next).toContain(key);
    }
    expect(isFeatureOn(next, 'contracts')).toBe(false);
    expect(isFeatureOn(next, 'insurance')).toBe(true);
  });

  test('toggling a key back on adds it to the set', () => {
    const off = toggleFeature(null, 'contracts');
    const back = toggleFeature(off, 'contracts');
    expect(back).toContain('contracts');
    expect(isFeatureOn(back, 'contracts')).toBe(true);
  });

  test('toggling is a pure, non-mutating operation', () => {
    const start = ['insurance'];
    const next = toggleFeature(start, 'contracts');
    expect(start).toEqual(['insurance']); // original untouched
    expect(next).toEqual(['insurance', 'contracts']);
  });

  test('registry keys are unique and non-empty', () => {
    expect(FEATURE_KEYS.length).toBe(new Set(FEATURE_KEYS).size);
    for (const f of FEATURES) {
      expect(f.key).toBeTruthy();
      expect(f.label).toBeTruthy();
      expect(f.hint).toBeTruthy();
    }
  });
});
