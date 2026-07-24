// CAM & tax estimate read from a bank deposit.
//  A) deriveEstimateFromDeposit — the pure arithmetic (the Boost replay + every guard).
//  B) applyStatementImport / undoStatementImport — the estimate entry writes the lease
//     estimate + stamps the confirmed year, and undo restores the prior estimate exactly.
import { describe, it, expect } from 'vitest';
import { deriveEstimateFromDeposit } from '../statementMatch';
import { applyStatementImport, undoStatementImport, getLease } from '../api';
import { currentYear } from '../format';

// A tenant whose base is $1,811.42/mo (the Boost repair), no roof, no estimate yet.
const boost = {
  baseByMonth: Array(12).fill(1811.42),
  roofByMonth: Array(12).fill(0),
  owed: Array(12).fill(2716),
  steps: [],
  square_footage: 835,
  camTaxAnnual: 0,
  anyEstimate: false,
};

describe('deriveEstimateFromDeposit', () => {
  it('backs the CAM & tax estimate out of an all-in deposit (Boost replay)', () => {
    const d = deriveEstimateFromDeposit(2716, boost, 1);
    // 2716 − 1811.42 = 904.58/mo → ×12 = 10854.96/yr (penny-exact, so the deposit
    // settles its month to the cent); $/SF ≈ 13.0000 on 835 SF.
    expect(d.monthly).toBe(904.58);
    expect(d.annual).toBe(10854.96);
    expect(d.psf.toFixed(4)).toBe('13.0000');
  });

  it('subtracts a roof-responsible tenant’s roof so it isn’t double-counted', () => {
    const roofed = { ...boost, roofByMonth: Array(12).fill(500) };
    const d = deriveEstimateFromDeposit(3216, roofed, 1); // 3216 − 1811.42 − 500 = 904.58
    expect(d.monthly).toBe(904.58);
    expect(d.annual).toBe(10854.96);
  });

  it('returns null for a month that bills no base (out of term / abated)', () => {
    const midYear = { ...boost, baseByMonth: [0, 0, 0, 0, 0, 0, 1811.42, 1811.42, 1811.42, 1811.42, 1811.42, 1811.42] };
    expect(deriveEstimateFromDeposit(2716, midYear, 3)).toBe(null); // month 3 out of term
    expect(deriveEstimateFromDeposit(2716, midYear, 7)).not.toBe(null); // month 7 in term
  });

  it('returns null when the remainder is under $1 (a gross lease / partial payment)', () => {
    expect(deriveEstimateFromDeposit(1811.42, boost, 1)).toBe(null); // deposit == base
    expect(deriveEstimateFromDeposit(1812.0, boost, 1)).toBe(null);  // 58¢ remainder
  });

  it('returns null for a deposit at the PRE-raise rate on a post-step month', () => {
    // Rent stepped $1,800 → $2,000 base in June; month 6 owed = 2000 + 904.58 est.
    const stepped = {
      ...boost,
      baseByMonth: [1800, 1800, 1800, 1800, 1800, 2000, 2000, 2000, 2000, 2000, 2000, 2000],
      owed: [2704.58, 2704.58, 2704.58, 2704.58, 2704.58, 2904.58, 2904.58, 2904.58, 2904.58, 2904.58, 2904.58, 2904.58],
      steps: [{ month: 6, base: 2000, prevBase: 1800 }],
    };
    // A deposit still at the pre-raise total (1800 + 904.58 = 2704.58) is explained by
    // the escalation — deriving off the raised 2000 base would understate the estimate.
    expect(deriveEstimateFromDeposit(2704.58, stepped, 6)).toBe(null);
    // A deposit at the CURRENT rate (2904.58) derives the same estimate, correctly.
    const d = deriveEstimateFromDeposit(2904.58, stepped, 6);
    expect(d.annual).toBe(10854.96);
  });

  it('returns null when the derived estimate already matches what’s on file', () => {
    const already = { ...boost, camTaxAnnual: 10854.96, anyEstimate: true };
    expect(deriveEstimateFromDeposit(2716, already, 1)).toBe(null);
  });

  it('guards a missing tenant / bad month', () => {
    expect(deriveEstimateFromDeposit(2716, null, 1)).toBe(null);
    expect(deriveEstimateFromDeposit(2716, boost, 0)).toBe(null);
    expect(deriveEstimateFromDeposit(2716, boost, 13)).toBe(null);
  });
});

describe('applyStatementImport — the estimate entry', () => {
  it('sets the lease estimate, stamps the year, and undo restores the prior estimate', async () => {
    const y = currentYear();
    const before = await getLease('lease-1');
    const prior = before.est_cam_annual ?? null;

    const entry = { type: 'estimate', lease_id: 'lease-1', property_id: 'prop-1', year: y, est_cam_annual: 12345.67 };
    const { import: imp } = await applyStatementImport({ propertyId: 'prop-1', year: y, fileName: 'may.csv', entries: [entry] });

    const after = await getLease('lease-1');
    expect(Number(after.est_cam_annual)).toBe(12345.67);
    expect(Number(after.est_tax_annual)).toBe(0); // the combined convention
    expect(Number(after.est_confirmed_year)).toBe(y);

    const rec = imp.applied.find((a) => a.kind === 'estimate');
    expect(rec).toBeTruthy();
    expect(rec.prior.est_cam_annual).toBe(prior); // captured for undo

    await undoStatementImport(imp);
    const restored = await getLease('lease-1');
    expect(restored.est_cam_annual ?? null).toBe(prior);
  });
});
