// Regression for the Overview "Annual rent roll" ≠ property-card revenue bug.
//
// Both the Overview card and the property Financials page read effective_rent(lease, year)
// (SQL v_property_totals / JS demo propertyTotals), while the Leases-page property card
// reads raw base_rent. Confirming a renewal writes the new rent onto base_rent but the old
// code left the escalation ledger at the PRE-renewal rent, and effective_rent always
// preferred the latest applied step — so a renewed lease reported a stale (lower) rent in
// the rent roll. Five Points Wings: $34,225 in the roll vs $41,403 on the card ($7,178 gap).
//
// Two guards here:
//   1) effectiveRent is now ERA-AWARE (migration 0054) — base_rent (the live rent) wins for
//      the current era;
//      the ledger is only consulted for a historical year that a later applied step supersedes.
//   2) rollLeaseIntoRenewal now records the renewal's rent as an applied ledger row, so the
//      ledger stays in sync and the Overview total matches the property card going forward.

import { effectiveRent } from '../escalations';
import { DEMO_MODE } from '../supabaseClient';
import {
  createCorporation, createProperty, createLease, createRenewal,
  getLease, confirmRenewal, listEscalations, listPropertyTotalsByYear, upsertExpenseRecord,
} from '../api';

// The exact live shape: base_rent moved to the renewed rent, but the ledger's last applied
// step is the pre-renewal 2017 figure — nothing dated after it.
const WINGSTOP_STALE = {
  lease: { base_rent: 41403 },
  esc: [
    { effective_date: '2014-01-01', new_base_rent: 31450, status: 'applied' },
    { effective_date: '2015-01-01', new_base_rent: 32375, status: 'applied' },
    { effective_date: '2016-01-01', new_base_rent: 33300, status: 'applied' },
    { effective_date: '2017-01-01', new_base_rent: 34225, status: 'applied' },
  ],
};

describe('effectiveRent — era-aware (pure)', () => {
  test('current-era base_rent wins over a stale ledger (the Wingstop bug)', () => {
    // OLD behavior returned the stale 34225 here; the rent has really been 41403 all along.
    expect(effectiveRent(WINGSTOP_STALE.lease, WINGSTOP_STALE.esc, 2026)).toBe(41403);
    expect(effectiveRent(WINGSTOP_STALE.lease, WINGSTOP_STALE.esc, 2023)).toBe(41403);
  });

  test('historical years still read the ledger once later steps supersede them', () => {
    // After the ledger is repaired: applied option rents dated 2018 and 2023.
    const lease = { base_rent: 41403 };
    const esc = [
      ...WINGSTOP_STALE.esc,
      { effective_date: '2018-01-01', new_base_rent: 37648, status: 'applied' },
      { effective_date: '2023-01-01', new_base_rent: 41403, status: 'applied' },
    ];
    expect(effectiveRent(lease, esc, 2016)).toBe(33300); // superseded by 2017/2018/2023
    expect(effectiveRent(lease, esc, 2020)).toBe(37648); // in the First Option era
    expect(effectiveRent(lease, esc, 2023)).toBe(41403); // current era → base_rent
    expect(effectiveRent(lease, esc, 2026)).toBe(41403); // current era → base_rent
  });

  test('healthy escalating lease (ledger in sync) is unchanged', () => {
    const lease = { base_rent: 34225 }; // matches the last applied step
    const esc = WINGSTOP_STALE.esc;
    expect(effectiveRent(lease, esc, 2015)).toBe(32375); // historical, from ledger
    expect(effectiveRent(lease, esc, 2026)).toBe(34225); // current era = base_rent = last step
  });

  test('a future SCHEDULED step (not applied) never shifts the current-era rent', () => {
    const lease = { base_rent: 50000 };
    const esc = [{ effective_date: '2027-01-01', new_base_rent: 52000, status: 'scheduled' }];
    expect(effectiveRent(lease, esc, 2026)).toBe(50000);
    expect(effectiveRent(lease, esc, 2027)).toBe(50000); // still 50000 until it's applied
  });

  test('no escalations → base_rent for any year', () => {
    expect(effectiveRent({ base_rent: 20000 }, [], 2026)).toBe(20000);
    expect(effectiveRent({ base_rent: 20000 }, undefined, 2010)).toBe(20000);
  });
});

describe('renewal keeps the ledger in sync so the rent roll matches the card', () => {
  const TODAY = new Date('2026-07-02T12:00:00');
  const YEAR = 2026;

  beforeAll(() => { expect(DEMO_MODE).toBe(true); });

  test('confirming a renewal records an applied ledger row; total_revenue == card base_rent', async () => {
    const corp = await createCorporation('Five Points Wings, LLC');
    const prop = await createProperty({ corporation_id: corp.id, name: 'Five Points Plaza', building_sf: 3000 });
    const lease = await createLease({
      property_id: prop.id, tenant_name: 'Wingstop', square_footage: 1650,
      base_rent: 34225, lease_start: '2013-01-01', lease_termination_date: '2018-01-01',
    });
    // The demo v_property_totals mock inner-joins expense_records, so seed the year's row.
    await upsertExpenseRecord({ property_id: prop.id, year: YEAR, taxes_total: 0, cam_total: 0, roof_total: 0 });
    // A past 5-year option stating its rent → applies, rolling the term to 2023-01-01.
    const opt = await createRenewal({ lease_id: lease.id, option_label: 'First Option Period', term_months: 60, new_rent: 41403, notes: null });
    await confirmRenewal(opt.id, TODAY);

    const after = await getLease(lease.id);
    expect(Number(after.base_rent)).toBe(41403); // card value

    // The renewal wrote its rent into the ledger as an applied step at the old term-end.
    const esc = await listEscalations(lease.id);
    const applied = esc.filter((e) => e.status === 'applied' && Number(e.new_base_rent) === 41403);
    expect(applied.length).toBe(1);
    expect(String(applied[0].effective_date)).toBe('2018-01-01');

    // The Overview/Financials total (effective_rent based) now matches the card's base_rent.
    const totals = await listPropertyTotalsByYear([prop.id], YEAR);
    expect(Number(totals[prop.id].total_revenue)).toBe(41403);
  });
});
