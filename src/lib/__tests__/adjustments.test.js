// Per-month charges and credits — the tenant sub-ledger (0082).
//
// ⚠ THE TWO TESTS THIS FILE EXISTS FOR are near the bottom, and they are the two a
// naive test cannot fail on. "The invoice total moved by $400" passes whether or not
// the feature quietly manufactures a payment or hides the charge — the same shape as
// `expect(blob.size).toBeGreaterThan(4000)` "verifying" a corrupt workbook. So:
//   ① post a +$400 charge on an ALREADY system-marked month → NOT ONE payment row's
//      amount changed (an adjustment never claims money arrived), and
//   ② owesToDate reports $400 (a charge on a paid month is not invisible).
// Both are byte-identical to the old behaviour when there are no adjustments, which is
// why the other 1,479 tests stay green.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ADJUSTMENT_KINDS, adjustmentKindInfo, adjustmentKindsFor, adjustmentAllowed,
  signedAmount, monthlyAdjustments, adjustmentsForMonth, adjustmentTotal,
  camTaxAdjustmentTotal, statementRows, monthName,
} from '../adjustments';
import { buildLeaseSchedule } from '../leaseSchedule';
import { allocatePayments, componentizeSchedule, ledgerRowSummary } from '../ledger';
import { reconcileFigures } from '../reconciliation';
import {
  addAdjustment, deleteAdjustment, listAdjustments, ensureInvoice, getYearInvoice,
  listPayments, markMonthPaid, unmarkMonthPaid, updateLease, getMonthlyRent,
  getTenantShare, getPropertyMonthlyRoll,
} from '../api';
import { currentYear } from '../format';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const Y = currentYear();

// ---------------------------------------------------------------- pure vocabulary

describe('the adjustment registry', () => {
  it('every kind has a unique key, a label and a direction', () => {
    const keys = ADJUSTMENT_KINDS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ADJUSTMENT_KINDS) {
      expect(k.label).toBeTruthy();
      expect(['both', 'charge', 'credit']).toContain(k.dir);
    }
  });

  it('an unknown kind reports itself unknown and never offsets the year-end true-up', () => {
    const info = adjustmentKindInfo('written_by_a_later_round');
    expect(info.unknown).toBe(true);
    expect(info.offsetsCamTax).toBe(false);
    // …but its AMOUNT still counts toward the month. Dropping it would break
    // base + camTax + roof + adj === owed between two bundles.
    expect(monthlyAdjustments([{ month: 3, kind: 'written_by_a_later_round', amount: 400 }])[2]).toBe(400);
    expect(camTaxAdjustmentTotal([{ month: 3, kind: 'written_by_a_later_round', amount: 400 }])).toBe(0);
  });

  it('a GROSS lease is refused the CAM & tax correction, and keeps the other three', () => {
    // The flat rent already CONTAINS taxes & CAM and the share is carved OUT of it
    // (0073) — a CAM correction there re-adds on top of a rent that already includes it.
    expect(adjustmentAllowed('camtax', { gross: true })).toBe(false);
    expect(adjustmentAllowed('camtax', { gross: false })).toBe(true);
    const keys = adjustmentKindsFor({ gross: true }).map((k) => k.key);
    expect(keys).toEqual(['base', 'fee', 'credit']);
    expect(adjustmentKindsFor({ gross: false })).toHaveLength(4);
  });

  it('a kind locked to one direction wins over the charge/credit pick', () => {
    // A late fee can never be stored as a credit by a stray toggle, and vice versa.
    expect(signedAmount({ kind: 'fee', amount: 250, direction: 'credit' })).toBe(250);
    expect(signedAmount({ kind: 'credit', amount: 250, direction: 'charge' })).toBe(-250);
    // A both-way kind honours the pick.
    expect(signedAmount({ kind: 'camtax', amount: 400, direction: 'charge' })).toBe(400);
    expect(signedAmount({ kind: 'camtax', amount: 400, direction: 'credit' })).toBe(-400);
    expect(signedAmount({ kind: 'base', amount: 0 })).toBe(0);
  });

  it('sums by month, by kind, and for the year', () => {
    const rows = [
      { id: 'a', month: 3, kind: 'camtax', amount: 400 },
      { id: 'b', month: 3, kind: 'credit', amount: -150 },
      { id: 'c', month: 7, kind: 'fee', amount: 75 },
    ];
    const arr = monthlyAdjustments(rows);
    expect(arr[2]).toBe(250);
    expect(arr[6]).toBe(75);
    expect(arr.filter((v) => v !== 0)).toHaveLength(2);
    expect(adjustmentTotal(rows)).toBe(325);
    expect(camTaxAdjustmentTotal(rows)).toBe(400); // only the CAM & tax correction
    expect(adjustmentsForMonth(rows, 3)).toHaveLength(2);
    expect(monthName(3)).toBe('March');
  });
});

