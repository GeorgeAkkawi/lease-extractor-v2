// The two ways a date can reach the new-lease diff without being a fact the document states,
// and what newLeaseChanges does with each. Pure — no Supabase, no React.
//
// Both matter more than they look, because lease_start becomes `boundaryIso` in
// applyNewLeaseTerms: the date the whole rent-era and CAM-era split hangs off, and the date
// that decides which months are in term at all.
import { describe, it, expect } from 'vitest';
import { newLeaseChanges, hasNoChanges, statedCamTaxAnnual } from '../newLeaseTerms';

const field = (value) => ({ value, confidence: 0.9, source_quote: '', page: 1 });
const LEASE = {
  base_rent: 84000, square_footage: 3000,
  lease_start: '2020-01-01', lease_termination_date: '2026-12-31',
  est_cam_annual: null, est_tax_annual: null, lease_type: 'net',
};

describe('newLeaseChanges — dates the document did not state', () => {
  // initialFromExtraction falls back to the SIGNING date when a lease prints no commencement
  // date (many do — it's a formula, "120 days after delivery"). On the intake FORM that is a
  // suggestion the user edits. In the upload dialog there is no field to edit, so George's
  // answer was: don't apply a guessed date at all.
  it('drops a lease start that came from the signing date, and reports it', () => {
    const extraction = { lease_start: field(null), execution_date: field('2026-03-15') };
    // What initialFromExtraction would hand over: the signing date standing in for the start.
    const proposed = { base_rent: 96000, lease_start: '2026-03-15' };
    const changes = newLeaseChanges({ lease: LEASE, proposed, extraction });

    expect(changes.fields.some((f) => f.key === 'lease_start')).toBe(false);
    expect(changes.guessedDates).toHaveLength(1);
    expect(changes.guessedDates[0].key).toBe('lease_start');
    expect(changes.guessedDates[0].value).toBe('2026-03-15');
    // The rest of the document still applies — silence on one field erases nothing else.
    expect(changes.fields.find((f) => f.key === 'base_rent').to).toBe(96000);
  });

  it('keeps a lease start the document actually prints', () => {
    const extraction = { lease_start: field('2026-07-01'), execution_date: field('2026-03-15') };
    const changes = newLeaseChanges({
      lease: LEASE, proposed: { lease_start: '2026-07-01' }, extraction,
    });
    expect(changes.guessedDates).toHaveLength(0);
    expect(changes.fields.find((f) => f.key === 'lease_start').to).toBe('2026-07-01');
  });

  it('drops an end date derived from the term length', () => {
    const extraction = { lease_termination_date: field(null), term_months: field(60) };
    const changes = newLeaseChanges({
      lease: LEASE, proposed: { lease_termination_date: '2031-06-30' }, extraction,
    });
    expect(changes.fields.some((f) => f.key === 'lease_termination_date')).toBe(false);
    expect(changes.guessedDates.map((g) => g.key)).toEqual(['lease_termination_date']);
  });

  // "April 31, 2033" is a date a model really does return, and V8 parses it happily by rolling
  // it to May 1 — so it used to go straight into a Postgres `date` column and fail the ENTIRE
  // apply with `date/time field value out of range`. With no fields in this dialog to correct
  // it in, the lease simply could not be applied at all.
  it('drops a date that is not a real day, and names what was printed', () => {
    const extraction = { lease_termination_date: field('2033-04-31') };
    const changes = newLeaseChanges({
      lease: LEASE, proposed: { base_rent: 96000, lease_termination_date: '2033-04-31' }, extraction,
    });
    expect(changes.fields.some((f) => f.key === 'lease_termination_date')).toBe(false);
    expect(changes.unusableDates).toEqual([
      { key: 'lease_termination_date', label: 'Lease end', printed: '2033-04-31' },
    ]);
    // …and the document is still applied for everything else.
    expect(changes.fields.find((f) => f.key === 'base_rent').to).toBe(96000);
  });

  it('a real end-of-month date is not mistaken for an impossible one', () => {
    const extraction = { lease_termination_date: field('2033-04-30') };
    const changes = newLeaseChanges({
      lease: LEASE, proposed: { lease_termination_date: '2033-04-30' }, extraction,
    });
    expect(changes.unusableDates).toHaveLength(0);
    expect(changes.fields.find((f) => f.key === 'lease_termination_date').to).toBe('2033-04-30');
  });
});

describe('newLeaseChanges — what counts as "nothing to update"', () => {
  // A document whose only content is a rent table printed by lease year with no placeable date
  // used to read as "nothing to update", so the dialog offered Done and the warning naming
  // those dropped steps never rendered.
  it('undated steps are something to say, not nothing', () => {
    expect(hasNoChanges({
      fields: [], escalations: 0, renewals: 0, abatements: 0, optionSteps: 0, undated: 3,
    })).toBe(false);
  });

  it('a guessed date is something to say too', () => {
    expect(hasNoChanges({
      fields: [], escalations: 0, renewals: 0, abatements: 0, optionSteps: 0, undated: 0,
      guessedDates: [{ key: 'lease_start' }], unusableDates: [],
    })).toBe(false);
  });

  it('a document that genuinely restates the lease says so', () => {
    expect(hasNoChanges({
      fields: [], escalations: 0, renewals: 0, abatements: 0, optionSteps: 0, undated: 0,
      guessedDates: [], unusableDates: [],
    })).toBe(true);
  });
});

describe('statedCamTaxAnnual', () => {
  it('sums CAM and tax into the one merged figure the app bills from', () => {
    expect(statedCamTaxAnnual({ est_cam_annual: field(9000), est_tax_annual: field(5700) })).toBe(14700);
  });

  it('a document silent on both prices nothing', () => {
    expect(statedCamTaxAnnual({ est_cam_annual: field(null), est_tax_annual: field(null) })).toBeNull();
  });

  // Deliberate, and now documented as such: the AI returns value: null for a figure it could
  // not find, so a literal 0 is far likelier to be a misread than a lease genuinely stating no
  // CAM — and applying it would zero the tenant's whole CAM & tax billing off one bad read.
  it('a stated zero is treated as silence, not as a real free-CAM clause', () => {
    expect(statedCamTaxAnnual({ est_cam_annual: field(0), est_tax_annual: field(0) })).toBeNull();
  });
});
