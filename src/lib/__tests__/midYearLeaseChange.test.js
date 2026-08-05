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
  listEscalations, getMonthlyRent, getYearInvoice, getTenantShare,
} from '../api';
import { newLeaseChanges, newLeaseTargets } from '../newLeaseTerms';
import { monthlyEstimates, reconcileFigures } from '../reconciliation';
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
// ⚠ THE EXTRACTION MUST STATE THE DATES THE PROPOSED CLAIMS. In the app these are one object
// (`proposed` is initialFromExtraction(extraction)), so they cannot disagree — and
// newLeaseChanges now drops a date the document didn't actually print, because
// initialFromExtraction falls back to the SIGNING date and this dialog has no field to correct
// a guess in (George, 2026-08-05: don't apply a guessed date at all). A fixture that states a
// start on one side and not the other is the shape of a lease with no printed commencement
// date, which is not what these cases are about.
const EXTRACTION = {
  escalations: [], renewal_options: [], abatements: [],
  lease_start: { value: NEW.start, confidence: 0.9, source_quote: '', page: 1 },
  lease_termination_date: { value: NEW.end, confidence: 0.9, source_quote: '', page: 1 },
};

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

  // The CAM half of George's rule: *"the CAM is recalculated. the previous months aren't
  // affected."* The estimate is a scalar on the lease, so before 0089 raising it here
  // re-priced January retroactively — and the year-end reconcile settled all twelve months
  // at the new figure.
  it('dates the CAM & tax estimate too, so the earlier months keep the old one', async () => {
    try {
      await updateLease(LEASE, { est_cam_annual: 12000, est_tax_annual: 0 });
      const lease = await getLease(LEASE);
      const proposed = { ...PROPOSED };
      const withEst = { ...EXTRACTION, est_cam_annual: { value: 24000 } };
      const changes = newLeaseChanges({ lease, proposed, extraction: withEst });
      const plan = buildScheduleFromExtraction(withEst, newLeaseTargets(lease, changes));
      await applyNewLeaseTerms({ leaseId: LEASE, changes, plan, extraction: withEst });

      const { data: est } = await supabase.from('lease_estimates').select('*').eq('lease_id', LEASE);
      expect(Number(est.find((e) => e.effective_date === OLD.start)?.cam_tax_annual)).toBe(12000);
      expect(Number(est.find((e) => e.effective_date === NEW.start)?.cam_tax_annual)).toBe(24000);

      // Six months at $12,000/yr + six at $24,000/yr = $18,000 for the year — not the
      // $24,000 that reading today's scalar across all twelve months produces.
      const share = await getTenantShare(LEASE, Y);
      const months = monthlyEstimates(est, share, Y);
      expect(months.camTax[0]).toBe(12000);
      expect(months.camTax[11]).toBe(24000);
      expect(reconcileFigures({ share, estimates: est, year: Y }).est.cam).toBe(18000);
    } finally {
      await supabase.from('lease_estimates').delete().eq('lease_id', LEASE);
      await updateLease(LEASE, { est_cam_annual: null, est_tax_annual: null });
      await restore();
    }
  });

  // ── §4 ────────────────────────────────────────────────────────────────────────────────
  // The closing row's SECOND job is pulling occupancyStart back to the real move-in, and that
  // is needed whenever the start moves forward — whatever the rent did. Gated on a rent
  // change (as it first was), a renewal at the SAME rent commencing later wrote nothing at
  // all: every earlier month fell out of term, owed 0, and the year's invoice was rebuilt
  // covering only July onward.
  it('keeps the earlier months in term when the start moves but the rent does NOT', async () => {
    try {
      const sameRent = { ...PROPOSED, base_rent: OLD.rent };
      const lease = await getLease(LEASE);
      const changes = newLeaseChanges({ lease, proposed: sameRent, extraction: EXTRACTION });
      // The rent really is unchanged — if this ever starts failing, the case has evaporated.
      expect(changes.fields.some((f) => f.key === 'base_rent')).toBe(false);
      const plan = buildScheduleFromExtraction(EXTRACTION, newLeaseTargets(lease, changes));
      await applyNewLeaseTerms({ leaseId: LEASE, changes, plan, extraction: EXTRACTION });

      // A closing row at the OLD start, carrying the (unchanged) rent, applied.
      const closing = (await listEscalations(LEASE)).find((e) => e.effective_date === OLD.start);
      expect(closing).toBeTruthy();
      expect(closing.status).toBe('applied');
      expect(Number(closing.new_base_rent)).toBe(OLD.rent);
      // …and no second row saying the same figure again at the boundary.
      expect((await listEscalations(LEASE)).filter((e) => e.effective_date === NEW.start)).toHaveLength(0);

      // The point of all of it: January is still in term and still owes.
      const mr = await getMonthlyRent(LEASE, Y);
      expect(mr.schedule[1].outsideTerm).toBeFalsy();
      expect(Number(mr.schedule[1].owed)).toBeGreaterThan(0);
      expect(mr.byMonth[1]).toBeTruthy();
    } finally { await restore(); }
  });

  // ── §2 ────────────────────────────────────────────────────────────────────────────────
  // The commonest shape of the change — a lease going from NO estimate to one — used to get
  // no closing row (there was no prior figure to put on it), so monthlyEstimates fell back to
  // the live scalar and re-billed January at the new estimate. Those months were billed at
  // the tenant's ACTUAL share, and that is what they must keep being billed at.
  it('leaves the months before it on the ACTUAL share when there was no estimate before', async () => {
    try {
      await updateLease(LEASE, { est_cam_annual: null, est_tax_annual: null });
      const lease = await getLease(LEASE);
      const withEst = { ...EXTRACTION, est_cam_annual: { value: 24000 } };
      const changes = newLeaseChanges({ lease, proposed: PROPOSED, extraction: withEst });
      const plan = buildScheduleFromExtraction(withEst, newLeaseTargets(lease, changes));
      await applyNewLeaseTerms({ leaseId: LEASE, changes, plan, extraction: withEst });

      const { data: est } = await supabase.from('lease_estimates').select('*').eq('lease_id', LEASE);
      const closing = est.find((e) => e.effective_date === OLD.start);
      // The closing row exists, carries NO figure, and says so explicitly (0090).
      expect(closing).toBeTruthy();
      expect(closing.cam_tax_annual).toBeNull();
      expect(closing.cam_tax_none).toBe(true);

      const share = await getTenantShare(LEASE, Y);
      const actualCamTax = Number(share.cam_amount || 0) + Number(share.tax_amount || 0);
      const months = monthlyEstimates(est, share, Y);
      expect(months.camTax[0]).toBe(actualCamTax);  // January — no estimate, so the actual
      expect(months.camTax[11]).toBe(24000);        // December — the new lease's estimate
      // Not the $24,000 that reading today's scalar across all twelve months produces.
      expect(reconcileFigures({ share, estimates: est, year: Y }).est.cam)
        .toBeCloseTo((actualCamTax * 6 + 24000 * 6) / 12, 2);
    } finally {
      await supabase.from('lease_estimates').delete().eq('lease_id', LEASE);
      await updateLease(LEASE, { est_cam_annual: null, est_tax_annual: null });
      await restore();
    }
  });

  // ── §3 ────────────────────────────────────────────────────────────────────────────────
  // Number(null) is 0 and Number.isFinite(0) is true, so a lease with no roof estimate had an
  // invented roof_annual: 0 written onto both rows — building a roof series where none should
  // exist and pricing every pre-boundary month at NO roof for a roof-responsible tenant.
  it('writes no roof figure at all when the lease carries no roof estimate', async () => {
    try {
      await updateLease(LEASE, { est_cam_annual: 12000, est_tax_annual: 0, est_roof_annual: null, roof_responsible: true });
      const lease = await getLease(LEASE);
      const withEst = { ...EXTRACTION, est_cam_annual: { value: 24000 } };
      const changes = newLeaseChanges({ lease, proposed: PROPOSED, extraction: withEst });
      const plan = buildScheduleFromExtraction(withEst, newLeaseTargets(lease, changes));
      await applyNewLeaseTerms({ leaseId: LEASE, changes, plan, extraction: withEst });

      const { data: est } = await supabase.from('lease_estimates').select('*').eq('lease_id', LEASE);
      expect(est.length).toBeGreaterThan(0);
      for (const r of est) expect(r.roof_annual).toBeNull();

      // With no roof rows, every month falls back to the live figure — which, with no roof
      // estimate on the lease, IS the tenant's actual roof share. Never 0.
      const share = await getTenantShare(LEASE, Y);
      const months = monthlyEstimates(est, share, Y);
      expect(months.roof[0]).toBe(Number(share.roof_amt || 0));
      expect(months.roof[0]).not.toBe(0);
    } finally {
      await supabase.from('lease_estimates').delete().eq('lease_id', LEASE);
      await updateLease(LEASE, { est_cam_annual: null, est_tax_annual: 0, est_roof_annual: null, roof_responsible: false });
      await restore();
    }
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
