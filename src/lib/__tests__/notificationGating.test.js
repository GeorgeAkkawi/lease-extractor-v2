// Token-free tests for the Settings-synced notification gating and the new
// expiry-focused alerts/letters:
//   • buildAlerts silences insurance / contract / receivables categories when the
//     matching Settings toggle is off, and never gates core lease dates.
//   • the free-rent-ending + holdover + insurance-chase-up alerts.
//   • the "please send the renewed certificate" letter wording.
//   • the Ask-Amlak snapshot omits a hidden module's facts + folds the feature set
//     into the cache fingerprint.
import { buildAlerts } from '../alerts';
import { buildInsuranceRenewalRequestEmail } from '../emailTemplates';
import { buildPortfolioSnapshot, snapshotToText, snapshotFingerprint } from '../portfolio';

const NOW = new Date('2026-01-15T12:00:00');
const props = [{ id: 'p1', corporation_id: 'corp1', name: 'Plaza' }];

// A data bundle exercising every gated category at once.
function fullData() {
  return {
    leases: [{ id: 'L1', tenant_name: 'Acme', property_id: 'p1', lease_termination_date: '2026-04-01', is_active: true }],
    escalations: [{ lease_id: 'L1', effective_date: '2026-02-01', status: 'scheduled' }],
    renewals: [],
    properties: props,
    insurance: [
      { party: 'tenant', lease_id: 'L1', property_id: 'p1', insurer: 'Harbor', expiry_date: '2026-02-10' },
      { party: 'landlord', property_id: 'p1', insurer: 'Granite', expiry_date: '2026-02-20' },
    ],
    contracts: [{ id: 'c1', name: 'Landscaping', vendor: 'GreenCo', vendor_email: 'g@x.com', end_date: '2026-03-01', property_id: 'p1' }],
    invoices: [{ lease_id: 'L1', property_id: 'p1', year: 2025, due_date: '2025-12-01', balance: 1500 }],
    abatements: [{ lease_id: 'L1', start_date: '2025-11-01', end_date: '2026-02-01', kind: 'free' }],
    insuranceRequests: [],
  };
}
const focuses = (out) => out.map((a) => a.focus);

describe('buildAlerts — Settings gating', () => {
  test('with everything on, every category fires', () => {
    const out = buildAlerts(fullData(), undefined, NOW); // no opts → all on
    const f = focuses(out);
    expect(f).toContain('escalation');
    expect(f).toContain('insurance');
    expect(f).toContain('contract');
    expect(f).toContain('invoice');
    expect(f).toContain('abatement');
  });

  test('Insurance module off silences ONLY insurance alerts', () => {
    const out = buildAlerts(fullData(), undefined, NOW, { features: ['contracts'], hiddenWidgets: [] });
    const f = focuses(out);
    expect(f).not.toContain('insurance');
    expect(f).toContain('contract');   // still on
    expect(f).toContain('invoice');    // ar not hidden
    expect(f).toContain('escalation'); // core — never gated
  });

  test('Service-contracts module off silences ONLY contract alerts', () => {
    const out = buildAlerts(fullData(), undefined, NOW, { features: ['insurance'], hiddenWidgets: [] });
    const f = focuses(out);
    expect(f).not.toContain('contract');
    expect(f).toContain('insurance');
    expect(f).toContain('escalation');
  });

  test('receivables (ar) hidden silences overdue-invoice AND free-rent alerts', () => {
    const out = buildAlerts(fullData(), undefined, NOW, { features: null, hiddenWidgets: ['ar'] });
    const f = focuses(out);
    expect(f).not.toContain('invoice');
    expect(f).not.toContain('abatement');
    expect(f).toContain('insurance'); // features null → still on
    expect(f).toContain('contract');
    expect(f).toContain('escalation');
  });

  test('empty enabled_features array = everything off silences insurance + contracts', () => {
    const out = buildAlerts(fullData(), undefined, NOW, { features: [], hiddenWidgets: [] });
    const f = focuses(out);
    expect(f).not.toContain('insurance');
    expect(f).not.toContain('contract');
    expect(f).toContain('escalation'); // core still fires
  });
});

