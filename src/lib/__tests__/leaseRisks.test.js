// The free half of the lease review: risks that live in the STATE of the record rather
// than the wording of the document. No AI, no cost, and — unlike the saved AI half — they
// disappear the moment the underlying thing is fixed.
//
// Every case pins todayIso explicitly, so these stay true as the calendar moves.
import { describe, it, expect } from 'vitest';
import { computeLeaseRisks } from '../leaseRisks';

const TODAY = '2026-07-29';
// A lease with nothing wrong with it — every case below is this, with one thing broken.
const HEALTHY = {
  id: 'l1',
  base_rent: 84000,
  lease_start: '2024-01-01',
  lease_termination_date: '2029-12-31',
  is_active: true,
  roof_responsible: false,
};
const COI = { id: 'i1', insurer: 'Summit Indemnity', expiry_date: '2027-06-30', additional_insured: true };

const keys = (args) => computeLeaseRisks({ todayIso: TODAY, ...args }).map((f) => f.key);

describe('a lease with nothing wrong raises nothing', () => {
  it('stays silent', () => {
    expect(keys({ lease: HEALTHY, escalations: [], renewals: [], insurance: COI })).toEqual([]);
  });

  it('degrades safely with no lease at all', () => {
    expect(computeLeaseRisks({})).toEqual([]);
    expect(computeLeaseRisks({ lease: null })).toEqual([]);
  });
});

describe('the term', () => {
  it('flags a missing start date — the whole schedule hangs off it', () => {
    expect(keys({ lease: { ...HEALTHY, lease_start: null }, insurance: COI })).toContain('no_start_date');
  });

  it('flags a missing term end — nothing can warn, and no renewal can be confirmed', () => {
    expect(keys({ lease: { ...HEALTHY, lease_termination_date: null }, insurance: COI })).toContain('no_term_end');
  });

  it('flags holdover when an ACTIVE lease is past its term', () => {
    expect(keys({ lease: { ...HEALTHY, lease_termination_date: '2026-05-31' }, insurance: COI })).toContain('holdover');
  });

  it('does NOT call a parked lease a holdover — the landlord already knows', () => {
    const parked = { ...HEALTHY, lease_termination_date: '2026-05-31', is_active: false };
    expect(keys({ lease: parked, insurance: COI })).not.toContain('holdover');
  });

  it('flags a lease that bills nothing', () => {
    expect(keys({ lease: { ...HEALTHY, base_rent: 0 }, insurance: COI })).toContain('no_base_rent');
  });
});

describe('renewal options', () => {
  const pending = (extra) => [{ id: 'r1', status: 'pending', option_label: 'First Option', ...extra }];

  it('flags an option whose notice window belonged to an earlier term', () => {
    // The beauty-and-barber shape (2026-07-28): notice by 2008, term carried to 2030 by
    // addendums. It reads as a live decision and is not one.
    const out = keys({
      lease: { ...HEALTHY, lease_termination_date: '2030-05-31' },
      renewals: pending({ notice_by_date: '2008-09-01', term_months: 60, new_rent: 19386 }),
      insurance: COI,
    });
    expect(out).toContain('option_lapsed_r1');
    // …and NOT also flagged as below-market: a lapsed option isn't a live choice, so
    // warning about the rent it would book would be noise on top of noise.
    expect(out).not.toContain('option_below_market_r1');
  });

  it('flags a live option that would book LESS than today’s rent', () => {
    expect(keys({
      lease: HEALTHY,                                     // $84,000 today
      renewals: pending({ notice_by_date: '2029-06-30', new_rent: 60000 }),
      insurance: COI,
    })).toContain('option_below_market_r1');
  });

  it('is quiet about a renewal that raises the rent, or holds it flat', () => {
    expect(keys({ lease: HEALTHY, renewals: pending({ notice_by_date: '2029-06-30', new_rent: 90000 }), insurance: COI }))
      .not.toContain('option_below_market_r1');
    expect(keys({ lease: HEALTHY, renewals: pending({ notice_by_date: '2029-06-30', new_rent: 84000 }), insurance: COI }))
      .not.toContain('option_below_market_r1');
  });

  it('flags an option with no notice deadline — nothing can remind you', () => {
    expect(keys({ lease: HEALTHY, renewals: pending({ notice_by_date: null }), insurance: COI }))
      .toContain('option_no_notice_r1');
  });

  it('says nothing about an applied or declined option — that’s a closed record', () => {
    const closed = [
      { id: 'r1', status: 'applied', new_rent: 10 },
      { id: 'r2', status: 'declined', notice_by_date: null },
    ];
    expect(keys({ lease: HEALTHY, renewals: closed, insurance: COI })).toEqual([]);
  });
});

