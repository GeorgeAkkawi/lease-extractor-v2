// Token-free replay of the Busey Bank renewal-option rent fix. No AI — pure functions
// (the SAME shared code the edge function runs) + the in-memory demo client (no env keys
// → DEMO_MODE). The lease's ONE 5-year extension option is priced YEAR BY YEAR (Exhibit D:
// five monthly installments, $35,238.17/mo stepping to $38,896.34/mo). That fits neither
// new_rent (a flat annual) nor annual_escalation_pct (a percent), so the model nulled both
// and the Renewal Options tab read "Not listed — enter at renewal". The fix captures the
// raw schedule, WE annualize (the model's own prose annualizations were off by hundreds),
// fill the option's new_rent, and lay dated "pending renewal" steps past the committed term.

import { DEMO_MODE, supabase } from '../supabaseClient';
import {
  createCorporation, createProperty, createLease, createLeaseFromExtraction,
  createRenewal, confirmRenewal, reconcileRenewalOptions,
  getLease, listRenewals, listEscalations,
  buildEscalations, buildRenewals, buildRenewalScheduleSteps,
} from '../api';
import { currentPhase } from '../leaseTerm';
import { annualizeOptionSchedule } from '../../../supabase/functions/_shared/rentSchedule.js';

const TODAY = new Date('2026-07-22T12:00:00'); // years before the 2031 option window

// Busey's Exhibit D — the option's five monthly installments, exactly as printed.
const BUSEY_MONTHLY = [35238.17, 36119.12, 37022.10, 37947.65, 38896.34];
// …× 12 = the correct ANNUAL rents (the model's prose notes had 3 of these wrong).
const BUSEY_ANNUAL = [422858.04, 433429.44, 444265.20, 455371.80, 466756.08];
const BUSEY_NOTICE = 'Tenant shall give written notice no later than twelve (12) months prior to the expiration of the Original Term';

const buseySchedule = () =>
  BUSEY_MONTHLY.map((amount, i) => ({ months_from_option_start: i * 12, amount, period: 'per_month' }));

beforeAll(() => { expect(DEMO_MODE).toBe(true); });

// ── 1. Pure annualization ──────────────────────────────────────────────────
describe('annualizeOptionSchedule (pure)', () => {
  test("Busey's five per_month installments → cent-exact annuals", () => {
    const out = annualizeOptionSchedule(buseySchedule(), 0);
    expect(out.rows.map((r) => r.annual)).toEqual(BUSEY_ANNUAL);
    expect(out.firstYearAnnual).toBe(422858.04);
    expect(out.rows.map((r) => r.months_from_option_start)).toEqual([0, 12, 24, 36, 48]);
  });

  test('$/SF rows annualize with sqft, and are dropped without it', () => {
    const rows = [{ months_from_option_start: 0, amount: 20, period: 'per_sqft_year' }];
    expect(annualizeOptionSchedule(rows, 10000).firstYearAnnual).toBe(200000);
    expect(annualizeOptionSchedule(rows, 0)).toBe(null); // no sqft → unresolvable → nothing usable
  });

  test('an unknown-basis row is skipped, not guessed', () => {
    expect(annualizeOptionSchedule([{ months_from_option_start: 0, amount: 5000, period: 'unknown' }], 0)).toBe(null);
  });

  test('offsets are normalized so the earliest period is 0 (lease-relative offsets → option-relative)', () => {
    const rows = [
      { months_from_option_start: 120, amount: 1000, period: 'per_year' },
      { months_from_option_start: 132, amount: 1100, period: 'per_year' },
    ];
    const out = annualizeOptionSchedule(rows, 0);
    expect(out.rows.map((r) => r.months_from_option_start)).toEqual([0, 12]);
    expect(out.rows.map((r) => r.annual)).toEqual([1000, 1100]);
  });

  test('the same period stated two ways collapses to one — plain-dollar wins over $/SF', () => {
    const rows = [
      { months_from_option_start: 0, amount: 21, period: 'per_sqft_year' }, // 21×1000 = 21000
      { months_from_option_start: 0, amount: 22000, period: 'per_year' },   // the real figure
    ];
    const out = annualizeOptionSchedule(rows, 1000);
    expect(out.rows).toHaveLength(1);
    expect(out.firstYearAnnual).toBe(22000);
  });
});

