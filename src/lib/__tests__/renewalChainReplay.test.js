// Token-free replay of the Wingstop situation the two screenshots exposed: a lease whose
// 68-month term is entirely in the past, carrying three (3) five-year renewal options — the
// lease's own mechanism for reaching today. No AI / Anthropic calls; runs against the
// in-memory demo client (DEMO_MODE), so it's deterministic and free.
//
// Proves what George asked for:
//   1) Lapsed options are still applyable, and CHAIN — applying Option 1 rolls the term
//      forward from where it ended, then Option 2 rolls it again until the lease is current.
//   2) An option whose rent the lease left OPEN ("Not listed") isn't applied blind:
//      confirmRenewalForLease returns { needsRent } and touches nothing until a figure is
//      supplied; the entered rent then becomes the new base rent and is recorded on the option.
//   3) An option that DOES state a rent still applies in one step (regression).

import { DEMO_MODE } from '../supabaseClient';
import {
  createCorporation, createProperty, createLease, createRenewal,
  getLease, listRenewals, confirmRenewal, confirmRenewalForLease,
} from '../api';

// Pin "today" so assertions don't depend on the wall clock (George's context date).
const TODAY = new Date('2026-07-02T12:00:00');

// A lease whose term ended Jan 31 2018 — well in the past as of "today" (Jul 2026).
async function pastTermLease(baseRent = 30525) {
  const corp = await createCorporation('Five Points Wings, LLC');
  const prop = await createProperty({ corporation_id: corp.id, name: 'Five Points Plaza', address: 'Athens, GA', building_sf: 3000 });
  return createLease({
    property_id: prop.id,
    tenant_name: 'Wingstop',
    square_footage: 1650,
    base_rent: baseRent,
    lease_start: '2012-06-01',
    lease_termination_date: '2018-01-31',
  });
}

beforeAll(() => {
  // Guard: if real Supabase keys ever leak into the test env, fail loudly rather than
  // silently hammering the live backend.
  expect(DEMO_MODE).toBe(true);
});

test('lapsed options chain forward; an unlisted-rent option applies with the entered figure', async () => {
  const lease = await pastTermLease();

  // Three 5-year (60-month) options. Option 1 states its rent; Options 2–3 leave it open
  // (the real lease says "greater of $41,403 or CPI" / "mutually agreed").
  const o1 = await createRenewal({ lease_id: lease.id, option_label: 'Option 1', term_months: 60, new_rent: 37648, notes: null });
  const o2 = await createRenewal({ lease_id: lease.id, option_label: 'Option 2', term_months: 60, new_rent: null, notes: 'Greater of $41,403 or 12× CPI' });
  await createRenewal({ lease_id: lease.id, option_label: 'Option 3', term_months: 60, new_rent: null, notes: 'Mutually agreed' });

  // Option 1 states a rent → applies in one step. Term rolls from where it ended (2018-01-31)
  // forward 60 months → 2023-01-31; base rent becomes the stated $37,648.
  await confirmRenewal(o1.id, TODAY);
  let after = await getLease(lease.id);
  expect(after.lease_termination_date).toBe('2023-01-31');
  expect(Number(after.base_rent)).toBe(37648);

  // Option 2 leaves the rent open → landlord types the agreed figure. Term rolls again to
  // 2028-01-31 (now in the future → lease is current/active), base rent = the entered value.
  await confirmRenewal(o2.id, TODAY, { newRent: 42500 });
  after = await getLease(lease.id);
  expect(after.lease_termination_date).toBe('2028-01-31');
  expect(Number(after.base_rent)).toBe(42500);
  expect(after.is_active).toBe(true);

  // The entered rent is recorded on the option so the row shows what was agreed.
  const rens = await listRenewals(lease.id);
  const applied2 = rens.find((r) => r.id === o2.id);
  expect(applied2.status).toBe('applied');
  expect(Number(applied2.new_rent)).toBe(42500);
});

test('confirmRenewalForLease will not apply an unlisted-rent option blind', async () => {
  const lease = await pastTermLease();
  const opt = await createRenewal({ lease_id: lease.id, option_label: 'Option 1', term_months: 60, new_rent: null, notes: 'Fair market value' });

  // No rent on the option and none supplied → the API asks for one and changes nothing.
  const res = await confirmRenewalForLease(lease.id, TODAY);
  expect(res).toEqual({ needsRent: true, renewalId: opt.id });

  let after = await getLease(lease.id);
  expect(after.lease_termination_date).toBe('2018-01-31'); // untouched
  let rens = await listRenewals(lease.id);
  expect(rens[0].status).toBe('pending');                  // untouched

  // Supply the figure → it applies and becomes the new base rent.
  await confirmRenewalForLease(lease.id, TODAY, { newRent: 39000 });
  after = await getLease(lease.id);
  expect(after.lease_termination_date).toBe('2023-01-31');
  expect(Number(after.base_rent)).toBe(39000);
  rens = await listRenewals(lease.id);
  expect(rens[0].status).toBe('applied');
});

test('an option that states its rent still applies in one step (regression)', async () => {
  const lease = await pastTermLease();
  await createRenewal({ lease_id: lease.id, option_label: 'Option 1', term_months: 60, new_rent: 60000, notes: null });

  // Rent is listed → no needsRent; applies directly.
  const res = await confirmRenewalForLease(lease.id, TODAY);
  expect(res == null || res.needsRent !== true).toBe(true);

  const after = await getLease(lease.id);
  expect(after.lease_termination_date).toBe('2023-01-31');
  expect(Number(after.base_rent)).toBe(60000);
});
