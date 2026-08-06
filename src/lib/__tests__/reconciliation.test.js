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
import { inTermMonths } from '../leaseSchedule';
import { currentYear } from '../format';

const Y = currentYear();
const round = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

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
    // toMatchObject, not toEqual: 0073 added base/total/gross/clamped alongside these.
    expect(b).toMatchObject({ cam: 6500, tax: 10000, camTax: 16500, roof: 1600, anyEstimate: true, gross: false });
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
    expect(b).toMatchObject({ cam: 7200, tax: 10000, camTax: 17200, roof: 1600, anyEstimate: false, gross: false });
  });

  it('never bills roof to a non-roof-responsible tenant, estimate or not', () => {
    const b = billedComponents({ ...brightCoffeeShare, roof_responsible: false });
    expect(b.roof).toBe(0);
    expect(b.anyEstimate).toBe(true); // cam/tax estimates still count
  });
});

// George, 2026-07-30, on Card Pop: "if the actual was ten thousand, it would show that
// there's a difference of ten thousand … you would subtract ten thousand from the forty
// two thousand to get thirty two thousand, and then thirty two thousand per year would
// be the new base rent."
describe('billedComponents — a GROSS lease carves expenses OUT of the flat rent', () => {
  // Card Pop's real shape: 1,800 SF at Joliet on a flat $3,500/mo.
  const cardPop = {
    lease_id: 'cp', tenant_name: 'Card Pop', lease_type: 'gross',
    base_rent: 42000, square_footage: 1800, roof_responsible: false,
    cam_amount: 6000, tax_amount: 4000, roof_amt: 0,
  };

  it('is George’s arithmetic exactly: $42,000 flat − $10,000 share = $32,000 base', () => {
    const b = billedComponents(cardPop);
    expect(b.camTax).toBe(10000);
    expect(b.base).toBe(32000);
    expect(b.total).toBe(42000);
    expect(b.gross).toBe(true);
  });

  it('holds the total steady as the actuals move — only the split shifts', () => {
    // The whole point: the tenant pays the same flat figure whatever the expenses turn
    // out to be, so a $3,500 deposit settles its month at every stage of the year.
    for (const [cam, tax] of [[0, 0], [3000, 2000], [9000, 6000]]) {
      const b = billedComponents({ ...cardPop, cam_amount: cam, tax_amount: tax });
      expect(b.total).toBe(42000);
      expect(b.base + b.camTax + b.roof).toBeCloseTo(42000, 2);
    }
  });

  it('IGNORES a stale estimate left on the lease', () => {
    // A lease flipped to gross may still carry est_* from when it billed net. Reading it
    // would bill an estimate on top of a rent that already includes the expenses.
    const b = billedComponents({ ...cardPop, est_cam_annual: 25000, est_tax_annual: 0 });
    expect(b.camTax).toBe(10000);   // the ACTUAL share, not the 25,000 estimate
    expect(b.base).toBe(32000);
    expect(b.anyEstimate).toBe(false); // → Difference dormant, ⚖ Reconcile hidden
  });

  it('carves roof out too, on a roof-responsible gross tenant', () => {
    const b = billedComponents({ ...cardPop, roof_responsible: true, roof_amt: 1200 });
    expect(b.roof).toBe(1200);
    expect(b.camTax).toBe(10000);
    expect(b.base).toBe(30800);
    expect(b.total).toBe(42000);
  });

  it('clamps at $0 base when the share exceeds the flat rent, and says so', () => {
    // The flat rent is the ceiling — the landlord absorbs the excess. Base must never
    // go negative or the base+camTax+roof === owed invariant breaks downstream.
    const b = billedComponents({ ...cardPop, cam_amount: 40000, tax_amount: 15000 });
    expect(b.base).toBe(0);
    expect(b.camTax).toBe(42000);
    expect(b.total).toBe(42000);
    expect(b.clamped).toBe(true);
  });

  it('leaves a net lease completely untouched', () => {
    const net = billedComponents({ ...cardPop, lease_type: 'net' });
    const legacy = billedComponents({ ...cardPop, lease_type: null });
    expect(net.base).toBe(42000);          // the rent itself
    expect(net.total).toBe(52000);         // + the share billed on top
    expect(net.gross).toBe(false);
    expect(legacy).toEqual(net);           // null reads as net — every existing row
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

  // A tenant who moved in mid-year is BILLED only the months it occupied — the invoice
  // proration loop (resyncYearBillingToEstimate / draft-invoice) skips every outsideTerm
  // month. This used to settle the WHOLE year's gap against that part-year bill, so a
  // half-year tenancy was trued up at exactly twice the right figure. Both sides now
  // prorate by the same in-term count the invoice used.
  describe('a lease that only ran part of the year settles on the months it was here', () => {
    // 6 months in term. Estimate $12,000/yr → billed $6,000. Actual share $18,000/yr.
    const halfYear = { roof_responsible: false, cam_amount: 18000, tax_amount: 0, roof_amt: 0, est_cam_annual: 12000, est_tax_annual: 0 };

    it('charges the IN-TERM gap, not the full-year one', () => {
      const fig = reconcileFigures({ share: halfYear, inTerm: 6 });
      expect(fig.estTotal).toBe(6000);   // what was actually billed
      expect(fig.actualTotal).toBe(9000); // 6 months of an $18,000/yr share
      expect(fig.diff).toBe(3000);        // NOT 6,000 — that was the bug
      expect(fig.direction).toBe('tenant_owes');
      expect(fig.inTerm).toBe(6);
    });

    it('prorates a refund the same way', () => {
      const over = { roof_responsible: false, cam_amount: 6000, tax_amount: 0, roof_amt: 0, est_cam_annual: 12000, est_tax_annual: 0 };
      const fig = reconcileFigures({ share: over, inTerm: 6 });
      expect(fig.diff).toBe(-3000); // billed 6,000, owed 3,000 → refund 3,000 (not 6,000)
      expect(fig.direction).toBe('landlord_owes');
    });

    it('prorates roof on its own line too', () => {
      const withRoof = { roof_responsible: true, cam_amount: 0, tax_amount: 0, roof_amt: 2400, est_cam_annual: 0, est_tax_annual: 0, est_roof_annual: 1200 };
      const roofLine = reconcileFigures({ share: withRoof, inTerm: 3 }).lines.find((l) => l.key === 'roof');
      expect(roofLine.est).toBe(300);    // 1,200 × 3/12
      expect(roofLine.actual).toBe(600); // 2,400 × 3/12
      expect(roofLine.diff).toBe(300);
    });

    it('does NOT prorate a posted CAM & tax correction — it is dollars already billed', () => {
      // $500 correction charged in full, on top of 6 months of the $12,000 estimate.
      const fig = reconcileFigures({
        share: halfYear, inTerm: 6,
        adjustments: [{ kind: 'camtax', amount: 500 }],
      });
      expect(fig.camTaxAdjust).toBe(500);
      expect(fig.estTotal).toBe(6500); // 6,000 prorated + 500 posted in full
      expect(fig.diff).toBe(2500);
    });

    it('a full-year lease is untouched to the cent (inTerm 12 = the old figures)', () => {
      const full = reconcileFigures({ share: brightCoffeeShare, inTerm: 12 });
      const dflt = reconcileFigures({ share: brightCoffeeShare });
      expect(full.diff).toBe(800);
      expect(full.estTotal).toBe(18000);
      expect(full.actualTotal).toBe(18800);
      expect(dflt.diff).toBe(full.diff); // omitting inTerm still means the whole year
    });
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

describe('inTermMonths — the count both the invoice and the reconciliation prorate by', () => {
  it('is 12 for a lease that covers the whole year', () => {
    expect(inTermMonths({ year: Y, leaseStart: `${Y - 2}-01-01`, escalations: [] })).toBe(12);
  });

  it('counts only the months a mid-year tenancy was here', () => {
    expect(inTermMonths({ year: Y, leaseStart: `${Y}-07-01`, escalations: [] })).toBe(6);
    expect(inTermMonths({ year: Y, leaseStart: `${Y}-10-15`, escalations: [] })).toBe(3);
  });

  it('is 12 when the start is unknown — the safe, unchanged default', () => {
    expect(inTermMonths({ year: Y, leaseStart: null, escalations: [] })).toBe(12);
  });

  it('reads the earliest APPLIED step, so a catch-up renewal does not look like a new tenancy', () => {
    // lease_start moved forward to July by a renewal, but the tenant has been paying since
    // Y-3. Read lease_start alone and its year-end settlement would be halved.
    const escalations = [{ status: 'applied', effective_date: `${Y - 3}-01-01`, new_base_rent: 50000 }];
    expect(inTermMonths({ year: Y, leaseStart: `${Y}-07-01`, escalations })).toBe(12);
    // A SCHEDULED step is not evidence of occupancy — it says nothing about being here yet.
    const scheduled = [{ status: 'scheduled', effective_date: `${Y - 3}-01-01`, new_base_rent: 50000 }];
    expect(inTermMonths({ year: Y, leaseStart: `${Y}-07-01`, escalations: scheduled })).toBe(6);
  });
});

describe('reconcileCamTax — a mid-year tenancy settles on its own months (Sunrise Yoga)', () => {
  // Oak Center is 6,000 SF; Sunrise Yoga is 1,000 SF (a 1/6 share) and moved in 1 July, so
  // its invoice bills SIX months of the estimate. Actual share of FY expenses:
  // CAM 30,000/6 = 5,000 + tax 40,000/6 = 6,666.67 → 11,666.67 for a full year.
  it('trues up half a year, not the whole one', async () => {
    await updateLease('lease-4', { est_cam_annual: 12000, est_tax_annual: 0, est_confirmed_year: Y });
    const { recon } = await reconcileCamTax('lease-4', 'prop-2', Y);
    // Billed: 12,000 × 6/12 = 6,000. Owed: 2,500 CAM + 3,333.34 tax = 5,833.34.
    expect(recon.est_cam).toBe(6000);
    expect(round(recon.actual_cam + recon.actual_tax)).toBe(5833.34);
    // The full-year gap is −333.33; half a year of it is −166.66. Charging the whole
    // difference against a half-year bill is the bug this pins.
    expect(round(recon.diff)).toBe(-166.66);
    expect(recon.direction).toBe('landlord_owes');
  });

  it('records the part-year basis in History so the figure is explicable', async () => {
    const events = await listHistoryEvents('prop-2');
    const ev = (events || []).find((e) => e.type === 'cam_reconciled' && e.lease_id === 'lease-4');
    expect(ev.description).toContain('6 of 12 months in term');
    expect(ev.meta.in_term_months).toBe(6);
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
