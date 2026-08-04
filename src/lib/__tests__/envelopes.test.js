// The state machine behind every e-signature surface. The one rule worth guarding hardest:
// a link that has run past its expiry still holds status 'sent' in the database — nothing
// sweeps it — so reading `env.status` directly reports a dead link as live. envelopeStatus()
// is the only correct read, and liveState() in supabase/functions/sign-envelope/index.ts is
// its server-side twin. If these tests and that function ever disagree, the landlord's screen
// and the tenant's page are telling two different stories about the same link.
import { describe, it, expect } from 'vitest';
import {
  envelopeStatus, isOpen, needsCountersign, needsApply, statusBadge, daysToExpiry,
  envelopeLine, sortEnvelopes, canVoid, canResend, expiryFromNow, purposeLabel,
  DEFAULT_EXPIRY_DAYS, EXPIRY_CHOICES, PURPOSE,
} from '../envelopes';

const NOW = new Date('2026-08-04T12:00:00Z').getTime();
const day = (n) => new Date(NOW + n * 86400000).toISOString();

const env = (over = {}) => ({
  id: 'env-1', status: 'sent', expires_at: day(10), sent_at: day(-2),
  signer_name: 'Sam Rivera', title: 'Second Amendment', purpose: 'extension', ...over,
});

describe('envelopeStatus — expiry is derived, never stored', () => {
  it('leaves a live sent envelope alone', () => {
    expect(envelopeStatus(env(), NOW)).toBe('sent');
  });

  it('reports a PAST-expiry envelope as expired even though the row still says sent', () => {
    const e = env({ expires_at: day(-1) });
    expect(e.status).toBe('sent');              // the database has not moved
    expect(envelopeStatus(e, NOW)).toBe('expired'); // …but the truth has
  });

  it('treats the exact expiry instant as expired, not as the last live moment', () => {
    expect(envelopeStatus(env({ expires_at: new Date(NOW).toISOString() }), NOW)).toBe('expired');
  });

  it('does NOT expire an envelope the tenant already signed', () => {
    // Their signature happened; a date passing afterwards cannot take it back.
    expect(envelopeStatus(env({ status: 'signed', expires_at: day(-30) }), NOW)).toBe('signed');
  });

  it('leaves the three settled states untouched by any date', () => {
    ['executed', 'declined', 'voided'].forEach((s) => {
      expect(envelopeStatus(env({ status: s, expires_at: day(-99) }), NOW)).toBe(s);
    });
  });

  it('a missing envelope reads as voided rather than throwing', () => {
    expect(envelopeStatus(null, NOW)).toBe('voided');
  });

  it('an envelope with no expiry never expires', () => {
    expect(envelopeStatus(env({ expires_at: null }), NOW)).toBe('sent');
  });
});

describe('what needs doing', () => {
  it('only a SIGNED envelope needs countersigning', () => {
    expect(needsCountersign(env({ status: 'signed' }), NOW)).toBe(true);
    ['sent', 'executed', 'declined', 'voided'].forEach((s) => {
      expect(needsCountersign(env({ status: s }), NOW)).toBe(false);
    });
  });

  it('an executed envelope needs applying until applied_at is stamped', () => {
    expect(needsApply(env({ status: 'executed' }), NOW)).toBe(true);
    expect(needsApply(env({ status: 'executed', applied_at: day(-1) }), NOW)).toBe(false);
  });

  it('“open” means sent or signed — a lapsed link is not open', () => {
    expect(isOpen(env(), NOW)).toBe(true);
    expect(isOpen(env({ status: 'signed' }), NOW)).toBe(true);
    expect(isOpen(env({ expires_at: day(-1) }), NOW)).toBe(false);
    expect(isOpen(env({ status: 'executed' }), NOW)).toBe(false);
  });
});