// ---------------------------------------------------------------- the money math

describe('adjustments in the schedule', () => {
  const base = { year: Y, grossBase: 120000, otherAnnual: 12000, abatements: [], escalations: [], leaseStart: `${Y - 2}-01-01` };

  it('projection mode adds the exact dollar figure to its own month, and nothing else', () => {
    const plain = buildLeaseSchedule(base);
    const withAdj = buildLeaseSchedule({ ...base, adjustments: [{ month: 3, kind: 'camtax', amount: 400 }] });
    expect(round2(withAdj.schedule[3].owed - plain.schedule[3].owed)).toBe(400);
    for (const m of [1, 2, 4, 12]) expect(withAdj.schedule[m].owed).toBe(plain.schedule[m].owed);
    expect(round2(withAdj.annual - plain.annual)).toBe(400);
    expect(withAdj.factor).toBe(1);
  });

  it('reconcile-to-a-bill keeps the charge exact — never smeared across twelve months', () => {
    // The invoice total already CONTAINS Σadj, so the SCHEDULED part scales to
    // total − Σadj. Get that wrong and a one-month $400 charge re-prices every month.
    const plain = buildLeaseSchedule(base);
    const invoiceTotal = round2(plain.annual + 400);
    const r = buildLeaseSchedule({ ...base, invoiceTotal, adjustments: [{ month: 3, kind: 'camtax', amount: 400 }] });
    expect(r.factor).toBe(1); // the scheduled part didn't have to move at all
    expect(round2(r.schedule[3].owed - plain.schedule[3].owed)).toBe(400);
    expect(r.schedule[1].owed).toBe(plain.schedule[1].owed);
    // …and the twelve months still settle the bill to the cent.
    const sum = round2(Object.values(r.schedule).reduce((s, c) => s + c.owed, 0));
    expect(sum).toBe(invoiceTotal);
  });

  it('the penny-fold never lands on a month that owes only because of a charge', () => {
    // A mid-year lease + an awkward total forces a real fold. The fold must land on a
    // SCHEDULED month, or base + camTax + roof + adj === owed breaks by those cents.
    const mid = { year: Y, grossBase: 100000, otherAnnual: 5000, abatements: [], escalations: [], leaseStart: `${Y}-07-01` };
    const plain = buildLeaseSchedule(mid);
    const invoiceTotal = round2(plain.annual + 0.07 + 250);
    const r = buildLeaseSchedule({ ...mid, invoiceTotal, adjustments: [{ month: 2, kind: 'fee', amount: 250 }] });
    // February is out of term — it owes exactly the fee, not the fee plus fold-cents.
    expect(r.schedule[2].owed).toBe(250);
    expect(round2(Object.values(r.schedule).reduce((s, c) => s + c.owed, 0))).toBe(invoiceTotal);
  });
});

