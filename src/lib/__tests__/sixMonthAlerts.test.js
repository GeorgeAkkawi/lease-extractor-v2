// Token-free tests for the 6-month notification horizon, contract-expiry alerts, the
// per-reminder email drafts, and the escalation gating that keeps un-exercised option
// steps out of the alert feed. Pure alerts.js where possible; DEMO client for draftAlertEmail.

import { DEMO_MODE } from '../supabaseClient';
import { bucket, buildAlerts, alertKey } from '../alerts';
import {
  createCorporation, createProperty, createLease, createRenewal,
  addServiceContract, draftAlertEmail, promptDueRenewalDecisions,
} from '../api';

beforeAll(() => { expect(DEMO_MODE).toBe(true); });

const NOW = new Date('2026-01-15T12:00:00');

describe('bucket() 3- and 6-month bands', () => {
  test('within-1-month stays urgent; 3m/6m are the new far bands; beyond 6m is nothing', () => {
    expect(bucket('2026-02-05', NOW).key).toBe('1m');     // ~21 days
    expect(bucket('2026-04-01', NOW).key).toBe('3m');     // ~76 days
    expect(bucket('2026-04-01', NOW).tone).toBe('warn');
    expect(bucket('2026-06-01', NOW).key).toBe('6m');     // ~137 days
    expect(bucket('2026-06-01', NOW).tone).toBe('info');  // calm, not red
    expect(bucket('2026-09-01', NOW)).toBe(null);         // ~229 days → off the radar
  });
});

describe('buildAlerts', () => {
  test('surfaces a contract expiry within 6 months, keyed by the contract id', () => {
    const out = buildAlerts({
      leases: [], escalations: [], renewals: [], insurance: [],
      properties: [{ id: 'p1', corporation_id: 'corp1', name: 'Plaza' }],
      contracts: [{ id: 'c1', name: 'Landscaping', vendor: 'GreenCo', vendor_email: 'g@x.com', end_date: '2026-04-01', property_id: 'p1' }],
    }, undefined, NOW);
    const c = out.find((a) => a.focus === 'contract');
    expect(c).toBeTruthy();
    expect(c.contract_name).toBe('Landscaping');
    expect(c.bucketLabel).toBe('Within 3 months');
    expect(c.vendor_email).toBe('g@x.com');
    expect(alertKey(c)).toBe('contract:c1:2026-04-01');
  });

  test('a DECLINED renewal option still triggers the red "no renewal" lease-ending alert', () => {
    const lease = { id: 'L1', tenant_name: 'Tenant', property_id: 'p1', lease_termination_date: '2026-04-01', is_active: true };
    const base = { leases: [lease], escalations: [], insurance: [], contracts: [], properties: [{ id: 'p1', corporation_id: 'corp1' }] };

    // Declined → the tenant said no → this is genuinely "ending, no renewal" → red.
    const declined = buildAlerts({ ...base, renewals: [{ id: 'R1', lease_id: 'L1', status: 'declined' }] }, undefined, NOW);
    const dTerm = declined.find((a) => a.focus === 'termination');
    expect(dTerm.noRenewal).toBe(true);
    expect(dTerm.tone).toBe('danger');
    expect(dTerm.title).toMatch(/no renewal/i);

    // Pending → a live option is still on the table → soften to a plain "lease ending".
    const pending = buildAlerts({ ...base, renewals: [{ id: 'R2', lease_id: 'L1', status: 'pending' }] }, undefined, NOW);
    const pTerm = pending.find((a) => a.focus === 'termination');
    expect(pTerm.noRenewal).toBe(false);
    expect(pTerm.title).not.toMatch(/no renewal/i);
  });

  test('escalation steps dated on/after the committed term end are gated out of alerts', () => {
    const lease = { id: 'L1', tenant_name: 'Tenant', property_id: 'p1', lease_termination_date: '2026-03-01', is_active: true };
    const out = buildAlerts({
      leases: [lease],
      escalations: [
        { lease_id: 'L1', effective_date: '2026-02-01', status: 'scheduled' }, // in-term → alert
        { lease_id: 'L1', effective_date: '2026-03-01', status: 'scheduled' }, // == term end → belongs to an option → gated
      ],
      renewals: [], insurance: [], contracts: [],
      properties: [{ id: 'p1', corporation_id: 'corp1' }],
    }, undefined, NOW);
    const escDates = out.filter((a) => a.focus === 'escalation').map((a) => a.date);
    expect(escDates).toContain('2026-02-01');
    expect(escDates).not.toContain('2026-03-01');
  });
});

