// Estimated CAM/tax billing + year-end reconciliation (0060). Pure math first,
// then the api-level flow against the demo mock (DEMO mode forced by the test env),
// which mirrors the live SQL — including the kind-scoped unique indexes.
//
// Demo seed (store.js), year Y = the current year, Maple Plaza building 5,000 SF:
//   lease-1 Bright Coffee — 2,000 SF (40%), roof-responsible, typed estimates
//     cam 6,500 / tax 10,000 / roof 1,500; actual share cam 7,200 / tax 10,000 /
//     roof 1,600. Its ANNUAL invoice inv-1 is already saved with the OLD snapshot
//     cam 9,000 / tax 7,500 / roof 1,600 → reconciliation runs off that snapshot:
//     actual 18,800 − billed 18,100 = +700 (tenant owes).
//   lease-2 City Dental — no estimates (bills actuals).
//   lease-3 Northwind (prop-2) — no invoice; 40% override share of taxes 40,000 /
//     cam 30,000, not roof-responsible → actual tax 16,000 / cam 12,000.
import { describe, it, expect } from 'vitest';
import { billedComponents, actualComponents, reconcileFigures } from '../reconciliation';
import {
  reconcileCamTax, getReconciliation, markReconciliationRefunded,
  draftCamReconciliationEmail, getYearInvoice, getMonthlyRent,
  listInvoices, updateLease,
} from '../api';
import { buildInvoice } from '../invoiceTemplate';
import { currentYear } from '../format';

const Y = currentYear();

const brightCoffeeShare = {
  lease_id: 'x', tenant_name: 'Bright Coffee Co.', roof_responsible: true,
  cam_amount: 7200, tax_amount: 10000, roof_amt: 1600,
  est_cam_annual: 6500, est_tax_annual: 10000, est_roof_annual: 1500,
};

describe('billedComponents — estimate-preferred per component', () => {
  it('uses each typed estimate and falls back to the actual per component', () => {
    // Only the CAM estimate typed — the known tax + roof bill from actuals.
    const b = billedComponents({ ...brightCoffeeShare, est_tax_annual: null, est_roof_annual: null });
    expect(b).toEqual({ cam: 6500, tax: 10000, roof: 1600, anyEstimate: true });
  });

  it('with no estimates it bills the actuals exactly as before', () => {
    const b = billedComponents({ ...brightCoffeeShare, est_cam_annual: null, est_tax_annual: null, est_roof_annual: null });
    expect(b).toEqual({ cam: 7200, tax: 10000, roof: 1600, anyEstimate: false });
  });

  it('never bills roof to a non-roof-responsible tenant, estimate or not', () => {
    const b = billedComponents({ ...brightCoffeeShare, roof_responsible: false });
    expect(b.roof).toBe(0);
    expect(b.anyEstimate).toBe(true); // cam/tax estimates still count
  });
});

describe('reconcileFigures — estimate vs actual', () => {
  it('tenant owes when actuals run above the estimate (roof its own line)', () => {
    const fig = reconcileFigures({ share: brightCoffeeShare, invoice: null });
    expect(fig.estTotal).toBe(18000);
    expect(fig.actualTotal).toBe(18800);
    expect(fig.diff).toBe(800);
    expect(fig.direction).toBe('tenant_owes');
    expect(fig.lines.map((l) => l.key)).toEqual(['cam', 'tax', 'roof']);
    expect(fig.lines.find((l) => l.key === 'roof').diff).toBe(100);
  });

  it('landlord owes when the estimate over-billed', () => {
    const share = { roof_responsible: false, cam_amount: 10800, tax_amount: 15000, roof_amt: 0, est_cam_annual: 12000, est_tax_annual: 15000 };
    const fig = reconcileFigures({ share, invoice: null });
    expect(fig.diff).toBe(-1200);
    expect(fig.direction).toBe('landlord_owes');
    expect(fig.lines.map((l) => l.key)).toEqual(['cam', 'tax']); // no roof line
  });

  it('within ±5¢ is even, not money owed (0055 dust convention)', () => {
    const share = { roof_responsible: false, cam_amount: 100.03, tax_amount: 0, roof_amt: 0, est_cam_annual: 100 };
    expect(reconcileFigures({ share, invoice: null }).direction).toBe('even');
  });

  it('no estimates and no invoice → est equals actual, nothing owed', () => {
    const share = { roof_responsible: true, cam_amount: 7200, tax_amount: 10000, roof_amt: 1600 };
    const fig = reconcileFigures({ share, invoice: null });
    expect(fig.diff).toBe(0);
    expect(fig.direction).toBe('even');
  });

  it('the year invoice snapshot beats the current estimate fields (what was truly billed)', () => {
    const invoice = { cam_annual: 9000, tax_annual: 7500, roof_annual: 1600 };
    const fig = reconcileFigures({ share: brightCoffeeShare, invoice });
    expect(fig.estTotal).toBe(18100);
    expect(fig.diff).toBe(700); // 18,800 actual − 18,100 billed
    expect(fig.direction).toBe('tenant_owes');
  });
});