describe('base + camTax + roof + adj === owed, every month', () => {
  const check = (schedule, comp, adj) => {
    for (let m = 1; m <= 12; m++) {
      const c = comp[m];
      expect(round2(c.base + c.camTax + c.roof + c.adj)).toBe(round2(schedule[m].owed));
      expect(c.adj).toBe(round2(Number(adj?.[m - 1]) || 0));
    }
  };

  it('holds on an ordinary year', () => {
    const rows = [{ month: 3, kind: 'camtax', amount: 400 }, { month: 9, kind: 'credit', amount: -150 }];
    const { schedule, adjustments } = buildLeaseSchedule({
      year: Y, grossBase: 120000, otherAnnual: 12000, abatements: [], escalations: [], leaseStart: `${Y - 2}-01-01`, adjustments: rows,
    });
    check(schedule, componentizeSchedule({ schedule, camTaxAnnual: 12000, roofAnnual: 0, adjustments }), adjustments);
  });

  it('holds on a FREE month — and a charge there is not printed as CAM & tax', () => {
    // The 'free' branch absorbs the whole owed into CAM & tax (base is $0 by
    // construction). Read the ADJUSTED owed there and a +$400 charge would print as an
    // invented $400 of CAM & tax expense.
    const abatements = [{ start_date: `${Y}-01-01`, end_date: `${Y}-03-31`, kind: 'free', value: null }];
    const rows = [{ month: 2, kind: 'fee', amount: 400 }];
    const { schedule, adjustments } = buildLeaseSchedule({
      year: Y, grossBase: 120000, otherAnnual: 12000, abatements, escalations: [], leaseStart: `${Y - 2}-01-01`, adjustments: rows,
    });
    const comp = componentizeSchedule({ schedule, camTaxAnnual: 12000, roofAnnual: 0, adjustments });
    expect(comp[2].base).toBe(0);
    expect(comp[2].camTax).toBe(comp[1].camTax); // unchanged by the fee
    expect(comp[2].adj).toBe(400);
    check(schedule, comp, adjustments);
  });

  it('holds on a mid-year start, where the charge lands out of term', () => {
    const rows = [{ month: 2, kind: 'fee', amount: 250 }];
    const { schedule, adjustments } = buildLeaseSchedule({
      year: Y, grossBase: 96000, otherAnnual: 6000, abatements: [], escalations: [], leaseStart: `${Y}-07-01`, adjustments: rows,
    });
    const comp = componentizeSchedule({ schedule, camTaxAnnual: 6000, roofAnnual: 0, adjustments });
    expect(comp[2]).toEqual({ base: 0, camTax: 0, roof: 0, adj: 250 });
    check(schedule, comp, adjustments);
  });
});

describe('coverage — the rule that keeps a charge visible', () => {
  const owed = Array(12).fill(1000);

  it('a settled month still reads "paid = paid" for a plain payment difference', () => {
    const a = allocatePayments({ owedByMonth: owed, payments: [{ amount: 800, period_month: 1, paid_date: `${Y}-01-05` }] });
    expect(a.states[0]).toBe('covered');
    expect(a.coverage[0]).toBe(1000); // the bill is satisfied whatever the cheque was
  });

  it('but a CHARGE posted on that same month is not covered by it', () => {
    const adj = Array(12).fill(0);
    adj[0] = 400;
    const withAdj = owed.map((o, i) => round2(o + adj[i]));
    const pay = [{ amount: 1000, period_month: 1, paid_date: `${Y}-01-05` }];
    const a = allocatePayments({ owedByMonth: withAdj, payments: pay, adjustments: adj });
    expect(a.owed[0]).toBe(1400);
    expect(a.coverage[0]).toBe(1000); // ← the scheduled bill only
    // Measured as the DELTA against the same year with no charge on it, so the other
    // eleven unpaid months (which legitimately owe) don't drown the signal.
    const base = ledgerRowSummary({ year: Y, owedByMonth: owed, allocation: allocatePayments({ owedByMonth: owed, payments: pay }), today: new Date(`${Y}-12-15T12:00:00`) });
    const s = ledgerRowSummary({ year: Y, owedByMonth: withAdj, allocation: a, today: new Date(`${Y}-12-15T12:00:00`) });
    expect(round2(s.owesToDate - base.owesToDate)).toBe(400);
  });

  it('a lump that pays the charge down settles the month', () => {
    const adj = Array(12).fill(0);
    adj[0] = 400;
    const withAdj = owed.map((o, i) => round2(o + adj[i]));
    const a = allocatePayments({
      owedByMonth: withAdj,
      payments: [
        { amount: 1000, period_month: 1, paid_date: `${Y}-01-05` },
        { amount: 400, paid_date: `${Y}-02-05` }, // untagged
      ],
      adjustments: adj,
    });
    expect(a.coverage[0]).toBe(1400);
    const pay1 = [{ amount: 1000, period_month: 1, paid_date: `${Y}-01-05` }];
    const base = ledgerRowSummary({ year: Y, owedByMonth: owed, allocation: allocatePayments({ owedByMonth: owed, payments: pay1 }), today: new Date(`${Y}-12-15T12:00:00`) });
    const s = ledgerRowSummary({ year: Y, owedByMonth: withAdj, allocation: a, today: new Date(`${Y}-12-15T12:00:00`) });
    expect(round2(s.owesToDate - base.owesToDate)).toBe(0); // the lump closed it
  });

  it('a CREDIT lowers what is owed and the month still reads settled', () => {
    const adj = Array(12).fill(0);
    adj[0] = -150;
    const withAdj = owed.map((o, i) => round2(o + adj[i]));
    const a = allocatePayments({ owedByMonth: withAdj, payments: [{ amount: 850, period_month: 1, paid_date: `${Y}-01-05` }], adjustments: adj });
    expect(a.owed[0]).toBe(850);
    expect(a.coverage[0]).toBe(850);
    const pay = [{ amount: 850, period_month: 1, paid_date: `${Y}-01-05` }];
    const base = ledgerRowSummary({ year: Y, owedByMonth: owed, allocation: allocatePayments({ owedByMonth: owed, payments: pay }), today: new Date(`${Y}-12-15T12:00:00`) });
    const s = ledgerRowSummary({ year: Y, owedByMonth: withAdj, allocation: a, today: new Date(`${Y}-12-15T12:00:00`) });
    // Both read settled ("paid = paid" already covered the plain month) — what the
    // credit changes is the BILL: the year bills $150 less, and the $150 the box was
    // showing in gold as "under" resolves to nothing, because now it isn't under.
    expect(s.owesToDate).toBe(base.owesToDate);
    expect(round2(base.billed - s.billed)).toBe(150);
    expect(base.variance).toBe(-150);
    expect(s.variance).toBe(0);
  });
});

