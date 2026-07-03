// Token-free tests for the renewal apply fix: confirming a FUTURE option early must extend
// the term WITHOUT moving lease_start or wiping today's rent (the old bug), while a PAST
// option still catches the lease up. Plus the leaseTerm gating that keeps an un-exercised
// option's printed rent steps from posing as committed. Pure leaseTerm + DEMO client.

import { DEMO_MODE } from '../supabaseClient';
import { resolveCurrentTerm, currentPhase } from '../leaseTerm';
import {
  createCorporation, createProperty, createLease, createEscalation, createRenewal,
  confirmRenewal, getLease, listEscalations, listRenewals,
} from '../api';

beforeAll(() => { expect(DEMO_MODE).toBe(true); });

const TODAY = new Date('2026-07-03T12:00:00');

describe('leaseTerm gating (pure)', () => {
  test('nextStep skips steps dated on/after the committed term end', () => {
    const lease = { lease_start: '2015-05-01', lease_termination_date: '2031-05-01', base_rent: 28348.92 };
    const escalations = [
      { effective_date: '2028-05-01', new_base_rent: 29000 },   // inside the term → the real next step
      { effective_date: '2031-05-01', new_base_rent: 30685.80 },// == term end → belongs to an un-exercised option
    ];
    const phase = currentPhase({ lease, escalations, today: TODAY });
    expect(phase.nextStep?.date).toBe('2028-05-01');

    // If the only future step is the option-year one, there is no committed next step.
    const phase2 = currentPhase({ lease, escalations: [escalations[1]], today: TODAY });
    expect(phase2.nextStep).toBe(null);
  });

  test('expired "last known rent" ignores option-year steps at/after term end', () => {
    const lease = { lease_start: '2012-06-01', lease_termination_date: '2018-01-31', base_rent: 30525 };
    const escalations = [
      { effective_date: '2017-06-01', new_base_rent: 34000 },  // last in-term rent
      { effective_date: '2018-01-31', new_base_rent: 41403 },  // option-year rent (at term end) — must NOT be picked
    ];
    const res = resolveCurrentTerm({ lease, escalations, today: TODAY });
    expect(res.status).toBe('expired');
    expect(res.currentRent).toBe(34000);
  });
});

describe('confirmRenewal — future option confirmed early (DEMO, Ricki\'s shape)', () => {
  test('extends the end date only; keeps lease_start + today\'s rent; no duplicate step', async () => {
    const corp = await createCorporation("Ricki's Holdings, LLC");
    const prop = await createProperty({ corporation_id: corp.id, name: "Ricki's Plaza", address: 'GA', building_sf: 13750 });
    const lease = await createLease({
      property_id: prop.id, tenant_name: "Ricki's Cafe", square_footage: 3000,
      base_rent: 28348.92, lease_start: '2015-05-01', lease_termination_date: '2031-05-01',
    });
    // The imported schedule already prints Option 3's opening rent at its window start.
    await createEscalation({ lease_id: lease.id, effective_date: '2031-05-01', escalation_type: 'manual', escalation_value: null, new_base_rent: 30685.80, status: 'scheduled' });
    const o3 = await createRenewal({ lease_id: lease.id, option_label: 'Third Option Period', term_months: 60, new_rent: 30685.80, notice_by_date: '2030-11-02' });

    await confirmRenewal(o3.id, TODAY);

    const after = await getLease(lease.id);
    expect(after.lease_termination_date).toBe('2036-05-01'); // extended 60 months from 2031-05-01
    expect(after.lease_start).toBe('2015-05-01');            // unchanged — the bug moved this to the future
    expect(Number(after.base_rent)).toBe(28348.92);          // today's rent untouched (2031 step is still future)

    const escs = await listEscalations(lease.id);
    expect(escs.length).toBe(1);                             // the imported step reused, not duplicated
    const opt = (await listRenewals(lease.id)).find((r) => r.id === o3.id);
    expect(opt.status).toBe('applied');
  });

  test('a PAST option still catches the lease up (moves lease_start + rent)', async () => {
    const corp = await createCorporation('Past Co, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Past Plaza', address: 'GA' });
    const lease = await createLease({ property_id: prop.id, tenant_name: 'Past Tenant', square_footage: 1000, base_rent: 30000, lease_start: '2015-02-01', lease_termination_date: '2020-01-31' });
    const o1 = await createRenewal({ lease_id: lease.id, option_label: 'Option 1', term_months: 12, new_rent: 33000 });

    await confirmRenewal(o1.id, TODAY);
    const after = await getLease(lease.id);
    expect(after.lease_start).toBe('2020-01-31'); // begun window → start rolls to where the old term ended
    expect(Number(after.base_rent)).toBe(33000);
  });
});