// ── 2. Pure step-building ──────────────────────────────────────────────────
describe('buildRenewalScheduleSteps (pure)', () => {
  const buseyOption = () => ({ option_label: 'Extension Term', term_months: 60, rent_schedule: annualizeOptionSchedule(buseySchedule(), 0).rows });

  test('dates the option schedule from termEnd + 1 day (Busey → 2031-09-01 … 2035-09-01)', () => {
    const steps = buildRenewalScheduleSteps([buseyOption()], '2031-08-31', [], TODAY);
    expect(steps.map((s) => s.effective_date)).toEqual([
      '2031-09-01', '2032-09-01', '2033-09-01', '2034-09-01', '2035-09-01',
    ]);
    expect(steps.map((s) => s.new_base_rent)).toEqual(BUSEY_ANNUAL);
    expect(steps.every((s) => s.escalation_type === 'manual' && s.escalation_value === null)).toBe(true);
  });

  test('chained options each start where the previous window ends', () => {
    const opt = (label) => ({ option_label: label, term_months: 60, rent_schedule: [{ months_from_option_start: 0, annual: 500000 }] });
    const steps = buildRenewalScheduleSteps([opt('Option 1'), opt('Option 2')], '2031-08-31', [], TODAY);
    expect(steps.map((s) => s.effective_date)).toEqual(['2031-09-01', '2036-09-01']);
  });

  test('past-window guard: a term that has already ended synthesizes nothing', () => {
    expect(buildRenewalScheduleSteps([buseyOption()], '2020-01-31', [], TODAY)).toEqual([]);
  });

  test('a boundary already covered by a printed step (±45 days) is not double-booked', () => {
    const existing = [{ effective_date: '2031-09-15', new_base_rent: 999 }]; // within 45d of 2031-09-01
    const steps = buildRenewalScheduleSteps([buseyOption()], '2031-08-31', existing, TODAY);
    expect(steps.map((s) => s.effective_date)).toEqual(['2032-09-01', '2033-09-01', '2034-09-01', '2035-09-01']);
  });

  test('no committed term end → no steps (the option still shows its new_rent)', () => {
    expect(buildRenewalScheduleSteps([buseyOption()], null, [], TODAY)).toEqual([]);
  });
});

// ── 3. Full import replay (DEMO client) ────────────────────────────────────
async function importBusey() {
  const corp = await createCorporation('Busey Holdings, LLC');
  const prop = await createProperty({ corporation_id: corp.id, name: 'Busey Center', building_sf: 20000 });
  const { data: fileRow } = await supabase.from('lease_files')
    .insert({ owner_id: 'demo-user', storage_path: 'x/busey.pdf', original_filename: 'Busey.pdf', extraction_raw: { term_months: { value: 120 } } })
    .select().single();

  // The extraction as it arrives AFTER the edge merge: rent_schedule annualized, new_rent filled.
  const option = {
    option_label: 'Extension Term - One (1) Five-Year Option',
    notice_by_date: null, term_months: 60, new_rent: 422858.04, annual_escalation_pct: null,
    notes: BUSEY_NOTICE, rent_schedule: annualizeOptionSchedule(buseySchedule(), 0).rows,
  };
  const extraction = { escalations: [], renewal_options: [option] };

  // Mirror LeaseNewPage.createFromAi: committed steps + option-window steps.
  const committed = buildEscalations(364629.12, extraction.escalations, '2021-09-01');
  const optionEscs = buildRenewalScheduleSteps(extraction.renewal_options, '2031-08-31', committed, TODAY);

  const lease = await createLeaseFromExtraction({
    propertyId: prop.id, leaseFileId: fileRow.id,
    lease: { tenant_name: 'Busey Bank', square_footage: 20000, base_rent: 364629.12, lease_start: '2021-09-01', lease_termination_date: '2031-08-31' },
    escalations: [...committed, ...optionEscs],
    renewals: buildRenewals(extraction.renewal_options),
    abatements: [], aiConfidence: null, leaseText: null,
  });
  // Deterministic reconcile (the internal back-fill already ran with the real clock).
  await reconcileRenewalOptions(await getLease(lease.id), TODAY);
  return await getLease(lease.id);
}