describe('year-end reconciliation is not charged twice', () => {
  const share = {
    lease_id: 'l', base_rent: 120000, square_footage: 1000, roof_responsible: false,
    cam_amount: 18800, tax_amount: 0, roof_amt: 0,
    est_cam_annual: 18000, est_tax_annual: 0, est_roof_annual: null,
  };

  it('a CAM & tax correction rides the estimate side', () => {
    const plain = reconcileFigures({ share });
    expect(plain.diff).toBe(800); // actual 18,800 vs estimate 18,000
    const withAdj = reconcileFigures({ share, adjustments: [{ month: 3, kind: 'camtax', amount: 400 }] });
    // The tenant has already been billed $400 more CAM — so only $400 is left to settle.
    expect(withAdj.camTaxAdjust).toBe(400);
    expect(withAdj.estTotal).toBe(18400);
    expect(withAdj.diff).toBe(400);
  });

  it('a late fee or a base correction does NOT touch it', () => {
    const withFee = reconcileFigures({ share, adjustments: [{ month: 3, kind: 'fee', amount: 400 }, { month: 4, kind: 'base', amount: -200 }] });
    expect(withFee.camTaxAdjust).toBe(0);
    expect(withFee.diff).toBe(800);
  });
});

describe('the tenant statement', () => {
  const scheduled = {};
  for (let m = 1; m <= 12; m++) scheduled[m] = { owed: 1000 };

  it('reads as a running account and only lists charges that have come due', () => {
    const { rows, balance } = statementRows({
      year: Y,
      scheduled,
      payments: [{ id: 'p1', amount: 1000, paid_date: `${Y}-01-05`, period_month: 1 }],
      adjustments: [{ id: 'a1', month: 2, kind: 'fee', amount: 75, memo: 'Late fee', created_at: `${Y}-02-10` }],
      today: new Date(`${Y}-03-15T12:00:00`),
    });
    // Jan rent, Jan payment, Feb rent, Feb fee, Mar rent — December is not listed.
    expect(rows.map((r) => r.type)).toEqual(['charge', 'payment', 'charge', 'adjustment', 'charge']);
    expect(rows.some((r) => r.label.includes('December'))).toBe(false);
    expect(rows[1].amount).toBe(-1000);
    // 1000 − 1000 + 1000 + 75 + 1000
    expect(balance).toBe(2075);
    expect(rows[rows.length - 1].balance).toBe(2075);
  });

  it('a credit reduces the balance and is typed as a credit', () => {
    const { rows, balance } = statementRows({
      year: Y, scheduled, payments: [],
      adjustments: [{ id: 'a2', month: 1, kind: 'credit', amount: -250, created_at: `${Y}-01-20` }],
      today: new Date(`${Y}-01-31T12:00:00`),
    });
    expect(rows.find((r) => r.type === 'credit')).toBeTruthy();
    expect(balance).toBe(750);
  });
});

