// Additional-insured notice: the pure warn/quiet rule, the dismiss key that re-arms
// on a renewed certificate, and the "corrected certificate" letter.
import { describe, it, expect } from 'vitest';
import { missingAdditionalInsured, additionalInsuredAlertKey } from '../insuranceNotices';
import { buildAdditionalInsuredRequestEmail } from '../emailTemplates';

describe('missingAdditionalInsured', () => {
  it('warns on an explicit "No"', () => {
    expect(missingAdditionalInsured({ id: 'p1', additional_insured: false })).toBe(true);
  });
  it('warns when the document did not state it (null)', () => {
    expect(missingAdditionalInsured({ id: 'p1', additional_insured: null })).toBe(true);
  });
  it('stays quiet when the landlord IS named', () => {
    expect(missingAdditionalInsured({ id: 'p1', additional_insured: true })).toBe(false);
  });
  it('stays quiet with no policy on file', () => {
    expect(missingAdditionalInsured(null)).toBe(false);
    expect(missingAdditionalInsured(undefined)).toBe(false);
  });
});

describe('additionalInsuredAlertKey', () => {
  it('is stable for the same certificate', () => {
    const p = { id: 'pol-1', expiry_date: '2027-06-30' };
    expect(additionalInsuredAlertKey(p)).toBe(additionalInsuredAlertKey({ ...p }));
  });
  it('changes when the expiry changes — a renewed cert re-arms the pop-up', () => {
    const before = additionalInsuredAlertKey({ id: 'pol-1', expiry_date: '2026-06-30' });
    const after = additionalInsuredAlertKey({ id: 'pol-1', expiry_date: '2027-06-30' });
    expect(before).not.toBe(after);
  });
  it('handles a certificate with no expiry date', () => {
    expect(additionalInsuredAlertKey({ id: 'pol-1', expiry_date: null })).toBe('addins:pol-1:none');
  });
  it('keys per policy, so two tenants never collide', () => {
    expect(additionalInsuredAlertKey({ id: 'a', expiry_date: '2027-01-01' }))
      .not.toBe(additionalInsuredAlertKey({ id: 'b', expiry_date: '2027-01-01' }));
  });
});

describe('buildAdditionalInsuredRequestEmail', () => {
  const args = {
    business: { company_name: 'Acme Holdings', contact_email: 'leasing@acme.example' },
    tenant_name: 'Bright Coffee Co.',
    contact_name: 'Sam Rivera',
    tenant_email: 'sam@brightcoffee.example',
    propertyName: 'Maple Plaza',
    insurer: 'Harbor Casualty',
    expiryDate: '2027-06-30',
  };
  it('asks for the additional-insured endorsement by name', () => {
    const { subject, body, to } = buildAdditionalInsuredRequestEmail(args);
    expect(subject).toBe('Additional Insured Endorsement Needed — Maple Plaza');
    expect(to).toBe('sam@brightcoffee.example');
    expect(body).toContain('does not name Acme Holdings as an additional insured');
    expect(body).toContain('your policy with Harbor Casualty');
    expect(body).toContain('June 30, 2027');
    expect(body).toContain('naming Acme Holdings as an additional insured');
  });
  it('degrades gracefully with no insurer / expiry / business on file', () => {
    const { subject, body } = buildAdditionalInsuredRequestEmail({
      tenant_name: 'Bright Coffee Co.', tenant_email: 'sam@brightcoffee.example', propertyName: 'Maple Plaza',
    });
    expect(subject).toBe('Additional Insured Endorsement Needed — Maple Plaza');
    expect(body).toContain('the certificate of insurance on file');
    expect(body).toContain('does not name the landlord as an additional insured');
  });
});
