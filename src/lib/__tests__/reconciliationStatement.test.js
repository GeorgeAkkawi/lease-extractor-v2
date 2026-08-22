// The year-end statement letter a tenant actually receives.
//
// ⚠ THE BUG THIS PINS IS AN ARITHMETIC CONTRADICTION INSIDE ONE DOCUMENT. `reconcileFigures`
// folds a year's CAM & tax CORRECTIONS into the estimate side — correctly, or the true-up
// charges the same dollars twice — but `reconcileCamTax` stored `est_cam`/`est_tax` as the
// PRE-correction figures beside `diff`, the post-correction one. The letter rebuilds its lines
// from those columns and computes each line's difference locally as (actual − est), while the
// TOTAL row prints the passed-in `diff`. On a $400 correction that reads:
//
//   • CAM & tax — billed $12,000.00 · actual $12,300.00 · difference +$300.00
//     TOTAL     — billed $12,000.00 · actual $12,300.00 · difference −$100.00
//     REFUND DUE TO TENANT: $100.00
//
// Two lines with identical figures and opposite differences, a refund matching neither, and
// prose saying expenses came in under estimate directly beneath a line saying they ran over.
// 0102 adds the column; this asserts the letter reads it.
import { describe, it, expect } from 'vitest';
import { buildCamReconciliationEmail } from '../emailTemplates';

const base = {
  business: { company_name: 'Amlak RE', contact_email: 'owner@example.com' },
  tenant_name: 'City Dental',
  contact_name: 'Dana Lee',
  tenant_email: 'billing@citydental.example',
  propertyName: 'Maple Plaza',
  year: 2026,
};

// The row shape the letter prints: "<label> — billed $A · actual $B · difference ±$C".
const rowsOf = (body) => body.split('\n').filter((l) => /difference/.test(l));
const diffOf = (line) => line.split('difference')[1].trim();

describe('the reconciliation statement adds up', () => {
  it('every line difference agrees with the TOTAL when a correction was billed', () => {
    // est 11,600 stored + 400 corrections = 12,000 billed; actual 12,300; diff = +300.
    const { body } = buildCamReconciliationEmail({
      ...base,
      lines: [{ label: 'CAM & tax', est: 11600 + 400, actual: 12300 }],
      camTaxAdjust: 400,
      diff: 300,
      direction: 'tenant_owes',
    });
    const rows = rowsOf(body);
    const line = rows.find((l) => /CAM & tax/.test(l));
    const total = rows.find((l) => /^TOTAL/.test(l));
    expect(diffOf(line)).toBe(diffOf(total));
    expect(line).toContain('billed $12,000.00');
    expect(total).toContain('billed $12,000.00');
  });

  it('names the correction as its own memo, without adding it a second time', () => {
    const { body } = buildCamReconciliationEmail({
      ...base,
      lines: [{ label: 'CAM & tax', est: 12000, actual: 12300 }],
      camTaxAdjust: 400,
      diff: 300,
      direction: 'tenant_owes',
    });
    expect(body).toContain('of which corrections billed during the year: +$400.00');
    // The memo sits between the line and the TOTAL, and the TOTAL still equals the line —
    // i.e. it is stated, not summed.
    const rows = rowsOf(body);
    expect(diffOf(rows.find((l) => /CAM & tax/.test(l)))).toBe(diffOf(rows.find((l) => /^TOTAL/.test(l))));
  });

  it('prints no memo row when nothing was corrected — the ordinary year is unchanged', () => {
    const { body } = buildCamReconciliationEmail({
      ...base,
      lines: [{ label: 'CAM & tax', est: 12000, actual: 11500 }],
      diff: -500,
      direction: 'landlord_owes',
    });
    expect(body).not.toContain('of which corrections');
    expect(body).toContain('REFUND DUE TO TENANT: $500.00');
    const rows = rowsOf(body);
    expect(diffOf(rows.find((l) => /^TOTAL/.test(l)))).toBe('−$500.00');
  });

  it('the prose and the arithmetic point the same way', () => {
    const { body } = buildCamReconciliationEmail({
      ...base,
      lines: [{ label: 'CAM & tax', est: 12000, actual: 12300 }],
      camTaxAdjust: 400,
      diff: 300,
      direction: 'tenant_owes',
    });
    expect(body).toContain('above the estimates you were billed');
    expect(body).toContain('BALANCE DUE: $300.00');
  });
});
