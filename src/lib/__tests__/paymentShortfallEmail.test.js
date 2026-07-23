// The rent-shortfall letter (drafted when a bank statement's deposit comes in below the
// scheduled rent — most often a rent adjustment the tenant hasn't picked up). Generated
// in code, no AI. Verifies the letterhead, the figures, the month label, the escalation
// mention, and that it addresses the tenant's own email.
import { describe, it, expect } from 'vitest';
import { buildPaymentShortfallEmail } from '../emailTemplates';

const business = { company_name: 'Amlak Holdings, LLC', address: '1 Main St, Chicago, IL', contact_email: 'owner@amlak.com', contact_phone: '555-1000' };

describe('buildPaymentShortfallEmail', () => {
  const email = buildPaymentShortfallEmail({
    business,
    tenant_name: 'City Dental, PC',
    contact_name: 'Dr. Ahmed Hegazy',
    tenant_email: 'dental@example.com',
    propertyName: 'Maple Plaza',
    monthLabel: 'March 2026',
    scheduled: 9150,
    received: 8000,
    shortfall: 1150,
    paidDate: '2026-03-04',
  });

  it('addresses the tenant and carries the letterhead', () => {
    expect(email.to).toBe('dental@example.com');
    expect(email.body).toContain('Amlak Holdings, LLC');
    expect(email.body).toContain('Dear Dr. Ahmed Hegazy,');
    expect(email.subject).toContain('Maple Plaza');
    expect(email.subject).toContain('March 2026');
  });

  it('states the received / scheduled / shortfall figures and the month', () => {
    expect(email.body).toContain('$8,000.00'); // received
    expect(email.body).toContain('$9,150.00'); // scheduled
    expect(email.body).toContain('$1,150.00'); // shortfall
    expect(email.body).toContain('March 2026');
  });

  it('explains it is most often a scheduled rent adjustment (escalation)', () => {
    expect(email.body.toLowerCase()).toContain('escalation');
  });

  it('derives the shortfall when not passed explicitly', () => {
    const e = buildPaymentShortfallEmail({ business, tenant_name: 'Acme', tenant_email: 'a@b.com', propertyName: 'Plaza', monthLabel: 'May 2026', scheduled: 5000, received: 4200 });
    expect(e.body).toContain('$800.00'); // 5,000 − 4,200
  });
});
