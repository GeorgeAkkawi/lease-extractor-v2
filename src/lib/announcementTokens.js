// Saved announcements have to survive being reused. A notice written in November and sent
// again the following November must go out dated THIS year, naming THIS property, signed
// with whatever the business is called today — otherwise "save as a template" quietly
// becomes "keep a copy of a stale letter".
//
// The mechanism is deliberately dumb and deterministic: on SAVE, swap the literal values
// out for tokens; on LOAD, swap today's values back in. No AI, no cost, no round trip, and
// the same input always produces the same output — which is what makes it testable and
// what makes it safe to run on every template open.
//
// (The "↻ Rewrite with AI" button in the announcements window is the other half of what
// George asked for: this keeps the FACTS current for free, that regenerates the WORDING
// for ~1–2¢ when he actually wants different prose.)

import { letterDate } from './emailTemplates';

// Order matters. Longest / most specific first, so a business called "Maple Plaza LLC" is
// tokenized whole before the property "Maple Plaza" can match inside it.
const FIELDS = ['date', 'contact', 'address', 'business', 'property'];

const TOKEN = {
  date: '{date}',
  contact: '{business_contact}',
  address: '{business_address}',
  business: '{business}',
  property: '{property}',
};

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A value shorter than this is too likely to appear by accident inside ordinary prose —
// a business initialled "AC" would tokenize the "AC" in "HVAC". Skip those rather than
// corrupt the letter; the worst case is one field that doesn't auto-refresh.
const MIN_SUBSTITUTABLE = 3;

// The values a letter carries that must be re-resolved every time it is opened. Built from
// the same business object the letter() scaffold uses, so the strings match exactly.
export function announcementValues({ business, propertyName, date }) {
  const contact = [business?.contact_email, business?.contact_phone].filter(Boolean).join(' · ');
  return {
    date: date || letterDate(),
    contact,
    address: business?.address || '',
    business: business?.company_name || '',
    property: propertyName || '',
  };
}

// SAVE side: the rendered letter → a template with tokens in place of the volatile bits.
export function tokenize(text, values) {
  let out = String(text ?? '');
  for (const field of FIELDS) {
    const value = String(values?.[field] ?? '').trim();
    if (value.length < MIN_SUBSTITUTABLE) continue;
    out = out.replaceAll(value, TOKEN[field]);
  }
  return out;
}

// LOAD side: a stored template → a letter carrying today's date and this property's facts.
// A token with no value collapses to a readable fallback rather than leaving "{property}"
// visible in something about to be emailed to tenants.
const FALLBACK = { date: '', contact: '', address: '', business: 'Property Management', property: 'the property' };

export function fill(text, values) {
  let out = String(text ?? '');
  for (const field of FIELDS) {
    const raw = String(values?.[field] ?? '').trim();
    const value = raw || FALLBACK[field];
    out = out.replaceAll(TOKEN[field], value);
  }
  // An empty address / contact line leaves a blank line behind in the letterhead. Collapse
  // runs of three-plus newlines so the letter doesn't open with a gap.
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

// Convenience for the two call sites in PropertyAnnouncementsModal.
export const toTemplate = ({ text, business, propertyName }) =>
  tokenize(text, announcementValues({ business, propertyName }));

export const fromTemplate = ({ text, business, propertyName }) =>
  fill(text, announcementValues({ business, propertyName }));
