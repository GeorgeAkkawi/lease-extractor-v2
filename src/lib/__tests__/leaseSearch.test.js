// The free per-property lease search + the expiring-soonest sort. Pure JS —
// no network, no AI. Replays the real use case: "which tenants must pay for
// the roof?" answered by scanning the cached lease/rider text for the word
// and surfacing the clause, so the landlord judges tenant-vs-landlord himself.
import { byTermEnd, searchLeases } from '../leaseSearch';

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
