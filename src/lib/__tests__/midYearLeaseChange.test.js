// A new lease that takes effect PART WAY THROUGH a year already billed.
//
// George, 2026-08-04: *"the rent might change mid way through the year due to a new lease. if
// that happens it should be recorded as it needs to be in the ledger so that when statements
// come in the payments match, but the CAM is recalculated. the previous months aren't affected
// and shouldn't be reconciled at the new figures because they would be part of the old lease."*
//
// Two things used to go wrong the moment that happened, and both are asserted here:
//
//   ① THE WHOLE YEAR WAS RE-PRICED. applyNewLeaseTerms moved base_rent and recorded no date
//     for the change, so monthlyBases — which reads the escalation ledger — had no boundary
//     and answered the NEW rent for January. A year half-collected silently changed shape.
//
//   ② THE EARLIER MONTHS' PAYMENTS WERE DELETED. Moving lease_start forward moves
//     occupancyStart with it, monthlyScheduleForYear marks every earlier month outsideTerm
//     with owed = 0, and the re-stamp loop deleted those months' payment rows and — because
//     it only re-records `if (owed > 0)` — wrote nothing back. Recorded money vanished.
//
// Runs against the demo mock. Seed: lease-2 (City Dental) — base rent $84,000 from
// {Y-1}-06-01, invoice inv-2 for year Y with January and February marked paid at $9,150.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyNewLeaseTerms, buildScheduleFromExtraction, getLease, updateLease,
  listEscalations, getMonthlyRent, getYearInvoice,
} from '../api';
import { newLeaseChanges, newLeaseTargets } from '../newLeaseTerms';
import { monthlyBases } from '../escalations';
import { supabase } from '../supabaseClient';
import { currentYear } from '../format';

const Y = currentYear();
const LEASE = 'lease-2';
const OLD = { rent: 84000, start: `${Y - 1}-06-01` };
const NEW = { rent: 120000, start: `${Y}-07-01`, end: `${Y + 5}-06-30` };

// The shape initialFromExtraction hands the diff — a new lease commencing 1 July.
const PROPOSED = {
  base_rent: NEW.rent,
  lease_start: NEW.start,
  lease_termination_date: NEW.end,
  lease_terms: 'NNN; renewed on new terms.',
};
const EXTRACTION = { escalations: [], renewal_options: [], abatements: [] };

async function applyMidYearLease() {
  const lease = await getLease(LEASE);
  const changes = newLeaseChanges({ lease, proposed: PROPOSED, extraction: EXTRACTION });
  const plan = buildScheduleFromExtraction(EXTRACTION, newLeaseTargets(lease, changes));
  return applyNewLeaseTerms({ leaseId: LEASE, changes, plan, extraction: EXTRACTION });
}

let snapshot = null;
beforeEach(async () => {
  const { data: escs } = await supabase.from('rent_escalations').select('*');
  const { data: pays } = await supabase.from('payments').select('*');
  snapshot = { escs: JSON.parse(JSON.stringify(escs || [])), pays: JSON.parse(JSON.stringify(pays || [])) };
  await updateLease(LEASE, {
    base_rent: OLD.rent, lease_start: OLD.start, lease_termination_date: `${Y}-05-31`,
    est_cam_annual: null, est_tax_annual: null, is_active: true,
  });
});

async function restore() {
  for (const table of ['rent_escalations', 'payments']) {
    const seed = table === 'rent_escalations' ? snapshot.escs : snapshot.pays;
    const { data: now } = await supabase.from(table).select('*');
    for (const r of now || []) if (!seed.some((s) => s.id === r.id)) await supabase.from(table).delete().eq('id', r.id);
    for (const r of seed) if (!(now || []).some((x) => x.id === r.id)) await supabase.from(table).insert(r);
  }
}

describe('a new lease that starts mid-year', () => {
  it('records the change as a dated boundary, with the old rent given an era of its own', async () => {
    try {
      await applyMidYearLease();
      const escs = await listEscalations(LEASE);

      const closing = escs.find((e) => e.effective_date === OLD.start);
      const boundary = escs.find((e) => e.effective_date === NEW.start);
      expect(Number(closing?.new_base_rent)).toBe(OLD.rent);
      expect(Number(boundary?.new_base_rent)).toBe(NEW.rent);
      // ⚠ Both APPLIED, never scheduled. A scheduled closing row carrying the OLD rent would
      // be picked up by applyDueEscalations on the next app load and written back over
      // base_rent — the lease would silently revert to the lease it just replaced.
      expect(closing.status).toBe('applied');
      expect(boundary.status).toBe('applied');
    } finally { await restore(); }
  });

  it('prices the months before the change at the OLD rent and the months after at the new', async () => {
    try {
      await applyMidYearLease();
      const lease = await getLease(LEASE);
      const bases = monthlyBases(await listEscalations(LEASE), lease.base_rent, Y);

      expect(bases[0]).toBe(OLD.rent);  // January — the old lease
      expect(bases[5]).toBe(OLD.rent);  // June    — the last month of it
      expect(bases[6]).toBe(NEW.rent);  // July    — the new lease commences
      expect(bases[11]).toBe(NEW.rent); // December
    } finally { await restore(); }
  });

  it('leaves the payments already recorded on the earlier months alone', async () => {
    try {
      const before = await getMonthlyRent(LEASE, Y);
      expect(before.byMonth[1]).toBeTruthy(); // the seed's January mark, so the test is real
      await applyMidYearLease();

      const after = await getMonthlyRent(LEASE, Y);
      // The rows still exist. They used to be deleted outright: January fell out of term
      // (occupancyStart moved to July), owed became 0, and nothing was written back.
      expect(after.byMonth[1]).toBeTruthy();
      expect(after.byMonth[2]).toBeTruthy();
      // …and the invoice still covers the whole year, not just July–December.
      expect(Number((await getYearInvoice(LEASE, Y)).base_rent_annual)).toBeGreaterThan(OLD.rent / 2);
    } finally { await restore(); }
  });

  it('does not double-book when the new lease prints its own step on the boundary', async () => {
    try {
      const withStep = {
        ...EXTRACTION,
        escalations: [{ effective_date: NEW.start, escalation_type: 'manual', new_base_rent: NEW.rent }],
      };
      const lease = await getLease(LEASE);
      const changes = newLeaseChanges({ lease, proposed: PROPOSED, extraction: withStep });
      const plan = buildScheduleFromExtraction(withStep, newLeaseTargets(lease, changes));
      await applyNewLeaseTerms({ leaseId: LEASE, changes, plan, extraction: withStep });

      const onBoundary = (await listEscalations(LEASE)).filter((e) => e.effective_date === NEW.start);
      expect(onBoundary.length).toBe(1); // the ±45-day guard, not two rows saying the same thing
    } finally { await restore(); }
  });

  it('adds no boundary when the new lease starts EARLIER — there is no prior era to close', async () => {
    try {
      const earlier = { ...PROPOSED, lease_start: `${Y - 2}-01-01` };
      const lease = await getLease(LEASE);
      const changes = newLeaseChanges({ lease, proposed: earlier, extraction: EXTRACTION });
      const plan = buildScheduleFromExtraction(EXTRACTION, newLeaseTargets(lease, changes));
      await applyNewLeaseTerms({ leaseId: LEASE, changes, plan, extraction: EXTRACTION });

      const escs = await listEscalations(LEASE);
      expect(escs.some((e) => e.effective_date === OLD.start)).toBe(false);
      expect(escs.some((e) => e.effective_date === `${Y - 2}-01-01`)).toBe(true);
    } finally { await restore(); }
  });
});
