// The password rule the browser enforces, pinned against the LIVE server policy.
//
// ⚠ WHY THIS FILE EXISTS. `passwordProblem` is a mirror of a setting that lives in the
// Supabase dashboard, and a mirror nothing asserts is a mirror that drifts. It did: on
// 2026-08-21 the live project accepted a 6-character password while this function
// demanded 10, and required a symbol class this function never checked. Both halves were
// wrong at once and nothing failed, because no test knew what the server said.
//
// This cannot reach the live project, so it does the next best thing: it states the
// server policy in one place, as data, and asserts the client agrees with it. If someone
// changes the dashboard, this file is the checklist of what has to move with it.
//
//   password_min_length          = 10
//   password_required_characters = abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789
//
// ⚠ Symbols are deliberately NOT required — see the comment above passwordProblem for
// why the only symbol preset Supabase offers cannot be mirrored.
import { describe, it, expect } from 'vitest';
import { passwordProblem } from '../Login';

const SERVER = {
  minLength: 10,
  groups: [
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '0123456789',
  ],
};

describe('the browser mirrors the server password policy', () => {
  it('accepts a password that satisfies every server group at the server length', () => {
    // one character from each required group, exactly at the minimum length
    const pw = 'aB3' + 'x'.repeat(SERVER.minLength - 3);
    expect(pw.length).toBe(SERVER.minLength);
    expect(passwordProblem(pw)).toBeNull();
  });

  it('rejects one character below the server minimum', () => {
    const pw = ('aB3' + 'x'.repeat(20)).slice(0, SERVER.minLength - 1);
    expect(passwordProblem(pw)).toBe(`Use at least ${SERVER.minLength} characters.`);
  });

  it('requires a character from each group the server requires', () => {
    // drop each group in turn from an otherwise-valid password and expect a complaint
    const missing = {
      lower: 'AB3' + 'X'.repeat(7),
      upper: 'ab3' + 'x'.repeat(7),
      digit: 'aBc' + 'x'.repeat(7),
    };
    for (const [group, pw] of Object.entries(missing)) {
      expect(pw.length).toBeGreaterThanOrEqual(SERVER.minLength);
      expect(passwordProblem(pw), `missing ${group} should be rejected`).not.toBeNull();
    }
  });

  it('does NOT demand a symbol, because the server no longer does', () => {
    // ⚠ The regression that would matter in the other direction: if someone adds a
    // symbol check here without changing the dashboard, every symbol-free password is
    // refused by the browser and accepted by the server — the mirror inverted.
    expect(passwordProblem('Abcdefghi1')).toBeNull();
  });

  it('states a specific problem, never a generic refusal', () => {
    // the whole point of the mirror: the user is told which rule they missed
    expect(passwordProblem('short1A')).toMatch(/at least 10/);
    expect(passwordProblem('abcdefghij1')).toMatch(/uppercase/i);
    expect(passwordProblem('ABCDEFGHIJ1')).toMatch(/lowercase/i);
    expect(passwordProblem('abcdefghijK')).toMatch(/number/i);
  });
});
