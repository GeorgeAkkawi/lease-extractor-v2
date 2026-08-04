import { announcementValues, fill, fromTemplate, tokenize, toTemplate } from '../announcementTokens';
import { buildAnnouncementEmail, letterDate } from '../emailTemplates';

// The whole point of a saved announcement is that reusing it next winter goes out dated
// THIS winter, naming THIS property, signed with whatever the business is called now.
// These tests pin the round trip that makes that true.

const business = {
  company_name: 'Akkawi Properties LLC',
  address: '1 Main Street, Springfield',
  contact_email: 'office@akkawi.example',
  contact_phone: '555-0100',
};

describe('announcement token round trip', () => {
  test('a rendered letter tokenizes and fills back to itself', () => {
    const { body } = buildAnnouncementEmail({
      business,
      propertyName: 'Maple Plaza',
      subject: 'Parking Lot Resurfacing',
      bodyProse: 'Dear Tenants,\n\nThe lot at Maple Plaza will be resurfaced.\n\nPlease contact the office.',
    });

    const stored = toTemplate({ text: body, business, propertyName: 'Maple Plaza' });
    expect(stored).toContain('{date}');
    expect(stored).toContain('{property}');
    expect(stored).toContain('{business}');
    // The volatile values are gone from what we persist.
    expect(stored).not.toContain('Maple Plaza');
    expect(stored).not.toContain('Akkawi Properties LLC');

    expect(fromTemplate({ text: stored, business, propertyName: 'Maple Plaza' })).toBe(body);
  });

  test('a template saved last year re-stamps today’s date', () => {
    const stored = 'Notice dated {date} for {property}.';
    const out = fill(stored, announcementValues({ business, propertyName: 'Oak Center' }));
    expect(out).toBe(`Notice dated ${letterDate()} for Oak Center.`);
    expect(out).not.toContain('{date}');
  });

  test('the same template serves a different property', () => {
    const stored = toTemplate({
      text: 'To all tenants of Maple Plaza — signed, Akkawi Properties LLC',
      business,
      propertyName: 'Maple Plaza',
    });
    expect(fromTemplate({ text: stored, business, propertyName: 'Oak Center' }))
      .toBe('To all tenants of Oak Center — signed, Akkawi Properties LLC');
  });

  test('a renamed business flows through to an old template', () => {
    const stored = toTemplate({ text: 'Signed, Akkawi Properties LLC', business, propertyName: 'Maple Plaza' });
    const renamed = { ...business, company_name: 'Akkawi Real Estate' };
    expect(fromTemplate({ text: stored, business: renamed, propertyName: 'Maple Plaza' }))
      .toBe('Signed, Akkawi Real Estate');
  });

  test('the business name is tokenized before the property, so an overlapping name survives', () => {
    // Property "Maple Plaza" is a substring of business "Maple Plaza Holdings LLC".
    const overlapping = { ...business, company_name: 'Maple Plaza Holdings LLC' };
    const stored = toTemplate({
      text: 'Maple Plaza Holdings LLC manages Maple Plaza.',
      business: overlapping,
      propertyName: 'Maple Plaza',
    });
    expect(stored).toBe('{business} manages {property}.');
    expect(fromTemplate({ text: stored, business: overlapping, propertyName: 'Maple Plaza' }))
      .toBe('Maple Plaza Holdings LLC manages Maple Plaza.');
  });

  test('text with nothing to substitute is returned untouched', () => {
    const text = 'A plain sentence with no volatile facts in it.';
    expect(toTemplate({ text, business, propertyName: 'Maple Plaza' })).toBe(text);
  });

  test('a value under three characters is left alone rather than corrupting prose', () => {
    // A business initialled "AC" must not tokenize the "AC" inside "HVAC".
    const tiny = { ...business, company_name: 'AC' };
    expect(tokenize('The HVAC contract', announcementValues({ business: tiny, propertyName: 'Maple Plaza' })))
      .toBe('The HVAC contract');
  });

  test('a missing property name fills to a readable fallback, never a bare token', () => {
    const out = fill('Notice for {property} from {business}.', announcementValues({ business: null, propertyName: '' }));
    expect(out).toBe('Notice for the property from Property Management.');
    expect(out).not.toContain('{');
  });
});

describe('buildAnnouncementEmail', () => {
  test('the To block is generic — no tenant name, contact or email anywhere', () => {
    const { body } = buildAnnouncementEmail({
      business,
      propertyName: 'Maple Plaza',
      subject: 'Holiday Hours',
      bodyProse: 'Dear Tenants,\n\nThe office closes early on the 24th.',
    });
    expect(body).toContain('All Tenants');
    expect(body).toContain('Maple Plaza');
    expect(body).toContain('RE: Holiday Hours');
    expect(body).toContain('Sincerely,');
    expect(body).toContain('Akkawi Properties LLC');
    // Nothing tenant-specific may reach a letter sent to every tenant at once. Note this
    // checks the ADDRESSING, not the word "suite" — a landlord's own letterhead address
    // legitimately contains "Suite 500", and asserting on the bare word would fail on that.
    expect(body).not.toMatch(/Tenant at /);          // the per-tenant To block never appears
    expect(body).not.toMatch(/Dear (?!Tenants)/);    // never addressed to one named tenant
    expect(body).not.toMatch(/base rent|balance|square feet/i);
  });

  test('a model that signs off anyway does not produce two signatures', () => {
    const { body } = buildAnnouncementEmail({
      business,
      propertyName: 'Maple Plaza',
      subject: 'Notice',
      bodyProse: 'Dear Tenants,\n\nThe lot closes Monday.\n\nSincerely,\nThe Management',
    });
    expect(body.match(/Sincerely,/g)).toHaveLength(1);
    expect(body).not.toContain('The Management');
  });

  test('an empty subject falls back to something sendable', () => {
    const { subject } = buildAnnouncementEmail({ business, propertyName: 'Maple Plaza', subject: '', bodyProse: 'Dear Tenants,' });
    expect(subject).toBe('Notice to tenants — Maple Plaza');
  });
});
