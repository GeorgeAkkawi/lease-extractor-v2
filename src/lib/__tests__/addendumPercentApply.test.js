// A rider's PERCENT rent step, end to end through applyAddendum. Percent steps carry no
// dollar figure of their own — they're priced from the rent in effect just before them —
// so every stage that filtered on `new_base_rent != null` silently deleted them. The demo
// mock's own canned rider shipped a live reproduction: its summary promised a 3% bump the
// review form never showed and the lease never received.
//
// Runs against the in-memory demo client (no env keys in test → DEMO_MODE): $0, no AI.

import { DEMO_MODE } from '../supabaseClient';
import {
  createCorporation, createProperty, createLease, createAddendum, applyAddendum,
  listEscalations, listRenewals, getLease,
} from '../api';

const TODAY = new Date('2026-07-01T12:00:00');

async function freshLease(overrides = {}) {
  const corp = await createCorporation('Percent Test Holdings');
  const prop = await createProperty({ corporation_id: corp.id, name: 'Test Plaza', address: '1 Test St', building_sf: 10000 });
  return createLease({
    property_id: prop.id,
    tenant_name: 'Percent Tenant LLC',
    square_footage: 4000,
    base_rent: 120000,
    lease_start: '2020-01-01',
    lease_termination_date: '2028-12-31',
    ...overrides,
  });
}

// What AddendumEditor.formToChanges() now hands applyAddendum for the Denny's-shaped
// rider: one operative rent, then a percent step two years later.
const DENNYS_CHANGES = {
  escalations: [
    { effective_date: '2023-07-01', escalation_type: 'manual', escalation_value: null, new_base_rent: 151140 },
    { effective_date: '2025-07-01', escalation_type: 'percent', escalation_value: 3, new_base_rent: null },
  ],
  renewals: [],
};

describe('a rider that raises rent by a percent', () => {
  test('DEMO_MODE is on (no keys in test)', () => expect(DEMO_MODE).toBe(true));

  test('the percent step survives and is priced from the rent before it', async () => {
    const lease = await freshLease();
    const add = await createAddendum({ lease_id: lease.id, label: 'Third Addendum', amendment_date: '2023-07-01', kind: 'rent_change' });
    await applyAddendum(add, DENNYS_CHANGES, TODAY);

    const escs = await listEscalations(lease.id);
    expect(escs).toHaveLength(2);

    const [first, second] = escs.sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    expect(first.effective_date).toBe('2023-07-01');
    expect(Number(first.new_base_rent)).toBe(151140);

    // 151,140 × 1.03 = 155,674.20 — computed by buildEscalations →
    // computeEscalatedRent off the PRIOR step, not carried from the model.
    expect(second.effective_date).toBe('2025-07-01');
    expect(second.escalation_type).toBe('percent');
    expect(Number(second.escalation_value)).toBe(3);
    expect(Number(second.new_base_rent)).toBeCloseTo(155674.2, 2);
  });

  test('a percent-only rider (no dollar figure anywhere) still writes a step', async () => {
    // The pure form of the dropped-step bug: nothing in the rider carries dollars.
    const lease = await freshLease({ base_rent: 100000 });
    const add = await createAddendum({ lease_id: lease.id, label: 'Rent Bump Rider', amendment_date: '2026-01-01', kind: 'rent_change' });
    await applyAddendum(add, {
      escalations: [{ effective_date: '2027-01-01', escalation_type: 'percent', escalation_value: 5, new_base_rent: null }],
      renewals: [],
    }, TODAY);

    const escs = await listEscalations(lease.id);
    expect(escs).toHaveLength(1);
    expect(Number(escs[0].new_base_rent)).toBeCloseTo(105000, 2); // 100,000 × 1.05
  });
});

