// Proves the lease AI assistant is FED the right context: the app-computed current
// phase, the original lease text, and every amendment. The ask-lease edge function then
// reasons over this string — so if it's assembled correctly, the assistant can answer
// about both the original terms and the current phase. Pure function, no backend.
import { buildLeaseAskContext } from '../leaseContext';

test('buildLeaseAskContext includes current phase, original lease, and amendments', () => {
  const lease = {
    tenant_name: 'D & D Dental, LLC',
    tenant_contact_name: 'Dr. Ahmed Hegazy',
    lease_start: '2021-10-01',
    lease_termination_date: '2026-09-30',
    base_rent: 47436,
    lease_text: 'ORIGINAL STORE LEASE — base rent $18/SF, term Oct 2001 to Sep 2011.',
  };
  const renewals = [
    { option_label: 'Option to Renew (5 yrs)', term_months: 60, annual_escalation_pct: 5, new_rent: null, notice_by_date: null, status: 'pending' },
  ];
  const addendums = [
    { label: 'Second Lease Extension', amendment_date: '2021-01-18', kind: 'extension', summary: 'Extends to 2026; adds a 5-yr option', addendum_text: 'Monthly BASE rent Oct 2024 at $22/SF.' },
  ];

  const ctx = buildLeaseAskContext({ lease, renewals, addendums });

  // current phase (authoritative "now")
  expect(ctx).toContain('CURRENT PHASE');
  expect(ctx).toContain('D & D Dental, LLC');
  expect(ctx).toContain('2026');            // committed term end
  expect(ctx).toContain('$47,436');         // current base rent
  // pending option is flagged as NOT yet exercised
  expect(ctx).toMatch(/pending|NOT yet exercised/i);
  // original lease text carried through
  expect(ctx).toContain('ORIGINAL LEASE');
  expect(ctx).toContain('ORIGINAL STORE LEASE');
  // amendments carried through
  expect(ctx).toContain('AMENDMENTS');
  expect(ctx).toContain('Second Lease Extension');
  expect(ctx).toContain('$22/SF');
});

test('buildLeaseAskContext is safe with no amendments or renewals', () => {
  const ctx = buildLeaseAskContext({ lease: { tenant_name: 'Acme', lease_text: 'base terms' }, renewals: [], addendums: [] });
  expect(ctx).toContain('None pending.');
  expect(ctx).toContain('None on record.');
  expect(ctx).toContain('base terms');
});