describe('insurance', () => {
  it('flags no certificate on file', () => {
    expect(keys({ lease: HEALTHY, insurance: null })).toContain('no_coi');
  });

  it('flags an expired certificate', () => {
    expect(keys({ lease: HEALTHY, insurance: { ...COI, expiry_date: '2026-01-31' } })).toContain('coi_expired');
  });

  it('flags a certificate that does not name the landlord — explicit no AND not stated', () => {
    expect(keys({ lease: HEALTHY, insurance: { ...COI, additional_insured: false } })).toContain('not_additional_insured');
    expect(keys({ lease: HEALTHY, insurance: { ...COI, additional_insured: null } })).toContain('not_additional_insured');
  });

  it('stays entirely silent when the caller did not load insurance', () => {
    // undefined means "the Insurance module is off, or it hasn't loaded" — reporting a
    // certificate as missing there would be a lie about data we never looked at.
    expect(keys({ lease: HEALTHY })).toEqual([]);
    expect(keys({ lease: HEALTHY, insurance: undefined })).toEqual([]);
  });
});

describe('billing shape', () => {
  it('flags roof-responsible with no roof estimate — the under-billing case', () => {
    // Infinite Mobile (2026-07-24): flagged roof-responsible, no estimate, so the roof
    // line billed a $30 actual share on top of an all-in estimate that already covered it.
    expect(keys({ lease: { ...HEALTHY, roof_responsible: true, est_roof_annual: null }, insurance: COI }))
      .toContain('roof_no_estimate');
  });

  it('accepts an explicit zero as an answer — "it’s inside the combined figure"', () => {
    expect(keys({ lease: { ...HEALTHY, roof_responsible: true, est_roof_annual: 0 }, insurance: COI }))
      .not.toContain('roof_no_estimate');
  });

  it('flags a rent step that is past due and still unapplied', () => {
    expect(keys({
      lease: HEALTHY,
      escalations: [{ id: 'e1', status: 'scheduled', effective_date: '2026-01-01' }],
      insurance: COI,
    })).toContain('rent_step_not_applied');
  });

  it('ignores a future step, an applied one, and one belonging to an unexercised option', () => {
    expect(keys({
      lease: HEALTHY,
      escalations: [
        { id: 'e1', status: 'scheduled', effective_date: '2027-01-01' },   // future
        { id: 'e2', status: 'applied', effective_date: '2025-01-01' },     // done
        { id: 'e3', status: 'scheduled', effective_date: '2030-01-01' },   // past term end
      ],
      insurance: COI,
    })).toEqual([]);
  });
});

describe('the output shape', () => {
  it('matches an AI flag, so one renderer draws both', () => {
    const [f] = computeLeaseRisks({ lease: { ...HEALTHY, base_rent: 0 }, insurance: COI, todayIso: TODAY });
    expect(f).toMatchObject({
      key: expect.any(String),
      severity: expect.stringMatching(/^(high|medium|info)$/),
      title: expect.any(String),
      note: expect.any(String),
      source: 'code',
    });
  });

  it('sorts most severe first', () => {
    const out = computeLeaseRisks({
      lease: { ...HEALTHY, lease_start: null, base_rent: 0 },   // medium + high
      insurance: COI,
      todayIso: TODAY,
    });
    expect(out[0].severity).toBe('high');
  });
});
