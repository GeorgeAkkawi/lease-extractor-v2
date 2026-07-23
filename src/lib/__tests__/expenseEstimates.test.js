// The AI extractor now also reads ESTIMATED CAM/tax charges some leases state
// ("estimated CAM charges of $4.50 per square foot per annum") — raw figure + basis
// from the model, annualized in CODE (never let the model multiply — the same rule
// the rent schedule established). These tests exercise the exact shared module the
// extract-lease edge function runs, plus the review-form prefill's rate round-trip.
import { describe, it, expect } from 'vitest';
import { estimateAnnualsFrom } from '../../../supabase/functions/_shared/rentSchedule.js';
import { initialFromExtraction } from '../../pages/LeaseNewPage';

const row = (charge, amount, period, extra = {}) =>
  ({ charge, amount, period, confidence: 0.9, source_quote: `${charge} ${amount} ${period}`, ...extra });

describe('estimateAnnualsFrom — code does the math, to the cent', () => {
  it('annualizes each basis: $/SF/yr × sqft, $/mo × 12, $/yr as-is', () => {
    const out = estimateAnnualsFrom(
      [row('cam', 4.5, 'per_sqft_year'), row('tax', 833.33, 'per_month'), row('roof', 1500, 'per_year')],
      2000
    );
    expect(out.cam).toBe(9000);
    expect(out.tax).toBe(9999.96);
    expect(out.roof).toBe(1500);
    expect(out.quotes.cam).toBe('cam 4.5 per_sqft_year');
    expect(out.confidence.cam).toBe(0.9);
  });

  it('skips what it cannot trust: unknown basis, $/SF with no sqft, junk rows', () => {
    const out = estimateAnnualsFrom(
      [row('cam', 1200, 'unknown'), row('tax', 4.5, 'per_sqft_year'), null, 'junk'],
      0 // no square footage anywhere
    );
    expect(out.cam).toBeNull(); // better no prefill than a wrong one
    expect(out.tax).toBeNull();
    expect(estimateAnnualsFrom(undefined, 2000)).toEqual({ cam: null, tax: null, roof: null, quotes: {}, confidence: {} });
  });

  it('a combined CAM+tax figure lands on cam only when no separate CAM figure exists', () => {
    const combinedOnly = estimateAnnualsFrom([row('combined', 1200, 'per_month')], 2000);
    expect(combinedOnly.cam).toBe(14400);
    expect(combinedOnly.tax).toBeNull();
    const both = estimateAnnualsFrom([row('cam', 6500, 'per_year'), row('combined', 1200, 'per_month')], 2000);
    expect(both.cam).toBe(6500); // the separate figure wins
  });

  it('the FIRST stated figure per charge wins (a later re-estimate never overrides)', () => {
    const out = estimateAnnualsFrom([row('cam', 6500, 'per_year'), row('cam', 7000, 'per_year')], 2000);
    expect(out.cam).toBe(6500);
  });
});

describe('review-form prefill — ONE combined CAM & tax $/SF rate that round-trips exactly', () => {
  const field = (value) => ({ value, confidence: 0.9, source_quote: 'q', page: 1 });

  it('sums CAM + tax annuals and divides to the rate the form multiplies back at save', () => {
    // 9,000 + 10,000 = 19,000 over 2,000 SF = $9.50/SF.
    const init = initialFromExtraction({ square_footage: field(2000), est_cam_annual: field(9000), est_tax_annual: field(10000) });
    expect(init.est_cam_tax).toBe(9.5);
  });

  it('an awkward quotient still round-trips to the stated figure to the cent', () => {
    // 10,000 / 1,077 SF has no clean 2-dp rate — the 6-dp prefill must multiply
    // back to the stated $10,000.00, not drift to $10,005.33.
    const init = initialFromExtraction({ square_footage: field(1077), est_tax_annual: field(10000) });
    expect(Math.round(init.est_cam_tax * 1077 * 100) / 100).toBe(10000);
  });

  it('with no square footage the combined annual prefills directly; no estimate stays blank', () => {
    const init = initialFromExtraction({ est_cam_annual: field(6500) });
    expect(init.est_cam_tax).toBe(6500);
    const none = initialFromExtraction({ square_footage: field(2000) });
    expect(none.est_cam_tax).toBe('');
  });
});