describe('a rider that prices its rent by LEASE YEAR', () => {
  test('an extension anchors the undated steps at the term end it begins from', async () => {
    // A rider extending an 2028-12-31 lease, priced "Year 1 / Year 2 / Year 3" with no
    // printed dates. The anchor is the term end the new period starts at — never the
    // amendment (signing) date. Before this, every undated step was dropped on the floor.
    const lease = await freshLease();
    const add = await createAddendum({ lease_id: lease.id, label: 'Extension Rider', amendment_date: '2026-03-15', kind: 'extension' });
    await applyAddendum(add, {
      extensionEnd: '2031-12-31',
      escalations: [
        { effective_date: null, months_from_start: 0, escalation_type: 'manual', escalation_value: null, new_base_rent: 160000 },
        { effective_date: null, months_from_start: 12, escalation_type: 'manual', escalation_value: null, new_base_rent: 165000 },
        { effective_date: null, months_from_start: 24, escalation_type: 'manual', escalation_value: null, new_base_rent: 170000 },
      ],
      renewals: [],
    }, TODAY);

    const escs = (await listEscalations(lease.id)).sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    expect(escs.map((e) => e.effective_date)).toEqual(['2028-12-31', '2029-12-31', '2030-12-31']);
    expect(escs.map((e) => Number(e.new_base_rent))).toEqual([160000, 165000, 170000]);
    expect((await getLease(lease.id)).lease_termination_date).toBe('2031-12-31');
  });

  test('a dated operative rent anchors from ITS date, not the term end', async () => {
    const lease = await freshLease();
    const add = await createAddendum({ lease_id: lease.id, label: 'Dated Rider', amendment_date: '2026-03-15', kind: 'rent_change' });
    await applyAddendum(add, {
      escalations: [
        { effective_date: '2026-04-01', escalation_type: 'manual', escalation_value: null, new_base_rent: 140000 },
        { effective_date: null, months_from_start: 12, escalation_type: 'manual', escalation_value: null, new_base_rent: 145000 },
      ],
      renewals: [],
    }, TODAY);

    const escs = (await listEscalations(lease.id)).sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    expect(escs.map((e) => e.effective_date)).toEqual(['2026-04-01', '2027-04-01']);
  });
});

describe('a rider that grants an option priced year by year', () => {
  test('the option\'s rent table becomes gated pending-renewal steps after the NEW term end', async () => {
    // A rider that extends the term AND grants an option must place that option's window
    // after the *new* end, not the one it replaced — and must not double-book a step the
    // rider already spelled out.
    const lease = await freshLease();
    const add = await createAddendum({ lease_id: lease.id, label: 'Extension + Option', amendment_date: '2026-03-15', kind: 'extension' });
    await applyAddendum(add, {
      extensionEnd: '2031-12-31',
      escalations: [],
      renewals: [{
        option_label: 'Option to Renew', term_months: 60, new_rent: null, annual_escalation_pct: null, notice_by_date: null,
        rent_schedule: [
          { months_from_option_start: 0, annual: 200000 },
          { months_from_option_start: 12, annual: 206000 },
        ],
      }],
    }, TODAY);

    expect(await listRenewals(lease.id)).toHaveLength(1);

    const escs = (await listEscalations(lease.id)).sort((a, b) => a.effective_date.localeCompare(b.effective_date));
    // The window opens the day AFTER the new committed end (the +1 day keeps un-exercised
    // option rent out of the Ask-AI facts, which gate on `d > end`).
    expect(escs.map((e) => e.effective_date)).toEqual(['2032-01-01', '2033-01-01']);
    expect(escs.map((e) => Number(e.new_base_rent))).toEqual([200000, 206000]);

    // Term-neutral: the option never moves the end date on its own.
    expect((await getLease(lease.id)).lease_termination_date).toBe('2031-12-31');
  });

  test('a flat option writes no schedule steps', async () => {
    const lease = await freshLease();
    const add = await createAddendum({ lease_id: lease.id, label: 'Flat Option', amendment_date: '2026-03-15', kind: 'new_option' });
    await applyAddendum(add, {
      escalations: [],
      renewals: [{ option_label: 'Option', term_months: 60, new_rent: 180000, annual_escalation_pct: null, notice_by_date: null, rent_schedule: [] }],
    }, TODAY);

    expect(await listRenewals(lease.id)).toHaveLength(1);
    expect(await listEscalations(lease.id)).toHaveLength(0);
  });
});