describe('buildAlerts — new expiry-focused alerts', () => {
  test('a free-rent window ending within a month raises a calm "Free rent ending" alert', () => {
    const out = buildAlerts(fullData(), undefined, NOW);
    const a = out.find((x) => x.focus === 'abatement');
    expect(a).toBeTruthy();
    expect(a.title).toMatch(/Free rent ending — Acme/);
    expect(a.detail).toMatch(/full billing resumes/);
    expect(a.tone).toBe('info'); // 17 days out → calm, not red
  });

  test('a still-active lease past its term end reads as HOLDOVER, not a generic overdue', () => {
    const data = {
      ...fullData(),
      leases: [{ id: 'L1', tenant_name: 'Acme', property_id: 'p1', lease_termination_date: '2026-01-01', is_active: true }],
      escalations: [], abatements: [], invoices: [], insurance: [], contracts: [], insuranceRequests: [],
    };
    const t = buildAlerts(data, undefined, NOW).find((x) => x.focus === 'termination');
    expect(t.holdover).toBe(true);
    expect(t.title).toMatch(/holdover/i);
    expect(t.bucketLabel).toBe('Holdover');
    expect(t.tone).toBe('danger');
  });

  test('an insurance request 21+ days old with no response raises a chase-up (gated by Insurance)', () => {
    const data = {
      leases: [{ id: 'L1', tenant_name: 'Acme', property_id: 'p1', is_active: true }],
      escalations: [], renewals: [], properties: props,
      insurance: [], contracts: [], invoices: [], abatements: [],
      insuranceRequests: [{ lease_id: 'L1', event_date: '2025-12-01' }], // ~45 days before NOW
    };
    const on = buildAlerts(data, undefined, NOW).find((x) => x.focus === 'insurance_chase');
    expect(on).toBeTruthy();
    expect(on.title).toMatch(/Insurance not received — Acme/);

    // Insurance module off → the chase-up is silenced too.
    const off = buildAlerts(data, undefined, NOW, { features: [], hiddenWidgets: [] });
    expect(off.some((x) => x.focus === 'insurance_chase')).toBe(false);
  });

  test('no chase-up when a policy was saved AFTER the request, or the request is recent', () => {
    const base = {
      leases: [{ id: 'L1', tenant_name: 'Acme', property_id: 'p1', is_active: true }],
      escalations: [], renewals: [], properties: props, contracts: [], invoices: [], abatements: [],
    };
    // Policy updated after the request → the tenant responded.
    const responded = buildAlerts({
      ...base,
      insurance: [{ party: 'tenant', lease_id: 'L1', updated_at: '2025-12-20T00:00:00Z' }],
      insuranceRequests: [{ lease_id: 'L1', event_date: '2025-12-01' }],
    }, undefined, NOW);
    expect(responded.some((x) => x.focus === 'insurance_chase')).toBe(false);

    // Request only 5 days ago → still waiting, no nag yet.
    const recent = buildAlerts({
      ...base, insurance: [],
      insuranceRequests: [{ lease_id: 'L1', event_date: '2026-01-10' }],
    }, undefined, NOW);
    expect(recent.some((x) => x.focus === 'insurance_chase')).toBe(false);
  });

  test('the tenant insurance-expiry alert carries insurer/expiry/expired for its ✉', () => {
    const a = buildAlerts(fullData(), undefined, NOW).find((x) => x.focus === 'insurance' && x.lease_id);
    expect(a.insurer).toBe('Harbor');
    expect(a.expiry_date).toBe('2026-02-10');
    expect(a.expired).toBe(false);
  });
});

describe('buildInsuranceRenewalRequestEmail', () => {
  const business = { company_name: 'Acme Holdings LLC', contact_email: 'leasing@acme.example' };
  const common = { business, tenant_name: 'Bright Coffee Co.', contact_name: 'Sam', tenant_email: 't@x.com', propertyName: 'Maple Plaza' };

  test('an EXPIRED policy → "expired on" wording + Expired subject, naming the insurer', () => {
    const e = buildInsuranceRenewalRequestEmail({ ...common, insurer: 'Harbor Casualty', expiryDate: '2025-12-01', expired: true });
    expect(e.subject).toMatch(/^Expired Certificate of Insurance/);
    expect(e.body).toMatch(/expired on/);
    expect(e.body).toMatch(/Harbor Casualty/);
    expect(e.body).toMatch(/additional insured/i);
    expect(e.to).toBe('t@x.com');
  });

  test('a still-current policy → neutral "updated copy" wording, coverage-through date, no alarm', () => {
    const e = buildInsuranceRenewalRequestEmail({ ...common, insurer: 'Harbor Casualty', expiryDate: '2030-12-01', expired: false });
    expect(e.subject).toMatch(/updated copy requested/i);
    expect(e.body).toMatch(/coverage through/);
    expect(e.body).toMatch(/most recent certificate/);
    expect(e.body).not.toMatch(/expired/i); // never say "expired" for a current policy
  });
});

describe('portfolio snapshot — Ask Amlak gating', () => {
  const inputs = {
    corporations: [{ id: 'c1', name: 'Acme' }],
    properties: [{ id: 'p1', corporation_id: 'c1', name: 'Plaza' }],
    leases: [{ id: 'L1', tenant_name: 'Acme Tenant', property_id: 'p1', base_rent: 60000, is_active: true }],
    insurance: [{ party: 'tenant', lease_id: 'L1', insurer: 'Harbor', expiry_date: '2026-02-10' }],
    contracts: [{ property_id: 'p1', service_type: 'landscaping', vendor: 'GreenCo', end_date: '2026-06-01' }],
    renewals: [], balances: [], today: '2026-01-15',
  };

  test('with all modules on, the summary text mentions insurance and contracts', () => {
    const text = snapshotToText(buildPortfolioSnapshot({ ...inputs, features: null }));
    expect(text).toMatch(/Insurance:/);
    expect(text).toMatch(/Service contracts:/);
    expect(text).toMatch(/Harbor/);
  });

  test('Insurance off → the summary text carries NO insurance facts at all', () => {
    const snap = buildPortfolioSnapshot({ ...inputs, features: ['contracts'] });
    expect(snap.insurance_shown).toBe(false);
    const text = snapshotToText(snap);
    expect(text).not.toMatch(/Insurance/);
    expect(text).not.toMatch(/Harbor/);
    expect(text).toMatch(/Service contracts:/); // contracts still shown
  });

  test('Contracts off → the summary text carries NO contract facts', () => {
    const snap = buildPortfolioSnapshot({ ...inputs, features: ['insurance'] });
    expect(snap.contracts_shown).toBe(false);
    const text = snapshotToText(snap);
    expect(text).not.toMatch(/Service contracts/);
    expect(text).toMatch(/Insurance:/);
  });

  test('the fingerprint folds in the enabled set, so a toggle invalidates cached answers', () => {
    const all = snapshotFingerprint({ leases: inputs.leases, features: null });
    const noIns = snapshotFingerprint({ leases: inputs.leases, features: ['contracts'] });
    const noCon = snapshotFingerprint({ leases: inputs.leases, features: ['insurance'] });
    expect(all).not.toBe(noIns);
    expect(all).not.toBe(noCon);
    expect(noIns).not.toBe(noCon);
  });
});