describe('reconcileCamTax — tenant owes (Bright Coffee, invoice snapshot)', () => {
  it('creates ONE reconciliation invoice for the shortfall, never mistaken for the year invoice', async () => {
    const { recon, created } = await reconcileCamTax('lease-1', 'prop-1', Y);
    expect(created).toBe(true);
    expect(recon.direction).toBe('tenant_owes');
    expect(recon.diff).toBe(700);
    expect(recon.invoice_id).toBeTruthy();

    const invoices = await listInvoices('lease-1');
    const reconInv = invoices.find((i) => i.kind === 'reconciliation');
    expect(reconInv.total_amount).toBe(700);
    expect(reconInv.year).toBe(Y);

    // The ÷12 gotcha: the ANNUAL invoice is still "the year invoice" — the monthly
    // tracker must never divide the true-up by 12.
    const yearInv = await getYearInvoice('lease-1', Y);
    expect(yearInv.id).toBe('inv-1');
    const monthly = await getMonthlyRent('lease-1', Y);
    expect(Math.round(monthly.annual)).toBe(78100); // inv-1's figures, not 78,100 + 700
  });

  it('is idempotent — reconciling the same year again returns the existing record', async () => {
    const first = await getReconciliation('lease-1', Y);
    const { recon, created } = await reconcileCamTax('lease-1', 'prop-1', Y);
    expect(created).toBe(false);
    expect(recon.id).toBe(first.id);
    const invoices = await listInvoices('lease-1');
    expect(invoices.filter((i) => i.kind === 'reconciliation').length).toBe(1);
  });
});

describe('reconcileCamTax — landlord owes (Northwind, refund flow)', () => {
  it('records a refund owed with NO invoice, and the statement letter promises it', async () => {
    // Estimates over-billed: 14,000 + 16,000 = 30,000 vs actual 12,000 + 16,000 = 28,000.
    await updateLease('lease-3', { est_cam_annual: 14000, est_tax_annual: 16000 });
    const { recon, created } = await reconcileCamTax('lease-3', 'prop-2', Y);
    expect(created).toBe(true);
    expect(recon.direction).toBe('landlord_owes');
    expect(recon.diff).toBe(-2000);
    expect(recon.invoice_id).toBeFalsy();
    expect(recon.status).toBe('open');
    expect((await listInvoices('lease-3')).filter((i) => i.kind === 'reconciliation')).toHaveLength(0);

    const letter = await draftCamReconciliationEmail(recon);
    expect(letter.subject).toContain('CAM & Tax Reconciliation');
    expect(letter.to).toBe('accounts@northwindbooks.example');
    expect(letter.body).toContain('refund of $2,000.00');
    // Invoice-style statement document ahead of the explanation letter: the
    // billed/actual/difference table with aligned rows and the REFUND DUE row.
    expect(letter.body).toContain('RECONCILIATION STATEMENT');
    expect(letter.body).toContain('BILLED (EST.)');
    expect(letter.body).toMatch(/REFUND DUE TO TENANT\s+\$2,000\.00/);
    const rows = letter.body.split('\n').filter((l) => /^(CHARGE|CAM|Property tax|TOTAL)\s+\S/.test(l));
    expect(rows.length).toBe(4);
    expect(new Set(rows.map((l) => l.length)).size).toBe(1); // columns line up
  });

  it('mark refunded settles the record', async () => {
    const open = await getReconciliation('lease-3', Y);
    const settled = await markReconciliationRefunded(open.id);
    expect(settled.status).toBe('settled');
    expect(settled.settled_at).toBeTruthy();
  });
});

describe('invoice template — estimated labels', () => {
  const facts = {
    tenant: 'Bright Coffee Co.', property: 'Maple Plaza', year: Y, tax_year: Y - 1,
    square_footage: 2000, base_rent_annual: 60000, cam_annual: 6500, tax_annual: 10000,
    roof_annual: 1500, today: `${Y}-01-01`, due: `${Y}-01-31`,
  };

  it('tags estimated lines and adds the reconciliation note', () => {
    const text = buildInvoice({ ...facts, estimated: { cam: true, tax: true, roof: true } });
    expect(text).toContain(`Property tax (${Y - 1} est.)`);
    expect(text).toContain(`Roof (${Y} est.)`);
    expect(text).toContain('reconciled');
  });

  it('keeps every charge row aligned even with the longer est. labels', () => {
    // "Property tax (2025 est.)" outgrows the old fixed label column — the label
    // width must stretch so all four numeric columns still line up.
    const text = buildInvoice({ ...facts, estimated: { cam: true, tax: true, roof: true } });
    const rows = text.split('\n').filter((l) => /^(Base rent|CAM \(|Roof \(|Property tax \(|AMOUNT DUE)/.test(l));
    expect(rows.length).toBe(5);
    const widths = new Set(rows.map((l) => l.length));
    expect(widths.size).toBe(1); // identical width ⇒ identical column positions
  });

  it('renders exactly as before when nothing is estimated', () => {
    const text = buildInvoice(facts);
    expect(text).toContain(`Property tax (${Y - 1})`);
    expect(text).not.toContain(`Property tax (${Y - 1} est.)`);
    expect(text).not.toContain('reconciled');
  });
});
