// Estimated CAM/tax billing + year-end reconciliation (0060). Pure math first,
// then the api-level flow against the demo mock (DEMO mode forced by the test env),
// which mirrors the live SQL — including the kind-scoped unique indexes.
//
// Demo seed (store.js), year Y = the current year, Maple Plaza building 5,000 SF:
//   lease-1 Bright Coffee — 2,000 SF (40%), roof-responsible, typed estimates
//     cam 6,500 / tax 10,000 / roof 1,500 (= 18,000); actual share cam 7,200 /
//     tax 10,000 / roof 1,600 (= 18,800) → reconciliation compares the CURRENT
//     estimate to the actual: 18,800 − 18,000 = +800 (tenant owes). (Its ANNUAL
//     invoice inv-1 still bills/monthly-tracks the year; it isn't the recon basis.)
//   lease-2 City Dental — no estimates (bills actuals).
//   lease-3 Northwind (prop-2) — no invoice; 40% override share of taxes 40,000 /
//     cam 30,000, not roof-responsible → actual tax 16,000 / cam 12,000.
import { describe, it, expect } from 'vitest';
import { billedComponents, actualComponents, reconcileFigures } from '../reconciliation';
import {
  reconcileCamTax, getReconciliation, markReconciliationRefunded,
  undoReconciliation, undoReconciliationRefund,
  draftCamReconciliationEmail, getYearInvoice,
  listInvoices, updateLease, listHistoryEvents,
} from '../api';
import { buildInvoice } from '../invoiceTemplate';
import { currentYear } from '../format';

const Y = currentYear();

const brightCoffeeShare = {
  lease_id: 'x', tenant_name: 'Bright Coffee Co.', roof_responsible: true,
  cam_amount: 7200, tax_amount: 10000, roof_amt: 1600,
  est_cam_annual: 6500, est_tax_annual: 10000, est_roof_annual: 1500,
};

describe('billedComponents — estimate-preferred, CAM & tax combined', () => {
  it('exposes camTax = cam + tax, falling back to the actual per component', () => {
    // Only the CAM estimate typed — the known tax + roof bill from actuals; the
    // combined CAM & tax figure the tenant sees is cam + tax = 16,500.
    const b = billedComponents({ ...brightCoffeeShare, est_tax_annual: null, est_roof_annual: null });
    expect(b).toEqual({ cam: 6500, tax: 10000, camTax: 16500, roof: 1600, anyEstimate: true });
  });

  it('reads a combined estimate stored as est_cam with est_tax = 0', () => {
    // How the merged editor now saves: the whole CAM & tax figure in est_cam_annual,
    // est_tax_annual zeroed — so cam + tax reads back as exactly what was entered.
    const b = billedComponents({ ...brightCoffeeShare, est_cam_annual: 16500, est_tax_annual: 0 });
    expect(b.camTax).toBe(16500);
    expect(b.anyEstimate).toBe(true);
  });

  it('with no estimates it bills the actuals exactly as before', () => {
    const b = billedComponents({ ...brightCoffeeShare, est_cam_annual: null, est_tax_annual: null, est_roof_annual: null });
    expect(b).toEqual({ cam: 7200, tax: 10000, camTax: 17200, roof: 1600, anyEstimate: false });
  });

  it('never bills roof to a non-roof-responsible tenant, estimate or not', () => {
    const b = billedComponents({ ...brightCoffeeShare, roof_responsible: false });
    expect(b.roof).toBe(0);
    expect(b.anyEstimate).toBe(true); // cam/tax estimates still count
  });
});