describe('Busey regression replay (DEMO)', () => {
  test('the option reads its projected rent + a real notice date; today\'s rent is untouched', async () => {
    const lease = await importBusey();
    const opt = (await listRenewals(lease.id))[0];
    expect(opt.status).toBe('pending');                 // a right, not yet exercised
    expect(Number(opt.new_rent)).toBe(422858.04);       // was null → "Not listed"; now the projected rent
    expect(opt.notice_by_date).toBe('2030-08-31');      // "twelve (12) months prior" to 2031-08-31
    expect(Number(lease.base_rent)).toBe(364629.12);    // option rent never leaks into today's rent
    expect(lease.lease_termination_date).toBe('2031-08-31'); // committed term unchanged
  });

  test('the five option-year steps are saved, dated, and stay SCHEDULED (gated "pending renewal")', async () => {
    const lease = await importBusey();
    const escs = (await listEscalations(lease.id)).filter((e) => e.effective_date > '2031-08-31');
    expect(escs.map((e) => e.effective_date).sort()).toEqual([
      '2031-09-01', '2032-09-01', '2033-09-01', '2034-09-01', '2035-09-01',
    ]);
    expect(escs.every((e) => e.status === 'scheduled')).toBe(true);
    expect(escs.map((e) => Number(e.new_base_rent)).sort((a, b) => a - b)).toEqual(BUSEY_ANNUAL);
  });

  test('currentPhase ignores the option steps — no committed next step past term end', async () => {
    const lease = await importBusey();
    const escalations = await listEscalations(lease.id);
    const phase = currentPhase({ lease, escalations, today: TODAY });
    expect(phase.nextStep).toBe(null); // the 2031+ steps are gated; nothing in-term follows
  });
});

// ── 4. Confirming the option ───────────────────────────────────────────────
describe('confirming the Busey option (DEMO)', () => {
  test('future confirm extends the term to 2036-08-31, keeps lease_start + rent, no duplicate steps', async () => {
    const lease = await importBusey();
    const opt = (await listRenewals(lease.id))[0];
    const before = (await listEscalations(lease.id)).length;

    await confirmRenewal(opt.id, TODAY);

    const after = await getLease(lease.id);
    expect(after.lease_termination_date).toBe('2036-08-31'); // +60 months from 2031-08-31
    expect(after.lease_start).toBe('2021-09-01');            // untouched
    expect(Number(after.base_rent)).toBe(364629.12);         // today's rent untouched (2031 step still future)
    expect((await listEscalations(lease.id)).length).toBe(before); // year-1 step reused, not duplicated
    expect((await listRenewals(lease.id))[0].status).toBe('applied');
  });

  test('a PAST option catches the lease up — base rent lands on the option\'s first-year figure', async () => {
    const corp = await createCorporation('Busey Past, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Old Center', building_sf: 20000 });
    const lease = await createLease({ property_id: prop.id, tenant_name: 'Busey Bank', square_footage: 20000, base_rent: 360000, lease_start: '2015-09-01', lease_termination_date: '2020-08-31' });
    const opt = await createRenewal({ lease_id: lease.id, option_label: 'Extension Term', term_months: 60, new_rent: 422858.04 });

    await confirmRenewal(opt.id, TODAY);
    const after = await getLease(lease.id);
    expect(after.lease_start).toBe('2020-08-31');       // begun window → start rolls to the old term end
    expect(Number(after.base_rent)).toBe(422858.04);    // the option's first-year rent
  });
});