describe('what the landlord can still do', () => {
  it('void is offered only before anyone has signed', () => {
    expect(canVoid(env(), NOW)).toBe(true);
    // Voiding after a signature would destroy the record of something that happened.
    expect(canVoid(env({ status: 'signed' }), NOW)).toBe(false);
    expect(canVoid(env({ expires_at: day(-1) }), NOW)).toBe(false);
  });

  it('resend covers BOTH a live link and a lapsed one', () => {
    expect(canResend(env(), NOW)).toBe(true);
    // The fix for an expired link is a new one — which is exactly what resend mints.
    expect(canResend(env({ expires_at: day(-1) }), NOW)).toBe(true);
    expect(canResend(env({ status: 'signed' }), NOW)).toBe(false);
    expect(canResend(env({ status: 'executed' }), NOW)).toBe(false);
  });
});

describe('what the row says', () => {
  it('counts down in days, and goes negative once past', () => {
    expect(daysToExpiry(env({ expires_at: day(3) }), NOW)).toBe(3);
    expect(daysToExpiry(env({ expires_at: day(-3) }), NOW)).toBe(-3);
    expect(daysToExpiry(env({ expires_at: null }), NOW)).toBe(null);
  });

  it('turns an imminent expiry into a prompt, not a bare date', () => {
    expect(envelopeLine(env({ expires_at: day(2) }), NOW)).toContain('expires in 2 days');
    expect(envelopeLine(env({ expires_at: day(1) }), NOW)).toContain('expires tomorrow');
    // Far out, a date is more useful than a large number of days.
    expect(envelopeLine(env({ expires_at: day(40) }), NOW)).not.toContain('expires in');
  });

  it('names the tenant in every state', () => {
    expect(envelopeLine(env(), NOW)).toContain('Sam Rivera');
    expect(envelopeLine(env({ status: 'signed', signed_at: day(-1) }), NOW)).toContain('Sam Rivera');
    expect(envelopeLine(env({ expires_at: day(-1) }), NOW)).toContain('Sam Rivera');
  });

  it('falls back to “the tenant” rather than printing nothing', () => {
    expect(envelopeLine(env({ signer_name: null }), NOW)).toContain('the tenant');
  });

  it('a signed envelope says the ball is in the landlord’s court', () => {
    expect(envelopeLine(env({ status: 'signed', signed_at: day(-1) }), NOW))
      .toContain('waiting on your signature');
  });
});

describe('badges', () => {
  it('a signed envelope is a WARN — it is work sitting undone', () => {
    expect(statusBadge(env({ status: 'signed' }), NOW).cls).toBe('warn');
    expect(statusBadge(env({ status: 'signed' }), NOW).label).toMatch(/countersign/i);
  });

  it('executed is the only good one', () => {
    expect(statusBadge(env({ status: 'executed' }), NOW).cls).toBe('good');
  });

  it('an expired link is badged from the DERIVED state, not the stored one', () => {
    const badge = statusBadge(env({ expires_at: day(-1) }), NOW);
    expect(badge.label).toBe('Expired');
  });
});

describe('ordering and helpers', () => {
  it('newest first — the opposite of the riders list below it', () => {
    const list = [env({ id: 'a', sent_at: day(-10) }), env({ id: 'b', sent_at: day(-1) }), env({ id: 'c', sent_at: day(-5) })];
    expect(sortEnvelopes(list).map((e) => e.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the array it was given', () => {
    const list = [env({ id: 'a', sent_at: day(-1) }), env({ id: 'b', sent_at: day(-9) })];
    sortEnvelopes(list);
    expect(list.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('expiryFromNow lands the requested number of days out', () => {
    const iso = expiryFromNow(30, new Date(NOW));
    expect(Math.round((new Date(iso).getTime() - NOW) / 86400000)).toBe(30);
  });

  it('a nonsense expiry falls back to the default rather than an invalid date', () => {
    const iso = expiryFromNow(undefined, new Date(NOW));
    expect(Math.round((new Date(iso).getTime() - NOW) / 86400000)).toBe(DEFAULT_EXPIRY_DAYS);
  });

  it('the default expiry is one of the offered choices', () => {
    expect(EXPIRY_CHOICES.some((c) => c.days === DEFAULT_EXPIRY_DAYS)).toBe(true);
  });

  it('every purpose has a label, and an unknown one still reads as something', () => {
    PURPOSE.forEach((p) => expect(purposeLabel(p.key)).toBe(p.label));
    expect(purposeLabel('nonsense')).toBe('Document');
  });
});
