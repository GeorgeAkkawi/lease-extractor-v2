// The free per-property lease search + the expiring-soonest sort. Pure JS —
// no network, no AI. Replays the real use case: "which tenants must pay for
// the roof?" answered by scanning the cached lease/rider text for the word
// and surfacing the clause, so the landlord judges tenant-vs-landlord himself.
import {
  byTermEnd,
  searchLeases,
  normalizeQuestion,
  buildLeaseQuestion,
  leaseCorpusFingerprint,
  gatherAnswerContext,
} from '../leaseSearch';

const L = (over = {}) => ({
  id: 'x',
  tenant_name: 'Tenant',
  lease_text: null,
  lease_termination_date: null,
  ...over,
});

describe('byTermEnd — soonest term end first', () => {
  test('dated ascending, no-date leases last, no-date ties alphabetical', () => {
    const leases = [
      L({ id: 'z', tenant_name: 'Zeta', lease_termination_date: null }),
      L({ id: 'far', tenant_name: 'Ricki', lease_termination_date: '2031-05-01' }),
      L({ id: 'soon', tenant_name: 'Vibhakar', lease_termination_date: '2026-09-30' }),
      L({ id: 'a', tenant_name: 'Ace', lease_termination_date: null }),
    ];
    expect([...leases].sort(byTermEnd).map((l) => l.id)).toEqual(['soon', 'far', 'a', 'z']);
  });

  test('same end date falls back to tenant name', () => {
    const leases = [
      L({ id: 'b', tenant_name: 'Bravo', lease_termination_date: '2027-01-31' }),
      L({ id: 'a', tenant_name: 'Alpha', lease_termination_date: '2027-01-31' }),
    ];
    expect([...leases].sort(byTermEnd).map((l) => l.id)).toEqual(['a', 'b']);
  });
});

describe('searchLeases — free keyword scan of cached documents', () => {
  const roofTenant = L({
    id: 'r1',
    tenant_name: 'Wingstop',
    lease_termination_date: '2027-01-31',
    lease_text:
      'Section 8. REPAIRS. Tenant shall maintain and repair the roof membrane at its sole cost and expense. Rent is due monthly in advance.',
  });
  const noRoof = L({
    id: 'r2',
    tenant_name: 'Gzim Mila',
    lease_text: 'Landlord shall keep the structure and parking areas in good repair.',
  });
  const handEntered = L({ id: 'n1', tenant_name: 'Hand Entered' });

  test('finds only the leases that mention the word, with the clause as a snippet', () => {
    const { matches, unsearchable } = searchLeases('roof', [roofTenant, noRoof, handEntered]);
    expect(matches.map((m) => m.lease.id)).toEqual(['r1']);
    expect(matches[0].count).toBe(1);
    const s = matches[0].snippets[0];
    expect(`${s.before}${s.hit}${s.after}`).toContain('repair the roof membrane');
    expect(s.source).toBeNull(); // hit came from the lease itself, not a rider
    expect(unsearchable.map((l) => l.id)).toEqual(['n1']); // no document on file
  });

  test('case-insensitive', () => {
    const { matches } = searchLeases('ROOF', [roofTenant, noRoof]);
    expect(matches.map((m) => m.lease.id)).toEqual(['r1']);
  });

  test('multi-word query requires every word somewhere in the lease', () => {
    expect(searchLeases('roof rent', [roofTenant, noRoof]).matches.map((m) => m.lease.id)).toEqual(['r1']);
    expect(searchLeases('roof parking', [roofTenant, noRoof]).matches).toEqual([]);
  });

  test('tenant name is searchable material', () => {
    const { matches } = searchLeases('wingstop', [roofTenant, noRoof]);
    expect(matches.map((m) => m.lease.id)).toEqual(['r1']);
    expect(matches[0].count).toBe(1);
    expect(matches[0].snippets[0].source).toBe('tenant name');
  });

  test('rider text is searched and the hit carries the rider label', () => {
    const addendums = {
      r2: [{ id: 'a1', lease_id: 'r2', label: 'First Amendment', addendum_text: 'Tenant assumes roof maintenance from the Landlord.' }],
    };
    const { matches } = searchLeases('roof', [roofTenant, noRoof], addendums);
    expect(matches.map((m) => m.lease.id)).toEqual(['r1', 'r2']);
    const riderHit = matches.find((m) => m.lease.id === 'r2').snippets[0];
    expect(riderHit.source).toBe('First Amendment');
    expect(`${riderHit.before}${riderHit.hit}${riderHit.after}`).toContain('assumes roof maintenance');
  });

  test('snippets are capped per lease but the count keeps going', () => {
    const many = L({ id: 'm1', lease_text: Array.from({ length: 8 }, (_, i) => `Clause ${i}: the roof. ${'x'.repeat(200)}`).join('\n') });
    const { matches } = searchLeases('roof', [many]);
    expect(matches[0].snippets.length).toBe(3);
    expect(matches[0].count).toBe(8);
  });

  test('empty query matches nothing but still reports unsearchable leases', () => {
    const { matches, unsearchable } = searchLeases('  ', [roofTenant, handEntered]);
    expect(matches).toEqual([]);
    expect(unsearchable.map((l) => l.id)).toEqual(['n1']);
  });
});