describe('reconcileFigures — estimate vs actual', () => {
  it('tenant owes when actuals run above the estimate (CAM & tax one line, roof its own)', () => {
    const fig = reconcileFigures({ share: brightCoffeeShare, invoice: null });
    expect(fig.estTotal).toBe(18000);
    expect(fig.actualTotal).toBe(18800);
    expect(fig.diff).toBe(800);
    expect(fig.direction).toBe('tenant_owes');
    // CAM (6,500 est / 7,200 actual) + tax (10,000 / 10,000) reconcile as one line.
    expect(fig.lines.map((l) => l.key)).toEqual(['camtax', 'roof']);
    const camtax = fig.lines.find((l) => l.key === 'camtax');
    expect(camtax.est).toBe(16500);
    expect(camtax.actual).toBe(17200);
    expect(fig.lines.find((l) => l.key === 'roof').diff).toBe(100);
  });

  it('landlord owes when the estimate over-billed', () => {
    const share = { roof_responsible: false, cam_amount: 10800, tax_amount: 15000, roof_amt: 0, est_cam_annual: 12000, est_tax_annual: 15000 };
    const fig = reconcileFigures({ share, invoice: null });
    expect(fig.diff).toBe(-1200);
    expect(fig.direction).toBe('landlord_owes');
    expect(fig.lines.map((l) => l.key)).toEqual(['camtax']); // one combined line, no roof
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

  it('reconciles against the current estimate fields (what the Finances column shows)', () => {
    // The live view + settlement compare the tenant's CURRENT estimate to the
    // actual, so on screen Estimated − Actual always equals the Difference — no
    // hidden invoice snapshot that could disagree with what the landlord sees.
    const fig = reconcileFigures({ share: brightCoffeeShare });
    expect(fig.estTotal).toBe(18000); // 6,500 + 10,000 + 1,500 (the typed estimate)
    expect(fig.diff).toBe(800); // 18,800 actual − 18,000 estimate
    expect(fig.direction).toBe('tenant_owes');
  });
});

describe('reconcileCamTax — tenant owes (Bright Coffee, estimate vs actual)', () => {
  it('creates ONE reconciliation invoice for the shortfall, never mistaken for the year invoice', async () => {
    const { recon, created } = await reconcileCamTax('lease-1', 'prop-1', Y);
    expect(created).toBe(true);
    expect(recon.direction).toBe('tenant_owes');
    expect(recon.diff).toBe(800);
    expect(recon.invoice_id).toBeTruthy();

    const invoices = await listInvoices('lease-1');
    const reconInv = invoices.find((i) => i.kind === 'reconciliation');
    expect(reconInv.total_amount).toBe(800);
    expect(reconInv.year).toBe(Y);

    // The reconciliation true-up must never be mistaken for the year invoice: the
    // ANNUAL invoice inv-1 stays "the year invoice", distinct from the recon invoice.
    const yearInv = await getYearInvoice('lease-1', Y);
    expect(yearInv.id).toBe('inv-1');
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
    // Invoice-style statement document ahead of the explanation letter: one
    // self-labeled billed/actual/difference line per charge and the REFUND DUE line.
    expect(letter.body).toContain('RECONCILIATION STATEMENT');
    expect(letter.body).toContain('BILLED (EST.)');
    expect(letter.body).toContain('REFUND DUE TO TENANT: $2,000.00');
    // CAM & tax reconcile as ONE combined line (30,000 est vs 28,000 actual), so the
    // statement has the combined charge row + the TOTAL line (no roof for Northwind).
    const rows = letter.body.split('\n').filter((l) => /^(• CAM|TOTAL)/.test(l));
    expect(rows.length).toBe(2);
    expect(letter.body).toContain('• CAM & tax — billed $30,000.00 · actual $28,000.00');
    rows.forEach((l) => expect(l).toMatch(/billed \$[\d,.]+ · actual \$[\d,.]+ · difference/));
    // Gmail-proof: the document never relies on space-padded columns (proportional
    // fonts collapse them) — no run of two spaces anywhere in the email.
    expect(letter.body).not.toMatch(/ {2}/);
  });

  it('mark refunded settles the record', async () => {
    const open = await getReconciliation('lease-3', Y);
    const settled = await markReconciliationRefunded(open.id);
    expect(settled.status).toBe('settled');
    expect(settled.settled_at).toBeTruthy();
  });
});

describe('undoReconciliation — un-reconcile reopens the year', () => {
  it('tenant owes: deletes the record, VOIDS its invoice, leaves the annual invoice alone', async () => {
    // lease-1 was reconciled above (recon + $800 reconciliation invoice on file).
    const recon = await getReconciliation('lease-1', Y);
    expect(recon).toBeTruthy();
    await undoReconciliation(recon);

    // The year is reopened…
    expect(await getReconciliation('lease-1', Y)).toBeNull();
    // …its invoice is voided (kept, not destroyed — payments would stay attached)…
    const invoices = await listInvoices('lease-1');
    const reconInvs = invoices.filter((i) => i.kind === 'reconciliation');
    expect(reconInvs).toHaveLength(1);
    expect(reconInvs[0].display_status).toBe('void');
    // …and the ANNUAL year invoice is untouched.
    expect((await getYearInvoice('lease-1', Y)).id).toBe('inv-1');
    // The trail records the undo.
    const events = await listHistoryEvents('prop-1');
    expect(events.some((e) => e.type === 'cam_reconcile_undone')).toBe(true);
  });

  it('re-reconciling after an undo works cleanly (void frees the unique slot)', async () => {
    const { recon, created } = await reconcileCamTax('lease-1', 'prop-1', Y);
    expect(created).toBe(true);
    expect(recon.diff).toBe(800);
    // Exactly one LIVE reconciliation invoice; the voided one stays as history.
    const reconInvs = (await listInvoices('lease-1')).filter((i) => i.kind === 'reconciliation');
    expect(reconInvs.filter((i) => i.display_status !== 'void')).toHaveLength(1);
    expect(reconInvs.filter((i) => i.display_status === 'void')).toHaveLength(1);
  });

  it('refunded landlord-owes: refund undo reopens it, then full undo removes it (no invoice involved)', async () => {
    // lease-3 was marked refunded (settled) above.
    const settled = await getReconciliation('lease-3', Y);
    expect(settled.status).toBe('settled');
    const reopened = await undoReconciliationRefund(settled.id);
    expect(reopened.status).toBe('open');
    expect(reopened.settled_at).toBeNull();

    await undoReconciliation(reopened);
    expect(await getReconciliation('lease-3', Y)).toBeNull();
    expect((await listInvoices('lease-3')).filter((i) => i.kind === 'reconciliation')).toHaveLength(0);
  });
});

describe('invoice template — estimated labels', () => {
  const facts = {
    tenant: 'Bright Coffee Co.', property: 'Maple Plaza', year: Y, tax_year: Y - 1,
    square_footage: 2000, base_rent_annual: 60000, cam_annual: 6500, tax_annual: 10000,
    roof_annual: 1500, today: `${Y}-01-01`, due: `${Y}-01-31`,
  };

  it('bills CAM & property tax as one combined line and adds the reconciliation note', () => {
    const text = buildInvoice({ ...facts, estimated: { cam: true, tax: true, roof: true } });
    // CAM (6,500) and property tax (10,000) are one combined charge; no separate tax line.
    expect(text).toContain(`CAM & property tax (${Y} est.)`);
    expect(text).not.toContain('Property tax (');
    expect(text).toContain(`Roof (${Y} est.)`);
    expect(text).toContain('reconciled');
  });

  it('formats each charge as one self-labeled line that survives Gmail (proportional fonts)', () => {
    // The old space-padded columns fell apart in Gmail's compose window / received
    // mail (proportional fonts collapse runs of spaces). Every charge is now one
    // line carrying all four unit-labeled figures, with no alignment to break.
    const text = buildInvoice({ ...facts, estimated: { cam: true, tax: true, roof: true } });
    const rows = text.split('\n').filter((l) => l.startsWith('• '));
    expect(rows.length).toBe(3); // base rent, CAM & property tax, roof
    rows.forEach((l) => expect(l).toMatch(/\$[\d,.]+\/mo · \$[\d,.]+\/yr · \$[\d,.]+\/SF\/mo · \$[\d,.]+\/SF\/yr$/));
    // Total unchanged — the combined CAM & tax line carries both figures (6,500 + 10,000).
    expect(text).toContain('AMOUNT DUE: $78,000.00/yr ($6,500.00/mo)');
    expect(text).not.toMatch(/ {2}/); // never relies on space-padding
  });

  it('still combines CAM & property tax into one line when nothing is a typed estimate', () => {
    const text = buildInvoice(facts);
    expect(text).toContain(`CAM & property tax (${Y} est.)`);
    expect(text).not.toContain('Property tax (');
    expect(text).not.toContain('reconciled'); // note only when a typed estimate is set
  });
});
