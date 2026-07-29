// The "Insurance not received" reminder's ✉ — the follow-up letter, and the wiring that
// makes the button exist at all.
//
// Two things had to be true and weren't: the reminder carried no ✉ (draftAlertEmail built
// one, but the page's alertCanEmail never returned true for insurance_chase, so it could
// never render — the gap flagged in CLAUDE.md on 2026-07-26); and re-sending the FIRST
// letter would have read as though we'd forgotten we already asked.
import { describe, it, expect } from 'vitest';
import { buildInsuranceSecondRequestEmail, buildInsuranceRenewalRequestEmail } from '../emailTemplates';

const ARGS = {
  business: { company_name: 'Acme Holdings', contact_email: 'office@acme.example' },
  tenant_name: 'Bright Coffee Co.',
  contact_name: 'Sam Rivera',
  tenant_email: 'sam@brightcoffee.example',
  propertyName: 'Maple Plaza',
  insurer: 'Harbor Casualty',
  expiryDate: '2026-06-30',
  expired: true,
  requestedDate: '2026-06-15',
};

describe('buildInsuranceSecondRequestEmail', () => {
  it('says plainly that this is the second request, and when the first went out', () => {
    const { subject, body, to } = buildInsuranceSecondRequestEmail(ARGS);
    expect(subject).toBe('Second Request — Certificate of Insurance — Maple Plaza');
    expect(to).toBe('sam@brightcoffee.example');
    expect(body).toContain('This is our second request.');
    expect(body).toContain('June 15, 2026');          // the date of the first ask
    expect(body).toContain('second request');
  });

  it('asks courteously — the likeliest explanation is an oversight, not a refusal', () => {
    const { body } = buildInsuranceSecondRequestEmail(ARGS);
    expect(body).toContain('kindly ask');
    expect(body).toContain('disregard this note');    // the "it may have crossed" out
    expect(body).toContain('naming Acme Holdings as an additional insured');
    // States the lease obligation as a fact, never a threat: nothing in the app knows what
    // this lease actually provides for, so it must not imply a penalty or a deadline.
    expect(body).toContain('coverage be maintained continuously');
    expect(body).not.toMatch(/default|breach|terminate|penalt|legal action|within \d+ days/i);
  });

  it('names the certificate on file when there is one', () => {
    const { body } = buildInsuranceSecondRequestEmail(ARGS);
    expect(body).toContain('with Harbor Casualty');
    expect(body).toContain('which expired June 30, 2026');
  });

  it('degrades with no insurer, expiry, request date or business on file', () => {
    const { subject, body } = buildInsuranceSecondRequestEmail({
      tenant_name: 'Bright Coffee Co.', tenant_email: 'sam@brightcoffee.example', propertyName: 'Maple Plaza',
    });
    expect(subject).toBe('Second Request — Certificate of Insurance — Maple Plaza');
    expect(body).toContain('This is our second request.');
    expect(body).toContain('naming the landlord as an additional insured');
    expect(body).not.toContain('undefined');
    expect(body).not.toContain('null');
  });

  it('is a different letter from the first request, not a resend', () => {
    const second = buildInsuranceSecondRequestEmail(ARGS).body;
    const first = buildInsuranceRenewalRequestEmail(ARGS).body;
    expect(second).not.toBe(first);
    expect(first).not.toContain('second request');
  });

  it('carries the full letter scaffold, so it is indistinguishable from a hand-written one', () => {
    const { body } = buildInsuranceSecondRequestEmail(ARGS);
    expect(body).toContain('Acme Holdings');                      // letterhead
    expect(body).toContain('RE: Certificate of insurance for Maple Plaza — second request');
    expect(body).toContain('Dear Sam Rivera,');
  });
});