// ---------------------------------------------------------------- against the app

// prop-2 (Oak Center) is the OPEN-year property — prop-1 carries a financial_snapshots
// row for the current year, so every adjustment there would silently refuse. lease-3
// (Northwind Books) runs the whole year, so January has always come due whatever month
// the suite runs in.
describe('posting an adjustment through the real API', () => {
  let invoiceId = null;
  beforeAll(async () => {
    await updateLease('lease-3', { est_cam_annual: 12000, est_tax_annual: 0, est_roof_annual: null });
    invoiceId = (await ensureInvoice('lease-3', 'prop-2', Y)).id;
  });
  afterAll(async () => {
    for (const a of await listAdjustments({ leaseId: 'lease-3', year: Y })) await deleteAdjustment(a.id);
    await unmarkMonthPaid('lease-3', Y, 1);
  });

  it('⚠ NEVER rewrites a payment: a charge on an already system-marked month leaves every payment row untouched', async () => {
    await unmarkMonthPaid('lease-3', Y, 1);
    await markMonthPaid('lease-3', 'prop-2', Y, 1); // a SYSTEM mark at the month's owed
    const before = (await listPayments(invoiceId)).map((p) => ({ id: p.id, amount: Number(p.amount), month: p.period_month }));
    expect(before.some((p) => p.month === 1)).toBe(true);
    const janPaid = before.find((p) => p.month === 1).amount;

    const res = await addAdjustment({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, month: 1, kind: 'camtax', amount: 400, memo: 'Snow removal invoice ran high' });
    expect(res.refused).toBeUndefined();

    // ① The resync re-stamps system marks to the SCHEDULED owed, never the adjusted one.
    // Feed it the adjusted owed and this payment would have been deleted and re-written
    // at janPaid + 400 — asserting money that never arrived.
    const after = (await listPayments(invoiceId)).map((p) => ({ id: p.id, amount: Number(p.amount), month: p.period_month }));
    expect(after).toEqual(before);
    expect(after.find((p) => p.month === 1).amount).toBe(janPaid);
  });

  it('⚠ …and the charge is NOT invisible: the month reports $400 still owed', async () => {
    const { schedule, adjustments, payments } = await getMonthlyRent('lease-3', Y);
    const alloc = allocatePayments({ owedByMonth: schedule, payments, adjustments });
    // ② settled ⇒ coverage caps at the SCHEDULED owed, so the charge is real arrears.
    expect(round2(alloc.owed[0] - alloc.coverage[0])).toBe(400);
    // Measured as the delta against the same lease-year with the charge removed, so the
    // other eleven unpaid months don't drown the signal.
    const plain = allocatePayments({ owedByMonth: schedule[1].owed != null ? Object.fromEntries(Object.entries(schedule).map(([m, c]) => [m, { ...c, owed: round2(c.owed - (adjustments?.[Number(m) - 1] || 0)) }])) : schedule, payments });
    const sum = ledgerRowSummary({ year: Y, owedByMonth: schedule, allocation: alloc, today: new Date(`${Y}-12-15T12:00:00`) });
    const baseSum = ledgerRowSummary({ year: Y, owedByMonth: plain.owed, allocation: plain, today: new Date(`${Y}-12-15T12:00:00`) });
    expect(round2(sum.owesToDate - baseSum.owesToDate)).toBe(400);
    // The box's own signal: received is $400 under what the month now bills.
    expect(round2(alloc.received[0] - alloc.owed[0])).toBe(-400);
  });

  it('the invoice total moved by exactly the charge, and the components did not', async () => {
    const inv = await getYearInvoice('lease-3', Y);
    const parts = round2(Number(inv.base_rent_annual) + Number(inv.cam_annual) + Number(inv.tax_annual) + Number(inv.roof_annual) - Number(inv.abatement_annual || 0));
    expect(round2(Number(inv.total_amount) - parts)).toBe(400);
    // …and the twelve months still sum to that total to the cent.
    const { schedule } = await getMonthlyRent('lease-3', Y);
    const sum = round2(Object.values(schedule).reduce((s, c) => s + c.owed, 0));
    expect(sum).toBe(round2(Number(inv.total_amount)));
  });

  it('the roll carries the adjustment so the Ledger and the panel read the same month', async () => {
    const roll = await getPropertyMonthlyRoll('prop-2', Y);
    const r = roll.find((x) => x.lease_id === 'lease-3');
    expect(r.adjustments[0]).toBe(400);
    expect(r.adjustmentRows).toHaveLength(1);
    const comp = componentizeSchedule({ schedule: r.schedule, factor: r.factor, camTaxAnnual: r.camTaxAnnual, roofAnnual: r.roofAnnual, adjustments: r.adjustments });
    expect(comp[1].adj).toBe(400);
    expect(round2(comp[1].base + comp[1].camTax + comp[1].roof + comp[1].adj)).toBe(round2(r.schedule[1].owed));
  });

  it('deleting it puts the month and the invoice back exactly', async () => {
    const before = await getYearInvoice('lease-3', Y);
    const [adj] = await listAdjustments({ leaseId: 'lease-3', year: Y });
    await deleteAdjustment(adj.id);
    const after = await getYearInvoice('lease-3', Y);
    expect(round2(Number(before.total_amount) - Number(after.total_amount))).toBe(400);
    const { adjustments } = await getMonthlyRent('lease-3', Y);
    expect(adjustments).toBeNull();
  });

  it('refuses a credit larger than the month, and writes nothing', async () => {
    const share = await getTenantShare('lease-3', Y);
    expect(share).toBeTruthy();
    const res = await addAdjustment({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, month: 1, kind: 'credit', amount: -999999 });
    expect(res.refused).toBe(true);
    expect(res.reason).toBe('negative');
    expect(await listAdjustments({ leaseId: 'lease-3', year: Y })).toHaveLength(0);
  });

  it('refuses a zero amount', async () => {
    const res = await addAdjustment({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, month: 1, kind: 'fee', amount: 0 });
    expect(res.refused).toBe(true);
    expect(res.reason).toBe('zero');
  });

  it('refuses a CLOSED year — prop-1 is closed for the current year', async () => {
    const res = await addAdjustment({ leaseId: 'lease-2', propertyId: 'prop-1', year: Y, month: 4, kind: 'fee', amount: 100 });
    expect(res.refused).toBe(true);
    expect(res.reason).toBe('closed');
    expect(await listAdjustments({ leaseId: 'lease-2', year: Y })).toHaveLength(0);
  });

  it('refuses a CAM & tax correction on a gross lease', async () => {
    await updateLease('lease-3', { lease_type: 'gross' });
    try {
      const res = await addAdjustment({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, month: 1, kind: 'camtax', amount: 400 });
      expect(res.refused).toBe(true);
      expect(res.reason).toBe('gross');
      // …but a base correction or a credit is still available to a gross tenant.
      const ok = await addAdjustment({ leaseId: 'lease-3', propertyId: 'prop-2', year: Y, month: 1, kind: 'base', amount: -100 });
      expect(ok.refused).toBeUndefined();
      await deleteAdjustment(ok.row.id);
    } finally {
      await updateLease('lease-3', { lease_type: null });
    }
  });
});

// The seeded $250 late fee on City Dental (other_income, round 8) records money that
// ARRIVED and was never billed. An adjustment records a charge that is OWED. One event
// is never both — and the fee must still move no Ledger month.
describe('other income and an adjustment stay different things', () => {
  it("City Dental's seeded late fee still moves no Ledger month", async () => {
    const roll = await getPropertyMonthlyRoll('prop-1', Y);
    const cd = roll.find((r) => r.tenant_name === 'City Dental');
    expect(cd.adjustments).toBeNull();
    expect(round2(cd.annual)).toBe(109800);
  });
});