describe('draftAlertEmail (DEMO)', () => {
  test('contract alert → vendor renewal letter addressed to the vendor email', async () => {
    const corp = await createCorporation('Vendor Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Vendor Plaza', address: 'X' });
    const contract = await addServiceContract({ property_id: prop.id, name: 'Snow removal', vendor: 'Arctic', vendor_email: 'ops@arctic.com', amount: 6000, frequency: 'annual', end_date: '2026-11-01' });
    const email = await draftAlertEmail({ focus: 'contract', contract_id: contract.id, property_id: prop.id, date: '2026-11-01' });
    expect(email).toBeTruthy();
    expect(email.email_to).toBe('ops@arctic.com');
    expect(email.email_subject).toMatch(/Service Contract Renewal/i);
    expect(email.email_body).toMatch(/Snow removal/);
  });

  test('termination alert → a lease-end notice; landlord-insurance alert → no email', async () => {
    const corp = await createCorporation('End Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'End Plaza', address: 'Y' });
    const lease = await createLease({ property_id: prop.id, tenant_name: 'Departing Tenant', tenant_email: 't@x.com', square_footage: 1000, base_rent: 20000, lease_start: '2021-01-01', lease_termination_date: '2026-12-31' });

    const term = await draftAlertEmail({ focus: 'termination', lease_id: lease.id, date: '2026-12-31' });
    expect(term.email_to).toBe('t@x.com');
    expect(term.email_subject).toMatch(/Lease Expiration/i);

    // Landlord's own building insurance has no lease/tenant → nothing to email.
    const none = await draftAlertEmail({ focus: 'insurance', lease_id: null, property_id: prop.id, date: '2026-12-31' });
    expect(none).toBe(null);
  });

  test('renewal-notice alert → the "approaching" tenant heads-up', async () => {
    const corp = await createCorporation('Ren Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Ren Plaza', address: 'Z' });
    const lease = await createLease({ property_id: prop.id, tenant_name: 'Renewing Tenant', tenant_email: 'r@x.com', square_footage: 1000, base_rent: 20000, lease_start: '2022-01-01', lease_termination_date: '2027-01-01' });
    const opt = await createRenewal({ lease_id: lease.id, option_label: 'Option 1', term_months: 60, new_rent: 22000, notice_by_date: '2026-07-01' });
    const email = await draftAlertEmail({ focus: 'renewal', renewal_id: opt.id, lease_id: lease.id, date: '2026-07-01' });
    expect(email).toBeTruthy();
    expect(email.email_subject).toMatch(/Upcoming Lease Renewal/i);
  });
});

describe('isRenewalDecisionDue at 6 months (via promptDueRenewalDecisions, DEMO)', () => {
  test('a lease ending ~5 months out (beyond the old 3-month window) now prompts a decision', async () => {
    const TODAY = new Date('2026-07-03T12:00:00');
    const corp = await createCorporation('SixMo Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'SixMo Plaza', address: 'W' });
    const lease = await createLease({ property_id: prop.id, tenant_name: 'SixMo Tenant', square_footage: 1000, base_rent: 20000, lease_start: '2021-12-03', lease_termination_date: '2026-12-03' });
    await createRenewal({ lease_id: lease.id, option_label: 'Option 1', term_months: 60, new_rent: 22000 }); // no notice_by_date → uses termEnd − 6mo

    const created = await promptDueRenewalDecisions(TODAY);
    expect(created.some((n) => n.lease_id === lease.id && n.kind === 'renewal_decision')).toBe(true);
  });
});