describe('normalizeQuestion — one cache key per question', () => {
  test('lowercases, trims, collapses whitespace', () => {
    expect(normalizeQuestion('  Who   pays\tthe ROOF? ')).toBe('who pays the roof?');
    expect(normalizeQuestion(null)).toBe('');
  });
});

describe('buildLeaseQuestion — templates the term into a per-tenant question', () => {
  test('names the term and asks tenant-vs-landlord, grouped by tenant', () => {
    const q = buildLeaseQuestion('roof');
    expect(q).toContain('"roof"');
    expect(q).toMatch(/TENANT or the LANDLORD/);
    expect(q).toMatch(/group the answer by tenant/i);
    expect(q).toMatch(/do not guess/i);
  });
});

describe('leaseCorpusFingerprint — flips when any lease/rider changes', () => {
  const base = [
    { id: 'a', lease_text: 'roof clause here', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'b', lease_text: 'parking clause', updated_at: '2026-02-01T00:00:00Z' },
  ];

  test('stable for the same corpus regardless of lease order', () => {
    const f1 = leaseCorpusFingerprint(base);
    const f2 = leaseCorpusFingerprint([base[1], base[0]]);
    expect(f1).toBe(f2);
  });

  test('changes when a lease text length changes', () => {
    const edited = [{ ...base[0], lease_text: 'roof clause here — now longer' }, base[1]];
    expect(leaseCorpusFingerprint(edited)).not.toBe(leaseCorpusFingerprint(base));
  });

  test('changes when a lease updated_at changes (same length edit)', () => {
    const touched = [{ ...base[0], updated_at: '2026-03-09T00:00:00Z' }, base[1]];
    expect(leaseCorpusFingerprint(touched)).not.toBe(leaseCorpusFingerprint(base));
  });

  test('changes when a rider is added, and reflects rider edits', () => {
    const withRider = { a: [{ id: 'r1', addendum_text: 'tenant assumes the roof', updated_at: '2026-04-01' }] };
    const f0 = leaseCorpusFingerprint(base);
    const f1 = leaseCorpusFingerprint(base, withRider);
    expect(f1).not.toBe(f0);
    const editedRider = { a: [{ id: 'r1', addendum_text: 'tenant assumes the roof entirely', updated_at: '2026-04-01' }] };
    expect(leaseCorpusFingerprint(base, editedRider)).not.toBe(f1);
  });
});

describe('gatherAnswerContext — cheap AI evidence, only matched leases', () => {
  const roofLease = {
    id: 'r1',
    tenant_name: 'Wingstop',
    lease_text:
      'SECTION 8. REPAIRS AND MAINTENANCE. ' +
      'Tenant shall, at its sole cost and expense, maintain and repair the roof membrane and all HVAC serving the Premises. ' +
      'Landlord shall keep the foundation in good order.',
  };
  const landlordRoof = {
    id: 'r2',
    tenant_name: 'City Dental',
    lease_text: 'Landlord shall maintain the roof and the structural elements of the Building at Landlord’s expense.',
  };
  const noRoof = { id: 'r3', tenant_name: 'Gzim Mila', lease_text: 'Tenant pays for parking and signage only.' };
  const handEntered = { id: 'n1', tenant_name: 'Hand Entered', lease_text: null };

  // Force clause-mode (not full-corpus) so we exercise the widening path.
  const clauseOpts = { smallCorpusChars: 1 };

  test('includes only leases that mention the term, labeled by tenant, with the whole clause', () => {
    const ctx = gatherAnswerContext('roof', [roofLease, landlordRoof, noRoof, handEntered], {}, clauseOpts);
    expect(ctx.map((c) => c.tenant)).toEqual(['Wingstop', 'City Dental']);
    // widened past the 60-char display snippet — full responsibility sentence present
    expect(ctx[0].text).toContain('Tenant shall, at its sole cost and expense, maintain and repair the roof');
    expect(ctx[1].text).toContain('Landlord shall maintain the roof');
  });

  test('empty query yields no context (no AI call to make)', () => {
    expect(gatherAnswerContext('   ', [roofLease], {}, clauseOpts)).toEqual([]);
  });

  test('caps evidence per lease in clause mode', () => {
    const many = {
      id: 'm1',
      tenant_name: 'Repeaty',
      lease_text: Array.from({ length: 40 }, (_, i) => `Clause ${i}: the roof shall be maintained. ${'x'.repeat(80)}`).join('\n'),
    };
    const [c] = gatherAnswerContext('roof', [many], {}, clauseOpts);
    expect(c.text.length).toBeLessThanOrEqual(2500);
  });

  test('small corpus → sends full lease text (best recall)', () => {
    const ctx = gatherAnswerContext('roof', [roofLease, landlordRoof]); // default smallCorpusChars → full mode
    expect(ctx[0].text).toContain('Landlord shall keep the foundation'); // whole doc, not just the clause
  });

  test('searches rider text too and labels the amendment', () => {
    const riders = { r3: [{ id: 'a1', label: 'First Amendment', addendum_text: 'Tenant hereby assumes all roof repairs.' }] };
    const ctx = gatherAnswerContext('roof', [noRoof], riders, clauseOpts);
    expect(ctx.map((c) => c.tenant)).toEqual(['Gzim Mila']);
    expect(ctx[0].text).toContain('[First Amendment]');
    expect(ctx[0].text).toContain('assumes all roof repairs');
  });
});
